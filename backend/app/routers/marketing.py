"""
HTTP routes for Phase 3.4 — Marketing Automation.
All endpoints require a valid JWT (get_current_user).

Prefix: /api/marketing  (registered in main.py)
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.schemas.marketing import (
    CampaignCreate, CampaignListItem, CampaignOut,
    CampaignPreviewOut, CampaignRecipientOut, PreviewRequest,
)
from app.services.auth_service import get_current_user
from app.services import marketing_service

router = APIRouter(prefix="/marketing", tags=["Marketing"])


# ---------------------------------------------------------------------------
# Preview — must be registered BEFORE /campaigns/{id} so FastAPI matches
# the literal path "/campaigns/preview" first.
# ---------------------------------------------------------------------------

@router.post("/campaigns/preview", response_model=CampaignPreviewOut)
def preview_audience(
    body: PreviewRequest,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    """
    Dry-run the audience filters and return the matched patient count
    plus up to 5 sample patients. Does NOT create any DB rows.
    """
    return marketing_service.preview_campaign(db, body.filters)


# ---------------------------------------------------------------------------
# Campaign CRUD
# ---------------------------------------------------------------------------

@router.get("/campaigns", response_model=List[CampaignListItem])
def list_campaigns(
    status: Optional[str] = None,
    page:   int = 1,
    limit:  int = 20,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    """List all campaigns, optionally filtered by status. Paginated."""
    return marketing_service.list_campaigns(db, status, page, limit)


@router.post("/campaigns", response_model=CampaignOut, status_code=status.HTTP_201_CREATED)
def create_campaign(
    body: CampaignCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new campaign in DRAFT status."""
    if not body.messages:
        raise HTTPException(status_code=400, detail="At least one message (EN) is required")
    return marketing_service.create_campaign(db, body, current_user.id)


@router.get("/campaigns/{campaign_id}", response_model=CampaignOut)
def get_campaign(
    campaign_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    """Return full detail for one campaign."""
    try:
        return marketing_service.get_campaign(db, campaign_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.delete("/campaigns/{campaign_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_campaign(
    campaign_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    """Delete a DRAFT campaign. Returns 409 if campaign is not in DRAFT."""
    try:
        marketing_service.delete_campaign(db, campaign_id)
    except ValueError as exc:
        msg = str(exc)
        code = 409 if "Only DRAFT" in msg else 404
        raise HTTPException(status_code=code, detail=msg)


# ---------------------------------------------------------------------------
# Queue action
# ---------------------------------------------------------------------------

@router.post("/campaigns/{campaign_id}/queue", response_model=CampaignOut)
def queue_campaign(
    campaign_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Expand the campaign to individual recipients and write to message_queue.
    The campaign must be in DRAFT status; status becomes QUEUED after this call.
    """
    try:
        return marketing_service.queue_campaign(db, campaign_id, current_user.id)
    except ValueError as exc:
        msg = str(exc)
        code = 409 if "already" in msg else 404
        raise HTTPException(status_code=code, detail=msg)


# ---------------------------------------------------------------------------
# Recipients
# ---------------------------------------------------------------------------

@router.get("/campaigns/{campaign_id}/recipients", response_model=List[CampaignRecipientOut])
def list_recipients(
    campaign_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    """List all recipients for a campaign (populated after queue_campaign)."""
    return marketing_service.list_recipients(db, campaign_id)
