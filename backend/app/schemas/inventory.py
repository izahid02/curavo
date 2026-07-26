"""
Pydantic schemas for the Inventory module.

Pydantic models define the exact shape of data flowing in (HTTP requests)
and out (HTTP responses).  FastAPI validates incoming JSON against these
automatically and rejects requests that don't match — so we never need
manual input validation in the route functions.

KEY RULE (from CLAUDE.md): money fields use Decimal, NEVER float.
Float arithmetic is imprecise — 0.1 + 0.2 ≠ 0.3 in floating point.
Decimal arithmetic is exact, which matters for financial calculations.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


# ---------------------------------------------------------------------------
# Strip / unit medicine management (Feature 3)
# ---------------------------------------------------------------------------

# The dosage forms the Add Medicine form offers as pill-style toggles.
MedicineType = Literal[
    "TABLET", "CAPSULE", "SYRUP", "INJECTION", "DROPS",
    "CREAM", "OINTMENT", "POWDER", "INHALER", "SUPPOSITORY", "OTHER",
]

# Only these two forms are ever packaged in strips.  Everything else (a syrup
# bottle, a tube of cream) is sold as a single item.
STRIP_CAPABLE_TYPES = {"TABLET", "CAPSULE"}


def _normalise_strip_fields(model):
    """
    Shared strip-field cleanup used by both ProductCreate and ProductUpdate.

    Rules enforced here, in one place, so the create and edit paths can never
    disagree:
      - A non-strip-capable medicine type cannot be a strip medicine.
      - is_strip=False clears units_per_strip / strip_mrp / unit_mrp.
      - unit_mrp is derived from strip_mrp / units_per_strip ONLY when the
        caller left it blank — a value the pharmacist typed always wins.
    """
    medicine_type = getattr(model, "medicine_type", None)

    # A syrup or injection can never be a strip medicine.
    if medicine_type is not None and medicine_type not in STRIP_CAPABLE_TYPES:
        model.is_strip = False

    if getattr(model, "is_strip", False) is False:
        # Not a strip medicine — make sure no stale strip pricing lingers.
        # (Only clear on create/full-update; a partial update leaves None as
        # "don't change" and is handled by the router's exclude_unset.)
        if medicine_type is not None and medicine_type not in STRIP_CAPABLE_TYPES:
            model.units_per_strip = None
            model.strip_mrp       = None
            model.unit_mrp        = None
        return model

    # Strip medicine: derive the per-tablet price when it was not supplied.
    if (
        getattr(model, "unit_mrp", None) is None
        and getattr(model, "strip_mrp", None) is not None
        and getattr(model, "units_per_strip", None)
    ):
        model.unit_mrp = (
            Decimal(str(model.strip_mrp)) / Decimal(str(model.units_per_strip))
        ).quantize(Decimal("0.01"))

    return model


# ---------------------------------------------------------------------------
# Category & Department — simple lookup tables, only an "out" schema needed
# ---------------------------------------------------------------------------

class CategoryOut(BaseModel):
    id:   int
    name: str

    model_config = {"from_attributes": True}


class DepartmentOut(BaseModel):
    id:   int
    name: str

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------

class ProductCreate(BaseModel):
    """
    Data the frontend sends when creating a new product.
    Fields marked with * in the UI are required (no default here).
    """
    name:            str     = Field(..., min_length=1, max_length=150)
    generic_name:    Optional[str]  = None
    brand:           Optional[str]  = None
    manufacturer:    Optional[str]  = None
    category_id:     Optional[int]  = None
    department_id:   Optional[int]  = None
    hsn_code:        Optional[str]  = None
    # gst_rate defaults to 12% (most common rate in India for pharma)
    gst_rate:        Decimal = Field(default=Decimal("12"), ge=0, le=100)
    barcode:         Optional[str]  = None
    rack_location:   Optional[str]  = None
    unit:            Optional[str]  = "unit"
    min_stock_level: int     = Field(default=10, ge=0)

    # --- Strip / unit fields (Feature 3) ------------------------------------
    medicine_type:   MedicineType      = "TABLET"
    is_strip:        bool              = False
    units_per_strip: Optional[int]     = Field(default=None, gt=0)
    strip_mrp:       Optional[Decimal] = Field(default=None, ge=0)
    unit_mrp:        Optional[Decimal] = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _resolve_strip_pricing(self):
        """
        Keep the strip fields internally consistent.

        Two jobs:
          1. Only tablets and capsules can come in strips.  If someone marks a
             syrup as a strip medicine, quietly clear the strip fields rather
             than storing nonsense that the billing screen would then have to
             defend against.
          2. Auto-derive unit_mrp = strip_mrp / units_per_strip when the user
             did not type one — but NEVER overwrite a value they did type,
             because loose tablets are often priced above the per-strip rate.
        """
        return _normalise_strip_fields(self)


class ProductUpdate(BaseModel):
    """
    For updating a product.  ALL fields are optional — only send the ones
    you want to change.  This is the standard "PATCH" pattern.
    """
    name:            Optional[str]     = None
    generic_name:    Optional[str]     = None
    brand:           Optional[str]     = None
    manufacturer:    Optional[str]     = None
    category_id:     Optional[int]     = None
    department_id:   Optional[int]     = None
    hsn_code:        Optional[str]     = None
    gst_rate:        Optional[Decimal] = None
    barcode:         Optional[str]     = None
    rack_location:   Optional[str]     = None
    unit:            Optional[str]     = None
    min_stock_level: Optional[int]     = None
    is_active:       Optional[bool]    = None

    # --- Strip / unit fields (Feature 3) ------------------------------------
    medicine_type:   Optional[MedicineType] = None
    is_strip:        Optional[bool]         = None
    units_per_strip: Optional[int]          = Field(default=None, gt=0)
    strip_mrp:       Optional[Decimal]      = Field(default=None, ge=0)
    unit_mrp:        Optional[Decimal]      = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _resolve_strip_pricing(self):
        """
        Same consistency rules as ProductCreate — see _normalise_strip_fields.

        On this partial-update schema, a None field means "leave unchanged",
        so the derivation only kicks in when the caller actually sent enough
        information to compute a unit price.
        """
        return _normalise_strip_fields(self)


class ProductListItem(BaseModel):
    """
    Lightweight product data for the product list/search table.
    Only the columns the table actually shows — keeps API responses fast
    by not fetching batch data for every row.
    current_stock is computed by the service layer (SUM of batch quantities).
    """
    id:              int
    name:            str
    generic_name:    Optional[str]
    barcode:         Optional[str]
    current_stock:   int       # computed — NOT stored on the products table
    min_stock_level: int
    gst_rate:        Decimal
    is_active:       bool

    # Strip fields so the medicines table can show "15 strips (150 units)"
    medicine_type:   Optional[str]     = "TABLET"
    is_strip:        bool              = False
    units_per_strip: Optional[int]     = None
    strip_mrp:       Optional[Decimal] = None
    unit_mrp:        Optional[Decimal] = None

    model_config = {"from_attributes": True}


class ProductOut(BaseModel):
    """
    Full product detail used on the product detail panel.
    Includes category_name and department_name (joined from lookup tables)
    and current_stock (computed across batches).
    """
    id:              int
    name:            str
    generic_name:    Optional[str]
    brand:           Optional[str]
    manufacturer:    Optional[str]
    category_id:     Optional[int]
    category_name:   Optional[str]   # resolved by _build_product_out() in the router
    department_id:   Optional[int]
    department_name: Optional[str]   # resolved by _build_product_out() in the router
    hsn_code:        Optional[str]
    gst_rate:        Decimal
    barcode:         Optional[str]
    rack_location:   Optional[str]
    unit:            Optional[str]
    min_stock_level: int
    is_active:       bool
    current_stock:   int             # SUM(batch.quantity_available) for non-expired batches
    created_at:      datetime

    # --- Strip / unit fields (Feature 3) ------------------------------------
    medicine_type:   Optional[str]     = "TABLET"
    is_strip:        bool              = False
    units_per_strip: Optional[int]     = None
    strip_mrp:       Optional[Decimal] = None
    unit_mrp:        Optional[Decimal] = None
    # Derived from current_stock — how the stock reads in strip terms.
    # available_strips is a WHOLE number: 155 tablets at 10 per strip is
    # "15 strips + 5 loose", not "15.5 strips".
    available_strips: Optional[int]    = None
    available_units:  Optional[int]    = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Batches
# ---------------------------------------------------------------------------

class BatchReceive(BaseModel):
    """
    Data the frontend sends when recording a new stock delivery.
    This creates one Batch row + one StockMovement row (IN).
    """
    product_id:        int
    batch_number:      Optional[str]    = None
    mrp:               Decimal          = Field(..., gt=0, description="Max retail price printed on the package")
    purchase_price:    Decimal          = Field(..., gt=0, description="What we paid per unit")
    selling_price:     Decimal          = Field(..., gt=0, description="What we charge per unit")
    mfg_date:          Optional[date]   = None
    expiry_date:       date
    quantity_received: int              = Field(..., gt=0)
    supplier_id:       Optional[int]    = None


class BatchOut(BaseModel):
    """
    Batch detail returned to the frontend, plus two computed fields:
      days_to_expiry: how many days until expiry (negative if already expired)
      expiry_status:  one of OK / WARN_90 / WARN_60 / WARN_30 / WARN_7 / EXPIRED
    """
    id:                 int
    product_id:         int
    product_name:       str          # from the related Product row
    supplier_id:        Optional[int]
    batch_number:       Optional[str]
    mrp:                Decimal
    purchase_price:     Decimal
    selling_price:      Decimal
    mfg_date:           Optional[date]
    expiry_date:        date
    quantity_received:  int
    quantity_available: int
    days_to_expiry:     int          # (expiry_date - today).days
    expiry_status:      str          # OK / WARN_90 / WARN_60 / WARN_30 / WARN_7 / EXPIRED
    created_at:         datetime
    # --- Bonus / scheme purchase (Feature B) --------------------------------
    # Shown as a small badge in the batch-breakdown popover when set.
    scheme_label:       Optional[str] = None
    bonus_quantity:     int = 0

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Add Stock (unified Medicines page flow)
# ---------------------------------------------------------------------------

class AddStockRequest(BaseModel):
    """
    Data the Add Stock panel sends to POST /api/inventory/add-stock.

    This is the SIMPLIFIED stock-in used by the unified Medicines page.
    It creates one Batch + one StockMovement(IN) + one StockPurchase record.

    expiry_date arrives as a "YYYY-MM" string (month/year picker), because a
    medicine pack prints only the month it expires, not a specific day.
    """
    product_id:              int
    supplier_id:             int
    supplier_invoice_number: str = Field(..., min_length=1, max_length=80)
    supplier_invoice_date:   date
    batch_number:            str = Field(..., min_length=1, max_length=60)
    quantity:                int = Field(..., gt=0, description="Units received — must be positive")
    # "YYYY-MM" (e.g. "2026-12"). Validated/parsed to the last day of the month
    # in the service layer so the medicine stays sellable through that month.
    expiry_date:             str = Field(..., pattern=r"^\d{4}-\d{2}$", description="Expiry month as YYYY-MM")
    mrp:                     Decimal = Field(..., gt=0, description="Max retail price printed on the pack")
    # Optional — only recorded when the pharmacist knows what we paid.
    cost_price:              Optional[Decimal] = Field(default=None, ge=0)

    # --- Strip pricing (Feature 3) ------------------------------------------
    # Price of a WHOLE strip and of ONE unit.  Sent only for strip medicines so
    # the product's cached strip_mrp/unit_mrp can be refreshed with the latest
    # delivery's prices.  The per-unit `mrp` above is still what the batch stores
    # and what billing uses; these two are display/reference prices on the
    # product record.  Ignored (left as-is) for non-strip medicines.
    strip_mrp:               Optional[Decimal] = Field(default=None, ge=0)
    unit_mrp:                Optional[Decimal] = Field(default=None, ge=0)

    # --- Payment / supplier credit (Feature 1) ------------------------------
    # How much of the supplier's invoice was actually paid at delivery time.
    # Anything left unpaid becomes supplier credit — money we owe them.
    amount_paid:             Decimal = Field(default=Decimal("0"), ge=0)
    # CASH / UPI mean money changed hands now.  CREDIT means nothing was paid
    # up front, so amount_paid is forced to 0 in the service layer.
    payment_mode:            Literal["CASH", "UPI", "CREDIT"] = "CASH"
    # The supplier's total invoice value.  Normally quantity x cost_price, but
    # the pharmacist can override it when the paper invoice says something
    # different (rounding, freight, a line we did not itemise).
    supplier_invoice_total:  Optional[Decimal] = Field(default=None, ge=0)
    # Required whenever credit is created — validated in the router, not here,
    # because the credit amount is only known after the totals are worked out.
    due_date:                Optional[date] = None

    # --- Advance balance adjustment (Feature A) -----------------------------
    # How much of the supplier's existing ADVANCE balance to spend on this
    # purchase (money we overpaid earlier, or return credit we are holding).
    # It is applied BEFORE cash: the advance offsets the invoice first, then any
    # cash paid, then whatever is left becomes new credit.  Clamped in the
    # service to min(advance_used, advance_balance, invoice_total).
    advance_used:            Decimal = Field(default=Decimal("0"), ge=0)

    # --- Bonus / scheme purchase (Feature B) --------------------------------
    # A distributor scheme like "5+1" (buy 5, get 1 free).  When both halves are
    # given, `quantity` is treated as the PAID quantity and the free bonus units
    # are added to stock on top of it.  scheme_label is auto-generated ("5+1")
    # when not supplied.
    scheme_buy:              Optional[int] = Field(default=None, gt=0)
    scheme_free:             Optional[int] = Field(default=None, gt=0)
    scheme_label:            Optional[str] = Field(default=None, max_length=20)


class AddStockResponse(BaseModel):
    """Result returned after a successful Add Stock submission."""
    success:            bool
    batch_id:           int
    new_total_stock:    int
    message:            str
    # --- Credit outcome (Feature 1) ----------------------------------------
    # Echoed back so the Add Stock panel can confirm "₹5,200 added to credit"
    # without a second round-trip.
    invoice_total:      Decimal = Decimal("0")
    amount_paid:        Decimal = Decimal("0")
    credit_amount:      Decimal = Decimal("0")
    credit_tx_id:       Optional[int] = None
    supplier_outstanding: Decimal = Decimal("0")
    # --- Advance outcome (Feature A) ---------------------------------------
    advance_used:              Decimal = Decimal("0")   # advance actually applied
    supplier_advance_remaining: Decimal = Decimal("0")  # advance left afterwards
    supplier_outstanding_after: Decimal = Decimal("0")  # what we owe afterwards
    # --- Scheme outcome (Feature B) ----------------------------------------
    scheme_label:            Optional[str] = None
    paid_quantity:           Optional[int] = None
    bonus_quantity:          int = 0
    total_quantity:          Optional[int] = None
    effective_cost_per_unit: Optional[Decimal] = None


# ---------------------------------------------------------------------------
# Purchase History (list of past stock-in events)
# ---------------------------------------------------------------------------

class PurchaseHistoryItem(BaseModel):
    """One row in the Purchase History table."""
    id:                      int
    product_id:              int
    product_name:            str
    supplier_id:             int
    supplier_name:           str
    supplier_invoice_number: str
    supplier_invoice_date:   date
    batch_id:                int
    batch_number:            Optional[str]
    expiry_date:             Optional[date]
    quantity:                int
    mrp:                     Decimal
    cost_price:              Optional[Decimal]
    added_by:                Optional[str]   # user's display name
    created_at:              datetime
    # --- Bonus / scheme purchase (Feature B) --------------------------------
    # `quantity` above is the PAID quantity; bonus_quantity is the free units.
    scheme_label:            Optional[str] = None
    bonus_quantity:          int = 0

    model_config = {"from_attributes": True}


class PurchaseHistoryResponse(BaseModel):
    """Paginated wrapper for the Purchase History list."""
    items:  list[PurchaseHistoryItem]
    total:  int
    limit:  int
    offset: int


# ---------------------------------------------------------------------------
# Stock Movements
# ---------------------------------------------------------------------------

class StockMovementOut(BaseModel):
    """One row from the stock_movements audit trail."""
    id:            int
    batch_id:      int
    product_name:  str          # from batch → product relationship
    movement_type: str
    quantity:      int
    reference:     Optional[str]
    created_at:    datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Paginated list response
# ---------------------------------------------------------------------------

class ProductListResponse(BaseModel):
    """
    Wraps a page of ProductListItem results with pagination metadata.
    The frontend uses total + page + limit to render page navigation.
    """
    items: list[ProductListItem]
    total: int
    page:  int
    limit: int


# ---------------------------------------------------------------------------
# Supplier returns — sending expired stock back (Feature 2)
# ---------------------------------------------------------------------------

class ReturnToSupplierRequest(BaseModel):
    """Body for POST /api/inventory/return-to-supplier."""
    batch_id:          int
    return_quantity:   int = Field(..., gt=0, description="Units to send back")
    # Optional — the backend resolves the supplier from the batch anyway, and
    # rejects the request if the two disagree.
    supplier_id:       Optional[int] = None
    return_type:       Literal["SAME_MEDICINE", "DIFFERENT_MEDICINE", "PENDING"]
    replacement_notes: Optional[str] = None
    notes:             Optional[str] = None


class ReturnToSupplierResponse(BaseModel):
    """Result of a processed return, including the credit impact."""
    return_id:                  int
    gross_value:                Decimal
    gst_deduction:              Decimal
    net_return_value:           Decimal
    credit_adjusted:            bool
    supplier_outstanding_after: Decimal
    advance_balance_after:      Decimal
    batch_quantity_after:       int
    message:                    str
    # --- Bonus / scheme purchase (Feature B) --------------------------------
    # When the returned batch was on a scheme, the value used only the paid
    # units; these report the split back to the modal.
    scheme_label:               Optional[str] = None
    bonus_returned:             int = 0
    paid_returned:              Optional[int] = None


class ReturnPreviewOut(BaseModel):
    """
    Everything the return modal needs to render before anything is written.

    Lets the frontend show the supplier, the cost price, the GST loss and the
    credit impact without duplicating the arithmetic in JavaScript.
    """
    batch_id:            int
    batch_number:        Optional[str] = None
    product_id:          int
    product_name:        str
    supplier_id:         int
    supplier_name:       str
    quantity_available:  int
    purchase_price:      Decimal
    gst_rate:            Decimal
    # Calculated for the full available quantity — the UI recalculates live as
    # the pharmacist types a smaller number.
    gross_value:         Decimal
    gst_deduction:       Decimal
    net_return_value:    Decimal
    supplier_outstanding: Decimal
    # --- Bonus / scheme purchase (Feature B) --------------------------------
    # Present when the batch was bought on a scheme, so the modal can show the
    # paid/bonus split and value only the paid units.
    scheme_label:        Optional[str] = None
    bonus_quantity:      int = 0        # total free units in the batch
    total_received:      Optional[int] = None  # batch's original received qty
    # Split of the currently-available quantity into paid vs bonus units.
    paid_available:      Optional[int] = None
    bonus_available:     int = 0


class SupplierReturnItem(BaseModel):
    """One row in the supplier returns history list."""
    id:                int
    supplier_id:       int
    supplier_name:     str
    product_id:        int
    product_name:      str
    batch_id:          int
    batch_number:      Optional[str] = None
    return_quantity:   int
    purchase_price:    Decimal
    gst_rate:          Decimal
    gross_value:       Decimal
    gst_deduction:     Decimal
    net_return_value:  Decimal
    return_type:       str
    replacement_notes: Optional[str] = None
    credit_adjusted:   bool
    status:            str
    return_date:       Optional[date] = None
    notes:             Optional[str] = None
    created_at:        Optional[datetime] = None
    # --- Bonus / scheme purchase (Feature B) --------------------------------
    scheme_label:      Optional[str] = None
    bonus_returned:    int = 0
    paid_returned:     Optional[int] = None


class SupplierReturnListResponse(BaseModel):
    """Paginated wrapper for the returns history."""
    items:  list[SupplierReturnItem]
    total:  int
    limit:  int
    offset: int
