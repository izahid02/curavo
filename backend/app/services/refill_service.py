"""
Phase 3.3 — Medicine Refill Reminders

When a PRESCRIPTION or chronic-condition patient buys medicines, the system
estimates when their supply will run out based on the quantity purchased and
standard daily dosage assumptions, then queues a reminder SMS 3 days before
that estimated finish date.

OFFLINE-FIRST: like the rest of Phase 3, this only writes to message_queue.
No messages are sent directly. A future SMS provider will read the queue.

DOSAGE ASSUMPTIONS (used when product.days_per_unit is not set):
  Diabetes medicines:         1 strip = 10 days
  Cardiac / Hypertension /
  Thyroid / Asthma:           1 strip = 30 days
  Everything else:            1 unit  =  7 days

The pharmacist can override any product's days_per_unit via the Inventory
screen in Phase 4. Until then, the tag-based estimates apply.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session, selectinload

from app.models.billing import Invoice, InvoiceItem
from app.models.followup import MessageQueue, MessageTemplate
from app.models.inventory import Product
from app.models.patients import Patient


# Tags that mark a patient as having a chronic condition.
# Patients with any of these tags get refill reminders after purchase.
CHRONIC_TAGS = {"Diabetes", "Cardiac", "Hypertension", "Asthma", "Thyroid"}


def is_chronic_patient(db: Session, patient_id: int) -> bool:
    """
    Return True if the patient has at least one chronic-condition tag.

    Loads the patient's tags and checks for intersection with CHRONIC_TAGS.
    Called from billing_service before deciding whether to schedule reminders.
    """
    patient = (
        db.query(Patient)
        .options(selectinload(Patient.tags))
        .filter(Patient.id == patient_id)
        .first()
    )
    if not patient:
        return False
    patient_tag_names = {t.name for t in patient.tags}
    return bool(patient_tag_names & CHRONIC_TAGS)


def get_days_per_unit(product: Product, patient_tag_names: set) -> int:
    """
    Estimate how many days one purchased unit (strip / bottle / inhaler) lasts.

    Priority:
      1. product.days_per_unit — pharmacist has set an exact value → always use it
      2. Tag-based estimate:
           Diabetes:  10 days  (short strip, taken daily)
           Cardiac / Hypertension / Thyroid / Asthma: 30 days (monthly dose)
      3. Default: 7 days (short-course medicine like an antibiotic strip)
    """
    if product.days_per_unit:
        return product.days_per_unit

    if "Diabetes" in patient_tag_names:
        return 10
    if patient_tag_names & {"Cardiac", "Hypertension", "Thyroid", "Asthma"}:
        return 30
    return 7


def _at_9am_ist(day: date) -> datetime:
    """
    Build a timezone-aware datetime for 9:00 AM IST on the given date.
    IST = UTC+5:30, so 9:00 AM IST = 03:30 UTC.
    Pharmacy staff arrive around 9 AM and will see the reminder right away.
    """
    return datetime(day.year, day.month, day.day, 3, 30, 0, tzinfo=timezone.utc)


def schedule_refill_reminder(db: Session, invoice_id: int, patient_id: int) -> None:
    """
    Create refill reminder messages for each medicine on the invoice.

    Called by billing_service.create_invoice() for:
      - patients whose patient_type == 'PRESCRIPTION', or
      - patients who have at least one tag in CHRONIC_TAGS

    For each unique product on the invoice:
      1. Sum the quantity (FEFO may split one product across two invoice_item rows)
      2. Compute total_days = get_days_per_unit() × total_qty
      3. Set estimated_finish_date on the invoice_item rows for that product
      4. If reminder_date (finish − 3 days) is still in the future, queue message(s)
         — one per language based on patient.preferred_language

    Refill messages are written to message_queue with follow_up_id=NULL.
    This is how we tell them apart from regular Day-2/5/10/30 follow-up messages
    when filtering in the router and the frontend.
    """
    # Load patient with tags in one query
    patient = (
        db.query(Patient)
        .options(selectinload(Patient.tags))
        .filter(Patient.id == patient_id)
        .first()
    )
    invoice = db.get(Invoice, invoice_id)
    if not patient or not invoice:
        return

    # Load items for this invoice with their product relationships
    items = (
        db.query(InvoiceItem)
        .filter(InvoiceItem.invoice_id == invoice_id)
        .options(selectinload(InvoiceItem.product))
        .all()
    )
    if not items:
        return

    # Load the refill template once — used for every medicine
    template = (
        db.query(MessageTemplate)
        .filter(MessageTemplate.code == "REFILL_REMINDER")
        .first()
    )

    patient_tag_names = {t.name for t in patient.tags}
    today = date.today()
    # invoice_date is a timezone-aware datetime; convert to a plain date for arithmetic
    invoice_date = invoice.invoice_date.date() if invoice.invoice_date else today
    mobile = patient.mobile or ""
    lang_pref = (patient.preferred_language or "BOTH").upper()

    # --- Group items by product_id ---
    # FEFO can split one product across two batches → two invoice_item rows.
    # We consolidate them so one reminder covers the total quantity purchased.
    # Structure: {product_id: (product_obj, total_qty, [item_rows])}
    groups: dict[int, list] = {}
    for item in items:
        if item.product_id not in groups:
            groups[item.product_id] = [item.product, 0, []]
        groups[item.product_id][1] += item.quantity
        groups[item.product_id][2].append(item)

    for product_id, (product, total_qty, item_rows) in groups.items():
        if not product:
            continue

        # --- Calculate finish and reminder dates ---
        days = get_days_per_unit(product, patient_tag_names)
        total_days    = days * total_qty
        finish_date   = invoice_date + timedelta(days=total_days)
        reminder_date = finish_date - timedelta(days=3)

        # Stamp every invoice_item row for this product with the finish date
        for item in item_rows:
            item.estimated_finish_date = finish_date

        # Only queue a reminder if the reminder date hasn't passed yet
        if reminder_date <= today:
            continue
        if not template:
            continue  # template not seeded yet — keep finish dates but skip message

        replacements = {
            "patient_name": patient.name,
            "medicine_name": product.name,
        }

        def _render(body: str) -> str:
            for k, v in replacements.items():
                body = body.replace(f"{{{k}}}", str(v))
            return body

        # Queue English message
        if lang_pref in ("EN", "BOTH") and template.body_en:
            db.add(MessageQueue(
                patient_id       = patient_id,
                follow_up_id     = None,   # None distinguishes refill from follow-up
                channel          = "SMS",
                recipient_mobile = mobile,
                language         = "EN",
                message_body     = _render(template.body_en),
                status           = "QUEUED",
                scheduled_at     = _at_9am_ist(reminder_date),
            ))

        # Queue Assamese message
        if lang_pref in ("AS", "BOTH") and template.body_as:
            db.add(MessageQueue(
                patient_id       = patient_id,
                follow_up_id     = None,
                channel          = "SMS",
                recipient_mobile = mobile,
                language         = "AS",
                message_body     = _render(template.body_as),
                status           = "QUEUED",
                scheduled_at     = _at_9am_ist(reminder_date),
            ))

    db.flush()
