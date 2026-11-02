"""
Business logic for Phase 3 — Smart Follow-Up System.

This service handles all follow-up scheduling, message queuing, and
response recording. It NEVER sends messages directly — it only writes
to the message_queue table. Actual sending happens later when an SMS/
WhatsApp provider is connected (Phase 3.2+).

OFFLINE-FIRST: all operations work with no internet connection.
"""
from datetime import date, datetime, timezone, timedelta
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session, selectinload

from app.models.billing import AuditLog, Invoice, InvoiceItem
from app.models.followup import (
    FollowUpSchedule, MessageQueue, MessageTemplate, PatientResponse
)
from app.models.patients import Patient
from app.models.inventory import Product
from app.utils.dates import get_today_ist
from app.services.shop_identity import shop_vars
from app.schemas.followup import (
    FollowUpScheduleOut, MessageQueueOut, PatientResponseCreate,
    PatientResponseOut, FollowUpStatsOut, ResponseSummaryOut,
    ComposeMessageRequest, ComposeMessageOut,
    PendingFollowUpOut, SendFollowUpRequest,
)


# ---------------------------------------------------------------------------
# Template codes and the day numbers we schedule automatically
# ---------------------------------------------------------------------------

FOLLOWUP_DAYS = [
    (2,  "FOLLOWUP_DAY2"),
    (5,  "FOLLOWUP_DAY5"),
    (10, "FOLLOWUP_DAY10"),
    (30, "FOLLOWUP_DAY30"),
]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _build_medicine_list(db: Session, invoice_id: int) -> str:
    """
    Return a comma-separated list of unique product names on an invoice.
    e.g. "Paracetamol 500mg, Cetirizine 10mg"

    We query invoice_items → product to get the names. If an item's product
    is somehow missing (deleted), we skip it gracefully.
    """
    items = (
        db.query(InvoiceItem)
        .filter(InvoiceItem.invoice_id == invoice_id)
        .options(selectinload(InvoiceItem.product))
        .all()
    )
    # Use a dict keyed by product_id to deduplicate (FEFO split = two items, one product)
    seen: dict[int, str] = {}
    for item in items:
        if item.product and item.product_id not in seen:
            seen[item.product_id] = item.product.name
    return ", ".join(seen.values()) if seen else "medicines"


def _render_message(template_body: str, replacements: dict) -> str:
    """
    Replace {variable} placeholders in a template body with real values.
    e.g. "Dear {patient_name}" → "Dear Ramesh"
    """
    result = template_body
    for key, value in replacements.items():
        result = result.replace(f"{{{key}}}", str(value))
    return result


def _scheduled_at(send_date: date) -> datetime:
    """
    Messages are scheduled to send at 10:00 AM on the given date.
    We store it as UTC-aware; the pharmacy is in IST (UTC+5:30).
    10:00 IST = 04:30 UTC.
    """
    return datetime(
        send_date.year, send_date.month, send_date.day,
        4, 30, 0,    # 04:30 UTC = 10:00 AM IST
        tzinfo=timezone.utc,
    )


# ---------------------------------------------------------------------------
# schedule_follow_ups — called by billing_service after invoice creation
# ---------------------------------------------------------------------------

