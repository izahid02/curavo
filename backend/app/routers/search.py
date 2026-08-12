"""
Smart medicine search endpoint.

GET /api/search/medicines?q=<query>

Why a dedicated /search router instead of extending the billing search?
  - The billing search (/billing/products/search) returns a minimal shape
    (product_id, selling_price, gst_rate) optimised for adding items to a
    bill — it does not include category, expiry, or low-stock flags.
  - This endpoint returns a richer shape for display: category badge,
    batch number, rack location, expiry month, MRP and low-stock indicator.
  - Both endpoints are needed; this one is what MedicineSearchBox shows.

Multi-word AND search:
  "amox cap" splits into ["amox", "cap"].
  Every word must appear in at least one of:
    products.name, products.generic_name, products.hsn_code, categories.name
  So searching a GENERIC name ("dolo") returns every brand that carries that
  generic — DOLO 650 (name match) *and* ZOLO 650 (generic_name match).

ONE ROW PER BATCH (not per product)
-----------------------------------
A medicine with three deliveries in stock produces three dropdown rows, each
with its own batch number, quantity and expiry.  The pharmacist picks the
exact physical box they are holding, and that batch_id travels all the way
into the invoice, so the bill records what was actually handed over instead
of relying on the server guessing via FEFO.

THE 30-DAY BILLING CUT-OFF (BILLING_MIN_EXPIRY_DAYS)
---------------------------------------------------
A batch that expires within 30 days is NOT sellable.  It has to go back to
the supplier (see the return-to-supplier flow), because a customer who buys
a strip today may still be taking it a month from now.  So those batches are
excluded from available_stock here, exactly as if they were already expired.

When *every* batch of a product is expired or inside that 30-day window, the
product is still returned — with available_stock 0 and
all_batches_near_expiry = true — so the pharmacist SEES that the medicine
exists but cannot be sold, instead of the search silently coming up empty.
Those rows also carry `alternatives`: other in-stock brands sharing the same
generic name.

Sort order (applied in Python after the query):
  0 — exact name match (case-insensitive)
  1 — name starts with the query
  2 — partial / cross-field match
  then alphabetical within each tier, then expiry_date ASC (FEFO) within
  each product so the earliest-expiring batch is offered first.
"""
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.inventory import Batch, Category, Product
from app.models.user import User
from app.services.auth_service import get_current_user
# BILLING_MIN_EXPIRY_DAYS (30) is defined ONCE, in inventory_service, because
# billing_service.fefo_allocate has to enforce exactly the same cut-off.  If
# this search hid a batch the allocator was still willing to sell (or the other
# way round), the pharmacist would see stock they cannot actually bill.
from app.services.inventory_service import BILLING_MIN_EXPIRY_DAYS
from app.utils.dates import get_today_ist

router = APIRouter(prefix="/search", tags=["Search"])


# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

# How many distinct PRODUCTS a search may match…
MAX_PRODUCTS = 15
# …and the hard ceiling on returned rows, since one product can contribute
# several batch rows.  Keeps the dropdown scrollable rather than endless.
MAX_ROWS = 50


# ---------------------------------------------------------------------------
# Response schema
# ---------------------------------------------------------------------------

class MedicineSearchResult(BaseModel):
    """
    One row in the search dropdown — normally ONE BATCH of one medicine.

    Fields shown in the UI:
      name, category, batch_number          → line 1
      prices, available_stock, nearest_expiry, rack_location → line 2
      low_stock                             → red dot

    Extra fields consumed by the billing screen when the user picks a result:
      id (product_id), batch_id, selling_price, gst_rate, unit
    """
    id:              int              # product_id
    name:            str
    generic_name:    str              # "" if not set — used for the
                                      # "same generic" alternatives label
    category:        str              # "" if the product has no category
    hsn_code:        str              # "" if not set
    rack_location:   Optional[str] = None   # where it physically sits, e.g. "B-2"

    # --- Batch identity ----------------------------------------------------
    # Null ONLY on an out-of-stock / all-near-expiry row, which represents the
    # product rather than any particular batch.
    batch_id:        Optional[int] = None
    batch_number:    Optional[str] = None

    available_stock: int            # THIS batch's sellable units (0 if none)
    nearest_expiry:  Optional[str]  # "YYYY-MM" e.g. "2027-02", null if none
    mrp:             float          # this batch's MRP, per unit
    low_stock:       bool           # product's TOTAL sellable stock < min level
    selling_price:   float          # this batch's selling price (for billing)
    gst_rate:        float
    unit:            str

    # --- Sellability flags -------------------------------------------------
    # out_of_stock            → nothing sellable at all (row is not clickable)
    # all_batches_near_expiry → stock physically exists but every batch is
    #                           expired or inside the 30-day window, so it must
    #                           be returned to the supplier, not sold.
    out_of_stock:            bool = False
    all_batches_near_expiry: bool = False

    # --- Strip / unit fields (Feature 3) ------------------------------------
    # Let the dropdown show "₹95/strip or ₹9.50/tab" and "15 strips (150 units)",
    # and let the billing screen offer a strip/unit toggle on the bill line.
    medicine_type:   str            = "TABLET"
    is_strip:        bool           = False
    units_per_strip: Optional[int]  = None
    strip_mrp:       Optional[float] = None
    unit_mrp:        Optional[float] = None
    # available_stock is always in individual UNITS; these two are the derived
    # view of it.  available_strips is whole strips only (integer division).
    available_strips: Optional[int] = None
    available_units:  Optional[int] = None

    # --- Alternatives (only on out-of-stock rows) --------------------------
    # Other ACTIVE, IN-STOCK products sharing this one's generic_name.  Each is
    # a complete search row (its own FEFO batch), so the frontend can hand it
    # straight to addToBill with no extra lookup.  Always empty on a sellable
    # row, and always empty on the alternatives themselves (no recursion).
    alternatives: list["MedicineSearchResult"] = []

    model_config = {"from_attributes": True}


