"""
Billing & POS API endpoints.

All routes are prefixed with /api/billing and require a valid JWT login.
Route functions stay THIN — real logic is in app/services/billing_service.py.

Endpoints:
  GET  /products/search          — products with FEFO price (for the billing screen)
  GET  /patients/search          — patient lookup for linking to an invoice
  POST /invoices                 — create a new invoice (the main sale action)
  GET  /invoices                 — list invoices with filters + pagination
  GET  /invoices/today           — today's invoices + total (MUST be before /{number})
  GET  /invoices/{number}        — full invoice detail by invoice_number
  POST /invoices/{number}/return — process an invoice return
"""
from datetime import date, datetime, time
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session, joinedload, selectinload

from app.database import get_db
from app.models.billing import Invoice, InvoiceItem
from app.models.inventory import Batch, Product
from app.models.opd import Doctor, OPDVisit
from app.models.patients import Patient
from app.models.user import User
from app.utils.dates import get_today_ist, ist_day_bounds_utc
from app.schemas.billing import (
    BillingProductOut,
    CreateInvoiceRequest,
    InvoiceListItem,
    InvoiceListResponse,
    InvoiceItemOut,
    InvoiceOut,
    PatientSearchOut,
    ReturnRequest,
    HomeVisitChargeOut,
    HomeVisitChargeUpdate,
)
from app.models.supplier_credit import HomeVisitCharge
from app.services.auth_service import get_current_user
from app.services.billing_service import create_invoice, get_next_invoice_number, process_return
from app.services.inventory_service import get_product_stock

router = APIRouter(prefix="/billing", tags=["Billing"])


# ---------------------------------------------------------------------------
# Helper: build InvoiceOut from an ORM Invoice object
# ---------------------------------------------------------------------------

def _build_invoice_out(invoice: Invoice) -> InvoiceOut:
    """
    Convert a SQLAlchemy Invoice object into the Pydantic response shape.
    Computes per-line taxable_amount and gst_amount (they aren't stored
    separately in the DB — we derive them from stored qty, unit_price, gst_rate).
    """
    patient_name = invoice.patient.name if invoice.patient else "Walk-in Customer"

    items: list[InvoiceItemOut] = []
    for item in invoice.items:
        # GST is INCLUSIVE in the MRP (see CLAUDE.md §4). unit_price is the
        # tax-inclusive MRP, so line_total (= qty × unit_price) already contains
        # the tax. We must EXTRACT the GST out of it, not add it on top:
        #   gst     = line_total × rate / (100 + rate)
        #   taxable = line_total − gst
        # (The old code did line_total × rate / 100, which is tax-on-top and
        #  overstated GST — e.g. ₹90 @ 12% gave ₹10.80 instead of ₹9.64.)
        line_total = item.line_total
        gst_amt = (line_total * item.gst_rate / (Decimal("100") + item.gst_rate)).quantize(Decimal("0.01"))
        taxable = (line_total - gst_amt).quantize(Decimal("0.01"))
        items.append(InvoiceItemOut(
            product_name=item.product.name,
            batch_number=item.batch.batch_number,
            quantity=item.quantity,
            unit_price=item.unit_price,
            purchase_price=item.purchase_price,
            gst_rate=item.gst_rate,
            taxable_amount=taxable,
            gst_amount=gst_amt,
            line_total=line_total,
        ))

    return InvoiceOut(
        id=invoice.id,
        invoice_number=invoice.invoice_number,
        invoice_date=invoice.invoice_date,
        patient_name=patient_name,
        items=items,
        subtotal=invoice.subtotal,
        discount_amount=invoice.discount_amount,
        gst_amount=invoice.gst_amount,
        total_amount=invoice.total_amount,
        payment_method=invoice.payment_method,
        status=invoice.status,
        referred_by=invoice.referred_by,
        amount_paid=invoice.amount_paid,
        credit_amount=invoice.credit_amount,
        credit_due_date=invoice.credit_due_date,
        # Service charge — shown on its own receipt line, never GST-taxed.
        home_visit_charge=invoice.home_visit_charge or Decimal("0"),
        home_visit_notes=invoice.home_visit_notes,
    )


def _build_list_item(invoice: Invoice) -> InvoiceListItem:
    """Build the lightweight list row for the Invoice History table."""
    patient_name = invoice.patient.name if invoice.patient else "Walk-in Customer"
    return InvoiceListItem(
        invoice_number=invoice.invoice_number,
        invoice_date=invoice.invoice_date,
        patient_name=patient_name,
        item_count=len(invoice.items),
        total_amount=invoice.total_amount,
        payment_method=invoice.payment_method,
        status=invoice.status,
    )


# ---------------------------------------------------------------------------
# Product search for the billing screen
# ---------------------------------------------------------------------------

