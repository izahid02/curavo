"""
SQLAlchemy ORM model for shop-wide settings.

WHY THIS TABLE EXISTS:
"Health Care Centre" was hardcoded in the sidebar, the login screen, the
thermal receipt and the browser tab.  That is fine until the shop is renamed,
a second branch opens, or the GSTIN printed on a tax invoice changes — at
which point the only fix is a rebuild.  A pharmacy's own identity is DATA, not
source code, so it lives in the database where the owner can change it.

ONE ROW, EVER.  There is no per-branch settings concept yet (that is Phase 5,
multi-branch), so every reader takes the lowest-id row and the startup seed
creates it if the table is empty.  Making it a table rather than a key/value
blob means each field is typed and can be validated.
"""
from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, String, Text

from app.database import Base


class PharmacySettings(Base):
    """The shop's own identity — name, contact details, and legal numbers."""
    __tablename__ = "pharmacy_settings"

    id               = Column(Integer, primary_key=True, index=True)
    # Everything below is nullable / defaulted so a half-filled form is a valid
    # row.  A pharmacy that has not entered its GSTIN yet still needs a name.
    pharmacy_name    = Column(String(150), nullable=False, default="Health Care Centre")
    # The name printed on TAX INVOICES, when it differs from the friendly shop
    # name above — e.g. the legal/registered name that goes with the GSTIN, or a
    # house style such as "M/S HEALTH CARE CENTER".  Printed exactly as typed.
    # NULL = print pharmacy_name in capitals.  (Added Nov 2026 for Curavo.)
    invoice_name     = Column(String(150), nullable=True)
    pharmacy_tagline = Column(String(150), nullable=True,  default="Pharmacy & Medical Store")
    pharmacy_address = Column(Text,        nullable=True)
    pharmacy_phone   = Column(String(40),  nullable=True)
    pharmacy_email   = Column(String(120), nullable=True)
    # GSTIN and Drug Licence number are printed on every tax invoice, and both
    # are legally required on a pharmacy's bill in India.
    pharmacy_gstin     = Column(String(20), nullable=True)
    pharmacy_dl_number = Column(String(60), nullable=True)
    # Naive UTC, like every other timestamp in this app (see utils/dates.py).
    updated_at       = Column(DateTime, nullable=True, default=datetime.utcnow)