# Pydantic needs an explicit rebuild to resolve the "MedicineSearchResult"
# forward reference used by the self-referencing `alternatives` field.
MedicineSearchResult.model_rebuild()


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _sellable_batches(db: Session, product_id: int, cutoff: date) -> list[Batch]:
    """
    Every batch of `product_id` that may legally be billed today, FEFO-ordered.

    Sellable means: has units left AND expires AFTER the 30-day cut-off.
    Expired batches fail the same test (their expiry is even earlier), so one
    comparison covers both cases.
    """
    return (
        db.query(Batch)
        .filter(
            Batch.product_id == product_id,
            Batch.quantity_available > 0,
            Batch.expiry_date > cutoff,
        )
        .order_by(Batch.expiry_date)   # FEFO — earliest expiry offered first
        .all()
    )


def _has_unsellable_stock(db: Session, product_id: int, cutoff: date) -> bool:
    """
    True when the product has physical units sitting on the shelf that are
    expired or inside the 30-day window.

    This is what separates "all batches near expiry" (stock exists but is
    return-to-supplier material) from a plain "out of stock" (nothing there).
    """
    return (
        db.query(Batch.id)
        .filter(
            Batch.product_id == product_id,
            Batch.quantity_available > 0,
            Batch.expiry_date <= cutoff,
        )
        .first()
        is not None
    )


def _strip_prices(product: Product) -> tuple[Optional[float], Optional[float], Optional[int]]:
    """
    Resolve (strip_mrp, unit_mrp, units_per_strip) for display.

    unit_mrp is normally stored, but older products may only have a strip
    price — derive the per-tablet price so the dropdown always has both.
    """
    units_per_strip = int(product.units_per_strip) if product.units_per_strip else None
    strip_price = float(product.strip_mrp) if product.strip_mrp is not None else None
    unit_price  = float(product.unit_mrp) if product.unit_mrp is not None else None

    if product.is_strip and unit_price is None and strip_price is not None and units_per_strip:
        unit_price = round(strip_price / units_per_strip, 2)

    return strip_price, unit_price, units_per_strip


