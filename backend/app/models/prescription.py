"""
SQLAlchemy ORM model for prescription image uploads.

Each row links one scanned prescription image to a patient and
(optionally) to the invoice it was dispensed against.

Only the file PATH is stored in the DB — the actual image bytes live
on disk under APP_DATA/prescriptions/.  This avoids bloating the
SQLite database file with binary data.
"""
from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from app.database import Base


class Prescription(Base):
    __tablename__ = "prescriptions"

    id          = Column(Integer, primary_key=True, index=True)

    # invoice_id is nullable: a prescription may be uploaded before the bill
    # is created, or it may be linked later.
    invoice_id  = Column(Integer, ForeignKey("invoices.id"), nullable=True, index=True)

    # patient_id is always required — a prescription must belong to someone.
    patient_id  = Column(Integer, ForeignKey("patients.id"), nullable=False, index=True)

    # Relative path from APP_DATA/prescriptions/
    # e.g. "42_20250115_143022_prescription.jpg"
    file_path   = Column(String, nullable=False)

    # Original filename the pharmacist uploaded (for display)
    file_name   = Column(String, nullable=False)

    # File size in bytes (stored so the UI can show "1.2 MB" without a disk read)
    file_size   = Column(Integer, nullable=True)

    # MIME type: image/jpeg, image/png, image/webp, or application/pdf
    mime_type   = Column(String, nullable=True)

    uploaded_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # Which user uploaded it (nullable in case the user record is deleted later)
    uploaded_by = Column(Integer, ForeignKey("users.id"), nullable=True)

    # Optional short note the pharmacist can attach ("front side only", etc.)
    notes       = Column(Text, nullable=True)

    # --- Multi-page prescriptions -------------------------------------------
    # ONE PRESCRIPTION, SEVERAL SHEETS.  A doctor's pad routinely runs to two
    # or three pages, and each page is stored as its own row here.  These two
    # columns are the only thing tying those rows back together:
    #   group_id    — the same opaque id on every page uploaded in one go
    #   page_number — 1-based position within that group, so order survives
    #
    # BOTH ARE NULL ON EVERY ROW WRITTEN BEFORE THIS EXISTED, and readers must
    # keep treating a NULL group_id as "a prescription of one page, by itself".
    # That is what those rows actually are, so no backfill is needed and the
    # pharmacy's existing prescriptions display exactly as they did.
    #
    # Deliberately NOT grouped by invoice_id instead: a prescription can be
    # uploaded before any bill exists (invoice_id is nullable), and two
    # separate prescriptions can legitimately hang off one invoice.
    group_id    = Column(String, nullable=True, index=True)
    page_number = Column(Integer, nullable=True)

    # Relationships for convenient JOIN access
    patient  = relationship("Patient", foreign_keys=[patient_id], lazy="select")
    invoice  = relationship("Invoice", foreign_keys=[invoice_id], lazy="select")
    uploader = relationship("User",    foreign_keys=[uploaded_by], lazy="select")
