"""
Patients API endpoints.

All routes are prefixed with /api/patients and require a valid JWT login.
Route functions stay THIN — real logic is in app/services/patient_service.py.

Endpoints:
  GET  /tags               — list all tags (for the register/edit form)
  POST /tags               — create a new tag

  GET  /                   — search patients (query, page, limit)
  POST /                   — register a new patient
  GET  /{id}               — patient detail with stats (departments, tags, purchase count)
  PUT  /{id}               — update patient fields and/or links
  GET  /{id}/summary       — rich history summary (visits, meds, follow-ups, risk flags)
  GET  /{id}/purchases     — all invoices for this patient, newest first
"""
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.billing import Invoice
from app.models.patients import Patient, Tag
from app.models.user import User
from app.schemas.billing import InvoiceOut
from app.schemas.patients import (
    PatientCreate,
    PatientListItem,
    PatientOut,
    PatientSummaryOut,
    PatientUpdate,
    TagCreate,
    TagOut,
)
from app.services.auth_service import get_current_user
from app.services.patient_service import (
    create_patient,
    get_patient_summary,
    get_patient_with_stats,
    get_purchase_history,
    search_patients,
    update_patient,
)

router = APIRouter(prefix="/patients", tags=["Patients"])


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------

@router.get("/tags", response_model=list[TagOut])
def list_tags(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    Return all available tags ordered by name.
    Used by the patient registration and edit forms to show the tag-pill selector.
    """
    return db.query(Tag).order_by(Tag.name).all()


@router.post("/tags", response_model=TagOut, status_code=status.HTTP_201_CREATED)
def create_tag(
    body: TagCreate,
    db:   Session = Depends(get_db),
    _:    User    = Depends(get_current_user),
):
    """
    Create a new tag.  Returns 409 if a tag with the same name already exists
    (tag names must be unique — case-insensitive check in the DB UNIQUE constraint).
    """
    existing = db.query(Tag).filter(Tag.name.ilike(body.name)).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Tag '{body.name}' already exists (id={existing.id})",
        )
    tag = Tag(name=body.name.strip())
    db.add(tag)
    db.commit()
    db.refresh(tag)
    return tag


# ---------------------------------------------------------------------------
# Patient search / list
# ---------------------------------------------------------------------------

@router.get("/", response_model=list[PatientListItem])
def list_patients(
    query: Optional[str] = Query(None, description="Search by name or mobile (partial match)"),
    page:  int           = Query(1,    ge=1,   description="Page number"),
    limit: int           = Query(20,   ge=1, le=100, description="Results per page"),
    db:    Session       = Depends(get_db),
    _:     User          = Depends(get_current_user),
):
    """
    Search patients by name or mobile number (case-insensitive partial match).
    With no query, returns all patients (newest first), paginated.
    """
    return search_patients(db, query, page, limit)


# ---------------------------------------------------------------------------
# Create patient
# ---------------------------------------------------------------------------

@router.post("/", response_model=PatientOut, status_code=status.HTTP_201_CREATED)
def register_patient(
    body:         PatientCreate,
    force:        bool    = Query(False, description="Register even if the phone number already exists"),
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Register a new patient.  Links to departments and tags (if provided) in
    the same transaction.  Writes an audit_log entry.

    Duplicate guard: a phone number should map to ONE patient record. If someone
    tries to register a number that already exists, we stop them with a 409 and
    name the existing patient so the front end can offer to select them instead.
    """
    # Normalise so "  98765 " and "98765" are treated as the same number.
    # `force=true` lets staff deliberately register a genuine second person who
    # happens to share a phone (e.g. a family landline).
    mobile = (body.mobile or "").strip()
    if mobile and not force:
        existing = (
            db.query(Patient)
            .filter(Patient.mobile == mobile)
            .first()
        )
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "message": f"A patient with this phone number already exists: {existing.name}",
                    "existing_patient_id": existing.id,
                    "existing_patient_name": existing.name,
                },
            )

    patient = create_patient(db, body, current_user.id)
    db.commit()
    db.refresh(patient)
    return get_patient_with_stats(db, patient.id)


# ---------------------------------------------------------------------------
# Patient detail
# ---------------------------------------------------------------------------

