"""
Pydantic schemas for the Suppliers module.

These define the shape of data coming IN (from the frontend) and going OUT
(returned to the frontend).  We never expose raw SQLAlchemy model objects —
always convert to one of these schemas first.
"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class SupplierCreate(BaseModel):
    """Fields required/allowed when creating a new supplier."""
    name: str                           # required — every supplier must have a name
    contact_person: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    gst_number: Optional[str] = None   # GSTIN — 15-char alphanumeric (validation optional for now)
    # Drug Licence number — the licence that lets this distributor sell
    # medicines.  Free text: formats vary by state, so we do not validate it.
    dl_number: Optional[str] = None


class SupplierUpdate(BaseModel):
    """All fields are optional on update — only send what changed."""
    name: Optional[str] = None
    contact_person: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    gst_number: Optional[str] = None
    dl_number: Optional[str] = None


class SupplierOut(BaseModel):
    """Full supplier record returned to the frontend."""
    id: int
    name: str
    contact_person: Optional[str]
    phone: Optional[str]
    address: Optional[str]
    gst_number: Optional[str]
    dl_number: Optional[str] = None
    created_at: datetime
    # How many stock batches reference this supplier.
    # Useful for the UI to warn before deleting a supplier that has history.
    batch_count: int = 0

    model_config = {"from_attributes": True}
