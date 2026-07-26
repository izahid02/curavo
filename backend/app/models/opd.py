"""
SQLAlchemy ORM models for OPD (Out-Patient Department) module.

Maps to tables created in Phase 3 schema additions:
  doctors    — doctor/specialist profiles used for referrals
  opd_visits — patient consultation records linking patient + doctor
"""
from sqlalchemy import Boolean, Column, Date, ForeignKey, Integer, String, Text, TIMESTAMP
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Doctor(Base):
    """A doctor or specialist at the health centre."""
    __tablename__ = "doctors"

    id             = Column(Integer, primary_key=True, index=True)
    name           = Column(String(120), nullable=False)
    specialization = Column(String(100), nullable=True)
    phone          = Column(String(20), nullable=True)
    is_active      = Column(Boolean, nullable=False, default=True)
    created_at     = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    visits = relationship("OPDVisit", back_populates="doctor")


class OPDVisit(Base):
    """One outpatient consultation record."""
    __tablename__ = "opd_visits"

    id             = Column(Integer, primary_key=True, index=True)
    patient_id     = Column(Integer, ForeignKey("patients.id"), nullable=False)
    doctor_id      = Column(Integer, ForeignKey("doctors.id"), nullable=True)
    visit_date     = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
    department_id  = Column(Integer, ForeignKey("departments.id"), nullable=True)
    diagnosis      = Column(Text, nullable=True)
    notes          = Column(Text, nullable=True)
    follow_up_date = Column(Date, nullable=True)
    status         = Column(String(20), nullable=False, default="COMPLETED")
    created_by     = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at     = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    doctor  = relationship("Doctor", back_populates="visits")
    patient = relationship("Patient", foreign_keys=[patient_id])
