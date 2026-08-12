"""
Business logic for the Credit Management module.

Key rules:
  - When credit is given: create CreditTransaction(CREDIT) + update CreditAccount
    + schedule 3 reminder rows with pre-rendered message text.
  - When payment arrives: create CreditTransaction(PAYMENT) + apply to oldest
    unpaid CREDIT transactions first (FIFO) + update CreditAccount.
  - Outstanding on CreditAccount is always outstanding = total_credit - total_paid
    — never derive it from transaction sums at query time to keep reads fast.
  - Overdue status: any PENDING/PARTIAL CREDIT tx where due_date < today.
    We update the status column lazily when get_patient_credit_summary() is called.
"""
import logging
from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from app.models.credit import CreditAccount, CreditReminder, CreditTransaction
from app.models.patients import Patient

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Message template helpers
# ---------------------------------------------------------------------------

PHONE = "6001666271"


def _render_messages(patient_name: str, amount: Decimal, due_date: date, remind_type: str):
    """
    Return (message_en, message_as) for the given reminder type.

    All three reminder types get the pharmacy phone number embedded so the
    patient can call without searching for it.
    """
    amount_str = f"₹{amount:,.0f}"
    date_str   = due_date.strftime("%d %b %Y")

    if remind_type == "3_DAYS_BEFORE":
        en = (
            f"Dear {patient_name}, your payment of {amount_str} to Health Care "
            f"Centre is due on {date_str}. Please arrange payment. "
            f"Call {PHONE} for help."
        )
        as_ = (
            f"প্ৰিয় {patient_name}, স্বাস্থ্য সেৱা কেন্দ্ৰলৈ আপোনাৰ {amount_str} "
            f"পৰিশোধৰ তাৰিখ {date_str}। অনুগ্ৰহ কৰি পৰিশোধৰ ব্যৱস্থা কৰক। "
            f"সহায়ৰ বাবে {PHONE} ত ফোন কৰক।"
        )

    elif remind_type == "DUE_DATE":
        en = (
            f"Dear {patient_name}, your payment of {amount_str} to Health Care "
            f"Centre is due TODAY. Please visit us or call {PHONE}."
        )
        as_ = (
            f"প্ৰিয় {patient_name}, স্বাস্থ্য সেৱা কেন্দ্ৰলৈ আপোনাৰ {amount_str} "
            f"পৰিশোধৰ তাৰিখ আজি। অনুগ্ৰহ কৰি আমাৰ ওচৰলৈ আহক বা {PHONE} ত ফোন কৰক।"
        )

    else:  # 2_DAYS_AFTER
        en = (
            f"Dear {patient_name}, your payment of {amount_str} to Health Care "
            f"Centre was due on {date_str} and is now overdue. Please clear your "
            f"dues. Call {PHONE}."
        )
        as_ = (
            f"প্ৰিয় {patient_name}, স্বাস্থ্য সেৱা কেন্দ্ৰলৈ আপোনাৰ {amount_str} "
            f"পৰিশোধৰ তাৰিখ {date_str} আছিল আৰু এতিয়া বাকী আছে। অনুগ্ৰহ কৰি "
            f"বকেয়া পৰিশোধ কৰক। {PHONE} ত ফোন কৰক।"
        )

    return en, as_


# ---------------------------------------------------------------------------
# Core service functions
# ---------------------------------------------------------------------------

def get_or_create_account(db: Session, patient_id: int) -> CreditAccount:
    """Return existing CreditAccount or create a blank one if none exists."""
    account = db.query(CreditAccount).filter(CreditAccount.patient_id == patient_id).first()
    if account is None:
        account = CreditAccount(
            patient_id=patient_id,
            total_credit=Decimal("0"),
            total_paid=Decimal("0"),
            outstanding=Decimal("0"),
        )
        db.add(account)
        db.flush()   # assign account.id before we reference it
    return account


