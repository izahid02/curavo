"""
Pydantic schemas for Phase 3.4 — Marketing Automation.

These classes define what data the API accepts (request bodies)
and what it returns (response bodies). Keeping schemas separate
from ORM models means we control exactly what is exposed.
"""
from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Filter schemas
# ---------------------------------------------------------------------------

class CampaignFilterCreate(BaseModel):
    """
    One targeting filter for a campaign.

    filter_type must be one of:
      TAG               filter_value = tag name, e.g. "Diabetes"
      DEPARTMENT        filter_value = department name, e.g. "Cardiology"
      PATIENT_TYPE      filter_value = "PRESCRIPTION" or "SELF_MEDICATION"
      GENDER            filter_value = "M", "F", or "O"
      LAST_VISIT_BEFORE filter_value = ISO date string "YYYY-MM-DD"
      LAST_VISIT_AFTER  filter_value = ISO date string "YYYY-MM-DD"
      AGE_MIN           filter_value = integer as string, e.g. "60"
      AGE_MAX           filter_value = integer as string, e.g. "18"
    """
    filter_type:  str
    filter_value: str


# ---------------------------------------------------------------------------
# Message schemas
# ---------------------------------------------------------------------------

class CampaignMessageCreate(BaseModel):
    """
    One language variant of the campaign message.
    language = "EN" or "AS"
    """
    language:     str
    message_body: str


# ---------------------------------------------------------------------------
# Campaign create / update schemas
# ---------------------------------------------------------------------------

class CampaignCreate(BaseModel):
    """
    Body for POST /api/marketing/campaigns.

    At least one message is required (English).
    Filters are optional — no filters means ALL patients with a mobile.
    scheduled_at is optional; if omitted the campaign is sent immediately
    when queue_campaign() is called.
    """
    name:          str
    description:   Optional[str] = None
    campaign_type: str                            # HEALTH_TIP | FESTIVAL | AWARENESS | PROMOTIONAL | RECALL
    channel:       str = "SMS"
    filters:       List[CampaignFilterCreate] = []
    messages:      List[CampaignMessageCreate]
    scheduled_at:  Optional[datetime] = None


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class CampaignOut(BaseModel):
    """
    Full campaign details returned by GET /campaigns/{id} and POST /campaigns.
    """
    id:              int
    name:            str
    description:     Optional[str]
    campaign_type:   str
    channel:         str
    status:          str
    scheduled_at:    Optional[datetime]
    sent_at:         Optional[datetime]
    created_at:      datetime
    recipient_count: int
    filters:         List[CampaignFilterCreate]
    messages:        List[CampaignMessageCreate]

    model_config = {"from_attributes": True}


class CampaignListItem(BaseModel):
    """
    Compact campaign row used in the list view table.
    """
    id:              int
    name:            str
    campaign_type:   str
    channel:         str
    status:          str
    scheduled_at:    Optional[datetime]
    sent_at:         Optional[datetime]
    created_at:      datetime
    recipient_count: int

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Preview schema
# ---------------------------------------------------------------------------

class SamplePatient(BaseModel):
    """A single patient shown in the campaign audience preview."""
    name:       str
    mobile:     str
    tags:       List[str]
    department: Optional[str]


class CampaignPreviewOut(BaseModel):
    """
    Returned by POST /campaigns/preview.
    Shows how many patients match the given filters and a sample of 5.
    """
    matched_patients: int
    sample_patients:  List[SamplePatient]


# ---------------------------------------------------------------------------
# Recipient schema
# ---------------------------------------------------------------------------

class CampaignRecipientOut(BaseModel):
    """One patient recipient row in the campaign detail modal."""
    id:            int
    patient_id:    int
    patient_name:  str
    mobile:        str
    status:        str
    queued_at:     Optional[datetime]
    sent_at:       Optional[datetime]
    error_message: Optional[str]

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Preview request body
# ---------------------------------------------------------------------------

class PreviewRequest(BaseModel):
    """Body for POST /campaigns/preview — just a list of filters."""
    filters: List[CampaignFilterCreate] = []
