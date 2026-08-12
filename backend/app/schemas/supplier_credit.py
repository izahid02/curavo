"""
Pydantic schemas for the supplier credit module.

These define the exact shape of every request and response for
/api/supplier-credit/*.  Routers never return raw SQLAlchemy objects — they
always pass through one of these models.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Shared row shapes
# ---------------------------------------------------------------------------

class DueRow(BaseModel):
    """One upcoming or overdue supplier payment."""
    supplier_id:    int
    supplier_name:  str
    credit_tx_id:   int
    amount_due:     Decimal
    due_date:       Optional[date] = None
    # Negative when the payment is late — the frontend keys its red styling
    # off the sign rather than needing a separate flag.
    days_until_due: Optional[int] = None


class SupplierCreditRow(BaseModel):
    """One supplier in the Credit Management table."""
    supplier_id:    int
    supplier_name:  str
    supplier_phone: Optional[str] = None
    outstanding:    Decimal
    advance:        Decimal
    total_credit:   Decimal
    total_paid:     Decimal
    next_due_date:  Optional[date] = None
    days_until_due: Optional[int] = None
    status:         str            # PENDING / DUE_SOON / OVERDUE / ADVANCE
    last_activity:  Optional[datetime] = None


# ---------------------------------------------------------------------------
# GET /summary
# ---------------------------------------------------------------------------

class SupplierCreditSummary(BaseModel):
    """Totals + due lists for the summary cards and dashboard widget."""
    total_outstanding:           Decimal
    total_advance:               Decimal
    total_overdue:               Decimal
    total_suppliers_with_credit: int
    upcoming_dues:               list[DueRow]
    overdue:                     list[DueRow]


class DueSoonResponse(BaseModel):
    """GET /due-soon — next 7 days plus everything already late."""
    total_outstanding: Decimal
    upcoming:          list[DueRow]
    overdue:           list[DueRow]


# ---------------------------------------------------------------------------
# GET /supplier/{id}
# ---------------------------------------------------------------------------

class SupplierBrief(BaseModel):
    id:             int
    name:           str
    phone:          Optional[str] = None
    contact_person: Optional[str] = None
    gst_number:     Optional[str] = None
    dl_number:      Optional[str] = None


class AccountBrief(BaseModel):
    outstanding:     Decimal
    advance_balance: Decimal
    total_credit:    Decimal
    total_paid:      Decimal
    last_activity:   Optional[datetime] = None


class SupplierCreditTxOut(BaseModel):
    """One line in a supplier's credit ledger."""
    id:                int
    type:              str            # CREDIT / PAYMENT / RETURN_ADJUSTMENT / ADVANCE
    amount:            Decimal
    paid_amount:       Decimal
    balance:           Decimal
    due_date:          Optional[date] = None
    status:            str
    payment_mode:      Optional[str] = None
    stock_purchase_id: Optional[int] = None
    invoice_number:    Optional[str] = None
    notes:             Optional[str] = None
    created_at:        Optional[datetime] = None


class SupplierLedgerOut(BaseModel):
    supplier:     SupplierBrief
    account:      AccountBrief
    transactions: list[SupplierCreditTxOut]


# ---------------------------------------------------------------------------
# POST /payment
# ---------------------------------------------------------------------------

class SupplierPaymentRequest(BaseModel):
    """Body for recording a payment to a supplier."""
    supplier_id:  int
    amount:       Decimal = Field(..., gt=0, description="Rupees paid — must be positive")
    payment_mode: Literal["CASH", "UPI"] = "CASH"
    notes:        Optional[str] = None
    # Optional — settle one specific invoice first instead of pure FIFO.
    credit_tx_id: Optional[int] = None


class SupplierPaymentResponse(BaseModel):
    """What the pay-supplier modal shows after a successful payment."""
    success:         bool = True
    payment_tx_id:   int
    amount:          Decimal
    applied_to_debt: Decimal
    advance_created: Decimal
    outstanding:     Decimal
    advance_balance: Decimal
    message:         str
