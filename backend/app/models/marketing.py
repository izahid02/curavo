"""
ORM models for Phase 3.4 — Marketing Automation.

Maps to 4 new tables:
  campaigns           — a bulk message targeting a filtered patient segment
  campaign_filters    — filter rules that narrow the target list (AND logic)
  campaign_messages   — message text per language (EN and/or AS)
  campaign_recipients — one row per patient after the campaign is queued

OFFLINE-FIRST: queuing writes to message_queue (same table used by follow-ups).
No messages are sent here; an SMS/WhatsApp provider reads the queue separately.
"""
from sqlalchemy import Column, ForeignKey, Integer, String, Text, TIMESTAMP
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Campaign(Base):
    """
    A marketing campaign: a name, type, channel, and optional schedule.

    status lifecycle:
      DRAFT   → created but not yet sent to anyone
      QUEUED  → recipients have been written to message_queue
      SENT    → provider confirmed all messages dispatched
      CANCELLED → manually cancelled before send
    """
    __tablename__ = "campaigns"

    id            = Column(Integer, primary_key=True, index=True)
    name          = Column(String(120), nullable=False)
    description   = Column(Text)
    campaign_type = Column(String(30), nullable=False)  # HEALTH_TIP, FESTIVAL, etc.
    channel       = Column(String(20), nullable=False, default="SMS")
    status        = Column(String(20), nullable=False, default="DRAFT")
    scheduled_at  = Column(TIMESTAMP(timezone=True))    # NULL = send immediately when queued
    sent_at       = Column(TIMESTAMP(timezone=True))    # timestamp when queue_campaign() ran
    created_by    = Column(Integer, ForeignKey("users.id"))
    created_at    = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    # Relationships — loaded on demand (lazy select)
    filters    = relationship("CampaignFilter",    back_populates="campaign", lazy="select", cascade="all, delete-orphan")
    messages   = relationship("CampaignMessage",   back_populates="campaign", lazy="select", cascade="all, delete-orphan")
    recipients = relationship("CampaignRecipient", back_populates="campaign", lazy="select", cascade="all, delete-orphan")
    creator    = relationship("User", foreign_keys=[created_by], lazy="select")


class CampaignFilter(Base):
    """
    One filter rule that narrows which patients receive this campaign.

    filter_type examples: TAG, DEPARTMENT, PATIENT_TYPE, GENDER,
      LAST_VISIT_BEFORE, LAST_VISIT_AFTER, AGE_MIN, AGE_MAX

    Multiple filters on the same campaign use AND logic — patients must
    satisfy ALL filters to be included.
    """
    __tablename__ = "campaign_filters"

    id           = Column(Integer, primary_key=True, index=True)
    campaign_id  = Column(Integer, ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False)
    filter_type  = Column(String(30), nullable=False)
    filter_value = Column(Text, nullable=False)

    campaign = relationship("Campaign", back_populates="filters")


class CampaignMessage(Base):
    """
    The message body for one language (EN or AS) within a campaign.

    Supports {patient_name} and {shop_name} variable substitution.
    A campaign should have at least one message (EN). AS is optional.
    """
    __tablename__ = "campaign_messages"

    id           = Column(Integer, primary_key=True, index=True)
    campaign_id  = Column(Integer, ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False)
    language     = Column(String(5), nullable=False)   # EN or AS
    message_body = Column(Text, nullable=False)

    campaign = relationship("Campaign", back_populates="messages")


class CampaignRecipient(Base):
    """
    One row per patient that was targeted by a campaign.

    Created in bulk when queue_campaign() runs.
    status mirrors message_queue.status: QUEUED → SENT or FAILED.
    """
    __tablename__ = "campaign_recipients"

    id           = Column(Integer, primary_key=True, index=True)
    campaign_id  = Column(Integer, ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False)
    patient_id   = Column(Integer, ForeignKey("patients.id"), nullable=False)
    mobile       = Column(String(20), nullable=False)
    status       = Column(String(20), nullable=False, default="QUEUED")
    queued_at    = Column(TIMESTAMP(timezone=True))
    sent_at      = Column(TIMESTAMP(timezone=True))
    error_message = Column(Text)

    campaign = relationship("Campaign", back_populates="recipients")
    patient  = relationship("Patient", foreign_keys=[patient_id], lazy="joined")