def create_credit_transaction(
    db: Session,
    patient_id: int,
    invoice_id: int | None,
    credit_amount: Decimal,
    due_date: date,
    created_by: int | None,
    notes: str | None = None,
) -> CreditTransaction:
    """
    Record that a patient owes credit_amount, due by due_date.

    Steps:
      1. Get/create CreditAccount.
      2. Create CreditTransaction(type='CREDIT').
      3. Update running totals on CreditAccount.
      4. Schedule three reminder rows (3 days before, on due date, 2 days after).
    """
    patient = db.get(Patient, patient_id)
    if patient is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Patient not found")

    # --- Transaction row -------------------------------------------------
    tx = CreditTransaction(
        patient_id=patient_id,
        invoice_id=invoice_id,
        type="CREDIT",
        amount=credit_amount,
        due_date=due_date,
        paid_amount=Decimal("0"),
        balance=credit_amount,
        status="PENDING",
        notes=notes,
        created_by=created_by,
    )
    db.add(tx)
    db.flush()  # assign tx.id before creating reminders that reference it

    # --- Update CreditAccount --------------------------------------------
    account = get_or_create_account(db, patient_id)
    account.total_credit += credit_amount
    account.outstanding  += credit_amount
    account.last_activity = datetime.utcnow()

    # --- Schedule 3 reminders -------------------------------------------
    reminder_schedule = [
        ("3_DAYS_BEFORE", due_date - timedelta(days=3)),
        ("DUE_DATE",      due_date),
        ("2_DAYS_AFTER",  due_date + timedelta(days=2)),
    ]

    for remind_type, remind_date in reminder_schedule:
        msg_en, msg_as = _render_messages(
            patient.name, credit_amount, due_date, remind_type
        )
        db.add(CreditReminder(
            credit_tx_id=tx.id,
            patient_id=patient_id,
            remind_date=remind_date,
            remind_type=remind_type,
            status="PENDING",
            message_en=msg_en,
            message_as=msg_as,
        ))

    db.flush()
    return tx


def record_payment(
    db: Session,
    patient_id: int,
    amount: Decimal,
    notes: str | None,
    created_by: int | None,
    credit_tx_id: int | None = None,
    payment_mode: str = "CASH",
) -> CreditAccount:
    """
    Record that a patient paid `amount` toward their credit balance.

    Payment is applied FIFO — oldest CREDIT transactions first.
    If credit_tx_id is provided, that specific transaction is paid first, then
    any remainder goes to the next oldest.

    payment_mode ('CASH' or 'UPI') is stored on the PAYMENT row so the Credit
    History tab and any cash-reconciliation report can tell counter cash from
    digital payments.

    Also cancels (SKIPPED) any pending reminders for transactions that become
    CLEARED as a result of this payment.
    """
    # --- Create PAYMENT transaction row ----------------------------------
    payment_tx = CreditTransaction(
        patient_id=patient_id,
        type="PAYMENT",
        amount=amount,
        balance=Decimal("0"),   # not meaningful for payment rows
        payment_mode=payment_mode,
        notes=notes,
        created_by=created_by,
    )
    db.add(payment_tx)

    # --- Gather open CREDIT transactions to pay off ---------------------
    open_txs_q = (
        db.query(CreditTransaction)
        .filter(
            CreditTransaction.patient_id == patient_id,
            CreditTransaction.type == "CREDIT",
            CreditTransaction.status.in_(["PENDING", "PARTIAL", "OVERDUE"]),
        )
        .order_by(CreditTransaction.created_at)
    )

    # If a specific transaction was targeted, put it first
    if credit_tx_id is not None:
        targeted = db.get(CreditTransaction, credit_tx_id)
        others   = [t for t in open_txs_q.all() if t.id != credit_tx_id]
        open_txs = ([targeted] if targeted else []) + others
    else:
        open_txs = open_txs_q.all()

    # --- Apply payment FIFO ----------------------------------------------
    remaining = amount
    for tx in open_txs:
        if remaining <= 0:
            break
        if tx.balance <= remaining:
            # This transaction is fully cleared
            remaining     -= tx.balance
            tx.paid_amount += tx.balance
            tx.balance      = Decimal("0")
            tx.status       = "CLEARED"
            # Cancel pending reminders for this now-cleared transaction
            for reminder in (
                db.query(CreditReminder)
                .filter(
                    CreditReminder.credit_tx_id == tx.id,
                    CreditReminder.status == "PENDING",
                )
                .all()
            ):
                reminder.status = "SKIPPED"
        else:
            # Partially paid
            tx.paid_amount += remaining
            tx.balance      -= remaining
            tx.status        = "PARTIAL"
            remaining        = Decimal("0")

    # --- Update CreditAccount -------------------------------------------
    account = get_or_create_account(db, patient_id)
    account.total_paid    += amount
    account.outstanding   = max(Decimal("0"), account.outstanding - amount)
    account.last_activity  = datetime.utcnow()

    db.flush()
    return account


