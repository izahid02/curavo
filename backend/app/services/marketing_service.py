"""
Business logic for Phase 3.4 — Marketing Automation.

Three main operations:
  1. get_filtered_patients  — run filter rules against the patients table
  2. preview_campaign       — return count + 5 sample patients for a filter set
  3. create_campaign        — persist campaign + filters + messages (DRAFT)
  4. queue_campaign         — expand to recipients + write to message_queue

OFFLINE-FIRST: queue_campaign() only writes to the DB. No HTTP calls.
An external SMS/WhatsApp provider reads message_queue when online.
"""
from datetime import datetime, timezone
from typing import List

from sqlalchemy import func
from sqlalchemy.orm import Session, selectinload

from app.models.billing import Invoice
from app.models.followup import MessageQueue
from app.models.marketing import (
    Campaign, CampaignFilter, CampaignMessage, CampaignRecipient
)
from app.models.patients import Patient, Tag
from app.models.inventory import Department
from app.schemas.marketing import (
    CampaignCreate, CampaignFilterCreate, CampaignOut, CampaignPreviewOut,
    CampaignListItem, CampaignRecipientOut, SamplePatient,
)


# ---------------------------------------------------------------------------
# Helper: build the output schema from an ORM Campaign object
# ---------------------------------------------------------------------------

def _build_campaign_out(db: Session, campaign: Campaign) -> CampaignOut:
    """Convert an ORM Campaign row into CampaignOut, adding recipient_count."""
    recipient_count = db.query(func.count(CampaignRecipient.id)).filter(
        CampaignRecipient.campaign_id == campaign.id
    ).scalar() or 0

    return CampaignOut(
        id=campaign.id,
        name=campaign.name,
        description=campaign.description,
        campaign_type=campaign.campaign_type,
        channel=campaign.channel,
        status=campaign.status,
        scheduled_at=campaign.scheduled_at,
        sent_at=campaign.sent_at,
        created_at=campaign.created_at,
        recipient_count=recipient_count,
        filters=[
            CampaignFilterCreate(filter_type=f.filter_type, filter_value=f.filter_value)
            for f in campaign.filters
        ],
        messages=[
            {"language": m.language, "message_body": m.message_body}
            for m in campaign.messages
        ],
    )


# ---------------------------------------------------------------------------
# 1. get_filtered_patients
# ---------------------------------------------------------------------------

def get_filtered_patients(db: Session, filters: List[CampaignFilterCreate]) -> List[Patient]:
    """
    Return all patients (who have a mobile number) that match ALL the given filters.

    Each filter type is applied as an AND condition — a patient must pass
    every filter to be included. Patients without a mobile are always excluded
    because we can't send them a message.

    How each filter_type works:
      TAG               → patient has a tag whose name matches filter_value
      DEPARTMENT        → patient belongs to a department with that name
      PATIENT_TYPE      → patient.patient_type matches filter_value
      GENDER            → patient.gender matches filter_value
      LAST_VISIT_BEFORE → most recent invoice date < filter_value (or never visited)
      LAST_VISIT_AFTER  → most recent invoice date > filter_value
      AGE_MIN           → patient.age >= int(filter_value)
      AGE_MAX           → patient.age <= int(filter_value)
    """
    # Start with all patients who have a mobile number
    query = db.query(Patient).filter(
        Patient.mobile.isnot(None),
        Patient.mobile != "",
    ).options(
        selectinload(Patient.tags),
        selectinload(Patient.departments),
    )

    for f in filters:
        ft  = f.filter_type.upper()
        fv  = f.filter_value.strip()

        if ft == "TAG":
            # Keep patients who have a tag with this name
            query = query.filter(
                Patient.tags.any(Tag.name.ilike(fv))
            )

        elif ft == "DEPARTMENT":
            # Keep patients in this department
            query = query.filter(
                Patient.departments.any(Department.name.ilike(fv))
            )

        elif ft == "PATIENT_TYPE":
            query = query.filter(
                Patient.patient_type.ilike(fv)
            )

        elif ft == "GENDER":
            query = query.filter(
                Patient.gender.ilike(fv)
            )

        elif ft == "LAST_VISIT_BEFORE":
            # Patients whose last invoice is before this date, OR who have never visited.
            # We use a subquery to find the max invoice date per patient.
            cutoff = fv   # ISO date string comparison works in PostgreSQL
            last_visit_subq = (
                db.query(Invoice.patient_id, func.max(Invoice.invoice_date).label("last_date"))
                .group_by(Invoice.patient_id)
                .subquery()
            )
            # LEFT join so patients with no invoices are included (last_date IS NULL)
            query = query.outerjoin(
                last_visit_subq,
                Patient.id == last_visit_subq.c.patient_id,
            ).filter(
                (last_visit_subq.c.last_date < cutoff) |
                (last_visit_subq.c.last_date.is_(None))
            )

        elif ft == "LAST_VISIT_AFTER":
            cutoff = fv
            last_visit_subq = (
                db.query(Invoice.patient_id, func.max(Invoice.invoice_date).label("last_date"))
                .group_by(Invoice.patient_id)
                .subquery()
            )
            query = query.join(
                last_visit_subq,
                Patient.id == last_visit_subq.c.patient_id,
            ).filter(
                last_visit_subq.c.last_date > cutoff
            )

        elif ft == "AGE_MIN":
            try:
                min_age = int(fv)
                query = query.filter(Patient.age >= min_age)
            except ValueError:
                pass   # ignore malformed filter value

        elif ft == "AGE_MAX":
            try:
                max_age = int(fv)
                query = query.filter(Patient.age <= max_age)
            except ValueError:
                pass

    return query.all()


