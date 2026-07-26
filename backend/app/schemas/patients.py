"""
Pydantic schemas for the Patients module.

Pydantic validates data coming in (requests) and shapes data going out
(responses).  Each class here is a contract:
  - PatientCreate / PatientUpdate  — what the frontend sends to us
  - PatientOut / PatientListItem   — what we send back to the frontend
  - TagOut                         — minimal tag info used in responses

RULE: All optional fields are typed as Optional[X] with a None default.
This lets the frontend send only the fields it wants to change (PATCH style).
"""
from datetime import date
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, Field

# DepartmentOut is already defined in the inventory schemas.
# We import and re-use it rather than duplicating the class.
from app.schemas.inventory import DepartmentOut  # noqa: F401 — re-exported for routers


# ---------------------------------------------------------------------------
# Tag schemas
# ---------------------------------------------------------------------------

class TagOut(BaseModel):
    """A single tag as returned by the API (e.g. {id: 1, name: "Diabetes"})."""
    id:   int
    name: str

    model_config = {"from_attributes": True}


class TagCreate(BaseModel):
    """Request body for creating a new tag."""
    name: str = Field(..., min_length=1, max_length=60)


# ---------------------------------------------------------------------------
# Patient create / update schemas
# ---------------------------------------------------------------------------

class PatientCreate(BaseModel):
    """
    Fields the frontend sends when registering a new patient.
    Fields marked with * in the form are required here (no default).
    """
    name:               str   = Field(..., min_length=1, max_length=120)
    mobile:             str   = Field(..., min_length=1, max_length=20)
    patient_type:       str   = Field(..., pattern="^(PRESCRIPTION|SELF_MEDICATION)$")
    age:                Optional[int]   = None
    gender:             Optional[str]   = Field(None, pattern="^(M|F|Other)$")
    email:              Optional[str]   = None
    address:            Optional[str]   = None
    # 'AS' = Assamese, 'EN' = English, 'BOTH' = bilingual
    preferred_language: str             = Field(default="BOTH", pattern="^(AS|EN|BOTH)$")
    department_ids:     list[int]       = []
    tag_ids:            list[int]       = []


class PatientUpdate(BaseModel):
    """
    All fields optional — send only the ones you want to change.
    This is the standard "partial update" pattern.
    """
    name:               Optional[str]   = None
    mobile:             Optional[str]   = None
    patient_type:       Optional[str]   = Field(None, pattern="^(PRESCRIPTION|SELF_MEDICATION)$")
    age:                Optional[int]   = None
    gender:             Optional[str]   = Field(None, pattern="^(M|F|Other)$")
    email:              Optional[str]   = None
    address:            Optional[str]   = None
    preferred_language: Optional[str]   = Field(None, pattern="^(AS|EN|BOTH)$")
    department_ids:     Optional[list[int]] = None
    tag_ids:            Optional[list[int]] = None


# ---------------------------------------------------------------------------
# Patient response schemas
# ---------------------------------------------------------------------------

class PatientOut(BaseModel):
    """
    Full patient detail — shown on the patient record page and detail modal.

    total_purchases: count of invoices linked to this patient.
    last_visit:      date of the most recent invoice, or None if no purchases.

    Note: total_purchases and last_visit are computed by the service layer
    (they are not columns on the patients table), so we construct this
    manually rather than using from_attributes conversion.
    """
    id:                 int
    name:               str
    mobile:             Optional[str]
    age:                Optional[int]
    gender:             Optional[str]
    email:              Optional[str]
    address:            Optional[str]
    patient_type:       str
    preferred_language: Optional[str]
    registration_date:  date
    departments:        list[DepartmentOut]
    tags:               list[TagOut]
    total_purchases:    int
    last_visit:         Optional[date]


class PatientListItem(BaseModel):
    """
    Lightweight patient row for the patient list table.
    Does NOT include full department/tag objects — only their names as
    plain strings.  This keeps the list response small and fast.
    """
    id:               int
    name:             str
    mobile:           Optional[str]
    age:              Optional[int]
    gender:           Optional[str]
    patient_type:     str
    departments:      list[str]   # just the names, e.g. ["Diabetes", "Cardiology"]
    tags:             list[str]   # just the names, e.g. ["Chronic Patient"]
    last_visit:       Optional[date]
    total_purchases:  int


# ---------------------------------------------------------------------------
# Patient summary schemas  (GET /patients/{id}/summary)
# ---------------------------------------------------------------------------

class PatientSummaryInfo(BaseModel):
    """Basic patient identity fields returned inside the summary card."""
    name:             str
    phone:            Optional[str]
    age:              Optional[int]
    tags:             list[str]
    departments:      list[str]
    registered_since: date


class VisitStatsOut(BaseModel):
    """Aggregated visit and spending statistics computed from invoices."""
    total_visits:            int
    last_visit:              Optional[date]
    days_since_last_visit:   Optional[int]
    avg_days_between_visits: Optional[float]
    total_spent:             Decimal
    avg_per_visit:           Optional[Decimal]


class TopMedicineOut(BaseModel):
    """One medicine in the 'top purchased medicines' list."""
    name:             str
    times_purchased:  int
    last_purchased:   Optional[date]


class FollowUpSummaryOut(BaseModel):
    """Follow-up schedule counts and next due date for the summary card."""
    pending:       int
    completed:     int
    next_due:      Optional[date]
    response_rate: Optional[float]


class PatientSummaryOut(BaseModel):
    """
    Full smart summary returned by GET /patients/{id}/summary.
    Combines visit stats, top medicines, follow-up counts, and risk flags
    all in one response so the frontend makes a single API call.
    """
    patient:       PatientSummaryInfo
    visit_stats:   VisitStatsOut
    top_medicines: list[TopMedicineOut]
    follow_ups:    FollowUpSummaryOut
    risk_flags:    list[str]
