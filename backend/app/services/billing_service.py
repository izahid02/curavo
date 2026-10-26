"""
Billing business logic.

This file contains the three core operations:
  1. get_next_invoice_number — generates HCC-YYYY-NNNNNN, thread-safe
  2. fefo_allocate           — picks which batches to deduct from (FEFO order)
  3. create_invoice          — the full sale transaction
  4. process_return          — reverses a sale

IMPORTANT RULES (from CLAUDE.md):
  - FEFO: sell from the batch expiring SOONEST first.  Skip expired batches.
  - Every stock change MUST write a StockMovement row.  Never change stock silently.
  - All money arithmetic uses Decimal, never float.
  - The entire create_invoice (invoice + items + stock + movements) runs in ONE
    database transaction.  The caller (router) calls db.commit() at the end;
    any exception before that rolls everything back automatically.
"""
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.billing import AuditLog, Invoice, InvoiceItem
from app.models.inventory import Batch, Product, StockMovement
from app.models.patients import Patient
from app.models.user import User
from app.schemas.billing import CreateInvoiceRequest
from app.services import costing, regulated_register


# ---------------------------------------------------------------------------
# Invoice numbering
# ---------------------------------------------------------------------------

def get_next_invoice_number(db: Session) -> str:
    """
    Generate the next sequential invoice number for the current year.
    Format: HCC-YYYY-NNNNNN  (e.g. HCC-2026-000001)

    Thread-safety: delegates to get_next_doc_number() which opens a
    BEGIN IMMEDIATE transaction on a dedicated connection, serialising all
    concurrent callers so they can never produce the same sequence number.
    """
    from app.database import get_next_doc_number
    year = date.today().year
    seq  = get_next_doc_number("INVOICE", year)
    return f"HCC-{year}-{seq:06d}"


# ---------------------------------------------------------------------------
# FEFO allocation
# ---------------------------------------------------------------------------

def fefo_allocate(
    db:                 Session,
    product_id:         int,
    quantity:           int,
    preferred_batch_id: int | None = None,
) -> list[dict]:
    """
    Decide which batches to take stock from to fulfil `quantity` units of
    `product_id`, using FEFO (First Expiry First Out) order.

    Rules:
      - Only batches with quantity_available > 0 that expire MORE than
        BILLING_MIN_EXPIRY_DAYS (30) days from now.  That single test rules out
        already-expired stock too, and it is deliberately the same rule the
        medicine search uses — what the pharmacist can see, they can bill, and
        nothing else.  Stock inside the 30-day window goes back to the supplier.
      - Sort by expiry_date ASC — earliest-expiring batch first
      - Fill the first batch; if it runs out, continue to the next
      - If total available stock is less than requested: raise HTTP 400

    preferred_batch_id: the batch the pharmacist actually picked in the search
    dropdown.  It is moved to the FRONT of the queue so their choice is what
    gets deducted; the rest of the list stays in FEFO order and only absorbs a
    shortfall.  An unknown or no-longer-sellable id is ignored (the batch may
    have emptied since the dropdown was rendered), leaving plain FEFO as a safe
    fallback rather than failing the sale.

    Returns a list like:
      [{"batch": <Batch>, "qty": 3}, {"batch": <Batch>, "qty": 2}]
    meaning "take 3 from batch A, then 2 from batch B".

    SQLite's single-writer model prevents concurrent stock conflicts, so no
    row-level locking is needed here.
    """
    # Import here rather than at module top: inventory_service imports from the
    # billing side in places, and a top-level import would make that circular.
    from app.services.inventory_service import BILLING_MIN_EXPIRY_DAYS
    from app.utils.dates import get_today_ist

    # A batch needs more than 30 days of shelf life left to be sellable.
    cutoff = get_today_ist() + timedelta(days=BILLING_MIN_EXPIRY_DAYS)

    batches = (
        db.query(Batch)
        .filter(
            Batch.product_id == product_id,
            Batch.expiry_date > cutoff,    # skips expired AND near-expiry stock
            Batch.quantity_available > 0,  # skip empty batches
        )
        .order_by(Batch.expiry_date)       # FEFO: earliest expiry first
        # SQLite uses file-level locking — only one writer at a time is
        # allowed anyway, so SELECT FOR UPDATE is unnecessary and unsupported.
        .all()
    )

    # Honour the pharmacist's explicit batch choice by pulling it to the front.
    # sorted() is stable, so False (= the chosen batch) sorts before True and
    # every other batch keeps its FEFO position behind it.
    if preferred_batch_id is not None:
        batches.sort(key=lambda b: b.id != preferred_batch_id)

    # Check whether enough stock exists across all valid batches
    total_available = sum(b.quantity_available for b in batches)
    if total_available < quantity:
        product = db.query(Product).filter(Product.id == product_id).first()
        name = product.name if product else f"Product #{product_id}"
        raise HTTPException(
            status_code=400,
            detail=(
                f"Insufficient sellable stock for {name}. Available: {total_available}. "
                f"(Batches expiring within {BILLING_MIN_EXPIRY_DAYS} days cannot be sold — "
                f"return them to the supplier.)"
            ),
        )

    # Fill from the earliest-expiring batch, then overflow to the next
    allocations: list[dict] = []
    remaining = quantity
    for batch in batches:
        if remaining <= 0:
            break
        take = min(batch.quantity_available, remaining)
        allocations.append({"batch": batch, "qty": take})
        remaining -= take

    return allocations


