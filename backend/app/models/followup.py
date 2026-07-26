"""
ORM models for Phase 3 — Smart Follow-Up System.

Maps to 4 new tables created in schema.sql:
  message_templates   — pre-written SMS/WhatsApp texts (EN + AS)
  follow_up_schedules — one row per Day-2/5/10/30 checkpoint per invoice
  message_queue       — outbound messages waiting to be sent by a provider
  patient_responses   — responses recorded by pharmacy staff (BETTER, SAME…)

KEY OFFLINE-FIRST DESIGN:
  This module NEVER sends messages directly. It only writes to message_queue.
  An external sender (SMS gateway, WhatsApp BSP) reads the queue later.
  The system works even with no internet connection — messages are safely stored.
"""
from sqlalchemy import Column, Date, ForeignKey, Integer, String, Text, TIMESTAMP
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class MessageTemplate(Base):
    """
    Stores message text for each follow-up day in English and Assamese.

    Variables like {patient_name} are replaced with real values at queue time.
    The 'variables' column is a comma-separated list of variable names for
    documentation purposes (not enforced by the DB).

    tag_filter: if set, this template is preferred for patients who carry
    that tag (e.g. "Diabetes"). NULL means it is the general fallback.
    day: numeric follow-up day (2, 5, 10, 30) — used by compose-message
         to pick the right template without parsing the code string.
    is_active: soft-disable a template without deleting it.
    """
    __tablename__ = "message_templates"

    id         = Column(Integer, primary_key=True, index=True)
    code       = Column(String(60), unique=True, nullable=False)   # e.g. FOLLOWUP_DAY2
    name       = Column(String(120), nullable=False)
    language   = Column(String(5), nullable=False)                 # EN, AS, BOTH
    channel    = Column(String(20), nullable=False, default="SMS")
    body_en    = Column(Text)    # English message body with {placeholders}
    body_as    = Column(Text)    # Assamese message body with {placeholders}
    variables  = Column(Text)    # comma-separated: {patient_name},{medicine_list}
    # --- Phase 3 additions ---
    day        = Column(Integer)            # 2, 5, 10, 30  (NULL for non-follow-up templates)
    tag_filter = Column(String(60))         # e.g. "Diabetes" — NULL means general fallback
    is_active  = Column(Integer, default=1) # 1 = active, 0 = disabled (stored as int for SQLite compat)
    created_at = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())


class FollowUpSchedule(Base):
    """
    One row per follow-up checkpoint (Day 2, 5, 10, 30) per invoice.

    When a SELF_MEDICATION patient buys medicines, the billing service
    creates 4 FollowUpSchedule rows automatically. Each row tracks whether
    we have reached out to the patient on that day.

    status lifecycle:
      PENDING   → follow-up is due (not yet done)
      COMPLETED → staff recorded a response for this day
      CANCELLED → patient said "Feeling Better" (or staff cancelled manually)
    """
    __tablename__ = "follow_up_schedules"

    id               = Column(Integer, primary_key=True, index=True)
    patient_id       = Column(Integer, ForeignKey("patients.id"), nullable=False)
    invoice_id       = Column(Integer, ForeignKey("invoices.id"), nullable=False)
    day_number       = Column(Integer, nullable=False)   # 2, 5, 10, or 30
    scheduled_date   = Column(Date, nullable=False)      # invoice_date + day_number
    status           = Column(String(20), nullable=False, default="PENDING")
    template_code    = Column(String(60))                # which template was used
    cancelled_at     = Column(TIMESTAMP(timezone=True))
    cancelled_reason = Column(String(120))
    sent_at          = Column(TIMESTAMP(timezone=True))   # set when pharmacist queues a message
    created_at       = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    patient  = relationship("Patient", foreign_keys=[patient_id], lazy="joined")
    invoice  = relationship("Invoice", foreign_keys=[invoice_id], lazy="joined")
    messages = relationship("MessageQueue", back_populates="follow_up", lazy="select")


class MessageQueue(Base):
    """
    Outbound message waiting to be sent by an SMS/WhatsApp provider.

    Each FollowUpSchedule can produce 1 or 2 messages (one per language
    if the patient's preferred_language is 'BOTH').

    status lifecycle:
      QUEUED    → ready to send (not yet dispatched)
      SENT      → provider confirmed delivery
      FAILED    → provider reported an error (see error_message)
      CANCELLED → the linked follow_up_schedule was cancelled

    The sending itself is done by a separate background process (not built yet).
    This module only writes; sending reads.
    """
    __tablename__ = "message_queue"

    id               = Column(Integer, primary_key=True, index=True)
    patient_id       = Column(Integer, ForeignKey("patients.id"), nullable=False)
    follow_up_id     = Column(Integer, ForeignKey("follow_up_schedules.id"), nullable=True)
    channel          = Column(String(20), nullable=False, default="SMS")
    recipient_mobile = Column(String(20), nullable=False)
    language         = Column(String(5), nullable=False, default="EN")
    message_body     = Column(Text, nullable=False)
    status           = Column(String(20), nullable=False, default="QUEUED")
    scheduled_at     = Column(TIMESTAMP(timezone=True), nullable=False)
    sent_at          = Column(TIMESTAMP(timezone=True))
    error_message    = Column(Text)
    created_at       = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    patient    = relationship("Patient", foreign_keys=[patient_id], lazy="joined")
    follow_up  = relationship("FollowUpSchedule", back_populates="messages", lazy="select")


class PatientResponse(Base):
    """
    A response entered by pharmacy staff when they speak to a patient.

    response_type values (chosen by pressing a button in the UI):
      BETTER      — patient is feeling better; triggers auto-cancellation
      SAME        — no change; follow-ups continue as scheduled
      WORSE       — condition worsened; logged for attention
      NEED_DOCTOR — patient wants a doctor; logged to audit_log
      CALL_ME     — patient wants a callback; logged to audit_log
    """
    __tablename__ = "patient_responses"

    id            = Column(Integer, primary_key=True, index=True)
    patient_id    = Column(Integer, ForeignKey("patients.id"), nullable=False)
    follow_up_id  = Column(Integer, ForeignKey("follow_up_schedules.id"), nullable=True)
    response_type = Column(String(30), nullable=False)
    notes         = Column(Text)
    recorded_by   = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at    = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
    actioned_at   = Column(TIMESTAMP(timezone=True))    # set when staff marks NEED_DOCTOR/CALL_ME as done
    action_note   = Column(Text)                        # optional note about what action was taken

    patient    = relationship("Patient", foreign_keys=[patient_id], lazy="joined")
    follow_up  = relationship("FollowUpSchedule", foreign_keys=[follow_up_id], lazy="select")
    recorder   = relationship("User", foreign_keys=[recorded_by], lazy="select")