def reduce_invoice_credit(
    db: Session,
    invoice_id: int,
    amount: Decimal,
    user_id: int | None = None,
) -> Decimal:
    """
    Cancel part of the credit raised by an invoice, because those goods came back.

    WHY THIS IS NOT record_payment():
    A payment means the patient handed over money — it grows total_paid and
    belongs in the cash reconciliation.  A return means the debt should never
    have existed: no money moved in either direction.  Booking it as a payment
    would show cash arriving at the counter that nobody ever received.
    So this walks the debt DOWN instead: the CREDIT transaction's amount and
    balance shrink, and so does the account's total_credit and outstanding.

    Returns how much was actually cancelled, which is capped at the invoice's
    remaining balance — a return worth more than the outstanding debt cannot
    push the account into negative territory.  (The rest of such a refund is
    money the patient already paid, and is handed back at the counter.)
    """
    if amount <= 0:
        return Decimal("0")

    # Every open CREDIT row raised by this invoice, oldest first.
    txs = (
        db.query(CreditTransaction)
        .filter(
            CreditTransaction.invoice_id == invoice_id,
            CreditTransaction.type == "CREDIT",
        )
        .order_by(CreditTransaction.created_at)
        .all()
    )
    if not txs:
        return Decimal("0")

    patient_id = txs[0].patient_id
    account = get_or_create_account(db, patient_id)

    remaining = Decimal(str(amount))
    cancelled = Decimal("0")

    for tx in txs:
        if remaining <= 0:
            break
        take = min(tx.balance, remaining)
        if take <= 0:
            continue

        tx.amount  = tx.amount - take
        tx.balance = tx.balance - take
        remaining -= take
        cancelled += take

        if tx.balance <= 0:
            tx.status = "CLEARED"
            # Nothing left to chase, so stop the reminder messages going out.
            for reminder in (
                db.query(CreditReminder)
                .filter(
                    CreditReminder.credit_tx_id == tx.id,
                    CreditReminder.status == "PENDING",
                )
                .all()
            ):
                reminder.status = "SKIPPED"
        elif tx.paid_amount and tx.paid_amount > 0:
            tx.status = "PARTIAL"

        tx.notes = ((tx.notes + " | ") if tx.notes else "") + f"Reduced Rs.{take} by return"

    if cancelled > 0:
        # total_credit shrinks too: this credit was never really extended.
        account.total_credit = max(Decimal("0"), (account.total_credit or Decimal("0")) - cancelled)
        account.outstanding  = max(Decimal("0"), (account.outstanding or Decimal("0")) - cancelled)
        account.last_activity = datetime.utcnow()

    db.flush()
    return cancelled


def get_due_reminders(db: Session) -> list[CreditReminder]:
    """
    Return all CreditReminders where remind_date <= today and status=PENDING.
    Called by the daily scheduler to queue messages.
    """
    today = date.today()
    return (
        db.query(CreditReminder)
        .filter(
            CreditReminder.remind_date <= today,
            CreditReminder.status == "PENDING",
        )
        .all()
    )


