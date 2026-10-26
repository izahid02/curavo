"""
The Schedule H1 / MTP register — one row per regulated medicine dispensed.

WHAT THIS TABLE IS
------------------
Rule 65(11)(d) requires a pharmacy to record every Schedule H1 sale in a
register, keep it three years, and produce it on inspection.  This table is
that register.  The MTP kit rides in the same table under its own category,
because the pharmacist wants one place to look rather than two.

EVERY VALUE HERE IS A SNAPSHOT.  THIS IS THE WHOLE POINT.
---------------------------------------------------------
The obvious design is foreign keys to patients, products and invoices, and
joining when the register is read.  That design is WRONG here, and quietly so.

A register entry records what was true at the moment of dispensing.  If the
pharmacist corrects a patient's phone number next year, or renames a medicine,
or a batch number is fixed, a joined register would silently rewrite history —
and a legal record that changes after the fact is worse than no record, because
it still looks authoritative.  So the patient's name, phone and address, the
prescriber's name and address, the medicine, the batch and the quantity are all
COPIED onto the row here and never read back through a relationship.

The id columns are kept alongside, but only so a human can navigate from a
register entry to the live record.  Nothing displayed in the register comes
from them.

The official register has six columns:
    S.No. | Name and address of the prescriber | Name of the patient |
    Name of the medicine dispensed | Quantity dispensed |
    Registration number of the patient and date
Everything else stored here is extra the pharmacist asked for (the patient's
phone, the batch, the invoice, who dispensed it).  A register may hold more
than the minimum; it may never hold less.
"""
from sqlalchemy import (
    Column, Date, ForeignKey, Integer, String, Text, TIMESTAMP, func,
)

from app.database import Base


class RegulatedSale(Base):
    __tablename__ = "regulated_sales"

    id = Column(Integer, primary_key=True, index=True)

    # --- When ---------------------------------------------------------------
    # sold_on is the DATE the register is read by, and is indexed because every
    # view of this table is "show me a date range".  sold_at keeps the time for
    # the audit trail.
    sold_on     = Column(Date, nullable=False, index=True)
    sold_at     = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    # --- Why this sale is in the register -----------------------------------
    # category      — 'H1' or 'MTP' (see services/drug_schedules.py)
    # drug_matched  — the Schedule H1 drug that put it here; NULL for an MTP kit
    # notification  — the gazette entry in force on the day, for the audit trail
    category     = Column(String(8),  nullable=False, index=True)
    drug_matched = Column(String(60), nullable=True)
    notification = Column(String(80), nullable=True)

    # --- The medicine (snapshot) --------------------------------------------
    product_id    = Column(Integer, ForeignKey("products.id"), nullable=True)
    product_name  = Column(String(150), nullable=False)
    generic_name  = Column(String(150), nullable=True)
    batch_id      = Column(Integer, ForeignKey("batches.id"), nullable=True)
    batch_number  = Column(String(60), nullable=True)
    expiry_date   = Column(Date, nullable=True)

    # quantity is in individual UNITS, the way stock is always counted.
    # quantity_label is how it was SOLD, in the pharmacist's own words
    # ("2 strips (30 tablets)"), because that is what an inspector is shown.
    quantity       = Column(Integer, nullable=False)
    quantity_label = Column(String(60), nullable=True)

    # --- The patient (snapshot) ---------------------------------------------
    patient_id      = Column(Integer, ForeignKey("patients.id"), nullable=True)
    patient_name    = Column(String(120), nullable=False)
    patient_phone   = Column(String(20),  nullable=True)
    patient_address = Column(Text,        nullable=True)

    # --- The prescriber (snapshot) ------------------------------------------
    # The schedule asks for the prescriber's NAME AND ADDRESS, not the name
    # alone — which is why the billing screen collects both.
    prescriber_name    = Column(String(120), nullable=False)
    prescriber_address = Column(Text,        nullable=True)

    # --- The sale (snapshot) ------------------------------------------------
    invoice_id     = Column(Integer, ForeignKey("invoices.id"), nullable=True)
    invoice_number = Column(String(40), nullable=True)

    # Who dispensed it.  Name copied for the same reason as everything else:
    # a staff member can leave and their user record can change.
    dispensed_by_id   = Column(Integer, ForeignKey("users.id"), nullable=True)
    dispensed_by_name = Column(String(120), nullable=True)

    created_at = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
