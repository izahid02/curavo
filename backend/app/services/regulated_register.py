"""
Writing the Schedule H1 / MTP register as medicines are dispensed.

Two jobs, in this order:

  1. REFUSE the sale if the details the register needs are not there.
  2. Write one register row per regulated line, with every value COPIED.

Why refusing is the right behaviour
-----------------------------------
The alternative — let the sale through and fill the register in later — means
the register is written from memory, at the end of a busy day, about a
customer who has left.  That is how registers end up with "walk-in" in the
patient column.  The counter is the only moment the information exists, so it
is the only moment worth asking.

The practical cost is real and should not be hidden from the pharmacist: a
walk-in customer cannot buy a Schedule H1 medicine anonymously any more.  That
is what the rule requires; the app simply stops pretending otherwise.

Why every value is copied
-------------------------
See models/regulated.py.  In short: a register entry states what was true at
the moment of dispensing, and a joined entry would silently rewrite itself
when a patient's phone number is corrected two years later.
"""
from typing import Iterable, Optional

from sqlalchemy.orm import Session

from app.models.inventory import Product
from app.models.regulated import RegulatedSale
from app.services.drug_schedules import (
    CATEGORY_LABELS,
    match_schedule_h1,
)
from app.utils.dates import get_today_ist


class RegisterDetailsMissing(Exception):
    """
    The bill contains a regulated medicine and the register cannot be written.

    Carries the human list of what is missing AND which medicines caused the
    requirement, because "fill in the address" is a far less useful thing to
    read at a counter than "ULTRACET TAB is a Schedule H1 medicine, so this
    sale needs the patient's address".
    """

    def __init__(self, missing: list[str], medicines: list[str]):
        self.missing = missing
        self.medicines = medicines
        names = ", ".join(medicines)
        needs = ", ".join(missing)
        super().__init__(
            f"{names} must be recorded in the register, so this sale needs: {needs}."
        )


def regulated_lines(db: Session, items) -> list[tuple[object, Product]]:
    """
    The invoice lines whose medicine goes into a register.

    Reads the flag the pharmacist CONFIRMED on the product, never the drug-name
    matcher: by the time a bill is being rung up, the question of whether a
    medicine is regulated has already been answered by a person, and answering
    it again here — differently — is how two parts of one app come to disagree.
    """
    product_ids = {getattr(i, "product_id", None) for i in items}
    product_ids.discard(None)
    if not product_ids:
        return []

    products = {
        p.id: p for p in db.query(Product).filter(Product.id.in_(product_ids)).all()
    }
    out = []
    for item in items:
        product = products.get(getattr(item, "product_id", None))
        if product is not None and product.register_category:
            out.append((item, product))
    return out


def check_details(
    regulated: list[tuple[object, Product]],
    patient,
    prescriber_name: Optional[str],
    prescriber_address: Optional[str],
) -> None:
    """
    Raise RegisterDetailsMissing unless everything the register needs is here.

    The official register asks for the prescriber's NAME AND ADDRESS, the
    patient's name, and a patient registration number with the date.  The
    patient's phone is this pharmacy's own addition — it is how they actually
    reach someone, and a register they will use beats one they resent.
    """
    if not regulated:
        return

    def blank(v) -> bool:
        return v is None or not str(v).strip()

    missing: list[str] = []
    if patient is None:
        missing.append("a patient (not a walk-in)")
    else:
        if blank(patient.name):     missing.append("patient name")
        if blank(patient.mobile):   missing.append("patient phone number")
        if blank(patient.address):  missing.append("patient address")
    if blank(prescriber_name):      missing.append("doctor's name")
    if blank(prescriber_address):   missing.append("doctor's address")

    if missing:
        raise RegisterDetailsMissing(
            missing=missing,
            medicines=sorted({p.name for _, p in regulated}),
        )


def _quantity_label(product: Product, units: int) -> str:
    """
    How the quantity READS to an inspector.

    Stock is counted in individual units, but "30" against a strip medicine
    means nothing on paper.  Whole strips only; any remainder is spelled out,
    because 35 tablets is "2 strips + 5 tablets" and rounding it to 2 strips
    would understate what left the shelf.
    """
    per = int(product.units_per_strip or 0) if product.is_strip else 0
    if per <= 1:
        return f"{units} {product.unit or 'unit'}{'' if units == 1 else 's'}"
    strips, loose = divmod(units, per)
    parts = []
    if strips:
        parts.append(f"{strips} strip{'' if strips == 1 else 's'}")
    if loose:
        parts.append(f"{loose} tablet{'' if loose == 1 else 's'}")
    return f"{' + '.join(parts)} ({units} units)" if parts else f"{units} units"


def write_rows(
    db: Session,
    regulated: list[tuple[object, Product]],
    *,
    invoice,
    patient,
    prescriber_name: Optional[str],
    prescriber_address: Optional[str],
    dispensed_by_id: Optional[int],
    dispensed_by_name: Optional[str],
) -> list[RegulatedSale]:
    """
    One register row per regulated line.  Every value copied, nothing joined.

    Called AFTER the invoice row is flushed, so the invoice number and id are
    real.  Inside the same transaction as the sale: if the sale rolls back the
    register entry goes with it, and a register can never claim a sale that
    did not happen.
    """
    today = get_today_ist()
    rows: list[RegulatedSale] = []

    for item, product in regulated:
        # The gazette entry is recorded for Schedule H1 so the register can say
        # WHY a medicine was in it, years later, after the list has changed
        # again.  An MTP kit is flagged by hand and has no drug-name match.
        hit = (
            match_schedule_h1(product.generic_name, product.name, on=today)
            if product.register_category == "H1"
            else None
        )
        batch = getattr(item, "batch", None)
        units = int(getattr(item, "quantity", 0) or 0)

        rows.append(RegulatedSale(
            sold_on      = today,
            category     = product.register_category,
            drug_matched = hit.name if hit else None,
            notification = hit.notified if hit else None,

            product_id   = product.id,
            product_name = product.name,
            generic_name = product.generic_name,
            batch_id     = getattr(item, "batch_id", None),
            batch_number = getattr(batch, "batch_number", None),
            expiry_date  = getattr(batch, "expiry_date", None),

            quantity       = units,
            quantity_label = _quantity_label(product, units),

            patient_id      = getattr(patient, "id", None),
            patient_name    = getattr(patient, "name", None) or "",
            patient_phone   = getattr(patient, "mobile", None),
            patient_address = getattr(patient, "address", None),

            prescriber_name    = (prescriber_name or "").strip(),
            prescriber_address = (prescriber_address or "").strip() or None,

            invoice_id     = getattr(invoice, "id", None),
            invoice_number = getattr(invoice, "invoice_number", None),

            dispensed_by_id   = dispensed_by_id,
            dispensed_by_name = dispensed_by_name,
        ))

    db.add_all(rows)
    return rows


def describe(category: str) -> str:
    """'Schedule H1' / 'MTP kit' — for messages shown to the pharmacist."""
    return CATEGORY_LABELS.get(category, category)