def _build_batch_row(
    product:       Product,
    category_name: str,
    batch:         Batch,
    product_stock: int,
) -> MedicineSearchResult:
    """
    Turn ONE sellable batch into ONE dropdown row.

    `product_stock` is the product's TOTAL sellable stock across every valid
    batch — used only for the low-stock dot, because min_stock_level is a
    property of the medicine, not of a single delivery.
    """
    strip_price, unit_price, units_per_strip = _strip_prices(product)
    is_strip = bool(product.is_strip)
    stock    = int(batch.quantity_available or 0)

    return MedicineSearchResult(
        id=product.id,
        name=product.name,
        generic_name=product.generic_name or "",
        category=category_name,
        hsn_code=product.hsn_code or "",
        rack_location=product.rack_location or None,
        batch_id=batch.id,
        batch_number=batch.batch_number or None,
        available_stock=stock,
        nearest_expiry=batch.expiry_date.strftime("%Y-%m") if batch.expiry_date else None,
        mrp=float(batch.mrp or 0),
        low_stock=product_stock < int(product.min_stock_level or 10),
        selling_price=float(batch.selling_price or batch.mrp or 0),
        gst_rate=float(product.gst_rate or 0),
        unit=product.unit or "unit",
        out_of_stock=False,
        all_batches_near_expiry=False,
        medicine_type=product.medicine_type or "TABLET",
        is_strip=is_strip,
        units_per_strip=units_per_strip,
        strip_mrp=strip_price,
        unit_mrp=unit_price,
        # Strip maths: stock is stored in individual units, so whole strips is
        # integer division — 155 tablets at 10/strip reads as "15 strips".
        available_strips=(stock // units_per_strip) if is_strip and units_per_strip else None,
        available_units=stock,
    )


def _build_unavailable_row(
    product:       Product,
    category_name: str,
    near_expiry:   bool,
    alternatives:  list[MedicineSearchResult],
) -> MedicineSearchResult:
    """
    Build the single greyed-out row shown when a product has nothing sellable.

    `near_expiry` distinguishes the two reasons: True = the stock is there but
    is expired / inside the 30-day window (return it to the supplier);
    False = the shelf is genuinely empty (reorder it).
    """
    strip_price, unit_price, units_per_strip = _strip_prices(product)

    return MedicineSearchResult(
        id=product.id,
        name=product.name,
        generic_name=product.generic_name or "",
        category=category_name,
        hsn_code=product.hsn_code or "",
        rack_location=product.rack_location or None,
        batch_id=None,
        batch_number=None,
        available_stock=0,
        nearest_expiry=None,
        mrp=0.0,
        low_stock=True,                 # zero stock is by definition low
        selling_price=0.0,
        gst_rate=float(product.gst_rate or 0),
        unit=product.unit or "unit",
        out_of_stock=True,
        all_batches_near_expiry=near_expiry,
        medicine_type=product.medicine_type or "TABLET",
        is_strip=bool(product.is_strip),
        units_per_strip=units_per_strip,
        strip_mrp=strip_price,
        unit_mrp=unit_price,
        available_strips=0 if product.is_strip and units_per_strip else None,
        available_units=0,
        alternatives=alternatives,
    )


def _find_alternatives(
    db:      Session,
    product: Product,
    cutoff:  date,
) -> list[MedicineSearchResult]:
    """
    Other brands of the SAME generic that are actually sellable right now.

    Only meaningful for an out-of-stock product: "DOLO 650 is finished, but
    ZOLO 650 is the same generic and we have 15 strips."

    Returns at most 3 rows, each being that alternative's FEFO batch.
    Empty when the product has no generic name recorded, or when no sibling
    brand has sellable stock.
    """
    generic = (product.generic_name or "").strip()
    if not generic:
        return []

    siblings = (
        db.query(Product, Category.name)
        .outerjoin(Category, Product.category_id == Category.id)
        .filter(
            Product.is_active == True,
            Product.id != product.id,
            func.lower(Product.generic_name) == generic.lower(),
        )
        .order_by(Product.name)
        .all()
    )

    alternatives: list[MedicineSearchResult] = []
    for sibling, sibling_category in siblings:
        batches = _sellable_batches(db, sibling.id, cutoff)
        if not batches:
            continue   # the alternative is out of stock too — no help
        total = sum(int(b.quantity_available or 0) for b in batches)
        # Offer the FEFO batch: the one that should be sold first anyway.
        alternatives.append(
            _build_batch_row(sibling, sibling_category or "", batches[0], total)
        )
        if len(alternatives) == 3:
            break

    return alternatives


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.get("/medicines", response_model=list[MedicineSearchResult])
def search_medicines(
    q:  str     = Query(..., min_length=2, description="Search query (min 2 chars)"),
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    Return the batches that match *q*, ready to drop straight onto a bill.

    A product matches when ALL whitespace-separated words in *q* appear in at
    least one of: name / generic name / HSN code / category name.  Matching is
    done on the PRODUCT; each matching product then contributes:
      - one row per sellable batch (expiry more than 30 days away, qty > 0), or
      - one greyed-out row (available_stock 0) when nothing is sellable, with
        `alternatives` listing in-stock brands of the same generic.

    Rows are sorted exact-name → prefix → partial, then alphabetically, then
    by expiry date ascending (FEFO) within each product.
    """
    today  = get_today_ist()
    cutoff = today + timedelta(days=BILLING_MIN_EXPIRY_DAYS)

    # Strip and lower each word; ignore empty tokens ("  amox  " → ["amox"])
    words = [w.strip() for w in q.split() if w.strip()]

    # ── Find matching PRODUCTS ────────────────────────────────────────────────
    # Note there is NO join to batches here.  The old version inner-joined the
    # batch table, which silently hid every out-of-stock medicine — the exact
    # case the pharmacist most needs to see (so they can offer an alternative
    # or reorder).  Stock is resolved per product afterwards instead.
    product_query = (
        db.query(Product, Category.name.label("category_name"))
        .outerjoin(Category, Product.category_id == Category.id)
        .filter(Product.is_active == True)
    )

    # AND filter — every word must match at least one field.  For products with
    # no category, Category.name IS NULL; NULL ILIKE returns NULL (falsy), so
    # the remaining fields are still checked correctly.
    for word in words:
        pattern = f"%{word}%"
        product_query = product_query.filter(
            Product.name.ilike(pattern)
            | Product.generic_name.ilike(pattern)
            | Product.hsn_code.ilike(pattern)
            | Category.name.ilike(pattern)
        )

    matches = product_query.all()

    # ── Rank the products (best match first) ──────────────────────────────────
    q_lower = q.strip().lower()

    def sort_key(match):
        product = match[0]
        name_l  = product.name.lower()
        if name_l == q_lower:
            rank = 0          # exact match — show first
        elif name_l.startswith(q_lower):
            rank = 1          # prefix match — show second
        else:
            rank = 2          # partial / cross-field match — show last
        return (rank, name_l)

    matches.sort(key=sort_key)
    matches = matches[:MAX_PRODUCTS]   # cap AFTER sorting: keep the best 15

    # ── Expand each product into its batch rows ───────────────────────────────
    results: list[MedicineSearchResult] = []
    for product, category_name in matches:
        batches = _sellable_batches(db, product.id, cutoff)

        if batches:
            # Total across valid batches drives the low-stock dot on every row.
            total_stock = sum(int(b.quantity_available or 0) for b in batches)
            for batch in batches:
                results.append(
                    _build_batch_row(product, category_name or "", batch, total_stock)
                )
        else:
            # Nothing sellable.  Say WHY (near-expiry vs empty shelf) and offer
            # same-generic substitutes the pharmacist can sell instead.
            near_expiry = _has_unsellable_stock(db, product.id, cutoff)
            results.append(_build_unavailable_row(
                product,
                category_name or "",
                near_expiry,
                _find_alternatives(db, product, cutoff),
            ))

        if len(results) >= MAX_ROWS:
            break

    return results[:MAX_ROWS]


# ---------------------------------------------------------------------------
# Barcode lookup
# ---------------------------------------------------------------------------

class BarcodeResult(MedicineSearchResult):
    """
    Extends the standard search result with the barcode that was scanned
    (echoed back so the frontend can confirm what it matched).

    out_of_stock / all_batches_near_expiry are inherited and carry the same
    meaning as in the search results: the billing screen shows a warning
    instead of adding the item to the bill.
    """
    barcode: Optional[str] = None


@router.get("/barcode/{barcode}", response_model=BarcodeResult)
def barcode_lookup(
    barcode: str,
    db:      Session = Depends(get_db),
    _:       User    = Depends(get_current_user),
):
    """
    Look up a single product by its exact barcode number.

    Returns the same rich shape as the medicine search endpoint — including the
    FEFO batch_id — so the billing screen can add the item immediately without
    any extra API call.

    404 → barcode not in system at all
    200 + out_of_stock: true → known product, but nothing sellable (either the
          shelf is empty or every batch is inside the 30-day expiry cut-off,
          which all_batches_near_expiry tells apart)
    200 → ready to sell
    """
    today  = get_today_ist()
    cutoff = today + timedelta(days=BILLING_MIN_EXPIRY_DAYS)

    product = (
        db.query(Product)
        .filter(Product.barcode == barcode, Product.is_active == True)
        .first()
    )

    if product is None:
        raise HTTPException(
            status_code=404,
            detail="No medicine found for this barcode",
        )

    # Fetch the category name (product may have no category — hence .scalar())
    category_name = (
        db.query(Category.name)
        .filter(Category.id == product.category_id)
        .scalar()
    ) or ""

    batches = _sellable_batches(db, product.id, cutoff)

    # Nothing sellable — inform the frontend so it can warn instead of billing.
    if not batches:
        row = _build_unavailable_row(
            product,
            category_name,
            _has_unsellable_stock(db, product.id, cutoff),
            _find_alternatives(db, product, cutoff),
        )
        return BarcodeResult(**row.model_dump(), barcode=product.barcode)

    # Scanning a barcode identifies the MEDICINE, not a specific box, so we
    # hand back the FEFO batch — the one that should leave the shelf first.
    total_stock = sum(int(b.quantity_available or 0) for b in batches)
    row = _build_batch_row(product, category_name, batches[0], total_stock)
    return BarcodeResult(**row.model_dump(), barcode=product.barcode)
