"""
Patient business logic.

This module handles the operations that need more than a simple DB query:
  create_patient       — insert patient + department links + tag links + audit log
  update_patient       — update fields + replace links + audit log
  get_patient_with_stats — fetch patient + compute invoice count + last visit
  search_patients      — search by name or mobile with pagination
  get_purchase_history — all invoices for a patient, newest first

RULE (from CLAUDE.md): multi-step writes (patient + link rows + audit log)
run inside the SAME database session.  The router calls db.commit() once at
the end — if anything fails, the whole transaction rolls back automatically.
"""
import json
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import and_, case, func
from sqlalchemy.orm import Session, joinedload, selectinload

from app.models.billing import AuditLog, Invoice, InvoiceItem
from app.models.followup import FollowUpSchedule
from app.models.inventory import Department, Product
from app.models.patients import Patient, Tag
from app.schemas.billing import InvoiceItemOut, InvoiceOut
from app.schemas.inventory import DepartmentOut
from app.services.revenue import net_invoice_amount_expr
from app.schemas.patients import (
    FollowUpSummaryOut,
    PatientCreate,
    PatientListItem,
    PatientOut,
    PatientSummaryInfo,
    PatientSummaryOut,
    PatientUpdate,
    TagOut,
    TopMedicineOut,
    VisitStatsOut,
)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _load_departments(db: Session, ids: list[int]) -> list[Department]:
    """
    Fetch Department rows for a list of IDs, raising 400 if any are missing.
    This prevents accidentally linking a patient to a non-existent department.
    """
    if not ids:
        return []
    rows = db.query(Department).filter(Department.id.in_(ids)).all()
    found = {r.id for r in rows}
    missing = set(ids) - found
    if missing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Department IDs not found: {sorted(missing)}",
        )
    return rows


def _load_tags(db: Session, ids: list[int]) -> list[Tag]:
    """Fetch Tag rows for a list of IDs, raising 400 if any are missing."""
    if not ids:
        return []
    rows = db.query(Tag).filter(Tag.id.in_(ids)).all()
    found = {r.id for r in rows}
    missing = set(ids) - found
    if missing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Tag IDs not found: {sorted(missing)}",
        )
    return rows


def _patient_stats(db: Session, patient_id: int) -> tuple[int, Optional[date]]:
    """
    Return (total_purchases, last_visit_date) for a patient.

    total_purchases: count of all invoices linked to this patient.
    last_visit_date: date of the most recent invoice, or None if no invoices.

    Uses a single aggregating query so we hit the DB once, not twice.
    """
    row = (
        db.query(
            func.count(Invoice.id).label("total"),
            func.max(Invoice.invoice_date).label("last"),
        )
        .filter(Invoice.patient_id == patient_id)
        .one()
    )
    last_visit = row.last.date() if row.last else None
    return (row.total or 0, last_visit)


def _build_patient_out(db: Session, patient: Patient) -> PatientOut:
    """
    Build a PatientOut response from an ORM Patient object.
    Computes total_purchases and last_visit by querying the invoices table.

    The patient must have its departments and tags already loaded
    (use selectinload in the query, or access them here — they'll lazy-load).
    """
    total_purchases, last_visit = _patient_stats(db, patient.id)
    return PatientOut(
        id=patient.id,
        name=patient.name,
        mobile=patient.mobile,
        age=patient.age,
        gender=patient.gender,
        email=patient.email,
        address=patient.address,
        patient_type=patient.patient_type,
        preferred_language=patient.preferred_language,
        registration_date=patient.registration_date,
        departments=[DepartmentOut(id=d.id, name=d.name) for d in patient.departments],
        tags=[TagOut(id=t.id, name=t.name) for t in patient.tags],
        total_purchases=total_purchases,
        last_visit=last_visit,
    )


# ---------------------------------------------------------------------------
# Public service functions
# ---------------------------------------------------------------------------

