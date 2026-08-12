"""
Inventory business logic.

Route functions in routers/inventory.py stay THIN — they call these
functions and return the result.  All real logic lives here so it can
be tested and reused without spinning up the web server.

KEY RULE: every stock change must also write a StockMovement audit row.
Never mutate batch.quantity_available without a matching movement.
"""
import calendar
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.inventory import Batch, Product, StockMovement, StockPurchase, Supplier
from app.models.user import User
from app.schemas.inventory import AddStockRequest, BatchReceive
from app.utils.dates import get_today_ist


# ---------------------------------------------------------------------------
# Canonical expiry-alert count — the SINGLE definition used everywhere
# ---------------------------------------------------------------------------
# Historically the sidebar badge, the dashboard card, and the Expiry Alerts page
# each counted expiry alerts differently (some counted batches, some only the
# 7-day window, some excluded already-expired stock), so the same shop showed
# three different numbers. This is now the one true definition, reused by all
# three places:
#
#   "Number of distinct active products that have at least one in-stock batch
#    which is already expired OR expiring within the next 60 days."
#
# It counts PRODUCTS, not batches (two batches of the same medicine = one alert),
# and it INCLUDES already-expired stock (still needs attention / a return).
#
# The horizon is 60 days, matching the LAST section on the Expiry Alerts page.
# It was 90 while that page had a 90-day section; when that section was removed
# the horizon had to move with it, or the badge would count products the page
# does not list and the pharmacist would go looking for stock that isn't there.
# If a section is ever added or removed again, change this number to match.

EXPIRY_ALERT_HORIZON_DAYS = 60


# ---------------------------------------------------------------------------
# The billing cut-off — how much shelf life a batch needs to be SELLABLE
# ---------------------------------------------------------------------------
# A batch expiring within 30 days must not be sold: a customer buying a strip
# today may still be taking it a month from now.  That stock goes back to the
# supplier instead (see supplier_return_service).
#
# This is the SINGLE definition of "too close to expiry to sell".  It is used
# by BOTH ends of the billing flow and they must never disagree:
#   - routers/search.py  — hides those batches from the medicine search
#   - billing_service.fefo_allocate — refuses to deduct stock from them
# If the search offered a batch the allocator then rejected (or vice versa),
# the pharmacist would see stock they cannot bill.  Change it in one place.
BILLING_MIN_EXPIRY_DAYS = 30


def count_expiry_alert_products(db: Session) -> int:
    """Canonical expiry-alert count (see module note above)."""
    horizon = get_today_ist() + timedelta(days=EXPIRY_ALERT_HORIZON_DAYS)
    return (
        db.query(func.count(func.distinct(Batch.product_id)))
        .filter(
            Batch.quantity_available > 0,
            Batch.expiry_date <= horizon,   # past (expired) OR within 90 days
        )
        .scalar()
    ) or 0


# ---------------------------------------------------------------------------
# Stock computation
# ---------------------------------------------------------------------------

def get_product_stock(db: Session, product_id: int) -> int:
    """
    Return the total available stock for a product.

    We SUM quantity_available only from NON-EXPIRED batches
    (expiry_date >= today).  Expired stock must not be counted
    because it cannot legally be sold.
    """
    result = (
        db.query(func.sum(Batch.quantity_available))
        .filter(
            Batch.product_id == product_id,
            Batch.expiry_date >= get_today_ist(),  # exclude expired batches
            Batch.quantity_available > 0,
        )
        .scalar()
    )
    # .scalar() returns None when there are no matching rows; we treat that as 0
    return int(result) if result is not None else 0


# ---------------------------------------------------------------------------
# Expiry classification
# ---------------------------------------------------------------------------

def get_expiry_status(expiry_date: date) -> str:
    """
    Classify a batch by how close it is to expiry.

    The thresholds match the colour-coded badges in ExpiryAlerts.jsx:
      EXPIRED  → already past expiry date       (red)
      WARN_7   → expires within 7 days          (red)
      WARN_30  → expires within 8–30 days       (orange)
      WARN_60  → expires within 31–60 days      (orange)
      WARN_90  → expires within 61–90 days      (green/warn)
      OK       → more than 90 days remaining
    """
    days = (expiry_date - get_today_ist()).days

    if days < 0:
        return "EXPIRED"
    elif days <= 7:
        return "WARN_7"
    elif days <= 30:
        return "WARN_30"
    elif days <= 60:
        return "WARN_60"
    elif days <= 90:
        return "WARN_90"
    else:
        return "OK"


# ---------------------------------------------------------------------------
# Receive stock
# ---------------------------------------------------------------------------

def receive_stock(db: Session, data: BatchReceive, user_id: int) -> Batch:
    """
    Record a new stock delivery:
      1. Create a Batch row from the delivery data.
      2. Write a StockMovement row (type='IN') as an immutable audit entry.

    BOTH writes happen BEFORE the caller commits, so they are in the same
    database transaction.  If anything fails, both roll back together —
    we never get a batch without a matching movement or vice versa.

    The caller (the route function) is responsible for calling db.commit().
    """
    # --- Step 1: create the batch -------------------------------------------
    batch = Batch(
        product_id=data.product_id,
        supplier_id=data.supplier_id,
        batch_number=data.batch_number,
        mrp=data.mrp,
        purchase_price=data.purchase_price,
        selling_price=data.selling_price,
        mfg_date=data.mfg_date,
        expiry_date=data.expiry_date,
        quantity_received=data.quantity_received,
        # quantity_available starts at quantity_received and decreases as we sell
        quantity_available=data.quantity_received,
    )
    db.add(batch)
    # flush() assigns batch.id without committing, so we can reference it below
    db.flush()

    # --- Step 2: audit trail ------------------------------------------------
    # This row proves stock came in and who recorded it.
    movement = StockMovement(
        batch_id=batch.id,
        movement_type="IN",
        quantity=data.quantity_received,   # positive = stock coming in
        reference="PURCHASE",
        user_id=user_id,
    )
    db.add(movement)

    return batch   # caller does db.commit() + db.refresh(batch)


# ---------------------------------------------------------------------------
# Add Stock (unified Medicines page flow)
# ---------------------------------------------------------------------------

