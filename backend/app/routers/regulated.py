"""
Regulated medicines — deciding WHICH medicines go into the register.

Three things happen here:

  1. /candidates  proposes matches between the shop's stock and Schedule H1
  2. /apply       records the pharmacist's decision on those proposals
  3. /check       answers "does this one medicine look regulated?", for the
                  confirmation popup on the Add/Edit Medicine form

NOTHING HERE FLAGS A MEDICINE ON ITS OWN.  The matcher proposes; a person
decides.  That is deliberate: the register is a legal record, an inspector
reads it as a statement of fact, and a flag applied by a substring match that
nobody looked at is a guess wearing a uniform.  The same rule runs the other
way too — un-flagging is equally a decision, so /apply takes both.

/missing-generic lives here as well, because it exists for exactly one reason:
Schedule H1 names drugs, matching reads the generic name, and a medicine with
no generic name recorded is invisible to the matcher.  Those products are the
hole in the register, so they are listed next to the thing that creates it.
"""
import csv
import io
from datetime import date, datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.inventory import Product
from app.models.regulated import RegulatedSale
from app.models.user import User
from app.services.auth_service import get_current_user
from app.services.drug_schedules import (
    CATEGORY_H1,
    CATEGORY_MTP,
    REGISTER_CATEGORIES,
    CATEGORY_LABELS,
    match_schedule_h1,
    schedule_h1_drugs,
)
# Same write-role gate the rest of inventory uses.  Imported rather than
# re-listed: two copies of "who may change stock" would drift apart.
from app.routers.inventory import _require_write_role

router = APIRouter(prefix="/regulated", tags=["regulated"])


# ---------------------------------------------------------------------------
# Shapes
# ---------------------------------------------------------------------------

class Candidate(BaseModel):
    """One proposed (or already recorded) regulated medicine."""
    product_id:        int
    name:              str
    generic_name:      Optional[str] = None
    brand:             Optional[str] = None
    current_stock:     Optional[int] = None
    # What the matcher thinks, and why.
    suggested:         Optional[str] = None   # 'H1' when a drug name matched
    matched_drug:      Optional[str] = None   # which drug put it here
    notification:      Optional[str] = None   # the gazette entry, for the trail
    # What is actually recorded on the product right now.
    register_category: Optional[str] = None
    # True when the pharmacist has already answered for this one.
    decided:           bool = False


class CandidateList(BaseModel):
    items:        list[Candidate]
    total:        int
    # How many active medicines could not be matched at all because they have
    # no generic name.  Surfaced here so the review screen can say so out loud
    # rather than letting the gap pass unnoticed.
    unmatchable:  int
    as_of:        date
    drugs_in_force: int


class Decision(BaseModel):
    product_id: int
    # None clears the flag — un-flagging is a decision too.
    category:   Optional[Literal["H1", "MTP"]] = None


class ApplyRequest(BaseModel):
    decisions: list[Decision] = Field(..., min_length=1)


class ApplyResponse(BaseModel):
    updated:   int
    unchanged: int


class CheckRequest(BaseModel):
    """What the Add/Edit Medicine form knows while the pharmacist is typing."""
    name:         Optional[str] = None
    generic_name: Optional[str] = None


class CheckResponse(BaseModel):
    matched:      bool
    category:     Optional[str] = None
    matched_drug: Optional[str] = None
    notification: Optional[str] = None
    label:        Optional[str] = None   # ready-to-show wording for the popup


class MissingGeneric(BaseModel):
    product_id:    int
    name:          str
    brand:         Optional[str] = None
    current_stock: Optional[int] = None


# ---------------------------------------------------------------------------
# 1 — Propose matches across the whole shelf
# ---------------------------------------------------------------------------

