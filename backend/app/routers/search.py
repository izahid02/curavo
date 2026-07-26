"""
Smart medicine search endpoint.

GET /api/search/medicines?q=<query>

Why a dedicated /search router instead of extending the billing search?
  - The billing search (/billing/products/search) returns a minimal shape
    (product_id, selling_price, gst_rate) optimised for adding items to a
    bill — it does not include category, expiry, or low-stock flags.
  - This endpoint returns a richer shape for display: category badge,
    nearest expiry month, MRP, and low-stock indicator.
  - Both endpoints are needed; this one is what MedicineSearchBox shows.

Multi-word AND search:
  "amox cap" splits into ["amox", "cap"].
  Every word must appear in at least one of:
    products.name, products.generic_name, products.hsn_code, categories.name
  So "amox cap" matches "Amoxicillin Capsule 500mg" because "amox" hits
  the name and "cap" hits the name too.

Sort order (applied in Python after the SQL GROUP BY):
  0 — exact name match (case-insensitive)
  1 — name starts with the query
  2 — partial / cross-field match
  then alphabetical within each tier.

Result cap: 15.  The GROUP BY query may return more if the user types a
very short word, so we sort ALL matching rows then slice [:15].
"""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.inventory import Batch, Category, Product
from app.models.user import User
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/search", tags=["Search"])


# ---------------------------------------------------------------------------
# Response schema
# ---------------------------------------------------------------------------

