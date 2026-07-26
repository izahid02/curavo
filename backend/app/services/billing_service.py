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
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.billing import AuditLog, Invoice, InvoiceItem
from app.models.inventory import Batch, Product, StockMovement
from app.models.patients import Patient
from app.schemas.billing import CreateInvoiceRequest


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

def fefo_allocate(db: Session, product_id: int, quantity: int) -> list[dict]:
    """
    Decide which batches to take stock from to fulfil `quantity` units of
    `product_id`, using FEFO (First Expiry First Out) order.

    Rules:
      - Only batches where expiry_date >= today AND quantity_available > 0
      - Sort by expiry_date ASC — earliest-expiring batch first
      - Fill the first batch; if it runs out, continue to the next
      - If total available stock is less than requested: raise HTTP 400

    Returns a list like:
      [{"batch": <Batch>, "qty": 3}, {"batch": <Batch>, "qty": 2}]
    meaning "take 3 from batch A, then 2 from batch B".

    SQLite's single-writer model prevents concurrent stock conflicts, so no
    row-level locking is needed here.
    """
    today = date.today()

    batches = (
        db.query(Batch)
        .filter(
            Batch.product_id == product_id,
            Batch.expiry_date >= today,    # skip expired batches — cannot sell them
            Batch.quantity_available > 0,  # skip empty batches
        )
        .order_by(Batch.expiry_date)       # FEFO: earliest expiry first
        # SQLite uses file-level locking — only one writer at a time is
        # allowed anyway, so SELECT FOR UPDATE is unnecessary and unsupported.
        .all()
    )

    # Check whether enough stock exists across all valid batches
    total_available = sum(b.quantity_available for b in batches)
    if total_available < quantity:
        product = db.query(Product).filter(Product.id == product_id).first()
        name = product.name if product else f"Product #{product_id}"
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient stock for {name}. Available: {total_available}",
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
        # Get batch allocations in FEFO order.  This also validates stock.
        allocations = fefo_allocate(db, bill_item.product_id, bill_item.quantity)

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
                purchase_price=batch.purchase_price,  # for profit calculation
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
) -> Invoice:
    """
    Reverse a completed invoice:
      - Restore stock to each original batch
      - Write RETURN stock movement rows
      - Mark invoice.status = 'RETURNED'
      - Write an AuditLog entry

    All changes are in one transaction; caller does db.commit().
    """
    invoice = (
        db.query(Invoice)
        .filter(Invoice.invoice_number == invoice_number)
        .first()
    )
    if invoice is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if invoice.status == "RETURNED":
        raise HTTPException(status_code=400, detail="Invoice has already been returned")

    # Return stock to each batch and record the movement
    for item in invoice.items:
        item.batch.quantity_available += item.quantity

        db.add(StockMovement(
            batch_id=item.batch_id,
            movement_type="RETURN",
            quantity=item.quantity,   # positive = stock coming BACK IN
            reference=invoice_number,
            user_id=user_id,
        ))

    invoice.status = "RETURNED"

    # Permanent record in the audit log: who returned it and why
    db.add(AuditLog(
        user_id=user_id,
        action="INVOICE_RETURN",
        entity="invoices",
        details=(
            f"Invoice {invoice_number} returned. "
            f"Reason: {reason or 'not specified'}"
        ),
    ))

    return invoice   # caller does db.commit() + db.refresh(invoice)
