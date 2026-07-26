"""
ORM models for the Patients module.

Extends the minimal stub used by billing into a full module with:
  - Tag           — flexible label (e.g. "Diabetes", "Senior Citizen")
  - patient_departments_table — many-to-many join table (patients ↔ departments)
  - patient_tags_table        — many-to-many join table (patients ↔ tags)
  - Patient       — full record with relationships to departments and tags

ALL tables already exist in the database (created by schema.sql).
We are only defining Python representations of those tables here.
"""
from sqlalchemy import Column, Date, ForeignKey, Integer, String, Table, Text, TIMESTAMP
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


# ---------------------------------------------------------------------------
# Association tables
#
# These are "pure join" tables — they have no extra columns, just two
# foreign-key columns that together form the primary key.
# SQLAlchemy's `secondary=` parameter uses these to handle many-to-many
# loading automatically without us writing any JOIN queries by hand.
# ---------------------------------------------------------------------------

patient_departments_table = Table(
    "patient_departments",
    Base.metadata,
    Column("patient_id",    Integer, ForeignKey("patients.id"),    primary_key=True),
    Column("department_id", Integer, ForeignKey("departments.id"), primary_key=True),
)

patient_tags_table = Table(
    "patient_tags",
    Base.metadata,
    Column("patient_id", Integer, ForeignKey("patients.id"), primary_key=True),
    Column("tag_id",     Integer, ForeignKey("tags.id"),     primary_key=True),
)


# ---------------------------------------------------------------------------
# Tag model
# ---------------------------------------------------------------------------

class Tag(Base):
    """
    Maps to the 'tags' table.

    Tags are flexible labels applied to patients so staff can filter and
    target messages (e.g. find all patients tagged "Diabetes" for a promo).
    The tag library is pre-seeded with 16 common labels on first startup.
    """
    __tablename__ = "tags"

    id   = Column(Integer, primary_key=True, index=True)
    name = Column(String(60), unique=True, nullable=False)


# ---------------------------------------------------------------------------
# Patient model (full version)
# ---------------------------------------------------------------------------

class Patient(Base):
    """
    Maps to the 'patients' table.

    This is the full version of the Patient model.  A minimal version was
    used during the billing build; this replaces it with many-to-many
    relationships for departments and tags.

    The relationships use lazy="select" (the default): they are only fetched
    from the database when explicitly accessed or when the service requests
    them with selectinload().  Billing code that loads a Patient to read
    its name will NOT trigger unnecessary department/tag queries.
    """
    __tablename__ = "patients"

    id                 = Column(Integer, primary_key=True, index=True)
    name               = Column(String(120), nullable=False)
    age                = Column(Integer)
    gender             = Column(String(10))
    mobile             = Column(String(20), index=True)
    email              = Column(String(120))
    address            = Column(Text)
    patient_type       = Column(String(30), nullable=False)
    preferred_language = Column(String(10), default="BOTH")
    registration_date  = Column(Date, nullable=False)
    created_at         = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    # Many-to-many: a patient can belong to multiple departments
    # (e.g. someone with diabetes who also needs cardiology).
    # "Department" is the class defined in models/inventory.py.
    # SQLAlchemy resolves the string reference once all models are imported.
    departments = relationship(
        "Department",
        secondary=patient_departments_table,
        lazy="select",
    )

    # Many-to-many: a patient can have multiple tags
    tags = relationship(
        "Tag",
        secondary=patient_tags_table,
        lazy="select",
    )