def schedule_follow_ups(db: Session, invoice_id: int, patient_id: int) -> None:
    """
    Create follow-up schedules (Day 2, 5, 10, 30) and queue messages for a
    patient who just made a purchase.

    Only called for SELF_MEDICATION patients (the billing service checks this
    before calling here).

    Steps for each day:
      1. Create a FollowUpSchedule row
      2. Load the matching message template
      3. Replace placeholders with patient name, medicine list, purchase date
      4. Create MessageQueue row(s) — one per language based on preferred_language
    """
    patient = db.get(Patient, patient_id)
    invoice = db.get(Invoice, invoice_id)
    if not patient or not invoice:
        return   # shouldn't happen, but be defensive

    # Build replacements once — they're the same for all 4 days
    invoice_date_str = invoice.invoice_date.strftime("%d-%b-%Y") if invoice.invoice_date else date.today().strftime("%d-%b-%Y")
    medicine_list    = _build_medicine_list(db, invoice_id)

    replacements = {
        "patient_name" : patient.name,
        "medicine_list": medicine_list,
        "purchase_date": invoice_date_str,
        # medicine_name is the same as medicine_list here (used in refill template)
        "medicine_name": medicine_list,
        # {shop_name} / {shop_name_as} / {shop_phone} — this shop, from settings
        **shop_vars(db),
    }

    # The base date for scheduling is today (invoice creation date), in IST.
    base_date = get_today_ist()

    for day_number, template_code in FOLLOWUP_DAYS:
        # Load the template
        template = (
            db.query(MessageTemplate)
            .filter(MessageTemplate.code == template_code)
            .first()
        )

        # Create the schedule row
        schedule = FollowUpSchedule(
            patient_id     = patient_id,
            invoice_id     = invoice_id,
            day_number     = day_number,
            scheduled_date = base_date + timedelta(days=day_number),
            status         = "PENDING",
            template_code  = template_code,
        )
        db.add(schedule)
        db.flush()   # flush to get schedule.id for the message queue rows

        if not template:
            continue  # no template found — skip message creation but keep schedule

        send_date  = base_date + timedelta(days=day_number)
        mobile     = patient.mobile or ""

        # Determine which languages to queue based on patient preference
        lang_pref = (patient.preferred_language or "BOTH").upper()
        queue_en  = lang_pref in ("EN", "BOTH") and template.body_en
        queue_as  = lang_pref in ("AS", "BOTH") and template.body_as

        if queue_en and template.body_en:
            db.add(MessageQueue(
                patient_id       = patient_id,
                follow_up_id     = schedule.id,
                channel          = "SMS",
                recipient_mobile = mobile,
                language         = "EN",
                message_body     = _render_message(template.body_en, replacements),
                status           = "QUEUED",
                scheduled_at     = _scheduled_at(send_date),
            ))

        if queue_as and template.body_as:
            db.add(MessageQueue(
                patient_id       = patient_id,
                follow_up_id     = schedule.id,
                channel          = "SMS",
                recipient_mobile = mobile,
                language         = "AS",
                message_body     = _render_message(template.body_as, replacements),
                status           = "QUEUED",
                scheduled_at     = _scheduled_at(send_date),
            ))

    db.flush()


# ---------------------------------------------------------------------------
# cancel_follow_ups — called when patient says "Feeling Better"
# ---------------------------------------------------------------------------

def cancel_follow_ups(
    db: Session,
    patient_id: int,
    invoice_id: int,
    reason: str = "Patient reported feeling better",
) -> int:
    """
    Cancel all PENDING follow-up schedules and their QUEUED messages for a
    specific patient + invoice combination.

    Returns the number of schedules cancelled.
    """
    now = datetime.now(timezone.utc)

    # Find all PENDING schedules for this patient + invoice
    schedules = (
        db.query(FollowUpSchedule)
        .filter(
            FollowUpSchedule.patient_id == patient_id,
            FollowUpSchedule.invoice_id == invoice_id,
            FollowUpSchedule.status == "PENDING",
        )
        .all()
    )

    cancelled_count = 0
    for schedule in schedules:
        schedule.status           = "CANCELLED"
        schedule.cancelled_at     = now
        schedule.cancelled_reason = reason

        # Also cancel any QUEUED messages linked to this schedule
        (
            db.query(MessageQueue)
            .filter(
                MessageQueue.follow_up_id == schedule.id,
                MessageQueue.status == "QUEUED",
            )
            .update({"status": "CANCELLED"})
        )
        cancelled_count += 1

    db.flush()
    return cancelled_count


# ---------------------------------------------------------------------------
# record_response
# ---------------------------------------------------------------------------

