"""
Purchasing API endpoints — Phase 2.

All routes require authentication.  Prefix: /api/purchasing

Purchase Orders:
  GET    /orders              — list POs (status filter, paginated)
  POST   /orders              — create a new PO
  GET    /orders/{id}         — PO detail with all items
  PATCH  /orders/{id}/status  — update PO status only

Goods Receipt Notes:
  GET    /grn                 — list GRNs (paginated)
  POST   /grn                 — create GRN (triggers stock IN, creates batches)
  GET    /grn/{id}            — GRN detail with all items
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.purchasing import GoodsReceiptNote, PurchaseOrder
from app.models.user import User
from app.schemas.purchasing import (
    GRNCreate, GRNOut,
    POCreate, POOut, POStatusUpdate,
)
from app.services.auth_service import get_current_user
from app.services.purchasing_service import (
    build_grn_out, build_po_out,
    create_grn, create_po,
    get_grn_list, get_po_list,
    update_po_status,
)

router = APIRouter(prefix="/purchasing", tags=["Purchasing"])


# ---------------------------------------------------------------------------
# PURCHASE ORDERS
# ---------------------------------------------------------------------------

@router.get("/orders")
def list_purchase_orders(
    page:   int           = Query(1, ge=1),
    limit:  int           = Query(20, ge=1, le=100),
    status: Optional[str] = Query(None, description="Filter: DRAFT, SENT, PARTIALLY_RECEIVED, RECEIVED, CANCELLED"),
    db:     Session       = Depends(get_db),
    _user:  User          = Depends(get_current_user),
):
    """Return a paginated list of purchase orders, newest first."""
    return get_po_list(db, page=page, limit=limit, status_filter=status)


@router.post("/orders", response_model=POOut, status_code=201)
def create_purchase_order(
    body:  POCreate,
    db:    Session = Depends(get_db),
    user:  User    = Depends(get_current_user),
):
    """
    Create a new PO in DRAFT status.  At least one item is required.
    This does NOT affect stock — it is just a document.
    """
    po = create_po(db, body, user_id=user.id)
    db.commit()
    db.refresh(po)
    return build_po_out(po)


@router.get("/orders/{po_id}", response_model=POOut)
def get_purchase_order(
    po_id: int,
    db:    Session = Depends(get_db),
    _user: User    = Depends(get_current_user),
):
    """Return full PO detail including all line items."""
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == po_id).first()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    return build_po_out(po)


@router.patch("/orders/{po_id}/status", response_model=POOut)
def patch_po_status(
    po_id: int,
    body:  POStatusUpdate,
    db:    Session = Depends(get_db),
    user:  User    = Depends(get_current_user),
):
    """
    Manually change a PO's status.

    Allowed manual transitions (from UI):
      DRAFT → SENT or CANCELLED
      SENT  → CANCELLED
      PARTIALLY_RECEIVED → CANCELLED

    RECEIVED and PARTIALLY_RECEIVED are set automatically when GRNs are created.
    """
    po = update_po_status(db, po_id=po_id, new_status=body.status, user_id=user.id)
    db.commit()
    db.refresh(po)
    return build_po_out(po)


# ---------------------------------------------------------------------------
# GOODS RECEIPT NOTES
# ---------------------------------------------------------------------------

@router.get("/grn")
def list_grns(
    page:  int     = Query(1, ge=1),
    limit: int     = Query(20, ge=1, le=100),
    db:    Session = Depends(get_db),
    _user: User    = Depends(get_current_user),
):
    """Return a paginated list of GRNs, newest first."""
    return get_grn_list(db, page=page, limit=limit)


@router.post("/grn", response_model=GRNOut, status_code=201)
def create_goods_receipt_note(
    body: GRNCreate,
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_user),
):
    """
    Record stock arriving at the pharmacy.

    This is the ONLY way new stock enters the system going forward.
    For each item this endpoint:
      1. Creates a new Batch row (expiry date, prices, qty)
      2. Creates a GRNItem row linked to that batch
      3. Writes a StockMovement row (type='IN')

    If po_id is supplied, the referenced PO's status is updated automatically.
    """
    grn = create_grn(db, body, user_id=user.id)
    db.commit()
    db.refresh(grn)
    return build_grn_out(grn)


@router.get("/grn/{grn_id}", response_model=GRNOut)
def get_grn(
    grn_id: int,
    db:     Session = Depends(get_db),
    _user:  User    = Depends(get_current_user),
):
    """Return full GRN detail including all items and batch info."""
    grn = db.query(GoodsReceiptNote).filter(GoodsReceiptNote.id == grn_id).first()
    if not grn:
        raise HTTPException(status_code=404, detail="GRN not found")
    return build_grn_out(grn)