@router.get("/products/search", response_model=list[BillingProductOut])
def search_billing_products(
    q:  str     = Query(..., min_length=1, description="Name, generic name, or barcode"),
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    Search for products that have sellable stock, returning their current
    FEFO selling price.  Used by the billing screen's search/scan input.

    Only products with at least one non-expired batch with qty > 0 appear.
    selling_price is the price from the FEFO batch (earliest expiry first).
    """
    today   = get_today_ist()
    pattern = f"%{q}%"

    products = (
        db.query(Product)
        .filter(
            Product.is_active == True,
            (
                Product.name.ilike(pattern)
                | Product.generic_name.ilike(pattern)
                | Product.barcode.ilike(pattern)
            ),
        )
        .limit(20)
        .all()
    )

    results: list[BillingProductOut] = []
    for p in products:
        # Find the FEFO batch — earliest non-expired batch that has stock
        fefo_batch = (
            db.query(Batch)
            .filter(
                Batch.product_id == p.id,
                Batch.expiry_date >= today,
                Batch.quantity_available > 0,
            )
            .order_by(Batch.expiry_date)
            .first()
        )
        if fefo_batch is None:
            continue   # no sellable stock — don't show in billing results

        results.append(BillingProductOut(
            product_id=p.id,
            name=p.name,
            generic_name=p.generic_name,
            barcode=p.barcode,
            gst_rate=p.gst_rate,
            current_stock=get_product_stock(db, p.id),
            selling_price=fefo_batch.selling_price,
            unit=p.unit,
        ))

    return results


# ---------------------------------------------------------------------------
# Patient search (optional — to link an invoice to a patient record)
# ---------------------------------------------------------------------------

@router.get("/patients/search", response_model=list[PatientSearchOut])
def search_patients(
    q:  str     = Query(..., min_length=1, description="Patient name or mobile"),
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    Quick patient lookup for the billing screen's optional patient-link field.
    Matches on name or mobile number (case-insensitive).
    """
    pattern = f"%{q}%"
    patients = (
        db.query(Patient)
        .filter(
            Patient.name.ilike(pattern)
            | Patient.mobile.ilike(pattern)
        )
        .limit(10)
        .all()
    )
    return [PatientSearchOut(id=p.id, name=p.name, mobile=p.mobile) for p in patients]


# ---------------------------------------------------------------------------
# Last doctor for a patient (from OPD visits — used to auto-fill Referred by)
# ---------------------------------------------------------------------------

@router.get("/patient/{patient_id}/last-doctor")
def get_last_doctor(
    patient_id: int,
    db:         Session = Depends(get_db),
    _:          User    = Depends(get_current_user),
):
    """
    Return the doctor from this patient's most recent OPD visit.
    If no OPD visit exists, returns {doctor_name: null}.
    Used by the billing screen to auto-fill the "Referred by" field.
    """
    visit = (
        db.query(OPDVisit)
        .options(joinedload(OPDVisit.doctor))
        .filter(OPDVisit.patient_id == patient_id)
        .order_by(OPDVisit.visit_date.desc())
        .first()
    )
    if visit is None or visit.doctor is None:
        return {"doctor_name": None}
    return {
        "doctor_name":     visit.doctor.name,
        "specialization":  visit.doctor.specialization,
        "visit_date":      visit.visit_date.isoformat(),
    }


# ---------------------------------------------------------------------------
# Create invoice
# ---------------------------------------------------------------------------

@router.post("/invoices", response_model=InvoiceOut, status_code=status.HTTP_201_CREATED)
def create_invoice_endpoint(
    body:         CreateInvoiceRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Create a new invoice (the main sale action).

    The service handles FEFO allocation, stock deduction, and stock movement
    audit rows — all in one DB transaction.  If anything fails (e.g. not
    enough stock) the entire transaction rolls back automatically.
    """
    invoice = create_invoice(db, body, current_user.id)
    db.commit()
    db.refresh(invoice)
    return _build_invoice_out(invoice)


# ---------------------------------------------------------------------------
# Invoice list with filters
# ---------------------------------------------------------------------------

@router.get("/invoices/today")
def today_summary(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    Return all COMPLETED invoices created today plus a running total.
    Useful for the end-of-day cash reconciliation.

    NOTE: this route MUST be defined before /invoices/{number} in the file,
    otherwise FastAPI would interpret "today" as an invoice number.
    """
    # invoice_date is stored in UTC. "Today" means today's IST calendar day, so
    # we filter on the UTC window that IST day occupies (half-open [start, end)).
    today_ist  = get_today_ist()
    start, end = ist_day_bounds_utc(today_ist)

    invoices = (
        db.query(Invoice)
        .options(joinedload(Invoice.patient), selectinload(Invoice.items))
        .filter(
            Invoice.invoice_date >= start,
            Invoice.invoice_date < end,
        )
        .order_by(Invoice.invoice_date.desc())
        .all()
    )

    completed_total = sum(
        inv.total_amount for inv in invoices if inv.status == "COMPLETED"
    )

    return {
        "date":            today_ist.isoformat(),
        "invoices":        [_build_list_item(inv) for inv in invoices],
        "completed_count": sum(1 for inv in invoices if inv.status == "COMPLETED"),
        "total_sales":     str(completed_total),
    }


@router.get("/invoices", response_model=InvoiceListResponse)
def list_invoices(
    page:      int           = Query(1,    ge=1,              description="Page number"),
    limit:     int           = Query(20,   ge=1,   le=100,    description="Results per page"),
    date_from: Optional[date] = Query(None, description="Filter invoices from this date (inclusive)"),
    date_to:   Optional[date] = Query(None, description="Filter invoices to this date (inclusive)"),
    search:    Optional[str]  = Query(None, description="Search by invoice number or patient name"),
    status_filter: Optional[str] = Query(None, alias="status", description="COMPLETED or RETURNED"),
    db:        Session        = Depends(get_db),
    _:         User           = Depends(get_current_user),
):
    """
    Paginated list of invoices.  Supports date range, status, and text search.
    Returns lightweight InvoiceListItem rows (no full item details).
    """
    query = (
        db.query(Invoice)
        .options(joinedload(Invoice.patient), selectinload(Invoice.items))
    )

    if date_from:
        query = query.filter(Invoice.invoice_date >= datetime.combine(date_from, time.min))
    if date_to:
        query = query.filter(Invoice.invoice_date <= datetime.combine(date_to, time.max))
    if status_filter:
        query = query.filter(Invoice.status == status_filter.upper())
    if search:
        # Search on invoice_number OR patient name (requires a join)
        pattern = f"%{search}%"
        query = (
            query
            .outerjoin(Invoice.patient)
            .filter(
                Invoice.invoice_number.ilike(pattern)
                | Patient.name.ilike(pattern)
            )
        )

    total    = query.count()
    invoices = (
        query
        .order_by(Invoice.invoice_date.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    return InvoiceListResponse(
        items=[_build_list_item(inv) for inv in invoices],
        total=total,
        page=page,
        limit=limit,
    )


@router.get("/invoices/{invoice_number}", response_model=InvoiceOut)
def get_invoice(
    invoice_number: str,
    db:             Session = Depends(get_db),
    _:              User    = Depends(get_current_user),
):
    """Return the full invoice detail including all line items."""
    invoice = (
        db.query(Invoice)
        .options(
            joinedload(Invoice.patient),
            selectinload(Invoice.items)
            .joinedload(InvoiceItem.product),
            selectinload(Invoice.items)
            .joinedload(InvoiceItem.batch),
        )
        .filter(Invoice.invoice_number == invoice_number)
        .first()
    )
    if not invoice:
        raise HTTPException(status_code=404, detail=f"Invoice {invoice_number} not found")
    return _build_invoice_out(invoice)


# ---------------------------------------------------------------------------
# Process return
# ---------------------------------------------------------------------------

@router.post("/invoices/{invoice_number}/return", response_model=InvoiceOut)
def return_invoice(
    invoice_number: str,
    body:           ReturnRequest,
    db:             Session = Depends(get_db),
    current_user:   User    = Depends(get_current_user),
):
    """
    Return an invoice: restore stock, write RETURN movements, mark as RETURNED.
    An already-returned invoice raises 400 to prevent double-returns.
    """
    invoice = process_return(db, invoice_number, body.reason, current_user.id)
    db.commit()
    db.refresh(invoice)
    return _build_invoice_out(invoice)


# ---------------------------------------------------------------------------
# Home visit / drip administration charge settings (Feature 4)
# ---------------------------------------------------------------------------

# Only these roles may change the shop-wide default fee.  Any logged-in user
# can READ it, because the billing screen needs it to pre-fill the amount.
_CHARGE_ADMIN_ROLES = {"Owner", "Administrator"}


def _get_or_create_home_visit_charge(db: Session) -> HomeVisitCharge:
    """
    Fetch the single settings row, creating it on first use.

    The startup seed normally creates this, but creating it lazily here too
    means a database that predates the seed cannot 404 the billing screen.
    """
    charge = db.query(HomeVisitCharge).order_by(HomeVisitCharge.id).first()
    if charge is None:
        charge = HomeVisitCharge(
            name="Home Visit / Drip Administration Charge",
            default_amount=Decimal("100.00"),
            is_active=True,
        )
        db.add(charge)
        db.commit()
        db.refresh(charge)
    return charge


@router.get("/home-visit-charge", response_model=HomeVisitChargeOut)
def get_home_visit_charge(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    The default home visit / drip charge, used to pre-fill the billing screen.
    The pharmacist can still override the amount for any individual bill.
    """
    return _get_or_create_home_visit_charge(db)


@router.put("/home-visit-charge", response_model=HomeVisitChargeOut)
def update_home_visit_charge(
    body:         HomeVisitChargeUpdate,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Change the shop-wide default charge.  Owner/Administrator only — this is a
    pricing decision, not a counter operation.
    """
    if current_user.role.name not in _CHARGE_ADMIN_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only an Owner or Administrator can change the home visit charge.",
        )

    charge = _get_or_create_home_visit_charge(db)
    charge.default_amount = body.default_amount
    if body.name is not None:
        charge.name = body.name
    if body.is_active is not None:
        charge.is_active = body.is_active

    db.commit()
    db.refresh(charge)
    return charge