def record_response(
    db: Session,
    data: PatientResponseCreate,
    user_id: int,
) -> PatientResponse:
    """
    Record a patient's response and take any automatic actions.

    BETTER     → cancel all remaining follow-ups for this invoice
    NEED_DOCTOR→ write an audit log entry so OPD desk sees it
    CALL_ME    → write an audit log entry for callback tracking
    """
    # Fetch patient for name (used in audit log messages)
    patient = db.get(Patient, data.patient_id)
    patient_name = patient.name if patient else f"Patient #{data.patient_id}"

    # Determine which invoice to cancel follow-ups for (if BETTER)
    invoice_id: Optional[int] = None
    if data.follow_up_id:
        schedule = db.get(FollowUpSchedule, data.follow_up_id)
        if schedule:
            invoice_id = schedule.invoice_id
            # Mark this specific schedule as COMPLETED
            if schedule.status == "PENDING":
                schedule.status = "COMPLETED"

    # Create the response record
    response = PatientResponse(
        patient_id    = data.patient_id,
        follow_up_id  = data.follow_up_id,
        response_type = data.response_type,
        notes         = data.notes,
        recorded_by   = user_id,
    )
    db.add(response)
    db.flush()

    # --- Take automatic actions based on response type ---

    if data.response_type == "BETTER" and invoice_id:
        # Cancel all remaining PENDING follow-ups for this purchase
        cancel_follow_ups(db, data.patient_id, invoice_id, "Patient reported feeling better")

    elif data.response_type == "NEED_DOCTOR":
        db.add(AuditLog(
            user_id = user_id,
            action  = "FOLLOWUP_NEED_DOCTOR",
            entity  = "follow_up_schedules",
            details = (
                f"Patient {patient_name} (ID {data.patient_id}) needs doctor "
                f"consultation. Recorded during follow-up response. "
                f"Notes: {data.notes or 'none'}"
            ),
        ))

    elif data.response_type == "CALL_ME":
        db.add(AuditLog(
            user_id = user_id,
            action  = "FOLLOWUP_CALLBACK_REQUESTED",
            entity  = "follow_up_schedules",
            details = (
                f"Callback requested by patient {patient_name} (ID {data.patient_id}). "
                f"Notes: {data.notes or 'none'}"
            ),
        ))

    db.flush()
    return response


# ---------------------------------------------------------------------------
# Query helpers
# ---------------------------------------------------------------------------

def get_due_today(db: Session) -> list[FollowUpScheduleOut]:
    """
    Return all PENDING follow-up schedules where scheduled_date = today.
    These are the patients staff should contact right now.
    """
    today = get_today_ist()
    schedules = (
        db.query(FollowUpSchedule)
        .filter(
            FollowUpSchedule.scheduled_date == today,
            FollowUpSchedule.status == "PENDING",
        )
        .options(
            selectinload(FollowUpSchedule.patient),
            selectinload(FollowUpSchedule.invoice),
        )
        .order_by(FollowUpSchedule.day_number)
        .all()
    )
    return [_to_schedule_out(s) for s in schedules]


def get_pending_messages(db: Session) -> list[MessageQueueOut]:
    """
    Return all QUEUED messages where scheduled_at <= now.
    These are ready to be sent as soon as a provider is connected.
    """
    now = datetime.now(timezone.utc)
    messages = (
        db.query(MessageQueue)
        .filter(
            MessageQueue.status == "QUEUED",
            MessageQueue.scheduled_at <= now,
        )
        .options(selectinload(MessageQueue.patient))
        .order_by(MessageQueue.scheduled_at)
        .all()
    )
    return [_to_message_out(m) for m in messages]