def parse_expiry_month(value: str) -> date:
    """
    Convert a "YYYY-MM" expiry string into a real date.

    A medicine pack prints only the month it expires (e.g. "12/2026"), and it
    stays sellable through the WHOLE of that month.  So we store the LAST day
    of the month — e.g. "2026-12" → date(2026, 12, 31).  This way FEFO and the
    expiry checks (which use expiry_date >= today) treat the medicine as valid
    right up to the end of its printed month.
    """
    year_str, month_str = value.split("-")
    year, month = int(year_str), int(month_str)
    # calendar.monthrange returns (weekday_of_first, number_of_days_in_month)
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, last_day)


def batch_number_exists(db: Session, product_id: int, batch_number: str) -> bool:
    """
    Return True if this product already has a batch with the given batch number.
    Batch numbers must be unique PER PRODUCT (the same number can legitimately
    appear for a different medicine).
    """
    existing = (
        db.query(Batch.id)
        .filter(
            Batch.product_id == product_id,
            Batch.batch_number == batch_number,
        )
        .first()
    )
    return existing is not None


# Money is rounded to PAISE (2dp) on invoice lines — that is what the supplier
# actually bills and what the ledger has to reconcile against.  PER-UNIT prices
# keep 4dp, because a strip price divided by 15 tablets (₹86.10 → ₹5.74) drifts
# by up to 75 paise across a 150-unit delivery if it is rounded to paise first.
_PAISE = Decimal("0.01")
_UNIT  = Decimal("0.0001")


def _round(value: Decimal, places: Decimal = _PAISE) -> Decimal:
    """
    Round money HALF-UP, the way an invoice does (and the way JavaScript's
    Math.round behaves for positive numbers, so the frontend preview and this
    calculation land on the same paisa).

    Python's default rounding is HALF-EVEN, which would turn ₹245.385 into
    ₹245.38 here while the browser showed ₹245.39 — a one-paisa disagreement
    between the screen and the stored invoice.
    """
    return Decimal(value).quantize(places, rounding=ROUND_HALF_UP)


def compute_purchase_totals(
    paid_quantity: int,
    cost_price: Optional[Decimal],
    gst_rate: Optional[Decimal],
    discount_percent: Optional[Decimal] = None,
    units_per_strip: int = 1,
    is_strip: bool = False,
    supplier_invoice_total: Optional[Decimal] = None,
) -> dict:
    """
    Reproduce a real Indian distributor's invoice line, exactly as printed.

    HOW A DISTRIBUTOR'S INVOICE ACTUALLY WORKS (this is the whole point):

        S.Rate                 the rate card price per unit, before tax
        − trade discount       knocked off the rate FIRST
        = goods value          what the medicine itself costs us
        + GST on GOODS VALUE   the tax, charged on the DISCOUNTED figure
        = line total           what we owe the supplier

    THE BUG THIS FIXES:
    We used to charge GST on the rate card price and treat the discount as a
    margin-only adjustment that never touched the invoice.  Real invoices do
    the opposite — the discount line comes before the tax line, so the tax is
    smaller too.  A ₹86.10 item at 5% discount and 5% GST cost us ₹85.88 per
    unit, not ₹90.45; on three units the old maths over-stated the supplier
    debt by ₹14.01 (₹271.67 instead of ₹257.66).  Every supplier credit row
    created since discounts were added carries that error.

    Worked example (COLIZA LIQUID, from a real invoice):
        S.Rate ₹86.10 · Disc 5% · GST 5% · Qty 3
        discount   = 86.10 × 5%      = ₹4.305/unit
        post-disc  = 86.10 − 4.305   = ₹81.795/unit   ← effective_cost
        GST        = 81.795 × 5%     = ₹4.0898/unit
        total/unit = 81.795 + 4.0898 = ₹85.8848
        goods total (×3)             = ₹245.39
        GST total   (on goods total) = ₹12.27
        INVOICE TOTAL                = ₹257.66

    Note this is the OPPOSITE direction to a SALE.  On a sale, GST is already
    baked into the MRP and gets extracted out of it (see CLAUDE.md).  On a
    PURCHASE, the rate is pre-tax and GST is added on top of it.

    ARGUMENTS
      paid_quantity  — in individual UNITS, always (bonus/free units excluded;
                       they cost nothing so they are not on the invoice)
      cost_price     — the S.Rate.  Per unit by default; pass is_strip=True with
                       units_per_strip to hand in a per-STRIP rate instead.
      discount_percent — the trade discount, as a percentage of the S.Rate.  A
                       percentage is basis-independent, which is why it is the
                       only shape accepted: the rupee equivalent would need a
                       basis (per unit? per strip? per line?) and any mismatch
                       there silently mis-states the supplier debt.  The rupee
                       figure is derived from it (see compute_discount) as
                       cost_price × quantity × percent / 100.
      supplier_invoice_total — override for when the paper invoice says something
                       else (freight, rounding, an unlisted line).  It replaces
                       invoice_total only; every other figure stays as computed
                       so the breakdown on screen still adds up.

    ⚠ THE APP'S OWN CALLERS PASS PER-UNIT FIGURES (is_strip=False).  The frontend
    divides a strip price by units_per_strip before sending, because the backend
    never receives the word "strip" (CLAUDE.md § core domain model).  The strip
    arguments exist for scripts and tests that want to work in the basis a
    pharmacist reads off the invoice.

    ROUNDING: per-unit figures keep 4 decimals, line totals are rounded to
    paise.  The GST line is computed from the ROUNDED goods total, exactly as a
    printed invoice does it, so goods + GST always equals the total on screen.

    Pure arithmetic — no database access.
    """
    qty  = Decimal(str(paid_quantity or 0))
    rate = Decimal(str(gst_rate)) if gst_rate is not None else Decimal("0")

    # A strip is a pricing convenience, never a storage unit — convert the whole
    # entry basis down to ONE unit before any arithmetic happens.
    per_pack = Decimal("1")
    if is_strip and units_per_strip and int(units_per_strip) > 0:
        per_pack = Decimal(str(int(units_per_strip)))

    s_rate_entered = Decimal(str(cost_price)) if cost_price is not None else Decimal("0")
    s_rate = s_rate_entered / per_pack                       # S.Rate per unit

    # --- Step 1: the trade discount, off the S.Rate -------------------------
    # A percentage is the only input, so the rupee figure is derived from it:
    # S.Rate × percent / 100, per unit (× quantity below gives the line saving).
    discount = compute_discount(s_rate, discount_percent)
    discount_per_unit = discount["discount_amount"]

    # --- Step 2: post-discount price — what the medicine really costs -------
    post_discount_per_unit = discount["effective_cost"]

    # --- Step 3: GST, charged on the POST-DISCOUNT price --------------------
    gst_per_unit = _round(post_discount_per_unit * rate / Decimal("100"), _UNIT)

    # --- Step 4: what one unit actually costs us at the door ----------------
    total_per_unit = _round(post_discount_per_unit + gst_per_unit, _UNIT)

    # --- Step 5: the invoice line -------------------------------------------
    # gross_goods is the rate-card value BEFORE the discount; it exists so the
    # on-screen breakdown can show the discount as its own line that reconciles
    # exactly (gross − discount = goods), with no stray paisa.
    gross_goods    = _round(s_rate * qty)
    goods_total    = _round(post_discount_per_unit * qty)
    discount_total = gross_goods - goods_total
    gst_total      = _round(goods_total * rate / Decimal("100"))
    computed_total = goods_total + gst_total

    if supplier_invoice_total is not None:
        invoice_total = _round(Decimal(str(supplier_invoice_total)))
    else:
        invoice_total = computed_total

    return {
        # --- per unit (4dp — these are prices, not invoice lines) -----------
        "s_rate":                 _round(s_rate, _UNIT),
        "discount_percent":       discount["discount_percent"],
        "discount_per_unit":      discount_per_unit,
        "post_discount_per_unit": post_discount_per_unit,
        "gst_per_unit":           gst_per_unit,
        "total_per_unit":         total_per_unit,
        # effective_cost is the per-unit post-discount price EX-GST — the figure
        # profit margin, expiry loss and supplier returns all work from.
        "effective_cost":         post_discount_per_unit,
        # --- the invoice line (paise) ---------------------------------------
        "gross_goods":     gross_goods,      # rate card × qty, before discount
        "discount_total":  discount_total,   # the discount line on the invoice
        "goods_total":     goods_total,      # post-discount, ex-GST
        "gst_total":       gst_total,        # tax on the goods total
        "gst_rate":        rate,
        "invoice_total":   invoice_total,    # what we owe (override applied)
        # --- legacy aliases --------------------------------------------------
        # Older callers and the stock_purchases columns use these names.
        # base_cost/total_cost are the COMPUTED figures, never the override, so
        # the stored breakdown always adds up on its own.
        "base_cost":       goods_total,
        "gst_on_purchase": gst_total,
        "total_cost":      computed_total,
    }