def create_patient(db: Session, data: PatientCreate, user_id: int) -> Patient:
    """
    Register a new patient in one atomic transaction:
      1. Validate that all department_ids and tag_ids actually exist.
      2. Insert the Patient row.
      3. Link to departments via patient_departments.
      4. Link to tags via patient_tags.
      5. Write an audit_log entry so we know who created this record.

    The caller (router) must call db.commit() after this returns.
    """
    depts = _load_departments(db, data.department_ids)
    tags  = _load_tags(db, data.tag_ids)

    # Create the patient row.  registration_date defaults to today.
    patient = Patient(
        name=data.name,
        mobile=data.mobile,
        age=data.age,
        gender=data.gender,
        patient_type=data.patient_type,
        preferred_language=data.preferred_language,
        email=data.email,
        address=data.address,
        registration_date=date.today(),
    )
    db.add(patient)
    db.flush()  # flush so patient.id is assigned before we use it in the links below

    # Link departments and tags through the many-to-many tables.
    # We set the relationship attributes directly; SQLAlchemy writes the join rows.
    patient.departments = depts
    patient.tags        = tags

    # Write audit trail
    db.add(AuditLog(
        user_id=user_id,
        action="PATIENT_CREATED",
        entity="patients",
        details=json.dumps({"patient_id": patient.id, "name": data.name, "mobile": data.mobile}),
    ))

    return patient


def update_patient(db: Session, patient_id: int, data: PatientUpdate, user_id: int) -> Patient:
    """
    Update a patient record in one atomic transaction:
      1. Look up the patient (404 if not found).
      2. Apply any non-None field changes.
      3. If department_ids provided, REPLACE all department links.
      4. If tag_ids provided, REPLACE all tag links.
      5. Write audit_log entry.

    The caller (router) must call db.commit() after this returns.
    """
    patient = (
        db.query(Patient)
        .options(selectinload(Patient.departments), selectinload(Patient.tags))
        .filter(Patient.id == patient_id)
        .first()
    )
    if not patient:
        raise HTTPException(status_code=404, detail=f"Patient {patient_id} not found")

    # Apply field-level updates — only change what was sent
    update_fields = data.model_dump(exclude_unset=True)
    for field in ("name", "mobile", "age", "gender", "patient_type",
                  "preferred_language", "email", "address"):
        if field in update_fields:
            setattr(patient, field, update_fields[field])

    # Replace department links if new IDs were provided
    if data.department_ids is not None:
        patient.departments = _load_departments(db, data.department_ids)

    # Replace tag links if new IDs were provided
    if data.tag_ids is not None:
        patient.tags = _load_tags(db, data.tag_ids)

    # Audit the change
    db.add(AuditLog(
        user_id=user_id,
        action="PATIENT_UPDATED",
        entity="patients",
        details=json.dumps({
            "patient_id": patient_id,
            "changed_fields": list(update_fields.keys()),
        }),
    ))

    return patient


def get_patient_with_stats(db: Session, patient_id: int) -> PatientOut:
    """
    Return full patient detail including departments, tags, total_purchases,
    and last_visit date.  Raises 404 if the patient does not exist.
    """
    patient = (
        db.query(Patient)
        .options(selectinload(Patient.departments), selectinload(Patient.tags))
        .filter(Patient.id == patient_id)
        .first()
    )
    if not patient:
        raise HTTPException(status_code=404, detail=f"Patient {patient_id} not found")

    return _build_patient_out(db, patient)


