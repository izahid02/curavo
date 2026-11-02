"""
Purchasing business logic — Phase 2.

Key functions:
  get_next_po_number  — HCC-PO-YYYY-NNNNNN, atomic via BEGIN IMMEDIATE
  get_next_grn_number — HCC-GRN-YYYY-NNNNNN, same pattern
  create_po           — creates PO + items in one transaction
  update_po_status    — validates and applies a status transition + writes audit log
  create_grn          — creates GRN + items + batches + stock_movements in one transaction,
                        then updates PO status if po_id supplied
  get_po_list         — paginated PO list with optional status filter
  get_grn_list        — paginated GRN list

IMPORTANT: All multi-step writes run inside a single DB transaction.
The router calls db.commit() after these functions return.
Any exception before commit rolls everything back automatically.
"""
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import text, func
from sqlalchemy.orm import Session

from app.models.billing import AuditLog
from app.models.inventory import Batch, Supplier, StockMovement
from app.models.purchasing import GoodsReceiptNote, GRNItem, PurchaseOrder, PurchaseOrderItem
from app.schemas.purchasing import (
    GRNCreate, GRNListItem, GRNOut, GRNItemOut,
    POCreate, POListItem, POOut, POItemOut,
)


# ---------------------------------------------------------------------------
# Sequential number generators (thread-safe)
# ---------------------------------------------------------------------------

def get_next_po_number(db: Session) -> str:
    """
    Generate the next PO number for the current year.
    Format: {PREFIX}-PO-YYYY-NNNNNN  (e.g. HCC-PO-2026-000001)

    Delegates to get_next_doc_number() which uses BEGIN IMMEDIATE on a
    dedicated connection — safe for concurrent requests, no FOR UPDATE needed.
    """
    from app.database import get_next_doc_number
    year = date.today().year
    seq  = get_next_doc_number("PO", year)
    from app.services.doc_numbers import get_invoice_prefix
    return f"{get_invoice_prefix(db)}-PO-{year}-{seq:06d}"


def get_next_grn_number(db: Session) -> str:
    """
    Generate the next GRN number for the current year.
    Format: {PREFIX}-GRN-YYYY-NNNNNN  (e.g. HCC-GRN-2026-000001)
    Same approach as get_next_po_number.
    """
    from app.database import get_next_doc_number
    year = date.today().year
    seq  = get_next_doc_number("GRN", year)
    from app.services.doc_numbers import get_invoice_prefix
    return f"{get_invoice_prefix(db)}-GRN-{year}-{seq:06d}"


# ---------------------------------------------------------------------------
# Purchase Order creation
# ---------------------------------------------------------------------------

def create_po(db: Session, data: POCreate, user_id: int) -> PurchaseOrder:
    """
    Create a PO with all its line items in one transaction.

    Steps:
      1. Validate that the supplier exists.
      2. Generate a sequential PO number (atomic via doc_counters).
      3. Create the PurchaseOrder header row.
      4. For each item, create a PurchaseOrderItem row and sum up the total.
      5. Update total_amount on the PO header.
      6. Flush (assign IDs) but do NOT commit — caller commits.
    """
    supplier = db.query(Supplier).filter(Supplier.id == data.supplier_id).first()
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")

    po_number = get_next_po_number(db)

    po = PurchaseOrder(
        po_number=po_number,
        supplier_id=data.supplier_id,
        user_id=user_id,
        status="DRAFT",
        order_date=date.today(),
        expected_date=data.expected_date,
        notes=data.notes,
        total_amount=Decimal("0"),
    )
    db.add(po)
    db.flush()   # assigns po.id so items can reference it

    total = Decimal("0")
    for item_data in data.items:
        line_total = Decimal(str(item_data.quantity_ordered)) * item_data.unit_price
        item = PurchaseOrderItem(
            po_id=po.id,
            product_id=item_data.product_id,
            quantity_ordered=item_data.quantity_ordered,
            unit_price=item_data.unit_price,
            line_total=line_total,
        )
        db.add(item)
        total += line_total

    po.total_amount = total
    db.flush()
    return po


# ---------------------------------------------------------------------------
# Purchase Order status update
# ---------------------------------------------------------------------------

# Which transitions are allowed manually (via the UI/API).
# RECEIVED and PARTIALLY_RECEIVED are set automatically by the GRN service —
# users cannot set those directly.
_ALLOWED_MANUAL_TRANSITIONS: dict[str, set[str]] = {
    "DRAFT":              {"SENT", "CANCELLED"},
    "SENT":               {"CANCELLED"},
    "PARTIALLY_RECEIVED": {"CANCELLED"},
    "RECEIVED":           set(),      # terminal — no further changes
    "CANCELLED":          set(),      # terminal — no further changes
}