def _refresh_overdue_statuses(db: Session, patient_id: int | None = None) -> None:
    """
    Lazily mark PENDING/PARTIAL transactions as OVERDUE once they are past
    their due_date, and stamp was_overdue=True at the same time.

    This is the ONE place a transaction becomes overdue.  Everything that needs
    fresh statuses calls this — per-patient (pass patient_id) or across all
    patients (pass nothing) — so the status and the permanent was_overdue flag
    can never disagree.

    was_overdue is only ever set to True here, never back to False.  That is
    what makes "has this patient been late before?" survive the patient paying
    up and the status flipping to CLEARED.
    """
    today = date.today()
    q = db.query(CreditTransaction).filter(
        CreditTransaction.type == "CREDIT",
        CreditTransaction.status.in_(["PENDING", "PARTIAL"]),
        CreditTransaction.due_date < today,
    )
    if patient_id is not None:
        q = q.filter(CreditTransaction.patient_id == patient_id)

    stale = q.all()
    for tx in stale:
        tx.status      = "OVERDUE"
        tx.was_overdue = True
    if stale:
        db.flush()


def _mark_overdue(db: Session, patient_id: int) -> None:
    """Per-patient wrapper kept for readability at the call sites."""
    _refresh_overdue_statuses(db, patient_id)


def _overdue_transactions(db: Session, patient_id: int) -> list[CreditTransaction]:
    """
    All CREDIT transactions for this patient currently sitting in OVERDUE,
    oldest due_date first.

    NOTE: this reads the stored status column, so callers should run
    _mark_overdue() first to make sure the statuses are up to date.
    """
    return (
        db.query(CreditTransaction)
        .filter(
            CreditTransaction.patient_id == patient_id,
            CreditTransaction.type == "CREDIT",
            CreditTransaction.status == "OVERDUE",
        )
        .order_by(CreditTransaction.due_date)
        .all()
    )


def is_defaulter(db: Session, patient_id: int) -> bool:
    """
    True when the patient has at least one credit transaction past its due
    date and still unpaid.

    Statuses are refreshed first so a transaction that fell overdue since the
    last page load is counted correctly.
    """
    _mark_overdue(db, patient_id)
    return bool(_overdue_transactions(db, patient_id))


def get_patient_credit_summary(db: Session, patient_id: int):
    """
    Return CreditAccount + last 20 CreditTransactions for a patient, plus the
    four flags the billing screen uses to decide which banner to show:

      is_defaulter        — has an unpaid transaction past its due date (red banner)
      has_outstanding     — owes anything at all (amber banner)
      outstanding_amount  — how much is owed
      oldest_overdue_date — due date of the oldest overdue transaction

    Updates overdue status before returning.
    """
    # Lazily update overdue flag
    _mark_overdue(db, patient_id)

    account = db.query(CreditAccount).filter(CreditAccount.patient_id == patient_id).first()
    if account is None:
        # Return an empty account so the frontend can render "no credit" gracefully
        empty = {
            "id": 0, "patient_id": patient_id,
            "total_credit": Decimal("0"), "total_paid": Decimal("0"),
            "outstanding": Decimal("0"), "last_activity": None,
            "created_at": datetime.utcnow(),
        }
        return {
            "account":             empty,
            "transactions":        [],
            "is_defaulter":        False,
            "has_outstanding":     False,
            "outstanding_amount":  Decimal("0"),
            "oldest_overdue_date": None,
        }

    txs = (
        db.query(CreditTransaction)
        .filter(CreditTransaction.patient_id == patient_id)
        .order_by(CreditTransaction.created_at.desc())
        .limit(20)
        .all()
    )

    overdue     = _overdue_transactions(db, patient_id)
    outstanding = account.outstanding or Decimal("0")

    return {
        "account":             account,
        "transactions":        txs,
        "is_defaulter":        bool(overdue),
        "has_outstanding":     outstanding > 0,
        "outstanding_amount":  outstanding,
        "oldest_overdue_date": overdue[0].due_date if overdue else None,
    }


# ---------------------------------------------------------------------------
# Credit history (all patients, both transaction types)
# ---------------------------------------------------------------------------

