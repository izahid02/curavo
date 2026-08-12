"""
Business logic for SUPPLIER credit — money the pharmacy owes its suppliers.

Everything that touches supplier balances lives here so the routers stay thin
and there is exactly ONE place where the arithmetic happens.  The two entry
points that matter most:

  create_credit_for_purchase()  — called from the Add Stock flow when the
                                  pharmacist does not pay the full invoice
  record_payment()              — called when we pay a supplier back
  apply_return_value()          — called when expired stock goes back and its
                                  value is knocked off what we owe

THE INVARIANT (every function here must preserve it):
    account.outstanding == SUM(balance of all open CREDIT transactions)
    account.advance_balance == value we have with the supplier but not yet used

Both counters are denormalised caches.  They exist so the dashboard can answer
"what do we owe?" without replaying the ledger, and they are ONLY ever moved by
functions in this file.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session

from app.models.inventory import Supplier
from app.models.supplier_credit import (
    SupplierCreditAccount, SupplierCreditTransaction, SupplierPaymentReminder,
)

# Two-decimal money rounding.  Every value we store goes through _money() so a
# stray floating-point-looking value like 1232.0000001 can never reach the DB.
_CENTS = Decimal("0.01")


def _money(value) -> Decimal:
    """Coerce anything numeric to a 2-decimal Decimal (rupees and paise)."""
    if value is None:
        return Decimal("0.00")
    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    return value.quantize(_CENTS)


# ---------------------------------------------------------------------------
# Account helpers
# ---------------------------------------------------------------------------

def get_or_create_account(db: Session, supplier_id: int) -> SupplierCreditAccount:
    """
    Fetch this supplier's credit account, creating an empty one on first use.

    We create lazily rather than seeding an account for every supplier, so the
    "suppliers with credit" list stays naturally short — a supplier we always
    pay cash never gets a row at all.
    """
    account = (
        db.query(SupplierCreditAccount)
        .filter(SupplierCreditAccount.supplier_id == supplier_id)
        .first()
    )
    if account is None:
        account = SupplierCreditAccount(
            supplier_id=supplier_id,
            total_credit=Decimal("0.00"),
            total_paid=Decimal("0.00"),
            outstanding=Decimal("0.00"),
            advance_balance=Decimal("0.00"),
            created_at=datetime.utcnow(),
        )
        db.add(account)
        db.flush()   # assigns account.id without committing
    return account


def _touch(account: SupplierCreditAccount) -> None:
    """Stamp last_activity — used to sort 'most recently active' supplier lists."""
    account.last_activity = datetime.utcnow()


# ---------------------------------------------------------------------------
# Reminders
# ---------------------------------------------------------------------------

def schedule_payment_reminders(
    db: Session,
    credit_tx: SupplierCreditTransaction,
) -> list[SupplierPaymentReminder]:
    """
    Create the three standard nudges for one CREDIT transaction.

    5 days before the due date, on the due date, and 2 days after it.  The
    "after" one is what turns into the red overdue warning on the dashboard.

    Returns an empty list when the transaction has no due date — an open-ended
    credit cannot be reminded about.
    """
    if credit_tx.due_date is None:
        return []

    offsets = [
        (-5, "5_DAYS_BEFORE"),
        (0,  "DUE_DATE"),
        (2,  "2_DAYS_AFTER"),
    ]

    reminders: list[SupplierPaymentReminder] = []
    for days, remind_type in offsets:
        reminder = SupplierPaymentReminder(
            credit_tx_id=credit_tx.id,
            supplier_id=credit_tx.supplier_id,
            remind_date=credit_tx.due_date + timedelta(days=days),
            remind_type=remind_type,
            status="PENDING",
            created_at=datetime.utcnow(),
        )
        db.add(reminder)
        reminders.append(reminder)

    return reminders


def _close_reminders_for(db: Session, credit_tx_id: int) -> None:
    """
    Mark a transaction's outstanding reminders as SHOWN once the debt is gone.

    We deliberately do NOT delete them — keeping the rows means a later audit
    can still see that reminders existed for this debt.
    """
    for reminder in (
        db.query(SupplierPaymentReminder)
        .filter(
            SupplierPaymentReminder.credit_tx_id == credit_tx_id,
            SupplierPaymentReminder.status == "PENDING",
        )
        .all()
    ):
        reminder.status = "SHOWN"


# ---------------------------------------------------------------------------
# Creating credit (from the Add Stock flow)
# ---------------------------------------------------------------------------

def use_advance_for_purchase(
    db: Session,
    *,
    supplier_id: int,
    amount: Decimal,
    stock_purchase_id: Optional[int] = None,
    notes: Optional[str] = None,
    created_by: Optional[int] = None,
) -> Decimal:
    """
    Spend some of a supplier's ADVANCE balance on a new stock purchase (Feature A).

    The pharmacist explicitly chose to offset this delivery with advance they
    are holding (overpayment or return credit).  We reduce advance_balance and
    write an ADVANCE_USED transaction so the ledger shows where the advance went.

    Returns the amount ACTUALLY applied — clamped to whatever advance is really
    available, so a stale figure from the UI can never push the balance negative.
    """
    account   = get_or_create_account(db, supplier_id)
    available = _money(account.advance_balance)
    applied   = min(available, _money(amount))
    if applied <= 0:
        return Decimal("0.00")

    account.advance_balance = _money(available - applied)

    tx = SupplierCreditTransaction(
        supplier_id=supplier_id,
        stock_purchase_id=stock_purchase_id,
        type="ADVANCE_USED",
        amount=applied,
        paid_amount=applied,
        balance=Decimal("0.00"),
        status="CLEARED",
        notes=notes or "Advance used for stock purchase",
        created_by=created_by,
        created_at=datetime.utcnow(),
    )
    db.add(tx)
    _touch(account)
    db.flush()
    return applied


def create_credit_for_purchase(
    db: Session,
    *,
    supplier_id: int,
    amount: Decimal,
    due_date: Optional[date],
    stock_purchase_id: Optional[int] = None,
    notes: Optional[str] = None,
    created_by: Optional[int] = None,
    consume_advance: bool = True,
) -> SupplierCreditTransaction:
    """
    Record that we took stock worth `amount` without paying for it.

    Creates the CREDIT transaction, bumps the supplier's outstanding balance,
    and schedules the three payment reminders.

    IMPORTANT — advance offset: if this supplier already owes US money (because
    we previously overpaid or returned expired stock), that advance is consumed
    FIRST and only the remainder becomes new debt.  Skipping this would leave
    the pharmacy simultaneously owing and being owed by the same supplier,
    which is never what the pharmacist means.

    Pass consume_advance=False when the caller has ALREADY handled the advance
    explicitly (the Add Stock flow does this via use_advance_for_purchase, so
    the pharmacist's chosen advance_used is the single source of truth and the
    advance is not silently applied twice).
    """
    amount  = _money(amount)
    account = get_or_create_account(db, supplier_id)

    # --- Consume any advance we are holding with this supplier -------------
    advance = _money(account.advance_balance)
    if consume_advance and advance > 0:
        used = min(advance, amount)
        account.advance_balance = _money(advance - used)
        amount = _money(amount - used)
        if notes is None and used > 0:
            notes = f"Advance of Rs.{used} applied against this purchase"

    credit_tx = SupplierCreditTransaction(
        supplier_id=supplier_id,
        stock_purchase_id=stock_purchase_id,
        type="CREDIT",
        amount=amount,
        due_date=due_date,
        paid_amount=Decimal("0.00"),
        balance=amount,
        # An already-zero credit (fully covered by advance) is born CLEARED.
        status="CLEARED" if amount <= 0 else "PENDING",
        notes=notes,
        created_by=created_by,
        created_at=datetime.utcnow(),
    )
    db.add(credit_tx)
    db.flush()   # need credit_tx.id for the reminders

    if amount > 0:
        account.total_credit = _money(_money(account.total_credit) + amount)
        account.outstanding  = _money(_money(account.outstanding) + amount)
        schedule_payment_reminders(db, credit_tx)

    _touch(account)
    return credit_tx


def record_purchase_payment(
    db: Session,
    *,
    supplier_id: int,
    amount: Decimal,
    payment_mode: str,
    stock_purchase_id: Optional[int] = None,
    notes: Optional[str] = None,
    created_by: Optional[int] = None,
) -> SupplierCreditTransaction:
    """
    Log the cash/UPI we handed over AT THE TIME of a delivery.

    This is bookkeeping only — it does NOT reduce `outstanding`, because the
    matching CREDIT row was already created for the unpaid portion alone.
    Recording it keeps the supplier ledger complete: the pharmacist can see
    "invoice was ₹7,200, we paid ₹2,000 cash, ₹5,200 went on credit".

    Contrast with record_payment() below, which IS a debt repayment.
    """
    amount  = _money(amount)
    account = get_or_create_account(db, supplier_id)

    payment_tx = SupplierCreditTransaction(
        supplier_id=supplier_id,
        stock_purchase_id=stock_purchase_id,
        type="PAYMENT",
        amount=amount,
        payment_mode=payment_mode,
        paid_amount=amount,
        balance=Decimal("0.00"),   # payment rows are not "payable"
        status="CLEARED",
        notes=notes or "Paid at time of delivery",
        created_by=created_by,
        created_at=datetime.utcnow(),
    )
    db.add(payment_tx)

    # total_paid tracks every rupee that left the till for this supplier,
    # including money paid up front, so the ledger totals reconcile.
    account.total_paid = _money(_money(account.total_paid) + amount)
    _touch(account)
    return payment_tx


# ---------------------------------------------------------------------------
# Paying a supplier back (FIFO)
# ---------------------------------------------------------------------------

def _open_credits(
    db: Session,
    supplier_id: int,
    prioritise_tx_id: Optional[int] = None,
) -> list[SupplierCreditTransaction]:
    """
    All still-owed CREDIT rows for a supplier, OLDEST FIRST (FIFO).

    If prioritise_tx_id is given, that transaction is moved to the front so a
    targeted payment settles the intended invoice before spilling over into
    older ones.
    """
    query = (
        db.query(SupplierCreditTransaction)
        .filter(
            SupplierCreditTransaction.supplier_id == supplier_id,
            SupplierCreditTransaction.type == "CREDIT",
            SupplierCreditTransaction.status.in_(["PENDING", "PARTIAL", "OVERDUE"]),
        )
        .order_by(SupplierCreditTransaction.created_at, SupplierCreditTransaction.id)
    )

    if prioritise_tx_id is not None:
        targeted = db.get(SupplierCreditTransaction, prioritise_tx_id)
        others   = [t for t in query.all() if t.id != prioritise_tx_id]
        # Only honour the target if it really is an open credit for this supplier
        if targeted is not None and targeted.supplier_id == supplier_id \
                and targeted.type == "CREDIT" and targeted.balance > 0:
            return [targeted] + others
        return others

    return query.all()


def _apply_fifo(
    db: Session,
    supplier_id: int,
    amount: Decimal,
    prioritise_tx_id: Optional[int] = None,
) -> Decimal:
    """
    Knock `amount` off the supplier's open credits, oldest first.

    Returns the LEFTOVER that could not be applied because every debt is
    settled — the caller decides whether that becomes an advance.

    This is shared by both repayments and return adjustments, so the two paths
    can never drift apart in how they consume debt.
    """
    remaining = _money(amount)

    for tx in _open_credits(db, supplier_id, prioritise_tx_id):
        if remaining <= 0:
            break

        balance = _money(tx.balance)
        if balance <= remaining:
            # This debt is fully settled by what is left of the payment.
            remaining      = _money(remaining - balance)
            tx.paid_amount = _money(_money(tx.paid_amount) + balance)
            tx.balance     = Decimal("0.00")
            tx.status      = "CLEARED"
            _close_reminders_for(db, tx.id)
        else:
            # Partially settled — debt survives, status reflects that.
            tx.paid_amount = _money(_money(tx.paid_amount) + remaining)
            tx.balance     = _money(balance - remaining)
            tx.status      = "PARTIAL"
            remaining      = Decimal("0.00")

    return remaining


def record_payment(
    db: Session,
    *,
    supplier_id: int,
    amount: Decimal,
    payment_mode: str = "CASH",
    notes: Optional[str] = None,
    credit_tx_id: Optional[int] = None,
    created_by: Optional[int] = None,
) -> dict:
    """
    Pay a supplier back.  Applied FIFO — oldest debt first.

    Overpayment is not an error: whatever is left after every debt is cleared
    becomes an ADVANCE transaction, and advance_balance grows.  That advance is
    automatically consumed by the next credit purchase (see
    create_credit_for_purchase).

    Returns a small dict the router turns into the API response.
    """
    amount  = _money(amount)
    account = get_or_create_account(db, supplier_id)

    # --- The payment row itself (the money leaving the till) ---------------
    payment_tx = SupplierCreditTransaction(
        supplier_id=supplier_id,
        type="PAYMENT",
        amount=amount,
        payment_mode=payment_mode,
        paid_amount=amount,
        balance=Decimal("0.00"),
        status="CLEARED",
        notes=notes,
        created_by=created_by,
        created_at=datetime.utcnow(),
    )
    db.add(payment_tx)

    # --- Apply it against open debts, oldest first -------------------------
    leftover = _apply_fifo(db, supplier_id, amount, prioritise_tx_id=credit_tx_id)
    applied  = _money(amount - leftover)

    account.total_paid  = _money(_money(account.total_paid) + amount)
    account.outstanding = _money(max(Decimal("0.00"),
                                     _money(account.outstanding) - applied))

    # --- Overpayment becomes an advance ------------------------------------
    advance_tx = None
    if leftover > 0:
        advance_tx = SupplierCreditTransaction(
            supplier_id=supplier_id,
            type="ADVANCE",
            amount=leftover,
            paid_amount=Decimal("0.00"),
            balance=Decimal("0.00"),
            status="CLEARED",
            notes="Overpayment held as advance with supplier",
            created_by=created_by,
            created_at=datetime.utcnow(),
        )
        db.add(advance_tx)
        account.advance_balance = _money(_money(account.advance_balance) + leftover)

    _touch(account)
    db.flush()

    return {
        "payment_tx_id":   payment_tx.id,
        "amount":          amount,
        "applied_to_debt": applied,
        "advance_created": leftover,
        "outstanding":     _money(account.outstanding),
        "advance_balance": _money(account.advance_balance),
    }


# ---------------------------------------------------------------------------
# Return adjustments (Feature 2 hooks into this)
# ---------------------------------------------------------------------------

def apply_return_value(
    db: Session,
    *,
    supplier_id: int,
    net_value: Decimal,
    notes: Optional[str] = None,
    created_by: Optional[int] = None,
) -> dict:
    """
    Apply the value of returned expired stock to a supplier's balance.

    If we owe them money → a RETURN_ADJUSTMENT transaction reduces the debt
    (FIFO, oldest first), exactly like a payment but without cash moving.
    If we owe them nothing → the value becomes an ADVANCE: they now hold
    that much of our money, to be used against the next credit purchase.

    Returns a dict describing what happened so the return endpoint can report
    "credit reduced by ₹1,232" versus "₹1,232 held as advance".
    """
    net_value = _money(net_value)
    account   = get_or_create_account(db, supplier_id)

    outstanding_before = _money(account.outstanding)

    if outstanding_before > 0:
        # --- Reduce the debt ----------------------------------------------
        adjustment_tx = SupplierCreditTransaction(
            supplier_id=supplier_id,
            type="RETURN_ADJUSTMENT",
            amount=net_value,
            paid_amount=net_value,
            balance=Decimal("0.00"),
            status="CLEARED",
            notes=notes or "Expired stock returned to supplier",
            created_by=created_by,
            created_at=datetime.utcnow(),
        )
        db.add(adjustment_tx)

        leftover = _apply_fifo(db, supplier_id, net_value)
        applied  = _money(net_value - leftover)

        account.outstanding = _money(max(Decimal("0.00"),
                                         outstanding_before - applied))

        # Return value bigger than the whole debt — the excess is an advance.
        if leftover > 0:
            account.advance_balance = _money(_money(account.advance_balance) + leftover)

        _touch(account)
        db.flush()
        return {
            "credit_adjusted": True,
            "credit_tx_id":    adjustment_tx.id,
            "applied":         applied,
            "advance_created": leftover,
            "outstanding":     _money(account.outstanding),
            "advance_balance": _money(account.advance_balance),
        }

    # --- No debt — the whole value becomes an advance ----------------------
    advance_tx = SupplierCreditTransaction(
        supplier_id=supplier_id,
        type="ADVANCE",
        amount=net_value,
        paid_amount=Decimal("0.00"),
        balance=Decimal("0.00"),
        status="CLEARED",
        notes=notes or "Expired stock returned — no outstanding credit, held as advance",
        created_by=created_by,
        created_at=datetime.utcnow(),
    )
    db.add(advance_tx)
    account.advance_balance = _money(_money(account.advance_balance) + net_value)

    _touch(account)
    db.flush()
    return {
        "credit_adjusted": False,
        "credit_tx_id":    advance_tx.id,
        "applied":         Decimal("0.00"),
        "advance_created": net_value,
        "outstanding":     _money(account.outstanding),
        "advance_balance": _money(account.advance_balance),
    }


# ---------------------------------------------------------------------------
# Reads — overdue refresh, summary, per-supplier ledger
# ---------------------------------------------------------------------------

def refresh_overdue_statuses(db: Session) -> int:
    """
    Flip any open credit whose due date has passed to OVERDUE.

    Called at the top of the read endpoints rather than on a timer, because
    this app is offline-first and may sit unopened for days — statuses must be
    correct whenever someone actually looks, not whenever a scheduler ran.

    Returns how many rows changed (useful in tests).
    """
    today = date.today()
    stale = (
        db.query(SupplierCreditTransaction)
        .filter(
            SupplierCreditTransaction.type == "CREDIT",
            SupplierCreditTransaction.status.in_(["PENDING", "PARTIAL"]),
            SupplierCreditTransaction.due_date.isnot(None),
            SupplierCreditTransaction.due_date < today,
            SupplierCreditTransaction.balance > 0,
        )
        .all()
    )
    for tx in stale:
        tx.status = "OVERDUE"
    if stale:
        db.commit()
    return len(stale)


def get_due_rows(db: Session, *, within_days: int = 7) -> dict:
    """
    Split open supplier debts into "due soon" and "already overdue".

    Shared by /summary and /due-soon so the dashboard widget and the credit tab
    can never disagree about what is overdue.
    """
    refresh_overdue_statuses(db)

    today  = date.today()
    cutoff = today + timedelta(days=within_days)

    open_txs = (
        db.query(SupplierCreditTransaction)
        .filter(
            SupplierCreditTransaction.type == "CREDIT",
            SupplierCreditTransaction.status.in_(["PENDING", "PARTIAL", "OVERDUE"]),
            SupplierCreditTransaction.balance > 0,
        )
        .order_by(SupplierCreditTransaction.due_date)
        .all()
    )

    upcoming, overdue = [], []
    for tx in open_txs:
        supplier = db.get(Supplier, tx.supplier_id)
        row = {
            "supplier_id":    tx.supplier_id,
            "supplier_name":  supplier.name if supplier else "Unknown supplier",
            "credit_tx_id":   tx.id,
            "amount_due":     _money(tx.balance),
            "due_date":       tx.due_date,
            "days_until_due": (tx.due_date - today).days if tx.due_date else None,
        }
        if tx.due_date is None:
            continue                      # open-ended credit — never "due"
        if tx.due_date < today:
            overdue.append(row)
        elif tx.due_date <= cutoff:
            upcoming.append(row)

    return {"upcoming": upcoming, "overdue": overdue}


def get_summary(db: Session) -> dict:
    """Totals for the Credit Management tab's three summary cards."""
    refresh_overdue_statuses(db)

    accounts = (
        db.query(SupplierCreditAccount)
        .filter(
            (SupplierCreditAccount.outstanding > 0)
            | (SupplierCreditAccount.advance_balance > 0)
        )
        .all()
    )

    total_outstanding = sum((_money(a.outstanding) for a in accounts), Decimal("0.00"))
    total_advance     = sum((_money(a.advance_balance) for a in accounts), Decimal("0.00"))
    with_credit       = len([a for a in accounts if _money(a.outstanding) > 0])

    due = get_due_rows(db, within_days=7)
    total_overdue = sum((r["amount_due"] for r in due["overdue"]), Decimal("0.00"))

    return {
        "total_outstanding":           _money(total_outstanding),
        "total_advance":               _money(total_advance),
        "total_overdue":               _money(total_overdue),
        "total_suppliers_with_credit": with_credit,
        "upcoming_dues":               due["upcoming"],
        "overdue":                     due["overdue"],
    }