def update_po_status(db: Session, po_id: int, new_status: str, user_id: int) -> PurchaseOrder:
    """
    Validate and apply a status transition, then write an audit log entry.

    Rules:
      - RECEIVED and PARTIALLY_RECEIVED cannot be set manually (only by GRN).
      - CANCELLED and RECEIVED are terminal — no further changes.
      - A cancelled PO cannot be revived.
    """
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == po_id).first()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")

    # Block manual assignment of auto-managed statuses
    if new_status in {"RECEIVED", "PARTIALLY_RECEIVED"}:
        raise HTTPException(
            status_code=400,
            detail=f"Status '{new_status}' is set automatically when a GRN is created. "
                   "You cannot set it manually.",
        )

    allowed = _ALLOWED_MANUAL_TRANSITIONS.get(po.status, set())
    if new_status not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot move a PO from '{po.status}' to '{new_status}'. "
                   f"Allowed transitions: {sorted(allowed) or 'none (terminal state)'}",
        )

    old_status = po.status
    po.status = new_status

    db.add(AuditLog(
        user_id=user_id,
        action="PO_STATUS_CHANGE",
        entity="purchase_orders",
        details=f"PO {po.po_number}: {old_status} → {new_status}",
    ))
    db.flush()
    return po


# ---------------------------------------------------------------------------
# GRN creation — this is where stock actually enters the system
# ---------------------------------------------------------------------------

def create_grn(db: Session, data: GRNCreate, user_id: int) -> GoodsReceiptNote:
    """
    Create a GRN and add stock to the system in one transaction.

    For each item in data.items this function:
      a. Creates a new Batch row (product_id, supplier_id, batch_number,
         mrp, purchase_price, selling_price, mfg_date, expiry_date, qty)
      b. Creates a GRNItem row pointing at the new batch
      c. Writes a StockMovement row (type='IN', reference=grn_number)

    If po_id is supplied, it also re-evaluates and updates the PO status:
      - All items fully received → RECEIVED
      - Some items received     → PARTIALLY_RECEIVED
    """
    supplier = db.query(Supplier).filter(Supplier.id == data.supplier_id).first()
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")

    # Validate PO if provided
    po: Optional[PurchaseOrder] = None
    if data.po_id:
        po = db.query(PurchaseOrder).filter(PurchaseOrder.id == data.po_id).first()
        if not po:
            raise HTTPException(status_code=404, detail="Purchase order not found")
        if po.supplier_id != data.supplier_id:
            raise HTTPException(
                status_code=400,
                detail="Supplier on the GRN does not match the PO's supplier.",
            )
        if po.status == "CANCELLED":
            raise HTTPException(
                status_code=400,
                detail="Cannot receive stock against a cancelled PO.",
            )

    grn_number   = get_next_grn_number(db)
    receipt_date = data.receipt_date or date.today()

    grn = GoodsReceiptNote(
        grn_number=grn_number,
        po_id=data.po_id,
        supplier_id=data.supplier_id,
        user_id=user_id,
        receipt_date=receipt_date,
        invoice_number=data.invoice_number,
        notes=data.notes,
        total_amount=Decimal("0"),
    )
    db.add(grn)
    db.flush()   # assigns grn.id

    total = Decimal("0")

    for item_data in data.items:
        # Step a: create a new batch — this is where the physical stock lives
        new_batch = Batch(
            product_id=item_data.product_id,
            supplier_id=data.supplier_id,
            batch_number=item_data.batch_number,
            mrp=item_data.mrp,
            purchase_price=item_data.purchase_price,
            selling_price=item_data.selling_price,
            mfg_date=item_data.mfg_date,
            expiry_date=item_data.expiry_date,
            quantity_received=item_data.quantity_received,
            quantity_available=item_data.quantity_received,  # starts fully available
        )
        db.add(new_batch)
        db.flush()   # assigns new_batch.id so we can reference it below

        line_total = Decimal(str(item_data.quantity_received)) * item_data.purchase_price

        # Step b: create the GRN item row, linked to the new batch
        grn_item = GRNItem(
            grn_id=grn.id,
            product_id=item_data.product_id,
            batch_id=new_batch.id,
            batch_number=item_data.batch_number,
            quantity_received=item_data.quantity_received,
            purchase_price=item_data.purchase_price,
            selling_price=item_data.selling_price,
            mrp=item_data.mrp,
            expiry_date=item_data.expiry_date,
            mfg_date=item_data.mfg_date,
            line_total=line_total,
        )
        db.add(grn_item)

        # Step c: immutable stock movement row — the audit trail for this stock IN
        db.add(StockMovement(
            batch_id=new_batch.id,
            movement_type="IN",
            quantity=item_data.quantity_received,   # positive = stock arriving
            reference=grn_number,
            user_id=user_id,
        ))

        total += line_total

    grn.total_amount = total
    db.flush()

    # Update PO status if this GRN references a PO
    if po:
        _update_po_after_grn(db, po)

    return grn