# ---------------------------------------------------------------------------
# 2. preview_campaign
# ---------------------------------------------------------------------------

def preview_campaign(db: Session, filters: List[CampaignFilterCreate]) -> CampaignPreviewOut:
    """
    Run the filters without creating anything and return:
      - total count of matched patients
      - first 5 as sample rows (name, mobile, tags, primary department)
    """
    patients = get_filtered_patients(db, filters)

    sample = []
    for p in patients[:5]:
        primary_dept = p.departments[0].name if p.departments else None
        sample.append(SamplePatient(
            name=p.name,
            mobile=p.mobile,
            tags=[t.name for t in p.tags],
            department=primary_dept,
        ))

    return CampaignPreviewOut(
        matched_patients=len(patients),
        sample_patients=sample,
    )


# ---------------------------------------------------------------------------
# 3. create_campaign
# ---------------------------------------------------------------------------

def create_campaign(db: Session, data: CampaignCreate, user_id: int) -> CampaignOut:
    """
    Persist a new campaign in DRAFT status.

    Creates Campaign + CampaignFilter rows + CampaignMessage rows in one
    database transaction so everything is either saved or nothing is.
    """
    campaign = Campaign(
        name=data.name,
        description=data.description,
        campaign_type=data.campaign_type,
        channel=data.channel,
        status="DRAFT",
        scheduled_at=data.scheduled_at,
        created_by=user_id,
    )
    db.add(campaign)
    db.flush()   # get campaign.id before inserting child rows

    for f in data.filters:
        db.add(CampaignFilter(
            campaign_id=campaign.id,
            filter_type=f.filter_type,
            filter_value=f.filter_value,
        ))

    for m in data.messages:
        db.add(CampaignMessage(
            campaign_id=campaign.id,
            language=m.language,
            message_body=m.message_body,
        ))

    db.commit()
    db.refresh(campaign)
    return _build_campaign_out(db, campaign)


# ---------------------------------------------------------------------------
# 4. queue_campaign
# ---------------------------------------------------------------------------