def get_supplier_rows(db: Session) -> list[dict]:
    """
    One row per supplier that has any credit activity — powers the table on
    the Credit Management tab.
    """
    refresh_overdue_statuses(db)
    today = date.today()

    rows = []
    for account in db.query(SupplierCreditAccount).all():
        outstanding = _money(account.outstanding)
        advance     = _money(account.advance_balance)
        if outstanding <= 0 and advance <= 0:
            continue   # settled suppliers do not clutter the table

        supplier = db.get(Supplier, account.supplier_id)

        # Next due date = earliest still-open credit for this supplier
        next_tx = (
            db.query(SupplierCreditTransaction)
            .filter(
                SupplierCreditTransaction.supplier_id == account.supplier_id,
                SupplierCreditTransaction.type == "CREDIT",
                SupplierCreditTransaction.status.in_(["PENDING", "PARTIAL", "OVERDUE"]),
                SupplierCreditTransaction.balance > 0,
                SupplierCreditTransaction.due_date.isnot(None),
            )
            .order_by(SupplierCreditTransaction.due_date)
            .first()
        )

        next_due = next_tx.due_date if next_tx else None
        if next_due is None:
            status = "ADVANCE" if outstanding <= 0 else "PENDING"
        elif next_due < today:
            status = "OVERDUE"
        elif (next_due - today).days <= 5:
            status = "DUE_SOON"
        else:
            status = "PENDING"

        rows.append({
            "supplier_id":    account.supplier_id,
            "supplier_name":  supplier.name if supplier else "Unknown supplier",
            "supplier_phone": supplier.phone if supplier else None,
            "outstanding":    outstanding,
            "advance":        advance,
            "total_credit":   _money(account.total_credit),
            "total_paid":     _money(account.total_paid),
            "next_due_date":  next_due,
            "days_until_due": (next_due - today).days if next_due else None,
            "status":         status,
            "last_activity":  account.last_activity,
        })

    # Most urgent first: overdue at the top, then soonest due.
    rows.sort(key=lambda r: (r["days_until_due"] is None, r["days_until_due"] or 0))
    return rows