def get_credit_history(
    db: Session,
    limit: int = 50,
    offset: int = 0,
    patient_id: int | None = None,
    tx_type: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
):
    """
    Return a page of credit transactions (CREDIT and PAYMENT) across all
    patients, newest first, joined to patient name and invoice number.

    balance_after
    -------------
    We do not store a per-transaction running balance, so we replay it: for
    each patient in the page we walk that patient's transactions from the
    beginning of time, adding CREDIT amounts and subtracting PAYMENT amounts.
    The value at each row is what the patient owed immediately after that
    transaction.  This is done once per patient (not once per row) so a page
    of 50 rows costs at most 50 extra queries in the worst case, and usually
    far fewer because rows cluster by patient.
    """
    from app.models.billing import Invoice

    q = db.query(CreditTransaction)

    if patient_id is not None:
        q = q.filter(CreditTransaction.patient_id == patient_id)
    if tx_type in ("CREDIT", "PAYMENT"):
        q = q.filter(CreditTransaction.type == tx_type)
    if date_from is not None:
        q = q.filter(CreditTransaction.created_at >= datetime.combine(date_from, datetime.min.time()))
    if date_to is not None:
        # date_to is inclusive — compare against the END of that day
        q = q.filter(CreditTransaction.created_at <= datetime.combine(date_to, datetime.max.time()))

    total = q.count()

    rows = (
        q.order_by(CreditTransaction.created_at.desc(), CreditTransaction.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    # --- Replay running balances, one patient at a time -------------------
    balances: dict[int, dict[int, Decimal]] = {}   # patient_id -> {tx_id: balance_after}

    for pid in {r.patient_id for r in rows}:
        running = Decimal("0")
        per_tx: dict[int, Decimal] = {}
        all_txs = (
            db.query(CreditTransaction)
            .filter(CreditTransaction.patient_id == pid)
            .order_by(CreditTransaction.created_at, CreditTransaction.id)
            .all()
        )
        for t in all_txs:
            if t.type == "CREDIT":
                running += t.amount
            else:
                running -= t.amount
            # Balance can never be negative from the patient's point of view
            per_tx[t.id] = max(Decimal("0"), running)
        balances[pid] = per_tx

    # --- Look up invoice numbers in one query -----------------------------
    invoice_ids = {r.invoice_id for r in rows if r.invoice_id}
    invoice_numbers: dict[int, str] = {}
    if invoice_ids:
        for inv_id, inv_no in (
            db.query(Invoice.id, Invoice.invoice_number)
            .filter(Invoice.id.in_(invoice_ids))
            .all()
        ):
            invoice_numbers[inv_id] = inv_no

    items = []
    for r in rows:
        patient = r.patient
        items.append({
            "id":             r.id,
            "created_at":     r.created_at,
            "patient_id":     r.patient_id,
            "patient_name":   patient.name if patient else f"Patient #{r.patient_id}",
            "type":           r.type,
            "amount":         r.amount,
            "payment_mode":   r.payment_mode,
            "invoice_number": invoice_numbers.get(r.invoice_id),
            "notes":          r.notes,
            "balance_after":  balances.get(r.patient_id, {}).get(r.id, Decimal("0")),
        })

    return {"total": total, "items": items}


# ---------------------------------------------------------------------------
# Defaulters
# ---------------------------------------------------------------------------

def get_defaulters(db: Session):
    """
    Return every patient who has EVER been late, worst risk first.

    A defaulter is anyone with at least one credit transaction carrying
    was_overdue=True, whatever its current status.  That deliberately includes
    patients who eventually paid up: the pharmacist wants to know "has this
    person been late before?" before handing out more credit, and a cleared
    debt does not erase that history.

    Two different notions of "overdue" appear in each row — keep them apart:
      times_overdue       — LIFETIME count of transactions that ever went late
      oldest_overdue_date — oldest transaction that is late RIGHT NOW,
                            or None when everything late has since been paid
      days_overdue        — days since that date, 0 when nothing is currently late

    Risk thresholds (kept here so the UI never has to duplicate them):
      HIGH   — outstanding > ₹1000 OR currently overdue by more than 30 days
      MEDIUM — outstanding > ₹500  OR currently overdue by more than 15 days
      LOW    — any other defaulter (including "was late once, all paid up now")

    Risk deliberately keys off the CURRENT position, not the lifetime count:
    someone who paid everything off is low risk today even if they were once
    late, and their history is still visible in times_overdue.

    NOTE: was_overdue only starts being recorded from the migration that added
    the column.  Transactions that were late and paid off BEFORE that point had
    their status overwritten to CLEARED and cannot be recovered, so lifetime
    counts are accurate going forward, not retroactively.
    """
    today = date.today()

    # Refresh overdue statuses (and stamp was_overdue) across all patients first
    _refresh_overdue_statuses(db)

    # Every transaction that has EVER been late — this is the defaulter set.
    # was_overdue is nullable on rows created before the migration, so compare
    # against True explicitly rather than relying on truthiness of NULL.
    ever_late = (
        db.query(CreditTransaction)
        .filter(
            CreditTransaction.type == "CREDIT",
            CreditTransaction.was_overdue.is_(True),
        )
        .all()
    )

    # Group by patient
    by_patient: dict[int, list[CreditTransaction]] = {}
    for tx in ever_late:
        by_patient.setdefault(tx.patient_id, []).append(tx)

    result = []
    for pid, txs in by_patient.items():
        account = db.query(CreditAccount).filter(CreditAccount.patient_id == pid).first()
        outstanding = (account.outstanding if account else Decimal("0")) or Decimal("0")

        # Currently-late transactions drive the date and the risk level.
        # The full `txs` list (lifetime) only drives times_overdue.
        still_late   = [t for t in txs if t.status == "OVERDUE" and t.due_date]
        oldest_due   = min(t.due_date for t in still_late) if still_late else None
        days_overdue = (today - oldest_due).days if oldest_due else 0

        # Most recent PAYMENT this patient made, if any
        last_payment = (
            db.query(CreditTransaction)
            .filter(
                CreditTransaction.patient_id == pid,
                CreditTransaction.type == "PAYMENT",
            )
            .order_by(CreditTransaction.created_at.desc())
            .first()
        )

        if outstanding > Decimal("1000") or days_overdue > 30:
            risk = "HIGH"
        elif outstanding > Decimal("500") or days_overdue > 15:
            risk = "MEDIUM"
        else:
            risk = "LOW"

        patient = db.get(Patient, pid)
        result.append({
            "patient_id":          pid,
            "name":                patient.name if patient else f"Patient #{pid}",
            "phone":               patient.mobile if patient else None,
            "outstanding":         outstanding,
            # Lifetime count — how many separate bills this patient let go late
            "times_overdue":       len(txs),
            "oldest_overdue_date": oldest_due,
            "days_overdue":        days_overdue,
            "last_payment_date":   last_payment.created_at if last_payment else None,
            "risk_level":          risk,
            # True = owes late money today, False = was late before but square now.
            # Lets the UI tell an active problem from a historical one.
            "currently_overdue":   bool(still_late),
        })

    # Worst first: HIGH before MEDIUM before LOW; within a risk level, patients
    # who owe late money today come before purely historical defaulters, then
    # most days overdue, then biggest lifetime offender.
    rank = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    result.sort(key=lambda r: (
        rank[r["risk_level"]],
        0 if r["currently_overdue"] else 1,
        -r["days_overdue"],
        -r["times_overdue"],
    ))
    return result


def get_all_credit_summary(db: Session):
    """
    Aggregate stats for the Credit dashboard page.
    Also marks overdue transactions across ALL patients.
    """
    # Bulk update overdue statuses across all patients
    _refresh_overdue_statuses(db)

    # Get all accounts with outstanding > 0
    accounts = (
        db.query(CreditAccount)
        .filter(CreditAccount.outstanding > 0)
        .all()
    )

    # For each account, find the oldest unpaid due_date and worst status
    patients_list = []
    total_outstanding = Decimal("0")
    overdue_count     = 0
    overdue_amount    = Decimal("0")

    for acc in accounts:
        # Open transactions for this patient
        open_txs = (
            db.query(CreditTransaction)
            .filter(
                CreditTransaction.patient_id == acc.patient_id,
                CreditTransaction.type == "CREDIT",
                CreditTransaction.status.in_(["PENDING", "PARTIAL", "OVERDUE"]),
            )
            .order_by(CreditTransaction.due_date)
            .all()
        )

        if not open_txs:
            continue

        oldest_due = open_txs[0].due_date if open_txs else None
        is_overdue = any(t.status == "OVERDUE" for t in open_txs)

        # Worst status: OVERDUE > PARTIAL > PENDING
        if is_overdue:
            worst = "OVERDUE"
        elif any(t.status == "PARTIAL" for t in open_txs):
            worst = "PARTIAL"
        else:
            worst = "PENDING"

        patient = acc.patient
        patients_list.append({
            "patient_id":      acc.patient_id,
            "name":            patient.name if patient else f"Patient #{acc.patient_id}",
            "phone":           patient.mobile if patient else None,
            "outstanding":     acc.outstanding,
            "oldest_due_date": oldest_due,
            "is_overdue":      is_overdue,
            "last_activity":   acc.last_activity,
            "status":          worst,
        })

        total_outstanding += acc.outstanding
        if is_overdue:
            overdue_count  += 1
            overdue_amount += acc.outstanding

    return {
        "total_outstanding":          total_outstanding,
        "total_patients_with_credit": len(patients_list),
        "overdue_count":              overdue_count,
        "overdue_amount":             overdue_amount,
        "patients":                   patients_list,
    }


def send_due_credit_reminders(db: Session) -> int:
    """
    Queue all due credit reminders into message_queue.
    Returns the number of reminders queued.

    This is called once a day (from the lifespan scheduler in main.py).
    """
    from app.models.followup import MessageQueue

    reminders = get_due_reminders(db)
    count = 0

    for reminder in reminders:
        patient = db.get(Patient, reminder.patient_id)
        if patient is None or not patient.mobile:
            # Skip if patient has no phone — can't send message
            reminder.status = "SKIPPED"
            continue

        # Queue English message
        if reminder.message_en:
            db.add(MessageQueue(
                patient_id=reminder.patient_id,
                follow_up_id=None,
                channel="SMS",
                recipient_mobile=patient.mobile,
                language="EN",
                message_body=reminder.message_en,
                status="QUEUED",
                scheduled_at=datetime.utcnow(),
            ))

        # Queue Assamese message
        if reminder.message_as:
            db.add(MessageQueue(
                patient_id=reminder.patient_id,
                follow_up_id=None,
                channel="SMS",
                recipient_mobile=patient.mobile,
                language="AS",
                message_body=reminder.message_as,
                status="QUEUED",
                scheduled_at=datetime.utcnow(),
            ))

        reminder.status  = "SENT"
        reminder.sent_at = datetime.utcnow()
        count += 1

    db.commit()
    logger.info("Credit reminders: queued %d", count)
    return count


def reschedule_reminders(db: Session, tx: CreditTransaction) -> None:
    """
    Cancel existing PENDING reminders for a transaction and create fresh
    ones based on the (updated) due_date.  Used by the due-date update endpoint.
    """
    # Cancel existing pending reminders
    existing = (
        db.query(CreditReminder)
        .filter(
            CreditReminder.credit_tx_id == tx.id,
            CreditReminder.status == "PENDING",
        )
        .all()
    )
    for r in existing:
        r.status = "SKIPPED"

    # Create new reminders with updated dates
    patient = db.get(Patient, tx.patient_id)
    if patient is None or tx.due_date is None:
        return

    schedule = [
        ("3_DAYS_BEFORE", tx.due_date - timedelta(days=3)),
        ("DUE_DATE",      tx.due_date),
        ("2_DAYS_AFTER",  tx.due_date + timedelta(days=2)),
    ]
    for remind_type, remind_date in schedule:
        msg_en, msg_as = _render_messages(
            patient.name, tx.amount, tx.due_date, remind_type
        )
        db.add(CreditReminder(
            credit_tx_id=tx.id,
            patient_id=tx.patient_id,
            remind_date=remind_date,
            remind_type=remind_type,
            status="PENDING",
            message_en=msg_en,
            message_as=msg_as,
        ))
    db.flush()
