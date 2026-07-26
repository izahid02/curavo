"""
Pydantic schemas for the Billing module.

Pydantic validates every incoming request automatically:
  - BillItem / CreateInvoiceRequest  — what the frontend sends to create a bill
  - ReturnRequest                    — what the frontend sends to return an invoice
  - InvoiceItemOut / InvoiceOut      — what the server sends back as a receipt/detail
  - InvoiceListItem / InvoiceListResponse — lightweight list for the history table
  - BillingProductOut                — product + price for the billing search dropdown

RULE: all money fields are Decimal, never float.
Float arithmetic is imprecise (0.1 + 0.2 ≠ 0.3).  Decimal is exact.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Incoming request schemas
# ---------------------------------------------------------------------------

class BillItem(BaseModel):
    """
    One line in the cashier's bill — just the product and how many units.
    The server looks up the price from the FEFO batch automatically.
    We do NOT accept a price from the frontend to prevent price manipulation.
    """
    product_id: int
    quantity:   int = Field(..., gt=0, description="Must be at least 1")


class CreateInvoiceRequest(BaseModel):
    """
    The full bill the frontend sends to create an invoice.
    items must contain at least one product.
    discount_amount is optional (defaults to 0 — no discount).
    patient_id is optional — walk-in customers leave it null.

    For CREDIT payment mode:
      amount_paid   = how much was paid today (can be 0 for full credit)
      credit_due_date = when the remaining balance is due
    """
    items:            list[BillItem] = Field(..., min_length=1, description="At least 1 item required")
    patient_id:       Optional[int]  = None
    payment_method:   str            = Field(default="CASH", pattern="^(CASH|UPI|CARD|CREDIT)$")
    discount_amount:  Decimal        = Field(default=Decimal("0"), ge=0)
    referred_by:      Optional[str]  = None   # doctor/referrer name for this invoice
    # Credit-specific fields (only used when payment_method == 'CREDIT')
    amount_paid:      Decimal        = Field(default=Decimal("0"), ge=0)
    credit_due_date:  Optional[date] = None
    # --- Home visit / drip administration charge (Feature 4) ----------------
    # A flat SERVICE fee for administering a drip or injection at the patient's
    # home.  Deliberately NOT a line item: it has no batch, no stock movement,
    # and attracts NO GST (it is a service, not a medicine).
    home_visit_charge: Decimal        = Field(default=Decimal("0"), ge=0)
    home_visit_notes:  Optional[str]  = None


class ReturnRequest(BaseModel):
    """Optional reason for returning an invoice (captured for the audit log)."""
    reason: Optional[str] = None


# ---------------------------------------------------------------------------
# Outgoing response schemas
# ---------------------------------------------------------------------------

class InvoiceItemOut(BaseModel):
    """
    One line on a receipt.  Note that taxable_amount and gst_amount are
    computed fields — they are derived from stored data, not stored separately,
    but we compute them here so the frontend doesn't have to.
    """
    product_name:   str
    batch_number:   Optional[str]
    quantity:       int
    unit_price:     Decimal
    purchase_price: Decimal   # snapshot — used for profit calculation
    gst_rate:       Decimal
    taxable_amount: Decimal   # qty × unit_price  (before tax)
    gst_amount:     Decimal   # taxable_amount × gst_rate / 100
    line_total:     Decimal   # taxable_amount + gst_amount  (what customer pays for this line)


class InvoiceOut(BaseModel):
    """
    Full invoice detail — shown on the receipt modal and the history detail view.
    patient_name is "Walk-in Customer" when no patient was linked.
    """
    # The database row id.  Needed by the billing screen so that, right after a
    # sale, it can link an uploaded prescription to THIS invoice
    # (POST /prescriptions/upload with invoice_id). Optional so older callers
    # that build InvoiceOut without it (e.g. purchase history) stay valid.
    id:              Optional[int] = None
    invoice_number:  str
    invoice_date:    datetime
    patient_name:    str
    items:           list[InvoiceItemOut]
    subtotal:        Decimal   # sum of all taxable_amounts
    discount_amount: Decimal
    gst_amount:      Decimal   # sum of all per-line gst_amounts
    # subtotal + gst_amount + home_visit_charge - discount
    total_amount:    Decimal
    payment_method:  Optional[str]
    status:          str       # 'COMPLETED' or 'RETURNED'
    referred_by:     Optional[str] = None
    amount_paid:     Optional[Decimal] = None
    credit_amount:   Optional[Decimal] = None
    credit_due_date: Optional[date]    = None
    # --- Home visit charge (Feature 4) --------------------------------------
    # Shown as its own line on the receipt, clearly marked as a service charge.
    home_visit_charge: Optional[Decimal] = Decimal("0")
    home_visit_notes:  Optional[str]     = None

    model_config = {"from_attributes": True}


class InvoiceListItem(BaseModel):
    """
    Lightweight row for the Invoice History table.
    Does NOT include the full items list — that is fetched on demand
    when the user clicks a row to open the detail view.
    """
    invoice_number:  str
    invoice_date:    datetime
    patient_name:    str
    item_count:      int      # how many invoice_items rows (may span multiple batches)
    total_amount:    Decimal
    payment_method:  Optional[str]
    status:          str


class InvoiceListResponse(BaseModel):
    """Paginated list of invoice headers."""
    items: list[InvoiceListItem]
    total: int
    page:  int
    limit: int


# ---------------------------------------------------------------------------
# Product search for the billing screen
# ---------------------------------------------------------------------------

class BillingProductOut(BaseModel):
    """
    Product + current FEFO price, returned by the billing search endpoint.
    Only products with sellable stock (non-expired qty > 0) appear here.
    selling_price is taken from the batch that would be consumed first (FEFO order).
    """
    product_id:    int
    name:          str
    generic_name:  Optional[str]
    barcode:       Optional[str]
    gst_rate:      Decimal
    current_stock: int
    selling_price: Decimal
    unit:          Optional[str]


class PatientSearchOut(BaseModel):
    """Minimal patient info for the billing screen's optional patient-link search."""
    id:     int
    name:   str
    mobile: Optional[str]


# ---------------------------------------------------------------------------
# Home visit / drip administration charge settings (Feature 4)
# ---------------------------------------------------------------------------

class HomeVisitChargeOut(BaseModel):
    """The configured default charge, read by the billing screen on load."""
    id:             int
    name:           str
    default_amount: Decimal
    is_active:      bool

    model_config = {"from_attributes": True}


class HomeVisitChargeUpdate(BaseModel):
    """Owner/Admin-only update of the default amount."""
    default_amount: Decimal = Field(..., ge=0, description="New default fee in rupees")
    name:           Optional[str]  = None
    is_active:      Optional[bool] = None