def _update_po_after_grn(db: Session, po: PurchaseOrder) -> None:
    """
    After a GRN is created against a PO, recalculate what has been received
    and update the PO status accordingly.

    We count how many units have been received for each PO line across
    all GRNs that reference this PO, then compare to quantity_ordered.
    """
    # Sum all received quantities per product across all GRNs for this PO
    received_rows = db.execute(
        text("""
            SELECT gi.product_id, SUM(gi.quantity_received) AS total_received
            FROM grn_items gi
            JOIN goods_receipt_notes grn ON grn.id = gi.grn_id
            WHERE grn.po_id = :po_id
            GROUP BY gi.product_id
        """),
        {"po_id": po.id},
    ).fetchall()

    received_map = {row.product_id: row.total_received for row in received_rows}

    # Compare each PO line's ordered qty against what has been received
    all_received = True
    any_received = False

    for po_item in po.items:
        received = received_map.get(po_item.product_id, 0)
        if received > 0:
            any_received = True
        if received < po_item.quantity_ordered:
            all_received = False

    if all_received and any_received:
        po.status = "RECEIVED"
    elif any_received:
        po.status = "PARTIALLY_RECEIVED"
    # If nothing was received for this PO yet, leave status unchanged

    db.flush()


# ---------------------------------------------------------------------------
# List helpers
# ---------------------------------------------------------------------------

def get_po_list(
    db: Session,
    page: int = 1,
    limit: int = 20,
    status_filter: Optional[str] = None,
) -> dict:
    """
    Return a paginated list of POs with lightweight summary data.
    Optionally filter by status (e.g. ?status=DRAFT).
    """
    q = db.query(PurchaseOrder)
    if status_filter:
        q = q.filter(PurchaseOrder.status == status_filter)

    total = q.count()
    pos   = q.order_by(PurchaseOrder.created_at.desc()).offset((page - 1) * limit).limit(limit).all()

    items = []
    for po in pos:
        items.append(POListItem(
            id=po.id,
            po_number=po.po_number,
            supplier_name=po.supplier.name,
            status=po.status,
            order_date=po.order_date,
            expected_date=po.expected_date,
            total_amount=po.total_amount,
            item_count=len(po.items),
            created_at=po.created_at,
        ))

    return {"items": items, "total": total, "page": page, "limit": limit}


def get_grn_list(
    db: Session,
    page: int = 1,
    limit: int = 20,
) -> dict:
    """Return a paginated list of GRNs with lightweight summary data."""
    q     = db.query(GoodsReceiptNote)
    total = q.count()
    grns  = q.order_by(GoodsReceiptNote.created_at.desc()).offset((page - 1) * limit).limit(limit).all()

    items = []
    for grn in grns:
        items.append(GRNListItem(
            id=grn.id,
            grn_number=grn.grn_number,
            supplier_name=grn.supplier.name,
            po_number=grn.po.po_number if grn.po else None,
            receipt_date=grn.receipt_date,
            total_amount=grn.total_amount,
            item_count=len(grn.items),
            created_at=grn.created_at,
        ))

    return {"items": items, "total": total, "page": page, "limit": limit}


# ---------------------------------------------------------------------------
# Detail helpers
# ---------------------------------------------------------------------------

def build_po_out(po: PurchaseOrder) -> POOut:
    """Convert a PurchaseOrder ORM object to the POOut response schema."""
    return POOut(
        id=po.id,
        po_number=po.po_number,
        supplier_id=po.supplier_id,
        supplier_name=po.supplier.name,
        status=po.status,
        order_date=po.order_date,
        expected_date=po.expected_date,
        notes=po.notes,
        total_amount=po.total_amount,
        items=[
            POItemOut(
                id=item.id,
                product_id=item.product_id,
                product_name=item.product.name,
                quantity_ordered=item.quantity_ordered,
                unit_price=item.unit_price,
                line_total=item.line_total,
            )
            for item in po.items
        ],
        created_at=po.created_at,
    )


def build_grn_out(grn: GoodsReceiptNote) -> GRNOut:
    """Convert a GoodsReceiptNote ORM object to the GRNOut response schema."""
    return GRNOut(
        id=grn.id,
        grn_number=grn.grn_number,
        supplier_id=grn.supplier_id,
        supplier_name=grn.supplier.name,
        po_id=grn.po_id,
        po_number=grn.po.po_number if grn.po else None,
        receipt_date=grn.receipt_date,
        invoice_number=grn.invoice_number,
        notes=grn.notes,
        total_amount=grn.total_amount,
        items=[
            GRNItemOut(
                id=item.id,
                product_id=item.product_id,
                product_name=item.product.name,
                batch_id=item.batch_id,
                batch_number=item.batch_number,
                quantity_received=item.quantity_received,
                purchase_price=item.purchase_price,
                selling_price=item.selling_price,
                mrp=item.mrp,
                expiry_date=item.expiry_date,
                mfg_date=item.mfg_date,
                line_total=item.line_total,
            )
            for item in grn.items
        ],
        created_at=grn.created_at,
    )