def get_stats(db: Session) -> FollowUpStatsOut:
    """Counts for the stats bar on the Follow-Ups page."""
    today = get_today_ist()
    now   = datetime.now(timezone.utc)

    total_pending   = db.query(FollowUpSchedule).filter(FollowUpSchedule.status == "PENDING").count()
    total_sent      = db.query(MessageQueue).filter(MessageQueue.status == "SENT").count()
    total_cancelled = db.query(FollowUpSchedule).filter(FollowUpSchedule.status == "CANCELLED").count()
    due_today       = (
        db.query(FollowUpSchedule)
        .filter(FollowUpSchedule.scheduled_date == today, FollowUpSchedule.status == "PENDING")
        .count()
    )
    overdue = (
        db.query(FollowUpSchedule)
        .filter(FollowUpSchedule.scheduled_date < today, FollowUpSchedule.status == "PENDING")
        .count()
    )

    return FollowUpStatsOut(
        total_pending   = total_pending,
        total_sent      = total_sent,
        total_cancelled = total_cancelled,
        due_today       = due_today,
        overdue         = overdue,
    )


# ---------------------------------------------------------------------------
# Output builders — convert ORM rows to Pydantic schemas
# ---------------------------------------------------------------------------

def _to_schedule_out(s: FollowUpSchedule) -> FollowUpScheduleOut:
    """Convert a FollowUpSchedule ORM row to the API output schema."""
    return FollowUpScheduleOut(
        id               = s.id,
        patient_id       = s.patient_id,
        patient_name     = s.patient.name if s.patient else "",
        patient_mobile   = s.patient.mobile if s.patient else None,
        invoice_id       = s.invoice_id,
        invoice_number   = s.invoice.invoice_number if s.invoice else "",
        day_number       = s.day_number,
        scheduled_date   = s.scheduled_date,
        status           = s.status,
        template_code    = s.template_code,
        cancelled_reason = s.cancelled_reason,
        created_at       = s.created_at,
    )


def _to_message_out(m: MessageQueue) -> MessageQueueOut:
    """Convert a MessageQueue ORM row to the API output schema."""
    return MessageQueueOut(
        id               = m.id,
        patient_id       = m.patient_id,
        patient_name     = m.patient.name if m.patient else "",
        follow_up_id     = m.follow_up_id,
        channel          = m.channel,
        recipient_mobile = m.recipient_mobile,
        language         = m.language,
        message_body     = m.message_body,
        status           = m.status,
        scheduled_at     = m.scheduled_at,
        sent_at          = m.sent_at,
        error_message    = m.error_message,
        created_at       = m.created_at,
    )


def _to_response_out(r: PatientResponse) -> PatientResponseOut:
    """Convert a PatientResponse ORM row to the API output schema."""
    return PatientResponseOut(
        id             = r.id,
        patient_id     = r.patient_id,
        patient_name   = r.patient.name   if r.patient else "",
        patient_mobile = r.patient.mobile if r.patient else None,
        follow_up_id   = r.follow_up_id,
        response_type  = r.response_type,
        notes          = r.notes,
        actioned_at    = r.actioned_at,
        action_note    = r.action_note,
        created_at     = r.created_at,
    )


def get_pending_responses(db: Session) -> list[PatientResponseOut]:
    """
    Return responses that need staff action:
    - response_type is NEED_DOCTOR or CALL_ME
    - actioned_at is NULL (not yet handled)
    These show in the "Needs Action" section on the Responses tab.
    """
    rows = (
        db.query(PatientResponse)
        .filter(
            PatientResponse.response_type.in_(["NEED_DOCTOR", "CALL_ME"]),
            PatientResponse.actioned_at == None,  # noqa: E711 — SQLAlchemy needs == None
        )
        .options(selectinload(PatientResponse.patient))
        .order_by(PatientResponse.created_at.desc())
        .all()
    )
    return [_to_response_out(r) for r in rows]


