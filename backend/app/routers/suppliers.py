"""
Suppliers API endpoints.

GET    /api/suppliers/       — list all suppliers (with optional name search)
POST   /api/suppliers/       — create a new supplier
GET    /api/suppliers/{id}   — get one supplier by ID
PUT    /api/suppliers/{id}   — update a supplier's details
DELETE /api/suppliers/{id}   — delete a supplier (blocked if batches exist)

All endpoints require a valid login token.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.inventory import Batch, Supplier
from app.models.user import User
from app.schemas.suppliers import SupplierCreate, SupplierOut, SupplierUpdate
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/suppliers", tags=["Suppliers"])


# ---------------------------------------------------------------------------
# Helper — attach batch_count to a Supplier ORM object
# ---------------------------------------------------------------------------

def _with_count(supplier: Supplier, db: Session) -> SupplierOut:
    """
    Build a SupplierOut response that includes how many batches reference
    this supplier.  We need this to warn the user before they try to delete
    a supplier that has purchase history.
    """
    count = (
        db.query(func.count(Batch.id))
        .filter(Batch.supplier_id == supplier.id)
        .scalar()
        or 0
    )
    out = SupplierOut.model_validate(supplier)
    out.batch_count = count
    return out


# ---------------------------------------------------------------------------
# LIST
# ---------------------------------------------------------------------------

@router.get("/", response_model=List[SupplierOut])
def list_suppliers(
    search: Optional[str] = Query(None, description="Filter by supplier name"),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """
    Return all suppliers, newest first.
    Pass ?search=<text> to filter by name (case-insensitive contains match).
    """
    q = db.query(Supplier)
    if search:
        q = q.filter(Supplier.name.ilike(f"%{search}%"))
    suppliers = q.order_by(Supplier.name).all()
    return [_with_count(s, db) for s in suppliers]


# ---------------------------------------------------------------------------
# CREATE
# ---------------------------------------------------------------------------

@router.post("/", response_model=SupplierOut, status_code=status.HTTP_201_CREATED)
def create_supplier(
    body: SupplierCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """
    Add a new supplier.  Name is required; all other fields are optional.
    Duplicate names are allowed (same distributor can have multiple entries
    for different branches/contacts).
    """
    supplier = Supplier(
        name=body.name,
        contact_person=body.contact_person,
        phone=body.phone,
        address=body.address,
        gst_number=body.gst_number,
    )
    db.add(supplier)
    db.commit()
    db.refresh(supplier)
    return _with_count(supplier, db)


# ---------------------------------------------------------------------------
# GET ONE
# ---------------------------------------------------------------------------

@router.get("/{supplier_id}", response_model=SupplierOut)
def get_supplier(
    supplier_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Return one supplier by ID, or 404 if not found."""
    supplier = db.query(Supplier).filter(Supplier.id == supplier_id).first()
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")
    return _with_count(supplier, db)


# ---------------------------------------------------------------------------
# UPDATE
# ---------------------------------------------------------------------------

@router.put("/{supplier_id}", response_model=SupplierOut)
def update_supplier(
    supplier_id: int,
    body: SupplierUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """
    Update any combination of fields on a supplier.
    Only the fields you send are changed; omitted fields stay as they are.
    """
    supplier = db.query(Supplier).filter(Supplier.id == supplier_id).first()
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")

    # model_dump(exclude_unset=True) gives us only the fields the caller sent,
    # so we don't accidentally overwrite fields with None.
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(supplier, field, value)

    db.commit()
    db.refresh(supplier)
    return _with_count(supplier, db)


# ---------------------------------------------------------------------------
# DELETE
# ---------------------------------------------------------------------------

@router.delete("/{supplier_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_supplier(
    supplier_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """
    Delete a supplier permanently.

    This will FAIL (HTTP 409) if any stock batches reference this supplier —
    deleting it would break the purchase history and audit trail.
    The UI shows the batch count before offering Delete so users are warned.
    """
    supplier = db.query(Supplier).filter(Supplier.id == supplier_id).first()
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")

    batch_count = (
        db.query(func.count(Batch.id))
        .filter(Batch.supplier_id == supplier_id)
        .scalar()
        or 0
    )
    if batch_count > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Cannot delete: {batch_count} stock batch(es) are linked to this supplier. "
                "Remove the batches first, or keep this supplier for historical accuracy."
            ),
        )

    db.delete(supplier)
    db.commit()