@router.get("/candidates", response_model=CandidateList)
def list_candidates(
    include_decided: bool = Query(
        False, description="Also return medicines already flagged or already dismissed"
    ),
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    Every active medicine that looks like it belongs in the register.

    A medicine appears here when its generic name contains a Schedule H1 drug
    in force today, OR when it is already flagged (so the screen can show what
    has been decided and let a decision be reversed).

    `unmatchable` counts the active medicines with no generic name.  They can
    never appear in this list however many Schedule H1 drugs they contain,
    which is precisely why that number is worth putting in front of someone.
    """
    products = (
        db.query(Product)
        .filter(Product.is_active == True)  # noqa: E712
        .order_by(Product.name)
        .all()
    )

    today = date.today()
    items: list[Candidate] = []
    unmatchable = 0

    for p in products:
        has_generic = bool(p.generic_name and p.generic_name.strip())
        if not has_generic:
            unmatchable += 1

        hit = match_schedule_h1(p.generic_name, p.name, on=today) if has_generic else None
        flagged = p.register_category

        # Nothing to say about a medicine that neither matched nor is flagged.
        if hit is None and not flagged:
            continue
        # Already answered: only shown when asked for.
        if flagged and not include_decided:
            continue

        items.append(Candidate(
            product_id        = p.id,
            name              = p.name,
            generic_name      = p.generic_name,
            brand             = p.brand,
            suggested         = CATEGORY_H1 if hit else None,
            matched_drug      = hit.name if hit else None,
            notification      = hit.notified if hit else None,
            register_category = flagged,
            decided           = bool(flagged),
        ))

    return CandidateList(
        items          = items,
        total          = len(items),
        unmatchable    = unmatchable,
        as_of          = today,
        drugs_in_force = len(schedule_h1_drugs(on=today)),
    )


# ---------------------------------------------------------------------------
# 2 — Record the pharmacist's decisions
# ---------------------------------------------------------------------------

@router.post("/apply", response_model=ApplyResponse)
def apply_decisions(
    body: ApplyRequest,
    db:   Session = Depends(get_db),
    _:    User    = Depends(_require_write_role),
):
    """
    Set (or clear) register_category on a batch of medicines.

    Takes the decisions in one request so confirming a shelf's worth of
    matches is one action, not thirty — and so a half-finished review cannot
    leave the register half-built.
    """
    ids = [d.product_id for d in body.decisions]
    found = {
        p.id: p for p in db.query(Product).filter(Product.id.in_(ids)).all()
    }
    missing = [i for i in ids if i not in found]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown medicine id(s): {missing}",
        )

    updated = unchanged = 0
    for d in body.decisions:
        product = found[d.product_id]
        if d.category is not None and d.category not in REGISTER_CATEGORIES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown register category '{d.category}'",
            )
        if product.register_category == d.category:
            unchanged += 1
            continue
        product.register_category = d.category
        updated += 1

    db.commit()
    return ApplyResponse(updated=updated, unchanged=unchanged)


# ---------------------------------------------------------------------------
# 3 — One medicine, checked live on the Add/Edit form
# ---------------------------------------------------------------------------

@router.post("/check", response_model=CheckResponse)
def check_one(
    body: CheckRequest,
    _:    User = Depends(get_current_user),
):
    """
    Does this medicine look like a Schedule H1 drug?

    Called by the Add/Edit Medicine form so the pharmacist is asked at the
    moment of typing — which is the moment they still remember what they meant
    and can see whether the generic name they entered was understood.  It
    doubles as a check on data entry: a popup that does NOT appear for a drug
    they know is Schedule H1 means the generic name is wrong or missing.

    Pure function of its inputs; touches no database.
    """
    hit = match_schedule_h1(body.generic_name, body.name)
    if hit is None:
        return CheckResponse(matched=False)
    return CheckResponse(
        matched      = True,
        category     = CATEGORY_H1,
        matched_drug = hit.name,
        notification = hit.notified,
        label        = f"{hit.name.title()} is a {CATEGORY_LABELS[CATEGORY_H1]} drug",
    )


# ---------------------------------------------------------------------------
# 4 — The hole in the register: medicines with no generic name
# ---------------------------------------------------------------------------

class GenericFill(BaseModel):
    product_id:   int
    generic_name: str = Field(..., min_length=1)


class FillGenericRequest(BaseModel):
    fills: list[GenericFill] = Field(..., min_length=1)


class FillGenericResponse(BaseModel):
    saved: int
    # Medicines that, now they have a generic name, turn out to contain a
    # Schedule H1 drug.  This is the point of filling the gaps: the answer
    # comes back immediately instead of waiting to be noticed.
    now_matching: list[Candidate]


@router.post("/fill-generic", response_model=FillGenericResponse)
def fill_generic_names(
    body: FillGenericRequest,
    db:   Session = Depends(get_db),
    _:    User    = Depends(_require_write_role),
):
    """
    Record generic names for medicines that had none, in one go.

    Then IMMEDIATELY re-check each one against Schedule H1 and report back any
    that now match.  A medicine with no generic name is invisible to the
    register check; the moment that changes, the pharmacist should be told --
    not left to run the check again and hope they remember why.

    Nothing is flagged here.  The matches come back as proposals, exactly as
    they do on the review screen, and a person still decides.
    """
    ids = [f.product_id for f in body.fills]
    found = {p.id: p for p in db.query(Product).filter(Product.id.in_(ids)).all()}
    missing = [i for i in ids if i not in found]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown medicine id(s): {missing}",
        )

    today = date.today()
    saved = 0
    now_matching: list[Candidate] = []

    for fill in body.fills:
        product = found[fill.product_id]
        value = fill.generic_name.strip()
        if not value or value == (product.generic_name or ""):
            continue
        product.generic_name = value
        saved += 1

        hit = match_schedule_h1(value, product.name, on=today)
        if hit and not product.register_category:
            now_matching.append(Candidate(
                product_id        = product.id,
                name              = product.name,
                generic_name      = value,
                brand             = product.brand,
                suggested         = CATEGORY_H1,
                matched_drug      = hit.name,
                notification      = hit.notified,
                register_category = None,
                decided           = False,
            ))

    db.commit()
    return FillGenericResponse(saved=saved, now_matching=now_matching)


@router.get("/missing-generic", response_model=list[MissingGeneric])
def list_missing_generic(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    Active medicines with no generic name recorded.

    Schedule H1 names drugs, so matching has nothing to read for these and
    they can never be proposed — including any that genuinely are regulated.
    Filling them in once is the difference between a register that works and
    one that only looks like it does.
    """
    rows = (
        db.query(Product)
        .filter(
            Product.is_active == True,  # noqa: E712
            or_(Product.generic_name.is_(None), Product.generic_name == ""),
        )
        .order_by(Product.name)
        .all()
    )
    return [
        MissingGeneric(product_id=p.id, name=p.name, brand=p.brand)
        for p in rows
    ]


# ---------------------------------------------------------------------------
# 5 — The register itself
# ---------------------------------------------------------------------------

class RegisterEntry(BaseModel):
    """One line of the register, exactly as it was written at the counter."""
    id:                 int
    serial:             int            # S.No. within the current view
    sold_on:            date
    category:           str
    category_label:     str
    drug_matched:       Optional[str] = None
    notification:       Optional[str] = None
    product_name:       str
    generic_name:       Optional[str] = None
    batch_number:       Optional[str] = None
    expiry_date:        Optional[date] = None
    quantity:           int
    quantity_label:     Optional[str] = None
    patient_name:       str
    patient_phone:      Optional[str] = None
    patient_address:    Optional[str] = None
    prescriber_name:    str
    prescriber_address: Optional[str] = None
    invoice_number:     Optional[str] = None
    dispensed_by_name:  Optional[str] = None


class RegisterPage(BaseModel):
    items: list[RegisterEntry]
    total: int
    # The window actually applied, so the screen can say what it is showing
    # rather than the user having to trust a dropdown.
    date_from: Optional[date] = None
    date_to:   Optional[date] = None


def _register_query(db: Session, date_from, date_to, category, search):
    q = db.query(RegulatedSale)
    if date_from:
        q = q.filter(RegulatedSale.sold_on >= date_from)
    if date_to:
        q = q.filter(RegulatedSale.sold_on <= date_to)
    if category:
        q = q.filter(RegulatedSale.category == category)
    if search:
        like = f"%{search.strip()}%"
        q = q.filter(or_(
            RegulatedSale.patient_name.ilike(like),
            RegulatedSale.patient_phone.ilike(like),
            RegulatedSale.product_name.ilike(like),
            RegulatedSale.prescriber_name.ilike(like),
            RegulatedSale.invoice_number.ilike(like),
        ))
    # Newest first: the entry someone is looking for is almost always today's.
    return q.order_by(RegulatedSale.sold_on.desc(), RegulatedSale.id.desc())


@router.get("/register", response_model=RegisterPage)
def read_register(
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    category:  Optional[str]  = Query(None, description="H1 or MTP"),
    search:    Optional[str]  = Query(None),
    limit:     int            = Query(200, ge=1, le=2000),
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    The register, newest first.

    Everything returned was COPIED onto the row at the moment of dispensing —
    nothing here is joined back to the patient, product or invoice, so an entry
    reads today exactly as it read on the day it was written.
    """
    q = _register_query(db, date_from, date_to, category, search)
    total = q.count()
    rows = q.limit(limit).all()

    # The serial is the position in THIS view, counted from the top, so a
    # printed or exported page is numbered the way a bound register is.
    items = [
        RegisterEntry(
            id=r.id,
            serial=i + 1,
            sold_on=r.sold_on,
            category=r.category,
            category_label=CATEGORY_LABELS.get(r.category, r.category),
            drug_matched=r.drug_matched,
            notification=r.notification,
            product_name=r.product_name,
            generic_name=r.generic_name,
            batch_number=r.batch_number,
            expiry_date=r.expiry_date,
            quantity=r.quantity,
            quantity_label=r.quantity_label,
            patient_name=r.patient_name,
            patient_phone=r.patient_phone,
            patient_address=r.patient_address,
            prescriber_name=r.prescriber_name,
            prescriber_address=r.prescriber_address,
            invoice_number=r.invoice_number,
            dispensed_by_name=r.dispensed_by_name,
        )
        for i, r in enumerate(rows)
    ]
    return RegisterPage(items=items, total=total, date_from=date_from, date_to=date_to)


# The register as a spreadsheet, in the order the official register uses:
#   S.No. | prescriber name and address | patient | medicine | quantity |
#   patient registration number and date
# Everything after that is this pharmacy's own addition.
_EXPORT_HEADERS = [
    "S.No.",
    "Date",
    "Name and address of the prescriber",
    "Name of the patient",
    "Patient phone",
    "Patient address",
    "Name of the medicine dispensed",
    "Generic name",
    "Quantity dispensed",
    "Batch no.",
    "Expiry",
    "Register",
    "Drug (Schedule H1)",
    "Notification",
    "Invoice no.",
    "Dispensed by",
]


def _export_rows(items: list[RegisterEntry]) -> list[list]:
    out = []
    for e in items:
        prescriber = e.prescriber_name
        if e.prescriber_address:
            prescriber = f"{prescriber}, {e.prescriber_address}"
        out.append([
            e.serial,
            e.sold_on.strftime("%d-%m-%Y"),
            prescriber,
            e.patient_name,
            e.patient_phone or "",
            e.patient_address or "",
            e.product_name,
            e.generic_name or "",
            e.quantity_label or str(e.quantity),
            e.batch_number or "",
            e.expiry_date.strftime("%m/%Y") if e.expiry_date else "",
            e.category_label,
            (e.drug_matched or "").title(),
            e.notification or "",
            e.invoice_number or "",
            e.dispensed_by_name or "",
        ])
    return out


@router.get("/register/export")
def export_register(
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    category:  Optional[str]  = Query(None),
    search:    Optional[str]  = Query(None),
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    Download the register as a spreadsheet.

    Written with openpyxl when it is available, and as CSV when it is not.
    The fallback is deliberate: this is a legal record a pharmacist may need
    to produce at short notice, and "the download button is broken because a
    library is missing" is not an acceptable answer at that moment.  CSV opens
    in Excel too.
    """
    rows = read_register(
        date_from=date_from, date_to=date_to, category=category,
        search=search, limit=2000, db=db, _=None,
    ).items
    data = _export_rows(rows)
    stamp = datetime.now().strftime("%Y%m%d_%H%M")

    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font
    except ImportError:
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(_EXPORT_HEADERS)
        writer.writerows(data)
        return Response(
            content=buf.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="H1-register-{stamp}.csv"'},
        )

    wb = Workbook()
    ws = wb.active
    ws.title = "Register"
    ws.append(_EXPORT_HEADERS)
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    for row in data:
        ws.append(row)
    # Widths chosen so an address is readable without the reader resizing
    # anything; a register is printed as often as it is scrolled.
    for col, width in zip("ABCDEFGHIJKLMNOP",
                          [6, 12, 34, 22, 14, 30, 26, 26, 18, 14, 10, 12, 18, 30, 16, 16]):
        ws.column_dimensions[col].width = width
    ws.freeze_panes = "A2"

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="H1-register-{stamp}.xlsx"'},
    )