def get_responses_summary(db: Session) -> ResponseSummaryOut:
    """Summary counts for the Responses tab and the sidebar badge."""
    total    = db.query(PatientResponse).count()
    better   = db.query(PatientResponse).filter(PatientResponse.response_type == "BETTER").count()
    same     = db.query(PatientResponse).filter(PatientResponse.response_type == "SAME").count()
    needs_dr = db.query(PatientResponse).filter(PatientResponse.response_type == "NEED_DOCTOR").count()
    call_me  = db.query(PatientResponse).filter(PatientResponse.response_type == "CALL_ME").count()
    pending  = (
        db.query(PatientResponse)
        .filter(
            PatientResponse.response_type.in_(["NEED_DOCTOR", "CALL_ME"]),
            PatientResponse.actioned_at == None,  # noqa: E711
        )
        .count()
    )
    return ResponseSummaryOut(
        total_responses = total,
        feeling_better  = better,
        still_same      = same,
        needs_doctor    = needs_dr,
        call_me         = call_me,
        pending_action  = pending,
    )


# ---------------------------------------------------------------------------
# compose_message  (Task 3)
# ---------------------------------------------------------------------------

def compose_message(
    db: Session,
    patient_id: int,
    follow_up_day: int,
    language: str = "both",
) -> ComposeMessageOut:
    """
    Compose a follow-up message for a patient using the best matching template.

    Template selection:
      1. First try: template where day == follow_up_day AND tag_filter matches
         one of the patient's tag names (AND is_active == 1).
      2. Fallback: template where day == follow_up_day AND tag_filter IS NULL
         (AND is_active == 1).

    This design is AI-upgrade-ready: when Ollama is connected in Phase 4,
    swap the body text here and set generated_by = "ollama".  The endpoint
    contract (fields, URL) never changes.
    """
    # Load patient with tags eagerly
    patient = (
        db.query(Patient)
        .options(selectinload(Patient.tags))
        .filter(Patient.id == patient_id)
        .first()
    )
    if not patient:
        raise ValueError(f"Patient {patient_id} not found")

    patient_tag_names = [t.name for t in (patient.tags or [])]

    # --- Step 1: look for a tag-specific template ---
    tag_used: Optional[str] = None
    template: Optional[MessageTemplate] = None

    for tag_name in patient_tag_names:
        candidate = (
            db.query(MessageTemplate)
            .filter(
                MessageTemplate.day == follow_up_day,
                MessageTemplate.tag_filter == tag_name,
                MessageTemplate.is_active == 1,
            )
            .first()
        )
        if candidate:
            template = candidate
            tag_used = tag_name
            break

    # --- Step 2: fallback to general template ---
    if template is None:
        template = (
            db.query(MessageTemplate)
            .filter(
                MessageTemplate.day == follow_up_day,
                MessageTemplate.tag_filter == None,    # noqa: E711
                MessageTemplate.is_active == 1,
            )
            .first()
        )

    # --- No template found at all — return a minimal placeholder ---
    if template is None:
        shop = shop_vars(db)
        placeholder = (
            f"Dear {patient.name}, this is a follow-up from {shop['shop_name']}. "
            f"Please call us at {shop['shop_phone']} if you have any questions."
        )
        return ComposeMessageOut(
            english      = placeholder if language.lower() != "as" else None,
            assamese     = None,
            template_day = follow_up_day,
            tag_used     = None,
            generated_by = "template",
        )

    # --- Render placeholders ---
    replacements = {"patient_name": patient.name, **shop_vars(db)}

    def render(body: Optional[str]) -> Optional[str]:
        if not body:
            return None
        result = body
        for k, v in replacements.items():
            result = result.replace(f"{{{k}}}", str(v))
        return result

    lang = language.lower()
    english  = render(template.body_en) if lang in ("en", "both") else None
    assamese = render(template.body_as) if lang in ("as", "both") else None

    return ComposeMessageOut(
        english      = english,
        assamese     = assamese,
        template_day = follow_up_day,
        tag_used     = tag_used,
        generated_by = "template",
    )


# ---------------------------------------------------------------------------
# get_pending  (Task 4)
# ---------------------------------------------------------------------------

