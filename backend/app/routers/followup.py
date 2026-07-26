"""
API routes for Phase 3 — Smart Follow-Up System.

All routes require authentication (Bearer JWT token).
Prefix: /api/followup

These endpoints let the frontend:
  - See who needs follow-up today
  - View all scheduled follow-ups
  - Cancel a follow-up manually
  - View the message queue
  - Record a patient response (BETTER / SAME / WORSE / NEED_DOCTOR / CALL_ME)
  - See summary statistics
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, selectinload

from app.database import get_db
from app.models.followup import FollowUpSchedule, MessageQueue, PatientResponse
from app.schemas.followup import (
    ActionRequest,
    CancelScheduleRequest,
    ComposeMessageRequest,
    ComposeMessageOut,
    FollowUpScheduleOut,
    FollowUpStatsOut,
    MessageQueueOut,
    PatientResponseCreate,
    PatientResponseOut,
    PendingFollowUpOut,
    ResponseSummaryOut,
    SendFollowUpRequest,
)
from app.services import followup_service
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/followup", tags=["Follow-Ups"])


# ---------------------------------------------------------------------------
# Follow-Up Schedules
# ---------------------------------------------------------------------------

@router.get("/schedules", response_model=list[FollowUpScheduleOut])
def list_schedules(
    status     : Optional[str] = Query(None, description="Filter by status: PENDING, COMPLETED, CANCELLED"),
    patient_id : Optional[int] = Query(None),
    page       : int           = Query(1, ge=1),
    limit      : int           = Query(50, ge=1, le=200),
    db         : Session       = Depends(get_db),
    _user                      = Depends(get_current_user),
):
    """
    List all follow-up schedules.
    Optionally filter by status or patient. Paginated.
    """
    q = db.query(FollowUpSchedule).options(
        selectinload(FollowUpSchedule.patient),
        selectinload(FollowUpSchedule.invoice),
    )
    if status:
        q = q.filter(FollowUpSchedule.status == status.upper())
    if patient_id:
        q = q.filter(FollowUpSchedule.patient_id == patient_id)

    q = q.order_by(FollowUpSchedule.scheduled_date.desc(), FollowUpSchedule.day_number)

    offset = (page - 1) * limit
    rows   = q.offset(offset).limit(limit).all()
    return [followup_service._to_schedule_out(s) for s in rows]


@router.get("/schedules/due-today", response_model=list[FollowUpScheduleOut])
def schedules_due_today(
    db    : Session = Depends(get_db),
    _user           = Depends(get_current_user),
):
    """Return all PENDING follow-up schedules for today — the main action list."""
    return followup_service.get_due_today(db)


@router.post("/schedules/{schedule_id}/cancel")
def cancel_schedule(
    schedule_id: int,
    body       : CancelScheduleRequest,
    db         : Session = Depends(get_db),
    _user                = Depends(get_current_user),
):
    """
    Manually cancel a single PENDING follow-up schedule.
    Also cancels any QUEUED messages linked to it.
    """
    from datetime import datetime, timezone

    schedule = db.get(FollowUpSchedule, schedule_id)
    if not schedule:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if schedule.status != "PENDING":
        raise HTTPException(status_code=400, detail=f"Cannot cancel a schedule in status '{schedule.status}'")

    schedule.status           = "CANCELLED"
    schedule.cancelled_at     = datetime.now(timezone.utc)
    schedule.cancelled_reason = body.reason or "Manually cancelled"

    # Cancel linked QUEUED messages
    db.query(MessageQueue).filter(
        MessageQueue.follow_up_id == schedule_id,
        MessageQueue.status == "QUEUED",
    ).update({"status": "CANCELLED"})

    db.commit()
    return {"message": "Schedule cancelled"}


# ---------------------------------------------------------------------------
# Message Queue
# ---------------------------------------------------------------------------

@router.get("/messages/pending", response_model=list[MessageQueueOut])
def messages_pending(
    db    : Session = Depends(get_db),
    _user           = Depends(get_current_user),
):
    """
    Return messages that are QUEUED and due to be sent now (scheduled_at <= now).
    These are what a future sender process would pick up.
    """
    return followup_service.get_pending_messages(db)


@router.get("/messages", response_model=list[MessageQueueOut])
def list_messages(
    status: Optional[str] = Query(None, description="QUEUED, SENT, FAILED, CANCELLED"),
    page  : int           = Query(1, ge=1),
    limit : int           = Query(50, ge=1, le=200),
    db    : Session       = Depends(get_db),
    _user                 = Depends(get_current_user),
):
    """List all messages in the queue, with optional status filter."""
    q = db.query(MessageQueue).options(selectinload(MessageQueue.patient))
    if status:
        q = q.filter(MessageQueue.status == status.upper())
    q = q.order_by(MessageQueue.scheduled_at.desc())

    offset = (page - 1) * limit
    rows   = q.offset(offset).limit(limit).all()
    return [followup_service._to_message_out(m) for m in rows]


# ---------------------------------------------------------------------------
# Patient Responses
# ---------------------------------------------------------------------------

@router.get("/responses/pending", response_model=list[PatientResponseOut])
def responses_pending(
    db    : Session = Depends(get_db),
    _user           = Depends(get_current_user),
):
    """
    Return responses that need staff action:
    response_type is NEED_DOCTOR or CALL_ME and actioned_at is NULL.
    These appear in the "Needs Action" section of the Responses tab.
    """
    return followup_service.get_pending_responses(db)


@router.get("/responses/summary", response_model=ResponseSummaryOut)
def responses_summary(
    db    : Session = Depends(get_db),
    _user           = Depends(get_current_user),
):
    """
    Summary counts for the Responses tab and the sidebar badge.
    pending_action = number of NEED_DOCTOR + CALL_ME not yet actioned.
    """
    return followup_service.get_responses_summary(db)


@router.patch("/responses/{response_id}/action")
def action_response(
    response_id : int,
    body        : ActionRequest,
    db          : Session = Depends(get_db),
    _user                 = Depends(get_current_user),
):
    """
    Mark a patient response as actioned.
    Sets actioned_at = now() and stores the optional action_note.
    After this, the response no longer appears in /responses/pending.
    """
    from datetime import datetime, timezone

    response = db.get(PatientResponse, response_id)
    if not response:
        raise HTTPException(status_code=404, detail="Response not found")
    if response.actioned_at:
        raise HTTPException(status_code=400, detail="Response has already been actioned")

    response.actioned_at = datetime.now(timezone.utc)
    response.action_note = body.action_note or None
    db.commit()
    return {"message": "Response marked as actioned"}


@router.post("/responses", response_model=PatientResponseOut)
def record_response(
    data : PatientResponseCreate,
    db   : Session = Depends(get_db),
    user           = Depends(get_current_user),
):
    """
    Record a patient's response when staff speaks to them.

    - BETTER     → cancels all remaining PENDING follow-ups for that invoice
    - NEED_DOCTOR→ logged to audit trail for OPD desk
    - CALL_ME    → logged to audit trail for callback tracking
    """
    valid_types = {"BETTER", "SAME", "WORSE", "NEED_DOCTOR", "CALL_ME"}
    if data.response_type.upper() not in valid_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid response_type. Must be one of: {', '.join(valid_types)}",
        )

    # Normalise to uppercase
    data.response_type = data.response_type.upper()

    response = followup_service.record_response(db, data, user.id)
    db.commit()
    db.refresh(response)
    return followup_service._to_response_out(response)


@router.get("/responses", response_model=list[PatientResponseOut])
def list_responses(
    patient_id: Optional[int] = Query(None),
    page      : int           = Query(1, ge=1),
    limit     : int           = Query(50, ge=1, le=200),
    db        : Session       = Depends(get_db),
    _user                     = Depends(get_current_user),
):
    """List recorded patient responses. Optionally filter by patient."""
    q = db.query(PatientResponse).options(selectinload(PatientResponse.patient))
    if patient_id:
        q = q.filter(PatientResponse.patient_id == patient_id)
    q = q.order_by(PatientResponse.created_at.desc())

    offset = (page - 1) * limit
    rows   = q.offset(offset).limit(limit).all()
    return [followup_service._to_response_out(r) for r in rows]


# ---------------------------------------------------------------------------
# Refill Reminders
# ---------------------------------------------------------------------------

@router.get("/refills/upcoming", response_model=list[MessageQueueOut])
def upcoming_refill_reminders(
    db    : Session = Depends(get_db),
    _user           = Depends(get_current_user),
):
    """
    Return QUEUED refill reminders scheduled within the next 7 days.

    Refill messages are identified by follow_up_id IS NULL — regular
    follow-up messages always have a follow_up_id pointing to a schedule row.
    Ordered by scheduled_at ascending so the soonest reminder is first.
    """
    now       = datetime.now(timezone.utc)
    cutoff    = now + timedelta(days=7)
    rows = (
        db.query(MessageQueue)
        .options(selectinload(MessageQueue.patient))
        .filter(
            MessageQueue.follow_up_id == None,   # noqa: E711
            MessageQueue.status == "QUEUED",
            MessageQueue.scheduled_at >= now,
            MessageQueue.scheduled_at <= cutoff,
        )
        .order_by(MessageQueue.scheduled_at.asc())
        .all()
    )
    return [followup_service._to_message_out(m) for m in rows]


@router.get("/refills", response_model=list[MessageQueueOut])
def list_refill_reminders(
    db    : Session = Depends(get_db),
    _user           = Depends(get_current_user),
):
    """
    List all refill reminder messages (any status except CANCELLED).

    Refill messages are identified by follow_up_id IS NULL.
    Ordered by scheduled_at ascending.
    """
    rows = (
        db.query(MessageQueue)
        .options(selectinload(MessageQueue.patient))
        .filter(
            MessageQueue.follow_up_id == None,   # noqa: E711
            MessageQueue.status != "CANCELLED",
        )
        .order_by(MessageQueue.scheduled_at.asc())
        .all()
    )
    return [followup_service._to_message_out(m) for m in rows]


# ---------------------------------------------------------------------------
# Compose Message  (Task 3)
# ---------------------------------------------------------------------------

@router.post("/compose-message", response_model=ComposeMessageOut)
def compose_message(
    data : ComposeMessageRequest,
    db   : Session = Depends(get_db),
    _user          = Depends(get_current_user),
):
    """
    Compose a bilingual follow-up message for a patient.

    Picks the best template for the given day: tag-specific first,
    then general fallback.  Returns both EN and AS bodies pre-filled with
    the patient's name — the UI shows editable text areas so the pharmacist
    can tweak before sending.

    generated_by is always "template" for now.  Phase 4 will change it to
    "ollama" when the local AI model is connected, with no frontend changes.
    """
    try:
        return followup_service.compose_message(db, data.patient_id, data.follow_up_day, data.language)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ---------------------------------------------------------------------------
# Pending Follow-Ups  (Task 4)
# ---------------------------------------------------------------------------

@router.get("/pending", response_model=list[PendingFollowUpOut])
def get_pending(
    db    : Session = Depends(get_db),
    _user           = Depends(get_current_user),
):
    """
    Return all PENDING follow-up schedules that are due today or overdue.

    Used by:
      - The Due Today tab (replacing the schedules/due-today endpoint, which
        only returned schedules for today).
      - The dashboard widget (counts how many are pending).

    Each item includes days_overdue, patient tags, and the last invoice date.
    """
    return followup_service.get_pending(db)


# ---------------------------------------------------------------------------
# Send Follow-Up  (Task 5)
# ---------------------------------------------------------------------------

@router.post("/{schedule_id}/send")
def send_follow_up(
    schedule_id : int,
    body        : SendFollowUpRequest,
    db          : Session = Depends(get_db),
    _user                 = Depends(get_current_user),
):
    """
    Mark a follow-up as sent and queue the composed message.

    Accepts the final (possibly pharmacist-edited) message bodies.
    Sets follow_up_schedules.status = 'SENT' and creates one MessageQueue
    row per non-empty language body.

    Note: 'SENT' means "we queued the message". The patient won't receive it
    until a real SMS/WhatsApp provider processes the queue — but the
    pharmacist's action is recorded immediately so the schedule doesn't
    stay on the Due Today list.
    """
    try:
        result = followup_service.send_follow_up(db, schedule_id, body)
        db.commit()
        return result
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

@router.get("/stats", response_model=FollowUpStatsOut)
def get_stats(
    db    : Session = Depends(get_db),
    _user           = Depends(get_current_user),
):
    """Summary counts for the stats bar on the Follow-Ups page."""
    return followup_service.get_stats(db)