# ---------------------------------------------------------------------------
# Create invoice (the main billing transaction)
# ---------------------------------------------------------------------------

def create_invoice(db: Session, data: CreateInvoiceRequest, user_id: int) -> Invoice:
    """
    Create a complete invoice in a single database transaction.

    For each requested item:
      1. Run FEFO allocation to find which batch(es) to deduct from
      2. For each batch allocation:
         a. Compute taxable_amount, gst_amount, line_total  (Decimal math throughout)
         b. Create InvoiceItem row with snapshotted prices
         c. Deduct quantity from batch.quantity_available
         d. Write a StockMovement row (type='SALE') as the audit trail
      3. Sum up all subtotals and GST
      4. Create the Invoice header row
      5. Link all InvoiceItem rows to the invoice

    The caller (router) does db.commit() after this returns.
    Any exception before commit rolls everything back automatically.
    """
    # Generate the invoice number FIRST so it can be used as the
    # 'reference' field on stock movement rows.
    invoice_number = get_next_invoice_number(db)

    pending_items: list[InvoiceItem] = []
    subtotal  = Decimal("0")
    total_gst = Decimal("0")

    for bill_item in data.items:
        # Get batch allocations.  The batch the pharmacist picked in the search
        # dropdown (if any) is deducted first; anything left over falls back to
        # FEFO order.  This also validates that enough sellable stock exists.
        allocations = fefo_allocate(
            db,
            bill_item.product_id,
            bill_item.quantity,
            preferred_batch_id=bill_item.batch_id,
        )

        for alloc in allocations:
            batch: Batch = alloc["batch"]
            qty:   int   = alloc["qty"]

            # --- Financial calculations (all Decimal, no float) ----------------
            # GST-INCLUSIVE MODEL: selling_price IS the MRP (total incl. GST).
            # We extract GST from the MRP rather than adding it on top.
            # This way the customer pays exactly the MRP — adding extra GST
            # on top of MRP is illegal in India.
            #
            # Formula:
            #   line_total  = qty × MRP                       (what customer pays)
            #   gst_amount  = line_total × rate / (100+rate)  (GST extracted from MRP)
            #   taxable_amt = line_total − gst_amount          (excl-GST base)
            unit_price = batch.selling_price
            gst_rate   = batch.product.gst_rate
            quantity   = Decimal(str(qty))

            line_total     = (unit_price * quantity).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
            gst_amount     = (line_total * gst_rate / (Decimal('100') + gst_rate)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
            taxable_amount = (line_total - gst_amount).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

            # --- Snapshot prices onto the invoice line -------------------------
            # We copy unit_price, purchase_price, and gst_rate from the batch
            # at the moment of sale.  If prices change tomorrow, old invoices
            # are unaffected — the values are frozen here forever.
            item = InvoiceItem(
                # invoice_id will be set after the Invoice row is flushed below
                batch_id=batch.id,
                product_id=batch.product_id,
                quantity=qty,
                unit_price=unit_price,
                # The SAME cost the batch panel shows, so a sale's reported
                # profit matches the margin the pharmacist was promised when
                # the stock was booked in.  Snapshotted here and never read
                # again, so past invoices keep whatever was true on the day.
                purchase_price=costing.unit_cost(batch) or batch.purchase_price,
                gst_rate=gst_rate,
                line_total=line_total,
            )
            pending_items.append(item)

            # --- Deduct stock from this batch ----------------------------------
            # This is an in-memory change; the DB UPDATE happens when we flush.
            batch.quantity_available -= qty

            # --- Immutable audit row for every stock change -------------------
            db.add(StockMovement(
                batch_id=batch.id,
                movement_type="SALE",
                quantity=-qty,           # negative = stock going OUT
                reference=invoice_number,
                user_id=user_id,
            ))

            subtotal  += taxable_amount
            total_gst += gst_amount

        # Flush after each product so the next product's fefo_allocate
        # sees the updated quantity_available (important if two bill items
        # share the same batch, e.g. duplicate product_ids in the request).
        db.flush()

    # --- Apply home visit charge and discount ---------------------------------
    # The home visit / drip charge is a SERVICE fee, so it is added AFTER the
    # GST maths and is never taxed — it contributes nothing to subtotal or
    # total_gst, only to what the customer pays.
    home_visit = (
        data.home_visit_charge
        if getattr(data, "home_visit_charge", None) is not None
        else Decimal("0")
    ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    discount     = data.discount_amount if data.discount_amount is not None else Decimal("0")
    total_amount = subtotal + total_gst + home_visit - discount

    # --- Resolve credit fields -------------------------------------------
    # For CREDIT mode: amount_paid is what was paid today, the rest is owed.
    # For all other modes: amount_paid equals the full total.
    is_credit     = data.payment_method == "CREDIT"
    amount_paid   = data.amount_paid if is_credit else total_amount
    credit_amount = (total_amount - amount_paid) if is_credit else Decimal("0")

    # --- Create the invoice header --------------------------------------------
    # --- The register gate -------------------------------------------------
    # Before anything is written: if this bill contains a Schedule H1 medicine
    # or an MTP kit, the register has to be writable, and it cannot be written
    # without the patient's and the prescriber's details.
    #
    # Checked HERE, before the invoice row exists, so a refusal leaves nothing
    # behind.  The counter is also the only moment this information exists —
    # afterwards the customer has gone and the register gets filled in from
    # memory, which is how registers end up saying "walk-in".
    regulated = regulated_register.regulated_lines(db, pending_items)
    if regulated:
        patient = (
            db.query(Patient).filter(Patient.id == data.patient_id).first()
            if data.patient_id else None
        )
        try:
            regulated_register.check_details(
                regulated,
                patient,
                data.referred_by,
                getattr(data, "referred_by_address", None),
            )
        except regulated_register.RegisterDetailsMissing as exc:
            # 400, not 500: the pharmacist can fix this, and the message names
            # both what is missing and which medicine demanded it.
            raise HTTPException(status_code=400, detail=str(exc))

    invoice = Invoice(
        invoice_number=invoice_number,
        patient_id=data.patient_id,
        user_id=user_id,
        subtotal=subtotal,
        discount_amount=discount,
        gst_amount=total_gst,
        total_amount=total_amount,
        payment_method=data.payment_method,
        amount_paid=amount_paid,
        credit_amount=credit_amount,
        credit_due_date=data.credit_due_date if is_credit else None,
        status="COMPLETED",
        referred_by=data.referred_by or None,
        home_visit_charge=home_visit,
        home_visit_notes=getattr(data, "home_visit_notes", None) or None,
    )
    db.add(invoice)
    db.flush()   # assigns invoice.id so we can link the items below

    # --- The register rows ---------------------------------------------------
    # After the flush, so the invoice number and id are real; inside the same
    # transaction, so a sale that rolls back takes its register entry with it.
    # A register must never claim a sale that did not happen.
    if regulated:
        dispenser = db.query(User).filter(User.id == user_id).first() if user_id else None
        regulated_register.write_rows(
            db,
            regulated,
            invoice            = invoice,
            patient            = patient,
            prescriber_name    = data.referred_by,
            prescriber_address = getattr(data, "referred_by_address", None),
            dispensed_by_id    = user_id,
            dispensed_by_name  = getattr(dispenser, "full_name", None)
                                 or getattr(dispenser, "username", None),
        )

    # --- Link items to this invoice -------------------------------------------
    for item in pending_items:
        item.invoice_id = invoice.id
        db.add(item)

    # Flush so the invoice_items rows are visible to the follow-up service
    # when it queries them to build the medicine list (autoflush=False, so we
    # must flush manually here before any SELECT on invoice_items).
    db.flush()

    # --- Auto-create credit transaction if payment mode is CREDIT -----------
    # This links the invoice to the credit system so outstanding balance is
    # tracked automatically without the cashier needing to do extra steps.
    if is_credit and credit_amount > 0 and data.patient_id and data.credit_due_date:
        from app.services.credit_service import create_credit_transaction as _create_credit
        _create_credit(
            db,
            patient_id=data.patient_id,
            invoice_id=invoice.id,
            credit_amount=credit_amount,
            due_date=data.credit_due_date,
            created_by=user_id,
            notes=f"From invoice {invoice_number}",
        )

    # --- Auto-schedule follow-ups and refill reminders ----------------------
    if invoice.patient_id:
        patient = db.get(Patient, invoice.patient_id)
        if patient:
            # Day 2/5/10/30 wellness follow-ups: only for SELF_MEDICATION patients
            # (patients on prescription are already under a doctor's supervision).
            if patient.patient_type == "SELF_MEDICATION":
                from app.services.followup_service import schedule_follow_ups
                schedule_follow_ups(db, invoice.id, invoice.patient_id)

            # Refill reminders: for PRESCRIPTION patients and any patient with a
            # chronic condition tag (Diabetes, Cardiac, Hypertension, Thyroid, Asthma).
            # These patients buy the same medicines regularly, so we alert them
            # 3 days before their estimated run-out date.
            from app.services.refill_service import (
                is_chronic_patient, schedule_refill_reminder,
            )
            if patient.patient_type == "PRESCRIPTION" or is_chronic_patient(db, patient.id):
                schedule_refill_reminder(db, invoice.id, patient.id)

    return invoice   # caller does db.commit() + db.refresh(invoice)


# ---------------------------------------------------------------------------
# Process return
# ---------------------------------------------------------------------------

def process_return(
    db: Session,
    invoice_number: str,
    reason: str | None,
    user_id: int,
    return_items: list | None = None,
) -> Invoice:
    """
    Return some — or all — of an invoice.

    WHY THIS IS PER LINE AND NOT PER INVOICE:
    A customer walks back in with one medicine off a five-line bill.  The old
    behaviour reversed the WHOLE invoice, which put four medicines the customer
    still has back on the shelf as sellable stock.  So the caller now names the
    lines and the quantities coming back.

    return_items: a list of objects with .invoice_item_id and .return_qty.
      Passing None (or an empty list) returns everything still outstanding on
      the invoice — that is what the old whole-invoice button did, and older
      clients that send only a reason keep working unchanged.

    For each returned line:
      - stock goes back onto that line's ORIGINAL batch (never FEFO — the
        physical box the customer is handing over came from that batch)
      - a StockMovement(type='RETURN') records it
      - invoice_item.returned_qty grows; is_returned flips once the whole line
        is back

    Invoice status afterwards:
      every line fully returned → 'RETURNED'
      some units returned       → 'PARTIAL_RETURN'

    The refund is the returned units' share of what the customer actually paid
    (see _refund_for below).  If the invoice was sold on credit, that refund
    reduces the outstanding credit rather than being handed over as cash.

    All changes are in one transaction; the caller does db.commit().
    """
    invoice = (
        db.query(Invoice)
        .filter(Invoice.invoice_number == invoice_number)
        .first()
    )
    if invoice is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if invoice.status == "RETURNED":
        raise HTTPException(status_code=400, detail="Invoice has already been fully returned")

    items_by_id = {item.id: item for item in invoice.items}

    # --- Work out what is actually coming back ------------------------------
    # requested maps invoice_item_id → units to return.
    requested: dict[int, int] = {}
    if return_items:
        for req in return_items:
            item = items_by_id.get(req.invoice_item_id)
            if item is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Item #{req.invoice_item_id} is not part of invoice {invoice_number}.",
                )
            qty = int(req.return_qty)
            if qty <= 0:
                # A zero row means "not selected" — silently skip rather than
                # failing the whole return over an unticked checkbox.
                continue
            remaining = item.quantity - (item.returned_qty or 0)
            if qty > remaining:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Cannot return {qty} of {item.product.name} — only "
                        f"{remaining} of that line remain(s) unreturned."
                    ),
                )
            # Two rows naming the same line add up rather than overwrite.
            requested[item.id] = requested.get(item.id, 0) + qty
            if requested[item.id] > remaining:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Cannot return more than {remaining} unit(s) of "
                        f"{item.product.name}."
                    ),
                )
    else:
        # No list given → return everything still outstanding (the old behaviour).
        for item in invoice.items:
            remaining = item.quantity - (item.returned_qty or 0)
            if remaining > 0:
                requested[item.id] = remaining

    if not requested:
        raise HTTPException(
            status_code=400,
            detail="Select at least one item (with a quantity) to return.",
        )

    # --- Restore stock, one line at a time ----------------------------------
    refund = Decimal("0")
    returned_names: list[str] = []

    for item_id, qty in requested.items():
        item = items_by_id[item_id]

        # Back onto the batch it was sold from, so expiry dates stay honest.
        item.batch.quantity_available += qty

        db.add(StockMovement(
            batch_id=item.batch_id,
            movement_type="RETURN",
            quantity=qty,              # positive = stock coming BACK IN
            reference=invoice_number,
            user_id=user_id,
        ))

        item.returned_qty = (item.returned_qty or 0) + qty
        item.is_returned = item.returned_qty >= item.quantity

        refund += _refund_for(invoice, item, qty)
        returned_names.append(f"{item.product.name} × {qty}")

    refund = refund.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    # Accumulate (never overwrite) — a line can come back across several visits,
    # and every dashboard and report subtracts this from total_amount to get
    # what the customer is left having paid.  See services/revenue.py.
    invoice.refunded_amount = (invoice.refunded_amount or Decimal("0")) + refund

    # --- Invoice status ------------------------------------------------------
    # "Fully returned" means every line is back, not just the ones in this
    # request — a second partial return can be what finally completes it.
    fully_returned = all(
        (it.returned_qty or 0) >= it.quantity for it in invoice.items
    )
    invoice.status = "RETURNED" if fully_returned else "PARTIAL_RETURN"

    # --- Credit invoices: refund reduces the debt, not the till -------------
    # Nothing was handed over for the unpaid part, so "refunding" it means the
    # patient simply owes less.
    if invoice.credit_amount and invoice.credit_amount > 0 and invoice.patient_id:
        from app.services.credit_service import reduce_invoice_credit
        applied = reduce_invoice_credit(db, invoice.id, refund, user_id)
        invoice.credit_amount = (invoice.credit_amount - applied)

    # Permanent record in the audit log: who returned what, and why
    db.add(AuditLog(
        user_id=user_id,
        action="INVOICE_RETURN" if fully_returned else "INVOICE_PARTIAL_RETURN",
        entity="invoices",
        details=(
            f"Invoice {invoice_number} {'fully' if fully_returned else 'partially'} "
            f"returned: {', '.join(returned_names)}. Refund Rs.{refund}. "
            f"Reason: {reason or 'not specified'}"
        ),
    ))

    return invoice   # caller does db.commit() + db.refresh(invoice)


