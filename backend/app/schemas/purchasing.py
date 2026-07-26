"""
Pydantic schemas for the Purchasing module (Phase 2).

"Create" schemas define what the frontend sends.
"Out" schemas define what the backend returns.
All money fields use Decimal (never float) — a hard rule from CLAUDE.md.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Purchase Order Item schemas
# ---------------------------------------------------------------------------

class POItemCreate(BaseModel):
    """One product line when creating a PO."""
    product_id:       int
    quantity_ordered: int     = Field(..., gt=0, description="Must order at least 1 unit")
    unit_price:       Decimal = Field(..., gt=0, description="Expected purchase price per unit")


class POItemOut(BaseModel):
    """One product line returned inside a PO response."""
    id:               int
    product_id:       int
    product_name:     str     # resolved from the Product relationship
    quantity_ordered: int
    unit_price:       Decimal
    line_total:       Decimal

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Purchase Order schemas
# ---------------------------------------------------------------------------

class POCreate(BaseModel):
    """Data sent when creating a new PO."""
    supplier_id:   int
    expected_date: Optional[date]  = None
    notes:         Optional[str]   = None
    items:         list[POItemCreate] = Field(..., min_length=1, description="At least one item required")


class POUpdate(BaseModel):
    """
    Partial update for a PO.  Only the fields included will be changed.
    Status changes go through PATCH /orders/{id}/status (its own endpoint).
    """
    status:        Optional[str]  = None
    expected_date: Optional[date] = None
    notes:         Optional[str]  = None


class POStatusUpdate(BaseModel):
    """Body sent to PATCH /orders/{id}/status."""
    status: str = Field(..., description="New status: SENT or CANCELLED")


class POOut(BaseModel):
    """Full PO returned to the frontend."""
    id:            int
    po_number:     str
    supplier_id:   int
    supplier_name: str            # resolved from the Supplier relationship
    status:        str
    order_date:    date
    expected_date: Optional[date]
    notes:         Optional[str]
    total_amount:  Decimal
    items:         list[POItemOut]
    created_at:    datetime

    model_config = {"from_attributes": True}


class POListItem(BaseModel):
    """Lighter PO summary used in the paginated list (no items array)."""
    id:            int
    po_number:     str
    supplier_name: str
    status:        str
    order_date:    date
    expected_date: Optional[date]
    total_amount:  Decimal
    item_count:    int            # computed in service layer
    created_at:    datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# GRN Item schemas
# ---------------------------------------------------------------------------

class GRNItemCreate(BaseModel):
    """One product/batch line when creating a GRN."""
    product_id:        int
    quantity_received: int            = Field(..., gt=0)
    purchase_price:    Decimal        = Field(..., gt=0)
    selling_price:     Decimal        = Field(..., gt=0)
    mrp:               Decimal        = Field(..., gt=0)
    expiry_date:       date
    mfg_date:          Optional[date] = None
    batch_number:      Optional[str]  = None


class GRNItemOut(BaseModel):
    """One GRN item line returned to the frontend."""
    id:                int
    product_id:        int
    product_name:      str          # from the Product relationship
    batch_id:          Optional[int]
    batch_number:      Optional[str]
    quantity_received: int
    purchase_price:    Decimal
    selling_price:     Decimal
    mrp:               Decimal
    expiry_date:       date
    mfg_date:          Optional[date]
    line_total:        Decimal

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# GRN schemas
# ---------------------------------------------------------------------------

class GRNCreate(BaseModel):
    """Data sent when creating a GRN (stock receiving event)."""
    supplier_id:    int
    po_id:          Optional[int]  = None   # leave empty for walk-in purchases
    receipt_date:   Optional[date] = None   # defaults to today on the server
    invoice_number: Optional[str]  = None   # supplier's own invoice reference
    notes:          Optional[str]  = None
    items:          list[GRNItemCreate] = Field(..., min_length=1)


class GRNOut(BaseModel):
    """Full GRN returned to the frontend."""
    id:             int
    grn_number:     str
    supplier_id:    int
    supplier_name:  str
    po_id:          Optional[int]
    po_number:      Optional[str]   # None when GRN has no PO
    receipt_date:   date
    invoice_number: Optional[str]
    notes:          Optional[str]
    total_amount:   Decimal
    items:          list[GRNItemOut]
    created_at:     datetime

    model_config = {"from_attributes": True}


class GRNListItem(BaseModel):
    """Lighter GRN summary for the paginated list."""
    id:             int
    grn_number:     str
    supplier_name:  str
    po_number:      Optional[str]
    receipt_date:   date
    total_amount:   Decimal
    item_count:     int
    created_at:     datetime

    model_config = {"from_attributes": True}