def compute_discount(
    cost_price: Optional[Decimal],
    discount_percent: Optional[Decimal] = None,
    discount_amount: Optional[Decimal] = None,
) -> dict:
    """
    Turn a supplier discount into the ONE number everything downstream needs:
    the effective cost of a single unit.

    WHY THIS EXISTS:
    A distributor's discount arrives in two different shapes.  Sometimes it is a
    percentage off the rate card ("5% trade discount"), sometimes a flat amount
    ("₹3 off per strip").  They mean the same thing — we paid less — but if each
    caller converts them itself, the profit card, the margin badge and the expiry
    loss all drift apart.  So the conversion happens here, once:

        percent given → discount_amount = cost_price × percent / 100
        amount given  → discount_percent = discount_amount / cost_price × 100
        effective_cost = cost_price − discount_amount

    The percentage wins when BOTH are supplied.  The UI only ever lets one be
    active (typing in either box clears the other), so this only matters for a
    hand-written API call — and "5%" is the less ambiguous of the two.

    EVERYTHING IS PER INDIVIDUAL UNIT, matching cost_price.  A strip medicine is
    typed in strips, but the frontend divides by units_per_strip before sending.

    The result can never go below zero: a discount larger than the cost would
    otherwise record a medicine that the supplier paid US to take.

    PRECISION: the money figures keep 4 decimals, not 2.  5% off ₹86.10 is
    ₹4.305 — rounding that to ₹4.31 per unit shifts the effective cost by half a
    paisa, which across 150 units is a rupee off the invoice total.  The
    percentage stays at 2dp because that is how it is quoted and stored.

    Pure arithmetic — no database access.
    """
    cost = Decimal(str(cost_price)) if cost_price is not None else Decimal("0")
    pct  = Decimal(str(discount_percent)) if discount_percent is not None else Decimal("0")
    amt  = Decimal(str(discount_amount)) if discount_amount is not None else Decimal("0")

    if cost <= 0:
        # Nothing to discount from — a percentage of zero is zero either way.
        pct = amt = Decimal("0")
    elif pct > 0:
        # Percentage is authoritative — derive the rupee figure from it.
        amt = cost * pct / Decimal("100")
    elif amt <= 0:
        pct = amt = Decimal("0")

    # A discount can wipe out the cost but never invert it.  Clamp BEFORE
    # deriving the percentage, so a fat-fingered "₹100 off a ₹60 tablet" is
    # recorded as 100%, not as a nonsensical 167%.
    amt = min(amt, cost)
    if cost > 0 and amt > 0:
        pct = amt / cost * Decimal("100")

    amt = _round(amt, _UNIT)
    effective = _round(cost - amt, _UNIT)

    return {
        "discount_percent": _round(pct),          # 2dp — how it is quoted
        "discount_amount":  amt,                  # 4dp, per unit
        "effective_cost":   effective,            # 4dp, per unit, ex-GST
    }