def queue_campaign(db: Session, campaign_id: int, user_id: int) -> CampaignOut:
    """
    Expand a DRAFT campaign into individual message_queue rows.

    Steps:
      1. Load campaign (must be DRAFT)
      2. Run get_filtered_patients() with campaign's filters
      3. For each matched patient:
         a. For each campaign message:
            - Create a CampaignRecipient row
            - Create a MessageQueue row (with variable substitution)
      4. Mark campaign.status = 'QUEUED' and set campaign.sent_at = now()
      5. All in one transaction

    Variable substitution replaces {patient_name} and {shop_name} in
    the message body with the actual patient name and shop name before
    queuing — so the final text is ready to send.
    """
    campaign = db.query(Campaign).options(
        selectinload(Campaign.filters),
        selectinload(Campaign.messages),
    ).filter(Campaign.id == campaign_id).first()

    if campaign is None:
        raise ValueError(f"Campaign {campaign_id} not found")

    if campaign.status != "DRAFT":
        raise ValueError(f"Campaign is already {campaign.status} — only DRAFT campaigns can be queued")

    # Resolve filter objects into CampaignFilterCreate for the service
    filter_specs = [
        CampaignFilterCreate(filter_type=f.filter_type, filter_value=f.filter_value)
        for f in campaign.filters
    ]

    patients = get_filtered_patients(db, filter_specs)

    # Determine the send time: use scheduled_at if set, otherwise now
    send_time = campaign.scheduled_at or datetime.now(timezone.utc)

    for patient in patients:
        for msg in campaign.messages:
            # Substitute variables in the message body
            body = (
                msg.message_body
                .replace("{patient_name}", patient.name)
                .replace("{shop_name}", "Health Care Centre")
            )

            # Track recipient in campaign_recipients
            db.add(CampaignRecipient(
                campaign_id=campaign_id,
                patient_id=patient.id,
                mobile=patient.mobile,
                status="QUEUED",
                queued_at=datetime.now(timezone.utc),
            ))

            # Write to the shared message_queue so the SMS provider can pick it up
            db.add(MessageQueue(
                patient_id=patient.id,
                follow_up_id=None,              # not a follow-up; this is a campaign message
                channel=campaign.channel,
                recipient_mobile=patient.mobile,
                language=msg.language,
                message_body=body,
                status="QUEUED",
                scheduled_at=send_time,
            ))

    # Mark campaign as queued
    campaign.status = "QUEUED"
    campaign.sent_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(campaign)
    return _build_campaign_out(db, campaign)


# ---------------------------------------------------------------------------
# List helpers
# ---------------------------------------------------------------------------

def list_campaigns(db: Session, status: str | None, page: int, limit: int) -> List[CampaignListItem]:
    """Return a paginated list of campaigns, newest first."""
    query = db.query(Campaign)
    if status:
        query = query.filter(Campaign.status == status.upper())
    query = query.order_by(Campaign.created_at.desc())
    campaigns = query.offset((page - 1) * limit).limit(limit).all()

    result = []
    for c in campaigns:
        rc = db.query(func.count(CampaignRecipient.id)).filter(
            CampaignRecipient.campaign_id == c.id
        ).scalar() or 0
        result.append(CampaignListItem(
            id=c.id,
            name=c.name,
            campaign_type=c.campaign_type,
            channel=c.channel,
            status=c.status,
            scheduled_at=c.scheduled_at,
            sent_at=c.sent_at,
            created_at=c.created_at,
            recipient_count=rc,
        ))
    return result


def get_campaign(db: Session, campaign_id: int) -> CampaignOut:
    """Load full campaign detail."""
    campaign = db.query(Campaign).options(
        selectinload(Campaign.filters),
        selectinload(Campaign.messages),
    ).filter(Campaign.id == campaign_id).first()
    if campaign is None:
        raise ValueError(f"Campaign {campaign_id} not found")
    return _build_campaign_out(db, campaign)


def delete_campaign(db: Session, campaign_id: int) -> None:
    """Delete a DRAFT campaign. Raises ValueError if not DRAFT."""
    campaign = db.query(Campaign).filter(Campaign.id == campaign_id).first()
    if campaign is None:
        raise ValueError(f"Campaign {campaign_id} not found")
    if campaign.status != "DRAFT":
        raise ValueError("Only DRAFT campaigns can be deleted")
    db.delete(campaign)
    db.commit()


def list_recipients(db: Session, campaign_id: int) -> List[CampaignRecipientOut]:
    """Return all recipients for a campaign."""
    rows = db.query(CampaignRecipient).filter(
        CampaignRecipient.campaign_id == campaign_id
    ).options(
        selectinload(CampaignRecipient.patient)
    ).order_by(CampaignRecipient.id).all()

    return [
        CampaignRecipientOut(
            id=r.id,
            patient_id=r.patient_id,
            patient_name=r.patient.name if r.patient else "Unknown",
            mobile=r.mobile,
            status=r.status,
            queued_at=r.queued_at,
            sent_at=r.sent_at,
            error_message=r.error_message,
        )
        for r in rows
    ]