def _refund_for(invoice: Invoice, item: InvoiceItem, qty: int) -> Decimal:
    """
    What `qty` units of `item` are worth back to the customer.

    Start from the line's own money — line_total is GST-inclusive, so the tax
    comes back with it automatically — and take the returned units' share:

        gross = line_total × qty / line_quantity

    Then subtract this line's share of any BILL-LEVEL discount.  A ₹50 discount
    on a ₹1,000 bill means the customer paid 95% of every line, so returning a
    ₹200 line refunds ₹190, not ₹200.  Sharing it by gross value is what makes
    a full return refund exactly (subtotal + GST − discount).

    The home visit charge is deliberately NOT refunded: the pharmacist already
    travelled and administered the drip.  Returning the medicine does not undo
    that service.

    Pure arithmetic — no database access.
    """
    if item.quantity <= 0:
        return Decimal("0")

    gross = (item.line_total * Decimal(qty) / Decimal(item.quantity))

    discount = invoice.discount_amount or Decimal("0")
    if discount > 0:
        # Denominator is the bill's own goods value (every line's line_total),
        # which is the base the discount was taken off.
        items_gross = sum((it.line_total for it in invoice.items), Decimal("0"))
        if items_gross > 0:
            gross -= discount * gross / items_gross

    return gross.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