def get_pending(db: Session) -> list[PendingFollowUpOut]:
    """
    Return all PENDING follow-up schedules that are due today OR overdue.

    Enriches each schedule with:
      - patient tags (for the Compose panel tag display)
      - days_overdue: positive integer if past due, 0 if due today
      - last_invoice_date: the invoice_date from the linked invoice
    """
    today = get_today_ist()

    schedules = (
        db.query(FollowUpSchedule)
        .filter(
            FollowUpSchedule.scheduled_date <= today,
            FollowUpSchedule.status == "PENDING",
        )
        .options(
            selectinload(FollowUpSchedule.patient).selectinload(Patient.tags),
            selectinload(FollowUpSchedule.invoice),
        )
        .order_by(FollowUpSchedule.scheduled_date.asc(), FollowUpSchedule.day_number)
        .all()
    )

    result = []
    for s in schedules:
        days_overdue = (today - s.scheduled_date).days  # 0 = today, >0 = overdue

        last_invoice_date: Optional[str] = None
        if s.invoice and s.invoice.invoice_date:
            d = s.invoice.invoice_date
            # invoice_date may be a datetime or a date — handle both
            last_invoice_date = d.date().isoformat() if hasattr(d, "date") else str(d)

        patient_tags = [t.name for t in (s.patient.tags if s.patient else [])]

        result.append(PendingFollowUpOut(
            id                = s.id,
            patient_id        = s.patient_id,
            patient_name      = s.patient.name   if s.patient else "",
            patient_phone     = s.patient.mobile if s.patient else None,
            patient_tags      = patient_tags,
            follow_up_day     = s.day_number,
            due_date          = s.scheduled_date,
            days_overdue      = days_overdue,
            status            = s.status,
            last_invoice_date = last_invoice_date,
            invoice_number    = s.invoice.invoice_number if s.invoice else "",
        ))

    return result


# ---------------------------------------------------------------------------
# send_follow_up  (Task 5)
# ---------------------------------------------------------------------------

def send_follow_up(
    db: Session,
    schedule_id: int,
    req: "SendFollowUpRequest",
) -> dict:
    """
    Mark a follow-up schedule as SENT and log the composed message(s) to
    message_queue so they are ready for a provider to pick up later.

    The pharmacist can edit the message text in the UI before clicking Send,
    so we accept the final body in the request rather than re-rendering here.

    Status after this call: FollowUpSchedule.status = "SENT"
    """
    from datetime import datetime, timezone

    schedule = db.get(FollowUpSchedule, schedule_id)
    if schedule is None:
        raise ValueError(f"Schedule {schedule_id} not found")
    if schedule.status not in ("PENDING",):
        raise ValueError(f"Schedule is already in status '{schedule.status}'")

    now = datetime.now(timezone.utc)
    schedule.status  = "SENT"
    schedule.sent_at = now

    patient  = db.get(Patient, schedule.patient_id)
    mobile   = (patient.mobile or "") if patient else ""

    queued_at_str = now.isoformat()

    # Queue English message
    if req.message_en and req.message_en.strip():
        db.add(MessageQueue(
            patient_id       = schedule.patient_id,
            follow_up_id     = schedule_id,
            channel          = req.channel or "SMS",
            recipient_mobile = mobile,
            language         = "EN",
            message_body     = req.message_en.strip(),
            status           = "QUEUED",
            scheduled_at     = now,
        ))

    # Queue Assamese message
    if req.message_as and req.message_as.strip():
        db.add(MessageQueue(
            patient_id       = schedule.patient_id,
            follow_up_id     = schedule_id,
            channel          = req.channel or "SMS",
            recipient_mobile = mobile,
            language         = "AS",
            message_body     = req.message_as.strip(),
            status           = "QUEUED",
            scheduled_at     = now,
        ))

    db.flush()
    return {"success": True, "queued_at": queued_at_str}
