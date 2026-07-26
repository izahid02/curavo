"""
Pydantic schemas for Phase 3 — Smart Follow-Up System.

These define the shape of data coming in (request bodies) and going out
(response bodies) for all /api/followup/* endpoints.

Pydantic validates inputs automatically — if a required field is missing
or the wrong type, FastAPI returns a clear 422 error before the code runs.
"""
from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Follow-Up Schedules
# ---------------------------------------------------------------------------

class FollowUpScheduleOut(BaseModel):
    """
    Returned when listing or viewing follow-up schedules.
    Includes patient and invoice details so the UI can show them inline
    without making extra API calls.
    """
    id               : int
    patient_id       : int
    patient_name     : str
    patient_mobile   : Optional[str]
    invoice_id       : int
    invoice_number   : str
    day_number       : int
    scheduled_date   : date
    status           : str          # PENDING, COMPLETED, CANCELLED
    template_code    : Optional[str]
    cancelled_reason : Optional[str]
    created_at       : datetime

    model_config = {"from_attributes": True}


class CancelScheduleRequest(BaseModel):
    """Body for manually cancelling a single follow-up schedule."""
    reason: Optional[str] = None


# ---------------------------------------------------------------------------
# Message Queue
# ---------------------------------------------------------------------------

class MessageQueueOut(BaseModel):
    """
    Returned when listing queued messages.
    The UI shows these so staff can see what messages are waiting to be sent.
    """
    id               : int
    patient_id       : int
    patient_name     : str
    follow_up_id     : Optional[int]
    channel          : str           # SMS, WHATSAPP
    recipient_mobile : str
    language         : str           # EN, AS
    message_body     : str
    status           : str           # QUEUED, SENT, FAILED, CANCELLED
    scheduled_at     : datetime
    sent_at          : Optional[datetime]
    error_message    : Optional[str]
    created_at       : datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Patient Responses
# ---------------------------------------------------------------------------

class PatientResponseCreate(BaseModel):
    """
    Sent by the UI when a staff member records how a patient is feeling.
    response_type must be one of: BETTER, SAME, WORSE, NEED_DOCTOR, CALL_ME
    If BETTER: the service automatically cancels all remaining follow-ups.
    """
    patient_id   : int
    follow_up_id : Optional[int] = None
    response_type: str    # BETTER | SAME | WORSE | NEED_DOCTOR | CALL_ME
    notes        : Optional[str] = None


class PatientResponseOut(BaseModel):
    """Returned after recording a response, or when listing responses."""
    id             : int
    patient_id     : int
    patient_name   : str
    patient_mobile : Optional[str]
    follow_up_id   : Optional[int]
    response_type  : str
    notes          : Optional[str]
    actioned_at    : Optional[datetime]  # None = not yet actioned
    action_note    : Optional[str]
    created_at     : datetime

    model_config = {"from_attributes": True}


class ActionRequest(BaseModel):
    """
    Body sent when staff marks a NEED_DOCTOR / CALL_ME response as actioned.
    action_note is optional — staff may just click confirm with no note.
    """
    action_note: str = ""


class ResponseSummaryOut(BaseModel):
    """
    Counts for the Responses tab summary bar.
    pending_action = NEED_DOCTOR + CALL_ME responses not yet actioned.
    """
    total_responses : int
    feeling_better  : int
    still_same      : int
    needs_doctor    : int
    call_me         : int
    pending_action  : int


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

class FollowUpStatsOut(BaseModel):
    """
    Counts shown in the stats bar at the top of the Follow-Ups page.
    Lets staff see at a glance how many patients need attention today.
    """
    total_pending   : int
    total_sent      : int       # messages with status SENT
    total_cancelled : int       # schedules cancelled
    due_today       : int       # PENDING schedules where scheduled_date = today
    overdue         : int       # PENDING schedules where scheduled_date < today


# ---------------------------------------------------------------------------
# Compose Message  (Task 3)
# ---------------------------------------------------------------------------

class ComposeMessageRequest(BaseModel):
    """
    Body sent by the UI when the pharmacist opens the Compose panel.

    language values:
      "EN"   — return only English message
      "AS"   — return only Assamese message
      "both" — return both (default; the UI shows two text areas)
    """
    patient_id    : int
    follow_up_day : int          # 2, 5, 10, or 30
    language      : str = "both"


class ComposeMessageOut(BaseModel):
    """
    Returned by POST /followup/compose-message.

    The 'generated_by' field is intentionally always "template" for now.
    When Ollama AI is wired up in Phase 4, the service changes this field
    to "ollama" — the frontend just reads it and shows the right label,
    so the UI needs no other change.
    """
    english      : Optional[str]   # None if patient language preference is AS-only
    assamese     : Optional[str]   # None if patient language preference is EN-only
    template_day : int
    tag_used     : Optional[str]   # which patient tag triggered the variant, or None
    generated_by : str = "template"


# ---------------------------------------------------------------------------
# Pending Follow-Ups  (Task 4)
# ---------------------------------------------------------------------------

class PendingFollowUpOut(BaseModel):
    """
    One row returned by GET /followup/pending.
    Includes both due-today and overdue PENDING schedules.
    """
    id               : int
    patient_id       : int
    patient_name     : str
    patient_phone    : Optional[str]
    patient_tags     : list[str]   # tag names, e.g. ["Diabetes", "Senior Citizen"]
    follow_up_day    : int
    due_date         : date
    days_overdue     : int         # 0 = due today, positive = past due
    status           : str
    last_invoice_date: Optional[str]   # ISO date string "2025-01-13"
    invoice_number   : str


# ---------------------------------------------------------------------------
# Send Follow-Up  (Task 5)
# ---------------------------------------------------------------------------

class SendFollowUpRequest(BaseModel):
    """
    Body sent when the pharmacist clicks Send in the Compose panel.

    message_en / message_as are the (possibly edited) final message bodies.
    At least one must be non-empty.
    """
    message_en : Optional[str] = None
    message_as : Optional[str] = None
    channel    : str = "SMS"