class MedicineSearchResult(BaseModel):
    """
    One row in the search dropdown.

    Fields shown in the UI:
      name, category              → line 1
      available_stock, nearest_expiry, mrp, low_stock → line 2 / indicator

    Extra fields consumed by the billing screen when the user picks a result:
      selling_price, gst_rate, unit
    """
    id:              int
    name:            str
    category:        str            # "" if the product has no category
    hsn_code:        str            # "" if not set
    available_stock: int            # SUM of all active-batch qty
    nearest_expiry:  Optional[str]  # "YYYY-MM" e.g. "2026-03", null if none
    mrp:             float          # lowest MRP across active batches
    low_stock:       bool           # True when stock < product.min_stock_level
    selling_price:   float          # FEFO batch selling price (for billing)
    gst_rate:        float
    unit:            str

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

    model_config = {"from_attributes": True}


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
    Return up to 15 medicines that:
      1. Are active (product.is_active = True).
      2. Have at least one non-expired batch with quantity_available > 0.
      3. Match ALL whitespace-separated words in *q* across name / generic
         name / HSN code / category name.

    Results are sorted: exact name match → prefix → partial → alphabetical.
    """
    today = date.today()
    # Strip and lower each word; ignore empty tokens ("  amox  " → ["amox"])
    words = [w.strip() for w in q.split() if w.strip()]

    # ── Aggregation query ──────────────────────────────────────────────────────
    # We join Product → Category (outer join: products without a category still
    # appear, with category_name = NULL) → Batch (inner join: only active batches).
    #
    # GROUP BY Product.id lets us aggregate per product:
    #   available_stock = total sellable units across all active batches
    #   nearest_expiry  = earliest expiry date (the FEFO batch)
    #   min_mrp         = cheapest MRP among active batches (shown in UI)
    #
    # SQLite allows selecting non-aggregated columns that are functionally
    # dependent on the GROUP BY key (Product.id is the PK, so all other
    # Product columns are guaranteed to be the same for each group).
    agg_query = (
        db.query(
            Product.id,
            Product.name,
            Product.generic_name,
            Product.hsn_code,
            Product.gst_rate,
            Product.unit,
            Product.min_stock_level,
            # Strip fields (Feature 3) — needed so the dropdown can price the
            # medicine per strip as well as per tablet.
            Product.medicine_type,
            Product.is_strip,
            Product.units_per_strip,
            Product.strip_mrp,
            Product.unit_mrp,
            Category.name.label("category_name"),
            func.sum(Batch.quantity_available).label("available_stock"),
            func.min(Batch.expiry_date).label("nearest_expiry"),
            func.min(Batch.mrp).label("min_mrp"),
        )
        .outerjoin(Category, Product.category_id == Category.id)
        # Inner join on active batches only — products with no active stock are
        # automatically excluded because there is no matching Batch row.
        .join(
            Batch,
            (Batch.product_id == Product.id)
            & (Batch.expiry_date >= today)
            & (Batch.quantity_available > 0),
        )
        .filter(Product.is_active == True)
        .group_by(Product.id)
    )

    # Apply AND filter — every word must match at least one field.
    # For products with no category, Category.name IS NULL; the OR short-circuits
    # correctly (NULL ILIKE pattern evaluates to NULL which is falsy, so the other
    # fields are still checked).
    for word in words:
        pattern = f"%{word}%"
        agg_query = agg_query.filter(
            Product.name.ilike(pattern)
            | Product.generic_name.ilike(pattern)
            | Product.hsn_code.ilike(pattern)
            | Category.name.ilike(pattern)
        )

    rows = agg_query.all()

    # ── Sort in Python (only works on the full result set, not per-page) ───────
    q_lower = q.strip().lower()

    def sort_key(row):
        name_l = row.name.lower()
        if name_l == q_lower:
            rank = 0          # exact match — show first
        elif name_l.startswith(q_lower):
            rank = 1          # prefix match — show second
        else:
            rank = 2          # partial / cross-field match — show last
        return (rank, name_l)

    rows.sort(key=sort_key)
    rows = rows[:15]  # cap after sort so the 15 returned are the best matches

    # ── Fetch FEFO selling_price per product (one query each, max 15 total) ───
    # We need the selling_price from the batch that would be sold first (FEFO =
    # earliest expiry date).  A single GROUP BY cannot give us the price of the
    # *first* row in a sorted subgroup without a window function, so we do a
    # tiny targeted lookup per product instead.
    results: list[MedicineSearchResult] = []
    for row in rows:
        # .limit(1) is required: .scalar() raises MultipleResultsFound when the
        # product has more than one active batch.  ORDER BY expiry_date + LIMIT 1
        # gives us exactly the FEFO batch price.
        fefo_price = (
            db.query(Batch.selling_price)
            .filter(
                Batch.product_id == row.id,
                Batch.expiry_date >= today,
                Batch.quantity_available > 0,
            )
            .order_by(Batch.expiry_date)
            .limit(1)
            .scalar()
        )

        # Format expiry as "YYYY-MM" string so the frontend can display "Mar 2026"
        nearest_expiry_str = (
            row.nearest_expiry.strftime("%Y-%m") if row.nearest_expiry else None
        )

        stock = int(row.available_stock or 0)

        # --- Strip maths (Feature 3) ---------------------------------------
        # Stock is stored in individual units.  Whole strips = integer division;
        # 155 tablets at 10/strip reads as "15 strips (155 units)".
        is_strip        = bool(row.is_strip)
        units_per_strip = int(row.units_per_strip) if row.units_per_strip else None
        available_strips = (
            stock // units_per_strip if is_strip and units_per_strip else None
        )

        # Fall back to the batch price when a strip price was never entered, so
        # the billing screen always has a number to work with.
        strip_price = float(row.strip_mrp) if row.strip_mrp is not None else None
        unit_price  = float(row.unit_mrp) if row.unit_mrp is not None else None
        if is_strip and unit_price is None and strip_price is not None and units_per_strip:
            unit_price = round(strip_price / units_per_strip, 2)

        results.append(MedicineSearchResult(
            id=row.id,
            name=row.name,
            category=row.category_name or "",
            hsn_code=row.hsn_code or "",
            available_stock=stock,
            nearest_expiry=nearest_expiry_str,
            mrp=float(row.min_mrp or 0),
            low_stock=stock < int(row.min_stock_level or 10),
            selling_price=float(fefo_price or row.min_mrp or 0),
            gst_rate=float(row.gst_rate or 0),
            unit=row.unit or "unit",
            medicine_type=row.medicine_type or "TABLET",
            is_strip=is_strip,
            units_per_strip=units_per_strip,
            strip_mrp=strip_price,
            unit_mrp=unit_price,
            available_strips=available_strips,
            available_units=stock,
        ))

    return results


# ---------------------------------------------------------------------------
# Barcode lookup
# ---------------------------------------------------------------------------

class BarcodeResult(MedicineSearchResult):
    """
    Extends the standard search result with two extra fields:
      barcode       — the barcode that was scanned (echoed back for confirmation)
      out_of_stock  — True when the product exists but has no sellable stock
                      (frontend shows a warning instead of adding to the bill)
    """
    barcode:      Optional[str] = None
    out_of_stock: bool = False


@router.get("/barcode/{barcode}", response_model=BarcodeResult)
def barcode_lookup(
    barcode: str,
    db:      Session = Depends(get_db),
    _:       User    = Depends(get_current_user),
):
    """
    Look up a single product by its exact barcode number.

    Returns the same rich shape as the medicine search endpoint so the
    billing screen can add the item immediately without any extra API call.

    404 → barcode not in system at all
    200 + out_of_stock: true → product known but all stock is expired or zero
    200 → ready to sell
    """
    today = date.today()

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

    # Fetch the category name (outer join equivalent — product may have no category)
    category_name = (
        db.query(Category.name)
        .filter(Category.id == product.category_id)
        .scalar()
    ) or ""

    # Aggregate stock across all active (non-expired, qty > 0) batches
    agg = (
        db.query(
            func.sum(Batch.quantity_available).label("available_stock"),
            func.min(Batch.expiry_date).label("nearest_expiry"),
            func.min(Batch.mrp).label("min_mrp"),
        )
        .filter(
            Batch.product_id == product.id,
            Batch.expiry_date >= today,
            Batch.quantity_available > 0,
        )
        .first()
    )

    available_stock = int(agg.available_stock or 0)

    # Product exists but nothing sellable — inform the frontend so it can warn
    if available_stock == 0:
        return BarcodeResult(
            id=product.id,
            name=product.name,
            category=category_name,
            hsn_code=product.hsn_code or "",
            available_stock=0,
            nearest_expiry=None,
            mrp=0.0,
            low_stock=True,
            selling_price=0.0,
            gst_rate=float(product.gst_rate or 0),
            unit=product.unit or "unit",
            barcode=product.barcode,
            out_of_stock=True,
        )

    # FEFO selling price — earliest-expiring batch that has stock
    fefo_price = (
        db.query(Batch.selling_price)
        .filter(
            Batch.product_id == product.id,
            Batch.expiry_date >= today,
            Batch.quantity_available > 0,
        )
        .order_by(Batch.expiry_date)
        .limit(1)
        .scalar()
    )

    nearest_expiry_str = (
        agg.nearest_expiry.strftime("%Y-%m") if agg.nearest_expiry else None
    )

    return BarcodeResult(
        id=product.id,
        name=product.name,
        category=category_name,
        hsn_code=product.hsn_code or "",
        available_stock=available_stock,
        nearest_expiry=nearest_expiry_str,
        mrp=float(agg.min_mrp or 0),
        low_stock=available_stock < int(product.min_stock_level or 10),
        selling_price=float(fefo_price or agg.min_mrp or 0),
        gst_rate=float(product.gst_rate or 0),
        unit=product.unit or "unit",
        barcode=product.barcode,
        out_of_stock=False,
    )