def _compute_scheme(
    data: AddStockRequest, cost: Decimal, units_per_pack: int = 1
) -> dict:
    """
    Work out the bonus/paid split for a purchase scheme (Feature B).

    Pure arithmetic, no database access.  Given the pharmacist's PAID quantity
    and a scheme like "5+1", it returns how many free bonus units are earned and
    the resulting total that enters stock.

    A SCHEME IS QUOTED IN THE PACK THE PHARMACIST BUYS, NOT IN TABLETS.
    When a distributor says "5+1" on a strip medicine they mean *buy 5 strips,
    get 1 strip free* — never "buy 5 tablets, get 1 tablet free".  Stock is
    always counted in individual units, so the scheme has to be scaled into
    units before the arithmetic:

        buy_units      = scheme_buy  x units_per_pack
        free_units     = scheme_free x units_per_pack
        bonus_quantity = (paid_quantity // buy_units) x free_units
        total_quantity = paid_quantity + bonus_quantity
        effective_cost = cost x paid_quantity / total_quantity  (informational)

    `units_per_pack` is the product's units_per_strip for a strip medicine and 1
    for everything else — a syrup bottle IS the pack, so "5+1" already means 5
    bottles.  Getting this wrong is expensive in both directions: counted in
    tablets, 20 strips of 20 on "5+1" would have earned 80 free TABLETS' worth
    of bonus computed off 400, i.e. 80 units — right by luck only when the
    scheme ratio happens to match; for 10+2 on strips of 15 it silently invents
    stock that the distributor never delivered.

    scheme_buy / scheme_free are STORED as the human numbers (5 and 1), not the
    scaled ones, so the ledger and Purchase History read the way the invoice does.

    When no scheme is given, everything falls back to a plain purchase: no bonus,
    total == paid, and the scheme columns stay NULL.
    """
    paid_quantity = data.quantity

    # A scheme needs BOTH halves; a lone "buy" or "free" is treated as none.
    if not data.scheme_buy or not data.scheme_free:
        return {
            "scheme_buy": None, "scheme_free": None, "scheme_label": None,
            "bonus_quantity": 0, "paid_quantity": paid_quantity,
            "total_quantity": paid_quantity, "effective_cost_per_unit": None,
        }

    label = data.scheme_label or f"{data.scheme_buy}+{data.scheme_free}"

    # Scale the scheme from packs (strips) into individual units.
    per_pack   = units_per_pack if units_per_pack and units_per_pack > 0 else 1
    buy_units  = data.scheme_buy * per_pack
    free_units = data.scheme_free * per_pack

    # Whole scheme sets only: 9.4 sets earns 9 lots of bonus, not a fraction.
    # This mirrors how distributors actually count.
    bonus_quantity = (paid_quantity // buy_units) * free_units
    total_quantity = paid_quantity + bonus_quantity

    effective_cost = None
    if cost and cost > 0 and total_quantity > 0:
        effective_cost = (cost * Decimal(paid_quantity) / Decimal(total_quantity)) \
            .quantize(Decimal("0.01"))

    return {
        "scheme_buy": data.scheme_buy,
        "scheme_free": data.scheme_free,
        "scheme_label": label,
        "bonus_quantity": bonus_quantity,
        "paid_quantity": paid_quantity,
        "total_quantity": total_quantity,
        "effective_cost_per_unit": effective_cost,
    }


def add_stock(
    db: Session, data: AddStockRequest, user_id: int
) -> tuple[Batch, StockPurchase, dict]:
    """
    Record one stock-in event from the unified Add Stock panel.

    Creates rows in a single transaction (the caller commits):
      1. Batch            — the physical stock, where quantity lives.
      2. StockMovement    — type "IN", the immutable audit trail entry.
      3. StockPurchase    — links the batch to the supplier + invoice details.
      4. Supplier credit  — a CREDIT row for the unpaid portion of the invoice
                            and/or a PAYMENT row for what was paid at delivery.

    Returns (batch, purchase, credit_info) so the route can report the stock
    result and the credit result together.

    Pricing: this simplified flow only asks for MRP and an optional cost price.
    Because GST is inclusive in MRP (see CLAUDE.md), selling_price = mrp.
    purchase_price falls back to 0 when the cost is not recorded.

    NOTE: this function assumes the caller has already validated that the
    product/supplier exist and the batch number is unique — it focuses on the
    writes so the route stays readable.
    """
    expiry = parse_expiry_month(data.expiry_date)

    # The product carries the identity fields this whole function needs: the GST
    # rate for the supplier's invoice, and units_per_strip for scheme scaling.
    product = db.get(Product, data.product_id)

    # --- The supplier's invoice line, computed once -------------------------
    # ONE call produces every figure this function needs: the discount in both
    # shapes, the post-discount (effective) cost, the GST charged on it, and the
    # invoice total we owe.  Doing it once means the batch, the purchase row and
    # the credit row can never disagree by a paisa.
    #
    # Order matters and mirrors the paper invoice: discount comes off the rate
    # FIRST, then GST is charged on what is left.
    #
    # The quantity here is `data.quantity` — the PAID quantity.  Scheme bonus
    # units are free, so they are never on the invoice.  (data.quantity is
    # always in individual UNITS; the frontend converts strips before sending,
    # so is_strip/units_per_strip are left at their per-unit defaults.)
    totals = compute_purchase_totals(
        paid_quantity=data.quantity,
        cost_price=data.cost_price,
        gst_rate=product.gst_rate if product else None,
        discount_percent=data.discount_percent,
        supplier_invoice_total=data.supplier_invoice_total,
    )
    # What the medicine really cost us per unit, ex-GST — the figure profit
    # margin, expiry loss and supplier returns all work from.  cost_price stays
    # as the un-discounted S.Rate so the row still matches the printed invoice.
    effective_cost = totals["effective_cost"]

    # --- Bonus / scheme purchase (Feature B) --------------------------------
    # The pharmacist enters the PAID quantity, in UNITS.  A scheme like "5+1" is
    # quoted in the pack the distributor sells — 5 STRIPS get 1 strip free for a
    # strip medicine, 5 bottles get 1 free otherwise — so _compute_scheme scales
    # it by units_per_strip.  The free units enter stock at zero extra cost; the
    # supplier invoice (and hence any credit) is based on the PAID quantity only.
    units_per_pack = (
        product.units_per_strip
        if product is not None and product.is_strip and product.units_per_strip
        else 1
    )
    # The scheme's "effective cost per unit" is computed from the DISCOUNTED
    # cost, because a discount and a bonus both lower the same real figure —
    # what one tablet on this shelf actually cost the pharmacy.
    scheme = _compute_scheme(data, effective_cost, units_per_pack)
    paid_quantity  = scheme["paid_quantity"]
    total_quantity = scheme["total_quantity"]

    # --- Step 1: the batch (physical stock) ---------------------------------
    batch = Batch(
        product_id=data.product_id,
        supplier_id=data.supplier_id,
        batch_number=data.batch_number,
        mrp=data.mrp,
        # GST is inclusive in MRP, so the shelf/selling price is the MRP itself.
        selling_price=data.mrp,
        # The batch stores the cost AFTER the supplier discount.  Profit is
        # locked at sale time from this figure (invoice_items.purchase_price
        # snapshots it — see CLAUDE.md), and the medicine genuinely cost us the
        # discounted amount, so this is the honest number to lock in.  With no
        # discount it is identical to cost_price, as before.  The un-discounted
        # rate stays visible on the stock_purchases row.
        purchase_price=effective_cost,
        mfg_date=None,
        expiry_date=expiry,
        # Stock includes the free bonus units — they are real, sellable tablets.
        quantity_received=total_quantity,
        quantity_available=total_quantity,  # starts full, decreases as we sell
        scheme_buy=scheme["scheme_buy"],
        scheme_free=scheme["scheme_free"],
        scheme_label=scheme["scheme_label"],
        bonus_quantity=scheme["bonus_quantity"],
        paid_quantity=paid_quantity,
        effective_cost_per_unit=scheme["effective_cost_per_unit"],
    )
    db.add(batch)
    db.flush()   # assigns batch.id without committing

    # --- Step 2: audit trail (stock coming IN) ------------------------------
    movement = StockMovement(
        batch_id=batch.id,
        movement_type="IN",                       # matches FEFO/report conventions
        quantity=total_quantity,                   # positive = stock in (incl. bonus)
        reference=data.supplier_invoice_number,    # traceable back to the invoice
        user_id=user_id,
    )
    db.add(movement)

    # --- Step 3: the purchase record (supplier + invoice link) --------------
    # `totals` was computed at the top of this function, from the PAID quantity
    # and the discounted rate.  What gets stored:
    #   cost_price      → the un-discounted S.Rate, per unit (matches the invoice)
    #   discount_*      → the trade discount, per unit, in both shapes
    #   effective_cost  → S.Rate − discount, per unit, ex-GST
    #   gst_on_purchase → the GST on this LINE, charged on the discounted goods
    #   total_cost      → goods + GST for the line = what the supplier billed us
    # gst_rate comes from the PRODUCT — it is an identity field, the same for
    # every delivery.
    purchase = StockPurchase(
        product_id=data.product_id,
        batch_id=batch.id,
        supplier_id=data.supplier_id,
        supplier_invoice_number=data.supplier_invoice_number,
        supplier_invoice_date=data.supplier_invoice_date,
        # quantity here is the PAID quantity — Purchase History adds bonus on top.
        quantity=paid_quantity,
        mrp=data.mrp,
        cost_price=data.cost_price,   # keep NULL if not provided (unlike batch)
        # The GST we paid on this line, and goods + GST.  Profit uses
        # effective_cost; supplier credit uses total_cost; expiry loss recomputes
        # the GST from effective_cost (same figure, per unit).
        gst_on_purchase=totals["gst_on_purchase"],
        total_cost=totals["total_cost"],
        # Supplier discount — stored in both shapes plus the resulting cost, so
        # the Expiry Alerts page can show "5% (₹3.00/strip)" AND compute the GST
        # loss from the discounted figure without redoing the arithmetic.
        discount_percent=totals["discount_percent"],
        discount_amount=totals["discount_per_unit"],
        effective_cost=effective_cost,
        scheme_label=scheme["scheme_label"],
        bonus_quantity=scheme["bonus_quantity"],
        created_by=user_id,
    )
    db.add(purchase)
    db.flush()   # assigns purchase.id so credit rows can link back to it

    # --- Step 4: supplier credit (Feature 1) --------------------------------
    # Work out what this delivery cost and how much of it is still unpaid.
    credit_info = _record_purchase_payment_and_credit(db, data, purchase, user_id, totals)

    # Return the batch plus the credit outcome so the router can report both.
    return batch, purchase, credit_info


def _record_purchase_payment_and_credit(
    db: Session,
    data: AddStockRequest,
    purchase: StockPurchase,
    user_id: int,
    totals: dict,
) -> dict:
    """
    Split one stock delivery into "paid now" and "owed later", and write the
    matching supplier-credit rows.

    THE ARITHMETIC:
        invoice_total = supplier_invoice_total, or
                        (quantity x post-discount rate) + GST on that
        credit_amount = invoice_total - amount_paid

    `totals` comes from compute_purchase_totals(), which already took the trade
    discount off the rate and then added GST to what was left — the same order
    the distributor's invoice prints.  The debt we record therefore matches the
    paper invoice: not the ex-GST goods value (that ignores the tax we owe), and
    not the pre-discount rate + GST (that over-states the debt on every
    discounted line).

    Note that `quantity` is always in individual UNITS (for strip medicines the
    frontend multiplies strips x units_per_strip before sending), and
    cost_price is the per-unit cost — so the multiplication is consistent.

    payment_mode == "CREDIT" is shorthand for "paid nothing now", so we force
    amount_paid to zero rather than trusting whatever the form sent.

    Returns a dict summarising the outcome; writes nothing when the delivery
    was fully paid in cash and there is no credit to track.
    """
    # Imported here rather than at module top to avoid a circular import:
    # supplier_credit_service does not import inventory_service, but keeping
    # this local makes the dependency direction obvious and safe.
    from app.services import supplier_credit_service as credit_svc

    # totals["invoice_total"] is already the right figure: the computed
    # post-discount + GST line total, unless the pharmacist typed an explicit
    # "Supplier invoice total" override (freight, rounding, an unlisted line),
    # in which case that wins.  The quantity behind it is the PAID quantity —
    # scheme bonus units are free — so this stays correct with or without a
    # scheme.
    invoice_total = totals["invoice_total"]

    # --- Step 1: apply the supplier's advance balance (Feature A) -----------
    # The advance offsets the invoice BEFORE any cash.  We clamp the requested
    # figure to both the real advance balance and the invoice total, so a stale
    # UI value can never over-spend the advance or create a negative remainder.
    advance_requested = Decimal(str(data.advance_used or 0)).quantize(Decimal("0.01"))
    advance_used = Decimal("0.00")
    if advance_requested > 0:
        advance_used = credit_svc.use_advance_for_purchase(
            db,
            supplier_id=data.supplier_id,
            amount=min(advance_requested, invoice_total),
            stock_purchase_id=purchase.id,
            notes=f"Advance used — invoice {data.supplier_invoice_number}",
            created_by=user_id,
        )

    # --- Step 2: what is left after the advance -----------------------------
    remaining = (invoice_total - advance_used).quantize(Decimal("0.01"))

    # "CREDIT" mode means nothing was handed over at the door.
    amount_paid = Decimal("0") if data.payment_mode == "CREDIT" else Decimal(str(data.amount_paid))
    # Never let a typo record more paid than what is left after the advance.
    amount_paid = min(amount_paid, remaining).quantize(Decimal("0.01"))

    credit_amount = (remaining - amount_paid).quantize(Decimal("0.01"))

    credit_tx_id = None

    # --- Step 3: the unpaid portion becomes supplier credit -----------------
    # consume_advance=False: we already spent the advance explicitly in Step 1,
    # so create_credit_for_purchase must NOT dip into it again.
    if credit_amount > 0:
        credit_tx = credit_svc.create_credit_for_purchase(
            db,
            supplier_id=data.supplier_id,
            amount=credit_amount,
            due_date=data.due_date,
            stock_purchase_id=purchase.id,
            notes=f"Stock purchase — invoice {data.supplier_invoice_number}",
            created_by=user_id,
            consume_advance=False,
        )
        credit_tx_id = credit_tx.id

    # --- Step 4: whatever we DID pay is logged for a complete ledger --------
    if amount_paid > 0:
        credit_svc.record_purchase_payment(
            db,
            supplier_id=data.supplier_id,
            amount=amount_paid,
            payment_mode=data.payment_mode if data.payment_mode != "CREDIT" else "CASH",
            stock_purchase_id=purchase.id,
            notes=f"Paid at delivery — invoice {data.supplier_invoice_number}",
            created_by=user_id,
        )

    # Read the resulting balance so the response can show it immediately.
    account = credit_svc.get_or_create_account(db, data.supplier_id)

    return {
        "invoice_total":        invoice_total,
        "amount_paid":          amount_paid,
        "credit_amount":        credit_amount,
        "credit_tx_id":         credit_tx_id,
        "supplier_outstanding": Decimal(str(account.outstanding or 0)),
        # Feature A extras
        "advance_used":               advance_used,
        "supplier_advance_remaining": Decimal(str(account.advance_balance or 0)),
        "supplier_outstanding_after": Decimal(str(account.outstanding or 0)),
    }


def update_batch(db: Session, batch: Batch, data, user_id: int) -> dict:
    """
    Correct a batch that was entered wrongly, and keep its purchase row in step.

    WHY A CORRECTION IS NOT A DELIVERY:
    Add Stock is typed in at the counter while boxes are being unpacked, so a
    transposed quantity or a wrong expiry month is routine.  The fix must not
    look like new stock arriving — a second Batch would double the shelf count
    and a StockMovement(type='IN') would show a delivery that never happened.
    So the quantity change is written as ONE ADJUST movement carrying the
    DIFFERENCE, signed:  +5 means five units were found, −5 means five were
    over-counted.  The stock number moves and the audit trail explains why.

    What gets rewritten, and why each one:
      batch.batch_number / expiry_date  — the identity of the physical box
      batch.mrp / selling_price         — the price on the pack (GST-inclusive)
      batch.purchase_price              — the POST-discount cost, because that
                                          is what invoice_items snapshots and
                                          therefore what locks in profit
      stock_purchases.cost_price        — the un-discounted S.Rate, so the row
                                          still matches the paper invoice
      stock_purchases discount/GST/total— recomputed by compute_purchase_totals,
                                          the same helper Add Stock uses, so a
                                          corrected line and a fresh one can
                                          never disagree by a paisa

    ⚠ SUPPLIER CREDIT IS DELIBERATELY NOT TOUCHED.  The credit ledger records
    what was agreed with the distributor; silently moving a debt because someone
    fixed a typo would make the supplier's statement stop reconciling with ours.
    The caller surfaces this in the confirmation message so a real invoice
    correction is settled from the Supplier Credit page, on purpose.

    Returns a dict describing what changed.  The caller commits.
    """
    product = db.get(Product, batch.product_id)

    # --- Identity fields ----------------------------------------------------
    if data.batch_number is not None:
        batch.batch_number = data.batch_number.strip()
    if data.expiry_date is not None:
        batch.expiry_date = parse_expiry_month(data.expiry_date)
    if data.scheme_label is not None:
        # An empty string means "there was no scheme after all".
        batch.scheme_label = data.scheme_label.strip() or None

    # --- Price on the pack --------------------------------------------------
    # GST is inclusive in MRP, so the selling price IS the MRP (CLAUDE.md §4).
    if data.selling_price is not None:
        batch.mrp = data.selling_price
        batch.selling_price = data.selling_price
        # Keep the product's cached strip/unit prices in step, exactly as Add
        # Stock does, so search and billing quote the corrected price.
        if product is not None and product.is_strip:
            product.unit_mrp = data.selling_price
            if data.strip_mrp is not None:
                product.strip_mrp = data.strip_mrp
            elif product.units_per_strip:
                product.strip_mrp = _round(data.selling_price * product.units_per_strip)

    # --- Quantity: the ADJUST movement --------------------------------------
    delta = 0
    if data.quantity is not None:
        delta = int(data.quantity) - int(batch.quantity_available or 0)
        if delta != 0:
            batch.quantity_available = int(data.quantity)
            # quantity_received moves by the same amount.  It is the "how many
            # ever existed" figure; leaving it behind would make a corrected
            # batch look as though most of it had already been sold.
            batch.quantity_received = max(
                int(batch.quantity_received or 0) + delta, int(data.quantity)
            )
            db.add(StockMovement(
                batch_id=batch.id,
                movement_type="ADJUST",   # the domain's word for a correction
                quantity=delta,           # signed: + found, − over-counted
                reference=f"EDIT-{batch.batch_number or batch.id}",
                user_id=user_id,
            ))

    # --- The purchase row ---------------------------------------------------
    purchase = (
        db.query(StockPurchase)
        .filter(StockPurchase.batch_id == batch.id)
        .order_by(StockPurchase.id.desc())
        .first()
    )

    totals = None
    if purchase is not None:
        if data.purchase_price is not None:
            purchase.cost_price = data.purchase_price
        if data.selling_price is not None:
            purchase.mrp = data.selling_price
        if data.discount_percent is not None:
            purchase.discount_percent = data.discount_percent
        if data.scheme_label is not None:
            purchase.scheme_label = data.scheme_label.strip() or None
        # The paid quantity follows the stock correction: if the pharmacist
        # typed 100 where they meant 10, both the shelf AND the invoice line
        # were wrong by the same 90.  Bonus units were free, so they never
        # counted toward the paid quantity and are excluded here too.
        if delta != 0:
            purchase.quantity = max(0, int(purchase.quantity or 0) + delta)

        # ONE recomputation, from the same helper Add Stock uses.
        totals = compute_purchase_totals(
            paid_quantity=purchase.quantity,
            cost_price=purchase.cost_price,
            gst_rate=product.gst_rate if product else None,
            discount_percent=purchase.discount_percent,
        )
        purchase.discount_amount = totals["discount_per_unit"]
        purchase.effective_cost  = totals["effective_cost"]
        purchase.gst_on_purchase = totals["gst_on_purchase"]
        purchase.total_cost      = totals["total_cost"]

        # The batch stores the POST-discount cost — that is what gets snapshotted
        # onto an invoice line and therefore what locks in profit at sale time.
        batch.purchase_price = totals["effective_cost"]
    elif data.purchase_price is not None:
        # Stock that came in through the older GRN flow has no purchase row.
        # There is nothing to apply a discount to, so the batch keeps the plain
        # cost it was given.
        batch.purchase_price = data.purchase_price

    db.flush()

    return {
        "quantity_delta":  delta,
        "effective_cost":  totals["effective_cost"] if totals else batch.purchase_price,
        "gst_on_purchase": totals["gst_on_purchase"] if totals else None,
        "total_cost":      totals["total_cost"] if totals else None,
        "purchase_changed": purchase is not None and (
            delta != 0 or data.purchase_price is not None or data.discount_percent is not None
        ),
    }


def get_purchase_history(
    db: Session,
    *,
    limit: int = 50,
    offset: int = 0,
    search: Optional[str] = None,
    supplier_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
) -> dict:
    """
    Return a paginated list of past stock-in events, newest first.

    Joins StockPurchase → Product / Supplier / Batch / User so each row carries
    the product name, supplier name, batch details, and who recorded it.

    Filters (all optional):
      search       — matches product name OR supplier name (case-insensitive)
      supplier_id  — only this supplier
      date_from    — invoice date on/after this day
      date_to      — invoice date on/before this day
    """
    q = (
        db.query(StockPurchase)
        .join(Product, StockPurchase.product_id == Product.id)
        .join(Supplier, StockPurchase.supplier_id == Supplier.id)
    )

    if search:
        pattern = f"%{search}%"
        q = q.filter(Product.name.ilike(pattern) | Supplier.name.ilike(pattern))
    if supplier_id:
        q = q.filter(StockPurchase.supplier_id == supplier_id)
    if date_from:
        q = q.filter(StockPurchase.supplier_invoice_date >= date_from)
    if date_to:
        q = q.filter(StockPurchase.supplier_invoice_date <= date_to)

    total = q.count()
    rows = (
        q.order_by(StockPurchase.created_at.desc(), StockPurchase.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    # Resolve the "added by" display name in one small lookup (few users).
    user_names = {u.id: (u.full_name or u.username) for u in db.query(User).all()}

    items = [
        {
            "id":                      p.id,
            "product_id":              p.product_id,
            "product_name":            p.product.name if p.product else "—",
            "supplier_id":             p.supplier_id,
            "supplier_name":           p.supplier.name if p.supplier else "—",
            "supplier_invoice_number": p.supplier_invoice_number,
            "supplier_invoice_date":   p.supplier_invoice_date,
            "batch_id":                p.batch_id,
            "batch_number":            p.batch.batch_number if p.batch else None,
            "expiry_date":             p.batch.expiry_date if p.batch else None,
            "quantity":                p.quantity,
            "mrp":                     p.mrp,
            "cost_price":              p.cost_price,
            "added_by":                user_names.get(p.created_by),
            "created_at":              p.created_at,
            "scheme_label":            p.scheme_label,
            "bonus_quantity":          p.bonus_quantity or 0,
        }
        for p in rows
    ]

    return {"items": items, "total": total, "limit": limit, "offset": offset}


# ---------------------------------------------------------------------------
# Alert queries
# ---------------------------------------------------------------------------

def get_low_stock_products(db: Session) -> list[dict]:
    """
    Return active products whose current non-expired stock is below
    their min_stock_level.

    We load all active products and compute stock in Python rather than
    in a correlated SQL subquery, so we can reuse get_product_stock()
    and keep the logic in one place.  The product count in a pharmacy
    is typically small enough that this is not a performance concern.
    """
    products = db.query(Product).filter(Product.is_active == True).all()
    low = []
    for p in products:
        stock = get_product_stock(db, p.id)
        if stock < p.min_stock_level:
            low.append({
                "id":              p.id,
                "name":            p.name,
                "generic_name":    p.generic_name,
                "barcode":         p.barcode,
                "current_stock":   stock,
                "min_stock_level": p.min_stock_level,
                "gst_rate":        p.gst_rate,
                "is_active":       p.is_active,
            })
    return low


def get_expiry_alerts(db: Session) -> dict:
    """
    Return batches grouped by how close they are to expiring.

    Returns a dict:
      {
        "expired":     [...],   # already past expiry
        "expires_30":  [...],   # 0–30 days left
        "expires_60":  [...],   # 31–60 days left
      }
    Batches with more than 60 days left are NOT included — there is nothing to
    act on yet.

    WHY ONLY THREE BUCKETS:
    The page used to have five (7 / 30 / 60 / 90 day sections on top of
    "expired"), which split the same shelf of medicine across rows that all
    needed the same decision.  A 7-day bucket is not a different action from a
    30-day one — both mean "send it back or discount it now" — and 90 days is
    too far out to do anything about, so it read as noise.  Three buckets map
    one-to-one onto the three real states: too late, act now, act soon.
    Batches inside 7 days now sit in the 30-day bucket.

    Each item also carries, for the Expiry Alerts table:
      supplier_name   — who we bought this batch from (via stock_purchases),
                        or None if we have no purchase record for the batch.
      cost_price      — the rate-card purchase price recorded on the
                        stock_purchase (may be None — it is skippable on old rows).
      discount_*      — the supplier discount given on that purchase, so the
                        table can show "5% (₹3.00/strip)".
      effective_cost  — cost_price − discount; what the medicine REALLY cost.
      est_loss        — the money actually lost if this batch expires (see below),
                        or None when we cannot work it out (no cost recorded).
      return_*        — the gross / GST / net figures for sending this batch
                        back, so every section can offer a Return to Supplier
                        button and preview the value without a second request.
    """
    # Only look at batches that still have stock — no point alerting on empty ones.
    batches = (
        db.query(Batch)
        .filter(Batch.quantity_available > 0)
        .join(Batch.product)   # loads product name in the same query
        .all()
    )

    # ------------------------------------------------------------------
    # Look up the supplier + recorded cost for each batch.
    #
    # The chain is:  batches → stock_purchases → suppliers.
    # We deliberately read the cost from stock_purchases (NOT batch.purchase_price),
    # because Add Stock stores 0 on the batch when the cost is left blank, but keeps
    # the stock_purchase cost_price as NULL — so stock_purchases is the honest source
    # of "did we actually record what we paid?".
    # ------------------------------------------------------------------
    batch_ids = [b.id for b in batches]
    purchase_by_batch: dict[int, StockPurchase] = {}
    if batch_ids:
        purchases = (
            db.query(StockPurchase)
            .filter(StockPurchase.batch_id.in_(batch_ids))
            .all()
        )
        for p in purchases:
            # One stock-in per batch is expected; keep the first if there are more.
            purchase_by_batch.setdefault(p.batch_id, p)

    # Imported here rather than at module top so the dependency direction stays
    # one-way (supplier_return_service already reads inventory models).  Reusing
    # its arithmetic means the value previewed on this page and the value the
    # return modal writes can never disagree.
    from app.services.supplier_return_service import (
        calculate_return_value, split_scheme_units,
    )

    result: dict = {
        "expired":    [],
        "expires_30": [],
        "expires_60": [],
    }
    today = get_today_ist()

    for b in batches:
        days = (b.expiry_date - today).days

        # --- Which section does this batch belong in? ------------------------
        # Three buckets, three actions.  Anything with more than 60 days left is
        # not actionable yet and is skipped entirely.
        if days < 0:
            key = "expired"
        elif days <= 30:
            key = "expires_30"
        elif days <= 60:
            key = "expires_60"
        else:
            continue

        # The per-batch status string (EXPIRED / WARN_7 / WARN_30 …) is still the
        # shared classification used by badges elsewhere in the app, so it is
        # reported as-is even though the sections no longer map 1:1 to it.
        status = get_expiry_status(b.expiry_date)

        # Resolve supplier name + recorded cost from the stock_purchase record.
        purchase = purchase_by_batch.get(b.id)
        supplier_name = purchase.supplier.name if (purchase and purchase.supplier) else None
        cost_price = purchase.cost_price if purchase else None

        # --- What the medicine really cost ----------------------------------
        # A supplier discount ("5% trade discount") means we paid less than the
        # rate card, so every loss figure below must work from the discounted
        # price.  Old rows have no effective_cost — fall back to cost_price,
        # which is exactly right for a purchase that had no discount.
        discount_percent = purchase.discount_percent if purchase else None
        discount_amount  = purchase.discount_amount if purchase else None
        effective_cost   = purchase.effective_cost if purchase else None
        if effective_cost is None or effective_cost <= 0:
            effective_cost = cost_price

        # --- Estimated loss --------------------------------------------------
        # When expired stock is returned to the supplier, the pharmacy gets the
        # COST price back — the only real loss is the GST already paid on it.
        #   est_loss = quantity × effective_cost × (gst_rate / 100)
        # Note effective_cost, NOT cost_price: the discount was already taken off
        # what we handed over, so charging the loss against the rate card would
        # overstate it.
        # If we never recorded a cost (None or 0) we cannot compute this, so we
        # return None and the UI shows a "—" with a hint instead of a fake ₹0.00.
        gst_rate = b.product.gst_rate  # e.g. Decimal("12") for 12%
        if effective_cost is not None and effective_cost > 0:
            est_loss = (
                Decimal(b.quantity_available) * effective_cost * gst_rate / Decimal("100")
            )
        else:
            est_loss = None

        # --- Return-to-supplier preview --------------------------------------
        # Every section now offers a Return to Supplier button, so every row
        # needs the three figures the modal will show.  Only the PAID units carry
        # value — scheme bonus units were free, so the supplier owes nothing for
        # them (same split the return modal applies).
        paid_available, _bonus_available = split_scheme_units(
            b.quantity_available, b.bonus_quantity or 0, b.quantity_received,
        )
        if effective_cost is not None and effective_cost > 0:
            values = calculate_return_value(paid_available, effective_cost, gst_rate)
            return_gross = values["gross_value"]
            return_gst   = values["gst_deduction"]
            return_net   = values["net_return_value"]
        else:
            return_gross = return_gst = return_net = None

        item = {
            "id":                 b.id,
            "product_id":         b.product_id,
            "product_name":       b.product.name,
            "supplier_id":        b.supplier_id,
            "supplier_name":      supplier_name,
            "batch_number":       b.batch_number,
            "mrp":                b.mrp,
            "purchase_price":     b.purchase_price,
            "cost_price":         cost_price,
            # Supplier discount, per individual unit.  The table pairs these
            # with units_per_strip below to read "5% (₹3.00/strip)".
            "discount_percent":   discount_percent,
            "discount_amount":    discount_amount,
            "effective_cost":     effective_cost,
            "gst_rate":           gst_rate,
            # Strip info so the table can present per-unit money per STRIP,
            # which is how the pharmacist buys and thinks about it.
            "is_strip":           bool(b.product.is_strip),
            "units_per_strip":    b.product.units_per_strip,
            "selling_price":      b.selling_price,
            "mfg_date":           b.mfg_date,
            "expiry_date":        b.expiry_date,
            "quantity_received":  b.quantity_received,
            "quantity_available": b.quantity_available,
            "days_to_expiry":     days,
            "expiry_status":      status,
            "est_loss":           est_loss,
            # Return preview (same arithmetic as the Return to Supplier modal).
            "return_gross_value": return_gross,
            "return_gst_loss":    return_gst,
            "return_net_value":   return_net,
            "created_at":         b.created_at,
        }
        result[key].append(item)

    # Canonical headline count — distinct products across ALL alert buckets.
    # (The buckets include expired stock and stop at 60 days, which is exactly
    #  what count_expiry_alert_products() counts, so the page headline, the
    #  sidebar badge and the Dashboard card always show the same number.)
    alert_product_ids = {
        item["product_id"]
        for bucket in result.values()
        for item in bucket
    }
    result["alert_product_count"] = len(alert_product_ids)

    return result