@router.get("/{patient_id}", response_model=PatientOut)
def get_patient(
    patient_id: int,
    db:         Session = Depends(get_db),
    _:          User    = Depends(get_current_user),
):
    """
    Return full patient detail: name, demographics, departments, tags,
    total invoice count, and last visit date.
    """
    return get_patient_with_stats(db, patient_id)


# ---------------------------------------------------------------------------
# Update patient
# ---------------------------------------------------------------------------

@router.put("/{patient_id}", response_model=PatientOut)
def update_patient_endpoint(
    patient_id:   int,
    body:         PatientUpdate,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Update a patient record.  All fields are optional — only send what changed.
    If department_ids or tag_ids are sent, they REPLACE the current links entirely.
    Writes an audit_log entry.
    """
    patient = update_patient(db, patient_id, body, current_user.id)
    db.commit()
    db.refresh(patient)
    return get_patient_with_stats(db, patient.id)


# ---------------------------------------------------------------------------
# Patient summary card
# ---------------------------------------------------------------------------

@router.get("/{patient_id}/summary", response_model=PatientSummaryOut)
def patient_summary(
    patient_id: int,
    db:         Session = Depends(get_db),
    _:          User    = Depends(get_current_user),
):
    """
    Return a rich patient history summary in a single call.

    Combines: visit stats (total, last, avg interval, total spent),
    top 10 purchased medicines, follow-up schedule counts, next due date,
    and auto-computed risk flags (no-visit, chronic-med overdue, overdue follow-up).

    All data comes from aggregate DB queries — no N+1 loops.
    """
    return get_patient_summary(db, patient_id)


# ---------------------------------------------------------------------------
# Purchase history
# ---------------------------------------------------------------------------

@router.get("/{patient_id}/purchases", response_model=list[InvoiceOut])
def patient_purchases(
    patient_id: int,
    db:         Session = Depends(get_db),
    _:          User    = Depends(get_current_user),
):
    """
    Return all invoices linked to this patient, newest first.
    Each entry is a full InvoiceOut with line items (for the purchase history
    section of the patient detail modal).
    """
    return get_purchase_history(db, patient_id)


# ---------------------------------------------------------------------------
# Recent invoices (compact) — for the billing screen's Patient History panel
# ---------------------------------------------------------------------------

@router.get("/{patient_id}/invoices")
def patient_invoices(
    patient_id: int,
    limit:      int     = Query(10, ge=1, le=100, description="How many invoices to return"),
    offset:     int     = Query(0,  ge=0,         description="How many to skip (for paging)"),
    db:         Session = Depends(get_db),
    _:          User    = Depends(get_current_user),
):
    """
    Return the patient's most recent invoices (newest first) in a COMPACT shape.

    This differs from /purchases (which returns the full GST receipt for every
    invoice).  Here we only send what the billing "Patient History" panel needs:
    invoice number, date, total, payment method, and a short medicine list.

    Because a single medicine can be split across two batches under FEFO, its
    invoice_items become TWO rows.  We MERGE rows by product name here so the
    panel shows "Amoxicillin 500mg × 2", not two separate ×1 lines.
    """
    invoices = (
        db.query(Invoice)
        .filter(Invoice.patient_id == patient_id)
        .order_by(Invoice.invoice_date.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    result = []
    for inv in invoices:
        # Merge line items by product name (collapses FEFO batch splits).
        merged: dict[str, dict] = {}
        order: list[str] = []   # preserve first-seen order for stable display
        for item in inv.items:
            name = item.product.name if item.product else "Unknown medicine"
            if name not in merged:
                merged[name] = {"quantity": 0, "line_total": Decimal("0")}
                order.append(name)
            merged[name]["quantity"]   += item.quantity
            merged[name]["line_total"] += (item.line_total or Decimal("0"))

        items_out = [
            {
                "product_name": name,
                "quantity":     merged[name]["quantity"],
                "line_total":   float(merged[name]["line_total"]),
            }
            for name in order
        ]

        # invoice_date is the authoritative sale timestamp; fall back to created_at.
        when = inv.invoice_date or inv.created_at

        result.append({
            "id":             inv.id,
            "invoice_number": inv.invoice_number,
            "created_at":     when.isoformat() if when else None,
            "total_amount":   float(inv.total_amount or 0),
            "payment_method": inv.payment_method,
            "status":         inv.status,
            "items":          items_out,
        })

    return result
