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
from decimal import Decimal
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
#    which is already expired OR expiring within the next 90 days."
#
# It counts PRODUCTS, not batches (two batches of the same medicine = one alert),
# and it INCLUDES already-expired stock (still needs attention / a return).

EXPIRY_ALERT_HORIZON_DAYS = 90


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


def _compute_scheme(data: AddStockRequest, cost: Decimal) -> dict:
    """
    Work out the bonus/paid split for a purchase scheme (Feature B).

    Pure arithmetic, no database access.  Given the pharmacist's PAID quantity
    and a scheme like "5+1", it returns how many free bonus units are earned and
    the resulting total that enters stock.

      bonus_quantity = (paid_quantity // scheme_buy) x scheme_free
      total_quantity = paid_quantity + bonus_quantity
      effective_cost = cost x paid_quantity / total_quantity   (informational)

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

    # Whole scheme sets only: 47 units on "5+1" earns 9 free (9 complete sets),
    # not a fractional bonus.  This mirrors how distributors actually count.
    bonus_quantity = (paid_quantity // data.scheme_buy) * data.scheme_free
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
    cost = data.cost_price if data.cost_price is not None else Decimal("0")

    # --- Bonus / scheme purchase (Feature B) --------------------------------
    # The pharmacist enters the PAID quantity.  On a scheme like "5+1", every 5
    # paid units earn 1 free — so 50 paid on "5+1" adds 10 free, 60 total.  The
    # free units enter stock at zero extra cost; the supplier invoice (and hence
    # any credit) is still based on the PAID quantity only.
    scheme = _compute_scheme(data, cost)
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
        purchase_price=cost,
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
        scheme_label=scheme["scheme_label"],
        bonus_quantity=scheme["bonus_quantity"],
        created_by=user_id,
    )
    db.add(purchase)
    db.flush()   # assigns purchase.id so credit rows can link back to it

    # --- Step 4: supplier credit (Feature 1) --------------------------------
    # Work out what this delivery cost and how much of it is still unpaid.
    credit_info = _record_purchase_payment_and_credit(db, data, purchase, user_id)

    # Return the batch plus the credit outcome so the router can report both.
    return batch, purchase, credit_info


def _record_purchase_payment_and_credit(
    db: Session,
    data: AddStockRequest,
    purchase: StockPurchase,
    user_id: int,
) -> dict:
    """
    Split one stock delivery into "paid now" and "owed later", and write the
    matching supplier-credit rows.

    THE ARITHMETIC:
        invoice_total = supplier_invoice_total, or quantity x cost_price
        credit_amount = invoice_total - amount_paid

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

    quantity = Decimal(str(data.quantity))
    cost     = data.cost_price if data.cost_price is not None else Decimal("0")

    # Prefer the explicit invoice total when given; otherwise derive it.
    # `quantity` is the PAID quantity (scheme bonus units are free), so this
    # stays correct whether or not a scheme was applied.
    if data.supplier_invoice_total is not None:
        invoice_total = Decimal(str(data.supplier_invoice_total))
    else:
        invoice_total = quantity * cost
    invoice_total = invoice_total.quantize(Decimal("0.01"))

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
        "expired":  [...],   # already past expiry
        "warn_7":   [...],   # <= 7 days
        "warn_30":  [...],   # <= 30 days
        "warn_60":  [...],   # <= 60 days
        "warn_90":  [...],   # <= 90 days
      }
    Batches with > 90 days remaining (status="OK") are NOT included —
    there is nothing to alert about.

    Each item also carries, for the Expiry Alerts table:
      supplier_name — who we bought this batch from (via stock_purchases),
                      or None if we have no purchase record for the batch.
      cost_price    — the purchase price recorded on the stock_purchase
                      (may be None — the pharmacist can skip it).
      est_loss      — the money actually lost if this batch expires (see below),
                      or None when we cannot work it out (no cost recorded).
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

    result: dict = {
        "expired": [],
        "warn_7":  [],
        "warn_30": [],
        "warn_60": [],
        "warn_90": [],
    }
    today = get_today_ist()

    for b in batches:
        status = get_expiry_status(b.expiry_date)
        if status == "OK":
            continue   # nothing to alert about

        days = (b.expiry_date - today).days

        # Resolve supplier name + recorded cost from the stock_purchase record.
        purchase = purchase_by_batch.get(b.id)
        supplier_name = purchase.supplier.name if (purchase and purchase.supplier) else None
        cost_price = purchase.cost_price if purchase else None

        # --- Estimated loss --------------------------------------------------
        # When expired stock is returned to the supplier, the pharmacy gets the
        # COST price back — the only real loss is the GST already paid on it.
        #   est_loss = quantity × cost_price × (gst_rate / 100)
        # If we never recorded a cost (None or 0) we cannot compute this, so we
        # return None and the UI shows a "—" with a hint instead of a fake ₹0.00.
        gst_rate = b.product.gst_rate  # e.g. Decimal("12") for 12%
        if cost_price is not None and cost_price > 0:
            est_loss = (
                Decimal(b.quantity_available) * cost_price * gst_rate / Decimal("100")
            )
        else:
            est_loss = None

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
            "gst_rate":           gst_rate,
            "selling_price":      b.selling_price,
            "mfg_date":           b.mfg_date,
            "expiry_date":        b.expiry_date,
            "quantity_received":  b.quantity_received,
            "quantity_available": b.quantity_available,
            "days_to_expiry":     days,
            "expiry_status":      status,
            "est_loss":           est_loss,
            "created_at":         b.created_at,
        }
        # "EXPIRED" → "expired", "WARN_7" → "warn_7", etc.
        key = status.lower()
        result[key].append(item)

    # Canonical headline count — distinct products across ALL alert buckets.
    # (The buckets already exclude OK/>90-day stock and include expired stock,
    #  so this distinct-product set is exactly count_expiry_alert_products().)
    alert_product_ids = {
        item["product_id"]
        for bucket in result.values()
        for item in bucket
    }
    result["alert_product_count"] = len(alert_product_ids)

    return result