def search_patients(
    db: Session,
    query: Optional[str],
    page: int,
    limit: int,
) -> list[PatientListItem]:
    """
    Search patients by name OR mobile (case-insensitive partial match).
    Returns a paginated list of lightweight PatientListItem rows.

    Each row includes department names, tag names, total_purchases, and
    last_visit computed from the invoices table.
    """
    base_q = db.query(Patient).options(
        selectinload(Patient.departments),
        selectinload(Patient.tags),
    )

    if query and query.strip():
        pattern = f"%{query.strip()}%"
        base_q = base_q.filter(
            Patient.name.ilike(pattern) | Patient.mobile.ilike(pattern)
        )

    patients = (
        base_q
        .order_by(Patient.registration_date.desc(), Patient.id.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    result: list[PatientListItem] = []
    for p in patients:
        total_purchases, last_visit = _patient_stats(db, p.id)
        result.append(PatientListItem(
            id=p.id,
            name=p.name,
            mobile=p.mobile,
            age=p.age,
            gender=p.gender,
            patient_type=p.patient_type,
            departments=[d.name for d in p.departments],
            tags=[t.name for t in p.tags],
            last_visit=last_visit,
            total_purchases=total_purchases,
        ))

    return result


def get_purchase_history(db: Session, patient_id: int) -> list[InvoiceOut]:
    """
    Return all invoices for a patient, newest first.

    Raises 404 if the patient does not exist.
    Each invoice is returned as a full InvoiceOut with all line items.
    """
    # Confirm patient exists
    exists = db.query(Patient.id).filter(Patient.id == patient_id).scalar()
    if not exists:
        raise HTTPException(status_code=404, detail=f"Patient {patient_id} not found")

    invoices = (
        db.query(Invoice)
        .options(
            joinedload(Invoice.patient),
            selectinload(Invoice.items).joinedload(InvoiceItem.product),
            selectinload(Invoice.items).joinedload(InvoiceItem.batch),
        )
        .filter(Invoice.patient_id == patient_id)
        .order_by(Invoice.invoice_date.desc())
        .all()
    )

    result: list[InvoiceOut] = []
    for inv in invoices:
        patient_name = inv.patient.name if inv.patient else "Walk-in Customer"
        items_out = []
        for item in inv.items:
            taxable = Decimal(str(item.quantity)) * item.unit_price
            gst_amt = (taxable * item.gst_rate / Decimal("100")).quantize(Decimal("0.01"))
            items_out.append(InvoiceItemOut(
                product_name=item.product.name,
                batch_number=item.batch.batch_number,
                quantity=item.quantity,
                unit_price=item.unit_price,
                purchase_price=item.purchase_price,
                gst_rate=item.gst_rate,
                taxable_amount=taxable,
                gst_amount=gst_amt,
                line_total=item.line_total,
            ))
        result.append(InvoiceOut(
            id=inv.id,
            invoice_number=inv.invoice_number,
            invoice_date=inv.invoice_date,
            patient_name=patient_name,
            items=items_out,
            subtotal=inv.subtotal,
            discount_amount=inv.discount_amount,
            gst_amount=inv.gst_amount,
            total_amount=inv.total_amount,
            payment_method=inv.payment_method,
            status=inv.status,
        ))

    return result


def get_patient_summary(db: Session, patient_id: int) -> PatientSummaryOut:
    """
    Build a comprehensive patient summary from 5 efficient aggregate queries.

    Query breakdown (no N+1 loops):
      1. Patient row + departments + tags        (selectinload)
      2. Visit stats                             (COUNT/MAX/MIN/SUM aggregate)
      3. Top medicines ranked by purchase count  (GROUP BY + JOIN)
      4. Follow-up schedule counts               (conditional SUM aggregate)
      5. Next upcoming follow-up date            (MIN scalar)

    Risk flags are computed in Python from the already-fetched aggregate data —
    no extra queries.
    """
    today = date.today()

    # ── 1. Patient (with tags and departments) ────────────────────────────────
    patient = (
        db.query(Patient)
        .options(selectinload(Patient.departments), selectinload(Patient.tags))
        .filter(Patient.id == patient_id)
        .first()
    )
    if not patient:
        raise HTTPException(status_code=404, detail=f"Patient {patient_id} not found")

    # ── 2. Visit stats — one aggregate query ──────────────────────────────────
    # total_visits counts all invoice rows (each visit = one invoice event).
    #
    # total_spent excludes fully RETURNED invoices and nets any refund off the
    # rest.  ⚠ This used to test `status == "COMPLETED"`, which was the ONLY
    # place in the app that dropped a partially-returned invoice to ZERO — a
    # patient who returned one item off a ₹2,000 bill lost the whole ₹2,000 from
    # their lifetime spend, which then quietly mis-ranked them everywhere this
    # figure is read.  Testing `!= "RETURNED"` keeps the sale that stuck, and
    # net_invoice_amount_expr() removes only what was actually handed back.
    visit_row = (
        db.query(
            func.count(Invoice.id).label("total_visits"),
            func.max(Invoice.invoice_date).label("last_visit"),
            func.min(Invoice.invoice_date).label("first_visit"),
            func.sum(
                case((Invoice.status != "RETURNED", net_invoice_amount_expr()), else_=0)
            ).label("total_spent"),
        )
        .filter(Invoice.patient_id == patient_id)
        .one()
    )

    total_visits = visit_row.total_visits or 0
    total_spent  = Decimal(str(visit_row.total_spent or 0))
    last_visit   = visit_row.last_visit.date()  if visit_row.last_visit  else None
    first_visit  = visit_row.first_visit.date() if visit_row.first_visit else None

    days_since_last     = (today - last_visit).days if last_visit else None
    avg_days_between    = None
    if total_visits > 1 and last_visit and first_visit:
        span = (last_visit - first_visit).days
        avg_days_between = round(span / (total_visits - 1), 1)

    avg_per_visit = (total_spent / total_visits).quantize(Decimal("0.01")) if total_visits > 0 else None

    # ── 3. Top medicines — one grouped query ──────────────────────────────────
    # Joins invoice_items → invoices (for patient filter) → products (for names).
    # Also fetches first/last purchase dates for the chronic-medicine overdue check.
    med_rows = (
        db.query(
            Product.name.label("name"),
            func.count(InvoiceItem.id).label("times"),
            func.max(Invoice.invoice_date).label("last_purch"),
            func.min(Invoice.invoice_date).label("first_purch"),
        )
        .select_from(InvoiceItem)
        .join(Invoice,  InvoiceItem.invoice_id  == Invoice.id)
        .join(Product,  InvoiceItem.product_id  == Product.id)
        .filter(Invoice.patient_id == patient_id)
        .group_by(InvoiceItem.product_id, Product.name)
        .order_by(func.count(InvoiceItem.id).desc())
        .limit(10)
        .all()
    )

    top_medicines: list[TopMedicineOut] = []
    risk_flags:    list[str]            = []

    for row in med_rows:
        last_purch = row.last_purch.date() if row.last_purch else None
        top_medicines.append(TopMedicineOut(
            name=row.name,
            times_purchased=row.times,
            last_purchased=last_purch,
        ))
        # Chronic-medicine overdue check: if purchased 3+ times and the gap
        # since last purchase exceeds 1.2× the patient's own average refill
        # interval, flag it.
        if row.times >= 3 and last_purch and row.first_purch:
            first_purch   = row.first_purch.date()
            span_days     = (last_purch - first_purch).days
            avg_interval  = span_days / (row.times - 1) if row.times > 1 else 30.0
            days_since    = (today - last_purch).days
            if days_since > avg_interval * 1.2:
                overdue = int(days_since - avg_interval)
                s = "s" if overdue != 1 else ""
                risk_flags.append(
                    f"Chronic medicine ({row.name}) not refilled"
                    f" — {overdue} day{s} overdue"
                )

    # ── 4. Follow-up stats — one aggregate query ──────────────────────────────
    fu_row = (
        db.query(
            func.count(FollowUpSchedule.id).label("total"),
            func.sum(
                case((FollowUpSchedule.status == "COMPLETED", 1), else_=0)
            ).label("completed"),
            func.sum(
                case((FollowUpSchedule.status == "PENDING", 1), else_=0)
            ).label("pending"),
            # Count PENDING items whose scheduled_date is in the past (overdue)
            func.sum(
                case(
                    (and_(
                        FollowUpSchedule.status == "PENDING",
                        FollowUpSchedule.scheduled_date < today,
                    ), 1),
                    else_=0,
                )
            ).label("overdue"),
        )
        .filter(FollowUpSchedule.patient_id == patient_id)
        .one()
    )

    fu_total     = fu_row.total     or 0
    fu_completed = fu_row.completed or 0
    fu_pending   = fu_row.pending   or 0
    fu_overdue   = fu_row.overdue   or 0
    fu_rate      = round(fu_completed / fu_total, 2) if fu_total > 0 else None

    # ── 5. Next upcoming (non-overdue) follow-up date ─────────────────────────
    next_due: Optional[date] = (
        db.query(func.min(FollowUpSchedule.scheduled_date))
        .filter(
            FollowUpSchedule.patient_id    == patient_id,
            FollowUpSchedule.status        == "PENDING",
            FollowUpSchedule.scheduled_date >= today,
        )
        .scalar()
    )

    # ── Risk flags (computed from data already in memory — no extra queries) ──
    if days_since_last is not None:
        if days_since_last > 60:
            risk_flags.append(
                f"No visit in 60+ days ({days_since_last} days since last visit)"
            )
        elif days_since_last > 30:
            risk_flags.append(
                f"No visit in 30+ days ({days_since_last} days since last visit)"
            )

    if fu_overdue > 0:
        s = "s" if fu_overdue != 1 else ""
        risk_flags.append(
            f"Pending follow-up overdue"
            f" ({fu_overdue} scheduled check{s} past due)"
        )

    return PatientSummaryOut(
        patient=PatientSummaryInfo(
            name=patient.name,
            phone=patient.mobile,
            age=patient.age,
            tags=[t.name for t in patient.tags],
            departments=[d.name for d in patient.departments],
            registered_since=patient.registration_date,
        ),
        visit_stats=VisitStatsOut(
            total_visits=total_visits,
            last_visit=last_visit,
            days_since_last_visit=days_since_last,
            avg_days_between_visits=avg_days_between,
            total_spent=total_spent,
            avg_per_visit=avg_per_visit,
        ),
        top_medicines=top_medicines,
        follow_ups=FollowUpSummaryOut(
            pending=fu_pending,
            completed=fu_completed,
            next_due=next_due,
            response_rate=fu_rate,
        ),
        risk_flags=risk_flags,
    )
