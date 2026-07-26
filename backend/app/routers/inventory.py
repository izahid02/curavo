"""
Inventory API endpoints.

All routes are prefixed with /api/inventory and require a valid JWT login.
Route functions stay THIN — real logic is in app/services/inventory_service.py.

Role access:
  READ  (GET)  → any authenticated user
  WRITE (POST/PUT/DELETE) → Owner, Administrator, Pharmacist, Inventory Manager
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from datetime import date
from decimal import Decimal

from app.models.inventory import Batch, Category, Department, Product, StockMovement, Supplier
from app.models.user import User
from app.schemas.inventory import (
    AddStockRequest,
    AddStockResponse,
    BatchOut,
    BatchReceive,
    CategoryOut,
    DepartmentOut,
    ProductCreate,
    ProductListResponse,
    ProductOut,
    ProductUpdate,
    PurchaseHistoryResponse,
    ReturnPreviewOut,
    ReturnToSupplierRequest,
    ReturnToSupplierResponse,
    StockMovementOut,
    SupplierReturnListResponse,
)
from app.services import supplier_return_service
from app.services.auth_service import get_current_user
from app.services.inventory_service import (
    add_stock,
    batch_number_exists,
    get_expiry_alerts,
    get_expiry_status,
    get_low_stock_products,
    get_product_stock,
    get_purchase_history,
    parse_expiry_month,
    receive_stock,
)

router = APIRouter(prefix="/inventory", tags=["Inventory"])

# Roles allowed to create/modify/delete inventory records.
# Billing Staff and OPD Staff can READ but not write.
_WRITE_ROLES = {"Owner", "Administrator", "Pharmacist", "Inventory Manager"}


def _require_write_role(current_user: User = Depends(get_current_user)) -> User:
    """
    Dependency that blocks write operations for read-only roles.
    Attach to POST/PUT/DELETE routes with:  Depends(_require_write_role)
    """
    if current_user.role.name not in _WRITE_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your role does not have permission to modify inventory.",
        )
    return current_user


# ---------------------------------------------------------------------------
# Helpers (private — not exposed as routes)
# ---------------------------------------------------------------------------

def _build_product_out(db: Session, product: Product) -> ProductOut:
    """Build a full ProductOut from an ORM Product + computed fields."""
    current_stock = get_product_stock(db, product.id)

    # For strip medicines, translate the unit count into strips for display.
    # Stock is stored in UNITS, so strips is an integer division — 155 tablets
    # at 10/strip is 15 whole strips (with 5 loose tablets left over).
    available_strips = None
    if product.is_strip and product.units_per_strip:
        available_strips = current_stock // product.units_per_strip

    return ProductOut(
        id=product.id,
        name=product.name,
        generic_name=product.generic_name,
        brand=product.brand,
        manufacturer=product.manufacturer,
        category_id=product.category_id,
        category_name=product.category.name if product.category else None,
        department_id=product.department_id,
        department_name=product.department.name if product.department else None,
        hsn_code=product.hsn_code,
        gst_rate=product.gst_rate,
        barcode=product.barcode,
        rack_location=product.rack_location,
        unit=product.unit,
        min_stock_level=product.min_stock_level,
        is_active=product.is_active,
        current_stock=current_stock,
        created_at=product.created_at,
        medicine_type=product.medicine_type or "TABLET",
        is_strip=bool(product.is_strip),
        units_per_strip=product.units_per_strip,
        strip_mrp=product.strip_mrp,
        unit_mrp=product.unit_mrp,
        available_strips=available_strips,
        available_units=current_stock,
    )


def _build_batch_out(batch: Batch) -> BatchOut:
    """Build a BatchOut from an ORM Batch + computed expiry fields."""
    from datetime import date as _date
    days = (batch.expiry_date - _date.today()).days
    return BatchOut(
        id=batch.id,
        product_id=batch.product_id,
        product_name=batch.product.name,
        supplier_id=batch.supplier_id,
        batch_number=batch.batch_number,
        mrp=batch.mrp,
        purchase_price=batch.purchase_price,
        selling_price=batch.selling_price,
        mfg_date=batch.mfg_date,
        expiry_date=batch.expiry_date,
        quantity_received=batch.quantity_received,
        quantity_available=batch.quantity_available,
        days_to_expiry=days,
        expiry_status=get_expiry_status(batch.expiry_date),
        created_at=batch.created_at,
        scheme_label=batch.scheme_label,
        bonus_quantity=batch.bonus_quantity or 0,
    )


# ---------------------------------------------------------------------------
# Lookup tables
# ---------------------------------------------------------------------------

@router.get("/categories", response_model=list[CategoryOut])
def list_categories(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """Return all product categories (Tablet, Syrup…). Used by the Add Product form."""
    return db.query(Category).order_by(Category.name).all()


@router.get("/departments", response_model=list[DepartmentOut])
def list_departments(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """Return all departments (Cardiology, Diabetes…). Used by the Add Product form."""
    return db.query(Department).order_by(Department.name).all()


# ---------------------------------------------------------------------------
# Products CRUD
# ---------------------------------------------------------------------------

@router.get("/products", response_model=ProductListResponse)
def list_products(
    page:   int           = Query(1, ge=1, description="Page number, starts at 1"),
    limit:  int           = Query(20, ge=1, le=100, description="Results per page"),
    search: Optional[str] = Query(None, description="Search name, generic name, or barcode"),
    db:     Session       = Depends(get_db),
    _:      User          = Depends(get_current_user),
):
    """
    Return a paginated list of active products.
    Optional 'search' matches name OR generic_name OR barcode (case-insensitive).
    """
    query = db.query(Product).filter(Product.is_active == True)

    if search:
        pattern = f"%{search}%"
        query = query.filter(
            Product.name.ilike(pattern)
            | Product.generic_name.ilike(pattern)
            | Product.barcode.ilike(pattern)
        )

    total    = query.count()
    products = (
        query
        .order_by(Product.name)
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    items = [
        {
            "id":              p.id,
            "name":            p.name,
            "generic_name":    p.generic_name,
            "barcode":         p.barcode,
            "current_stock":   get_product_stock(db, p.id),
            "min_stock_level": p.min_stock_level,
            "gst_rate":        p.gst_rate,
            "is_active":       p.is_active,
            "medicine_type":   p.medicine_type or "TABLET",
            "is_strip":        bool(p.is_strip),
            "units_per_strip": p.units_per_strip,
            "strip_mrp":       p.strip_mrp,
            "unit_mrp":        p.unit_mrp,
        }
        for p in products
    ]

    return ProductListResponse(items=items, total=total, page=page, limit=limit)


@router.post(
    "/products",
    response_model=ProductOut,
    status_code=status.HTTP_201_CREATED,
)
def create_product(
    body:         ProductCreate,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(_require_write_role),
):
    """Create a new product (medicine identity record). Stock is added separately via batches."""
    product = Product(**body.model_dump())
    db.add(product)
    db.commit()
    db.refresh(product)
    return _build_product_out(db, product)


@router.get("/products/{product_id}", response_model=ProductOut)
def get_product(
    product_id: int,
    db:         Session = Depends(get_db),
    _:          User    = Depends(get_current_user),
):
    """Return full product detail including computed current_stock."""
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    return _build_product_out(db, product)


@router.put("/products/{product_id}", response_model=ProductOut)
def update_product(
    product_id: int,
    body:       ProductUpdate,
    db:         Session = Depends(get_db),
    _:          User    = Depends(_require_write_role),
):
    """Update one or more fields on an existing product.  Only send changed fields."""
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    # exclude_unset=True means we only update fields that were explicitly sent,
    # leaving everything else unchanged.
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(product, field, value)

    db.commit()
    db.refresh(product)
    return _build_product_out(db, product)


@router.delete("/products/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_product(
    product_id: int,
    db:         Session = Depends(get_db),
    _:          User    = Depends(_require_write_role),
):
    """
    Soft-delete: set is_active = False rather than deleting the row.
    We never hard-delete products because past invoices and batches reference them.
    """
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    product.is_active = False
    db.commit()


# ---------------------------------------------------------------------------
# Batches — receiving stock
# ---------------------------------------------------------------------------

@router.post(
    "/batches/receive",
    response_model=BatchOut,
    status_code=status.HTTP_201_CREATED,
)
def receive_new_stock(
    body:         BatchReceive,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(_require_write_role),
):
    """
    Record a new stock delivery.  Creates a Batch row and a StockMovement
    audit row in a single transaction.
    """
    product = db.query(Product).filter(Product.id == body.product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    batch = receive_stock(db, body, current_user.id)
    db.commit()
    db.refresh(batch)
    return _build_batch_out(batch)


@router.post(
    "/add-stock",
    response_model=AddStockResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_stock_to_product(
    body:         AddStockRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(_require_write_role),
):
    """
    Add stock to an existing medicine (unified Medicines page flow).

    In one transaction this creates:
      - a new Batch (the physical stock),
      - a StockMovement(type="IN") audit row,
      - a StockPurchase record linking the batch to the supplier + invoice.

    Validation performed here BEFORE writing anything:
      - the product exists,
      - the supplier exists,
      - the batch number is not already used for this product,
      - the expiry month is in the future.
    """
    # --- Validate references exist ------------------------------------------
    product = db.query(Product).filter(Product.id == body.product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    supplier = db.query(Supplier).filter(Supplier.id == body.supplier_id).first()
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")

    # --- Batch number must be unique for this product -----------------------
    if batch_number_exists(db, body.product_id, body.batch_number):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Batch number '{body.batch_number}' already exists for this medicine.",
        )

    # --- Expiry must be a sane, real-world date -----------------------------
    expiry = parse_expiry_month(body.expiry_date)
    # Guard against data-entry typos like "0229-03" (year 229) which otherwise
    # sail through and show up as "656470 days ago" in the expiry alerts.
    if expiry.year < 2020 or expiry.year > 2050:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid expiry date",
        )
    if expiry < date.today():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Expiry date must be in the future.",
        )

    # --- Advance balance check (Feature A) ---------------------------------
    # If the pharmacist chose to spend some of this supplier's advance, make
    # sure they actually have that much BEFORE writing anything.  The service
    # clamps too, but a clear up-front error is friendlier than a silent clamp.
    quantity_dec  = Decimal(str(body.quantity))
    cost_dec      = body.cost_price if body.cost_price is not None else Decimal("0")
    invoice_total = (
        Decimal(str(body.supplier_invoice_total))
        if body.supplier_invoice_total is not None
        else quantity_dec * cost_dec
    )

    advance_requested = Decimal(str(body.advance_used or 0))
    advance_applied   = Decimal("0")
    if advance_requested > 0:
        from app.services import supplier_credit_service as credit_svc
        account   = credit_svc.get_or_create_account(db, body.supplier_id)
        available = Decimal(str(account.advance_balance or 0))
        if available < advance_requested:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Advance balance insufficient. Available: Rs.{available}",
            )
        # The advance can never offset more than the invoice is worth.
        advance_applied = min(advance_requested, invoice_total)

    # --- Credit needs a due date -------------------------------------------
    # Work out up front whether this delivery will create credit, so we can
    # reject a missing due date BEFORE writing any stock rows.  Credit is only
    # what remains after BOTH the advance and the cash paid.
    remaining_dec = invoice_total - advance_applied
    paid_dec = Decimal("0") if body.payment_mode == "CREDIT" else Decimal(str(body.amount_paid))
    will_create_credit = (remaining_dec - min(paid_dec, remaining_dec)) > 0

    if will_create_credit and body.due_date is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A due date is required when part of the invoice is unpaid (credit).",
        )
    if body.due_date is not None and body.due_date < date.today():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Credit due date cannot be in the past.",
        )

    # --- Refresh the product's strip prices (Feature 3) ---------------------
    # Strip MRP can change delivery to delivery.  When the Add Stock panel sends
    # updated strip_mrp/unit_mrp for a strip medicine, store them on the product
    # so search results, billing and future Add Stock pre-fills use the latest
    # prices.  We only touch strip medicines and only overwrite when a value is
    # actually provided.
    if product.is_strip:
        if body.strip_mrp is not None:
            product.strip_mrp = body.strip_mrp
        if body.unit_mrp is not None:
            product.unit_mrp = body.unit_mrp

    # --- All good — perform the writes and commit ---------------------------
    batch, _purchase, credit = add_stock(db, body, current_user.id)
    db.commit()
    db.refresh(batch)

    new_total = get_product_stock(db, product.id)

    # Scheme details are read straight off the freshly-created batch.
    total_qty = batch.quantity_received
    bonus_qty = batch.bonus_quantity or 0

    # Tailor the confirmation message to what actually happened.
    if bonus_qty > 0:
        message = (
            f"{batch.paid_quantity} paid + {bonus_qty} bonus "
            f"= {total_qty} units added to {product.name}"
        )
    else:
        message = f"{body.quantity} units added to {product.name}"
    if credit["advance_used"] > 0:
        message += f" — Rs.{credit['advance_used']} from advance"
    if credit["credit_amount"] > 0:
        message += f" — Rs.{credit['credit_amount']} added to supplier credit"

    return AddStockResponse(
        success=True,
        batch_id=batch.id,
        new_total_stock=new_total,
        message=message,
        invoice_total=credit["invoice_total"],
        amount_paid=credit["amount_paid"],
        credit_amount=credit["credit_amount"],
        credit_tx_id=credit["credit_tx_id"],
        supplier_outstanding=credit["supplier_outstanding"],
        advance_used=credit["advance_used"],
        supplier_advance_remaining=credit["supplier_advance_remaining"],
        supplier_outstanding_after=credit["supplier_outstanding_after"],
        scheme_label=batch.scheme_label,
        paid_quantity=batch.paid_quantity,
        bonus_quantity=bonus_qty,
        total_quantity=total_qty,
        effective_cost_per_unit=batch.effective_cost_per_unit,
    )


@router.get("/purchase-history", response_model=PurchaseHistoryResponse)
def purchase_history(
    limit:       int           = Query(50, ge=1, le=200),
    offset:      int           = Query(0, ge=0),
    search:      Optional[str] = Query(None, description="Match product OR supplier name"),
    supplier_id: Optional[int] = Query(None, description="Filter by supplier"),
    date_from:   Optional[date] = Query(None, description="Invoice date on/after (YYYY-MM-DD)"),
    date_to:     Optional[date] = Query(None, description="Invoice date on/before (YYYY-MM-DD)"),
    db:          Session       = Depends(get_db),
    _:           User          = Depends(get_current_user),
):
    """
    Return a paginated list of every stock-in event recorded via Add Stock,
    newest first, joined with product/supplier/batch/user details.
    """
    result = get_purchase_history(
        db,
        limit=limit,
        offset=offset,
        search=search,
        supplier_id=supplier_id,
        date_from=date_from,
        date_to=date_to,
    )
    return PurchaseHistoryResponse(**result)


@router.get("/batches/{product_id}", response_model=list[BatchOut])
def list_batches_for_product(
    product_id: int,
    db:         Session = Depends(get_db),
    _:          User    = Depends(get_current_user),
):
    """
    Return all batches for a product, sorted earliest-expiry first.
    This FEFO order is the same order billing will consume stock from.
    """
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    batches = (
        db.query(Batch)
        .filter(Batch.product_id == product_id)
        .order_by(Batch.expiry_date)
        .all()
    )
    return [_build_batch_out(b) for b in batches]


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------

@router.get("/alerts/expiry")
def expiry_alerts(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """Return all non-empty batches grouped by expiry proximity."""
    return get_expiry_alerts(db)


@router.get("/alerts/low-stock")
def low_stock_alerts(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """Return products whose available stock is below their minimum level."""
    return get_low_stock_products(db)


# ---------------------------------------------------------------------------
# Stock movement history
# ---------------------------------------------------------------------------

@router.get("/movements/{product_id}", response_model=list[StockMovementOut])
def stock_movement_history(
    product_id: int,
    db:         Session = Depends(get_db),
    _:          User    = Depends(get_current_user),
):
    """
    Return the full stock movement audit trail for a product.
    Ordered most-recent first so the latest activity shows at the top.
    """
    movements = (
        db.query(StockMovement)
        .join(StockMovement.batch)
        .filter(Batch.product_id == product_id)
        .order_by(StockMovement.created_at.desc())
        .all()
    )
    return [
        StockMovementOut(
            id=m.id,
            batch_id=m.batch_id,
            product_name=m.batch.product.name,
            movement_type=m.movement_type,
            quantity=m.quantity,
            reference=m.reference,
            created_at=m.created_at,
        )
        for m in movements
    ]


# ---------------------------------------------------------------------------
# Returning expired stock to the supplier (Feature 2)
# ---------------------------------------------------------------------------

@router.get("/return-preview/{batch_id}", response_model=ReturnPreviewOut)
def preview_supplier_return(
    batch_id: int,
    db:       Session = Depends(get_db),
    _:        User    = Depends(get_current_user),
):
    """
    Everything the "Return to Supplier" modal needs before anything is written:
    who the supplier is, what we paid, the GST that will be lost, and how much
    credit we currently owe them.

    Having the backend do this arithmetic means the preview shown to the
    pharmacist and the value actually recorded can never disagree.
    """
    context = supplier_return_service.resolve_return_context(db, batch_id)
    if context is None:
        raise HTTPException(
            status_code=404,
            detail="Batch not found, or no supplier is linked to this batch.",
        )

    # Split the available quantity into paid vs bonus units (Feature B) and
    # value only the paid units — the free bonus units cannot be reclaimed.
    paid_available, bonus_available = supplier_return_service.split_scheme_units(
        context["quantity_available"],
        context["bonus_quantity"],
        context["total_received"],
    )
    values = supplier_return_service.calculate_return_value(
        paid_available,
        context["purchase_price"],
        context["gst_rate"],
    )

    batch    = context["batch"]
    product  = context["product"]
    supplier = context["supplier"]

    return ReturnPreviewOut(
        batch_id=batch.id,
        batch_number=batch.batch_number,
        product_id=product.id,
        product_name=product.name,
        supplier_id=context["supplier_id"],
        supplier_name=supplier.name if supplier else "Unknown supplier",
        quantity_available=context["quantity_available"],
        purchase_price=context["purchase_price"],
        gst_rate=context["gst_rate"],
        gross_value=values["gross_value"],
        gst_deduction=values["gst_deduction"],
        net_return_value=values["net_return_value"],
        supplier_outstanding=context["outstanding"],
        scheme_label=context["scheme_label"],
        bonus_quantity=context["bonus_quantity"],
        total_received=context["total_received"],
        paid_available=paid_available,
        bonus_available=bonus_available,
    )


@router.post(
    "/return-to-supplier",
    response_model=ReturnToSupplierResponse,
    status_code=status.HTTP_201_CREATED,
)
def return_stock_to_supplier(
    body:         ReturnToSupplierRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(_require_write_role),
):
    """
    Send expired (or soon-to-expire) stock back to the supplier.

    In one transaction this:
      - records the return with its GST loss,
      - reduces the batch quantity,
      - writes a StockMovement(type="RETURN", negative quantity),
      - reduces what we owe that supplier — or banks an advance if we owe
        them nothing.
    """
    try:
        result = supplier_return_service.process_return(
            db,
            batch_id=body.batch_id,
            return_quantity=body.return_quantity,
            supplier_id=body.supplier_id,
            return_type=body.return_type,
            replacement_notes=body.replacement_notes,
            notes=body.notes,
            created_by=current_user.id,
        )
    except ValueError as exc:
        # Validation failures from the service layer are user-facing messages.
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    db.commit()
    return ReturnToSupplierResponse(**result)


@router.get("/returns", response_model=SupplierReturnListResponse)
def list_supplier_returns(
    limit:       int           = Query(100, ge=1, le=500),
    offset:      int           = Query(0, ge=0),
    supplier_id: Optional[int] = Query(None, description="Filter to one supplier"),
    db:          Session       = Depends(get_db),
    _:           User          = Depends(get_current_user),
):
    """History of every expired-stock return, newest first."""
    result = supplier_return_service.list_returns(
        db, limit=limit, offset=offset, supplier_id=supplier_id,
    )
    return SupplierReturnListResponse(**result)
