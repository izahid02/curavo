"""
Document numbers: tax-invoice numbers, and the shop prefix they carry.

Format:  {PREFIX}-{YYYY}-{NNNNNN}      e.g. HCC-2026-000014, SM-2026-000001

THREE RULES, each learned the hard way:

1. GAPLESS.  GST requires invoice numbers to run consecutively.  The number
   used to be taken FIRST, on its own connection, and committed at once - so
   any bill refused afterwards (not enough stock, a Schedule H1 bill without
   prescriber details) burned a number that no invoice ever carried.  HCC's
   live series has gaps from exactly this.  Now the number is taken INSIDE the
   bill's own transaction, at the very end, after every check has passed: a
   bill that fails rolls its number back with everything else.

   Why that is safe for two bills at once: by the time create_invoice asks for
   a number it has already written stock changes, so its transaction holds
   SQLite's single write lock.  No other bill can touch the counter until this
   one commits or rolls back - the increment cannot interleave.

2. AT MOST 16 CHARACTERS.  The GST limit for an invoice number.  The
   "-YYYY-NNNNNN" part is 12, so a shop's prefix is 1-4 capital letters or
   digits.  (A prefix like "SUNRISE" would make every invoice non-compliant.)

3. A SERIES NEVER CHANGES MID-YEAR.  The counter restarts every 1 January.
   Once this year's first invoice exists, the prefix is locked until the next
   year, so a reader of the books never sees one year split across two series.

Upgrades: a shop that has been billing for months has no prefix saved (the
column is new).  Its prefix is read from its own most recent invoice, so HCC
simply continues HCC-2026-000014, -000015 ... with nothing to set up.  A brand
new shop starts with "INV" until the owner chooses one.
"""
import re
from datetime import date

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.settings import PharmacySettings

DEFAULT_PREFIX = "INV"
PREFIX_MAX_LEN = 4
_PREFIX_RE = re.compile(r"^[A-Z0-9]{1,%d}$" % PREFIX_MAX_LEN)
# What an existing invoice number looks like; the prefix is group 1.
# Up to 8 characters, so a legacy series is always recognised and continued.
_EXISTING_RE = re.compile(r"^([A-Z0-9]{1,8})-(\d{4})-(\d{6})$")


class InvalidPrefix(ValueError):
    """The prefix typed in Pharmacy Settings is not allowed."""


def normalise_prefix(raw: str) -> str:
    """'sm' -> 'SM', ' sm- ' -> 'SM'.  Raises InvalidPrefix if not 1-4 A-Z/0-9."""
    p = (raw or "").strip().upper().rstrip("-")
    if not _PREFIX_RE.match(p):
        raise InvalidPrefix(
            f"Invoice prefix must be 1 to {PREFIX_MAX_LEN} capital letters or digits "
            f"(for example SM).  GST limits an invoice number to 16 characters."
        )
    return p


def _settings_row(db: Session):
    return db.query(PharmacySettings).order_by(PharmacySettings.id).first()


def _inferred_prefix(db: Session):
    """The prefix of this shop's most recent invoice, or None if it has none."""
    row = db.execute(text("SELECT invoice_number FROM invoices ORDER BY id DESC LIMIT 1")).first()
    if row:
        m = _EXISTING_RE.match(row[0] or "")
        if m:
            return m.group(1)
    return None


def get_invoice_prefix(db: Session, persist: bool = False) -> str:
    """
    The shop's invoice prefix.  Saved setting first, else the prefix of the last
    invoice (an upgraded shop), else "INV" (a new shop).  With persist=True the
    answer is written to settings so it never has to be guessed again - done
    inside the caller's transaction (create_invoice), never on a read.
    """
    row = _settings_row(db)
    if row is not None and row.invoice_prefix:
        return row.invoice_prefix
    prefix = _inferred_prefix(db) or DEFAULT_PREFIX
    if persist and row is not None:
        row.invoice_prefix = prefix
    return prefix


def _this_year() -> int:
    # Same clock the old generator used (the shop PC's local date).
    return date.today().year


def _counter_value(db: Session, year: int) -> int:
    row = db.execute(
        text("SELECT last_number FROM doc_counters WHERE doc_type = 'INVOICE' AND year = :y"),
        {"y": year},
    ).first()
    return int(row[0]) if row else 0


def prefix_locked(db: Session) -> bool:
    """True once this year's first invoice has been numbered."""
    return _counter_value(db, _this_year()) > 0


def peek_next_invoice_number(db: Session) -> str:
    """What the next bill WILL be numbered - for the settings screen.  Takes nothing."""
    year = _this_year()
    return f"{get_invoice_prefix(db)}-{year}-{_counter_value(db, year) + 1:06d}"


def take_next_invoice_number(db: Session) -> str:
    """
    Reserve the next invoice number INSIDE the caller's transaction (rule 1).

    Call it as late as possible - after every check that could refuse the bill.
    If the transaction rolls back, the counter rolls back with it: no gap.
    """
    year = _this_year()
    params = {"y": year}
    db.execute(text(
        "INSERT OR IGNORE INTO doc_counters (doc_type, year, last_number) VALUES ('INVOICE', :y, 0)"
    ), params)
    db.execute(text(
        "UPDATE doc_counters SET last_number = last_number + 1 WHERE doc_type = 'INVOICE' AND year = :y"
    ), params)
    seq = _counter_value(db, year)
    return f"{get_invoice_prefix(db, persist=True)}-{year}-{seq:06d}"