def get_supplier_ledger(db: Session, supplier_id: int) -> Optional[dict]:
    """
    Full credit history for one supplier — the [View History] slide-in panel.

    Returns None when the supplier does not exist so the router can 404.
    """
    supplier = db.get(Supplier, supplier_id)
    if supplier is None:
        return None

    refresh_overdue_statuses(db)
    account = get_or_create_account(db, supplier_id)

    transactions = (
        db.query(SupplierCreditTransaction)
        .filter(SupplierCreditTransaction.supplier_id == supplier_id)
        .order_by(SupplierCreditTransaction.created_at.desc(),
                  SupplierCreditTransaction.id.desc())
        .all()
    )

    tx_out = []
    for tx in transactions:
        # Resolve the supplier's invoice number through the stock purchase, so
        # the ledger reads like the paper invoices the pharmacist filed.
        invoice_number = None
        if tx.stock_purchase_id and tx.stock_purchase is not None:
            invoice_number = tx.stock_purchase.supplier_invoice_number

        tx_out.append({
            "id":                tx.id,
            "type":              tx.type,
            "amount":            _money(tx.amount),
            "paid_amount":       _money(tx.paid_amount),
            "balance":           _money(tx.balance),
            "due_date":          tx.due_date,
            "status":            tx.status,
            "payment_mode":      tx.payment_mode,
            "stock_purchase_id": tx.stock_purchase_id,
            "invoice_number":    invoice_number,
            "notes":             tx.notes,
            "created_at":        tx.created_at,
        })

    return {
        "supplier": {
            "id":             supplier.id,
            "name":           supplier.name,
            "phone":          supplier.phone,
            "contact_person": supplier.contact_person,
            "gst_number":     supplier.gst_number,
            "dl_number":      supplier.dl_number,
        },
        "account": {
            "outstanding":     _money(account.outstanding),
            "advance_balance": _money(account.advance_balance),
            "total_credit":    _money(account.total_credit),
            "total_paid":      _money(account.total_paid),
            "last_activity":   account.last_activity,
        },
        "transactions": tx_out,
    }
