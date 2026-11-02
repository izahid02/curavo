"""
Shop-wide settings API.

  GET /api/settings/pharmacy  — the shop's identity.  NO LOGIN REQUIRED.
  PUT /api/settings/pharmacy  — change it.  Owner (or Administrator) only.

WHY THE GET IS PUBLIC:
The login screen shows the shop's name above the password box, and it renders
before anyone has a token.  The thermal receipt reads the same endpoint.  The
fields returned — name, address, phone, GSTIN — are all printed on the shop's
own bills and painted on its signboard, so there is nothing here to protect.
The PUT is a different matter and is locked to the owner.
"""
from datetime import datetime

import mimetypes

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.database import get_branding_dir, get_db
from app.models.settings import PharmacySettings
from app.models.user import User
from app.schemas.settings import PharmacySettingsOut, PharmacySettingsUpdate
from app.services import doc_numbers
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/settings", tags=["Settings"])

# Who may rename the pharmacy.  This is the identity printed on every tax
# invoice, so it is an ownership decision, not a counter operation.
# Administrator is included because on a single-PC install the owner often IS
# the administrator account.
_SETTINGS_ADMIN_ROLES = {"Owner", "Administrator"}

# The defaults a brand-new install starts with.  Kept here (not only in the
# model) so the lazy get-or-create below reads in one place.
DEFAULT_NAME    = "My Pharmacy"
DEFAULT_TAGLINE = "Pharmacy & Medical Store"


def get_or_create_settings(db: Session) -> PharmacySettings:
    """
    Fetch the single settings row, creating it on first use.

    The startup seed normally creates it, but creating it lazily here too means
    a database that predates the seed cannot 404 the login screen — which would
    be a blank-page failure on the very first thing the user sees.
    """
    row = db.query(PharmacySettings).order_by(PharmacySettings.id).first()
    if row is None:
        row = PharmacySettings(
            pharmacy_name=DEFAULT_NAME,
            pharmacy_tagline=DEFAULT_TAGLINE,
            updated_at=datetime.utcnow(),
        )
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


@router.get("/pharmacy", response_model=PharmacySettingsOut)
def read_pharmacy_settings(db: Session = Depends(get_db)):
    """
    The shop's identity.  Deliberately unauthenticated — see the module note.
    Every screen that shows the pharmacy name reads this one endpoint, so a
    rename lands everywhere at once.
    """
    return get_or_create_settings(db)


@router.put("/pharmacy", response_model=PharmacySettingsOut)
def update_pharmacy_settings(
    body:         PharmacySettingsUpdate,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Change the shop's identity.  Owner / Administrator only."""
    if current_user.role.name not in _SETTINGS_ADMIN_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only an Owner or Administrator can change the pharmacy settings.",
        )

    row = get_or_create_settings(db)

    # Invoice prefix: validated (1-4 A-Z/0-9) and locked once this year's first
    # bill exists - a GST series must not change mid-year.  Blank = unchanged.
    if (body.invoice_prefix or "").strip():
        try:
            new_prefix = doc_numbers.normalise_prefix(body.invoice_prefix)
        except doc_numbers.InvalidPrefix as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        current = doc_numbers.get_invoice_prefix(db)
        if new_prefix != current:
            if doc_numbers.prefix_locked(db):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(f"This year's invoices already use {current}-.  The prefix can be "
                            f"changed before the first bill of next year, so one year never "
                            f"mixes two series."),
                )
            row.invoice_prefix = new_prefix

    row.pharmacy_name = body.pharmacy_name.strip()
    # For the optional fields, a blank string means "clear it" — storing NULL
    # rather than "" keeps every reader's `value or fallback` check honest.
    row.pharmacy_name_as   = (body.pharmacy_name_as or "").strip() or None
    row.invoice_name       = (body.invoice_name or "").strip() or None
    row.pharmacy_tagline   = (body.pharmacy_tagline or "").strip() or None
    row.pharmacy_address   = (body.pharmacy_address or "").strip() or None
    row.pharmacy_phone     = (body.pharmacy_phone or "").strip() or None
    row.pharmacy_email     = (body.pharmacy_email or "").strip() or None
    row.pharmacy_gstin     = (body.pharmacy_gstin or "").strip() or None
    row.pharmacy_dl_number = (body.pharmacy_dl_number or "").strip() or None
    row.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(row)
    return row


# ---------------------------------------------------------------------------
# Shop logo and signature (printed on receipts and the A4 tax invoice)
# ---------------------------------------------------------------------------
#
# Two images per shop, stored as files in the branding folder (the database
# only ever holds text).  Reading needs a login; changing them is the same
# Owner / Administrator decision as renaming the shop - the signature in
# particular goes on every legal invoice.

_BRANDING_KINDS = ("logo", "signature")
_BRANDING_EXTS  = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp"}
_BRANDING_MAX_BYTES = 2 * 1024 * 1024     # 2 MB is plenty for a logo or a scanned signature


def _branding_file(kind: str):
    """The stored file for `kind`, whatever its extension, or None."""
    for ext in ("png", "jpg", "webp"):
        f = get_branding_dir() / f"{kind}.{ext}"
        if f.exists():
            return f
    return None


def _check_kind(kind: str) -> None:
    # The kind arrives in the URL, so it is untrusted: only two exact words are
    # allowed, which also means it can never be used to reach another folder.
    if kind not in _BRANDING_KINDS:
        raise HTTPException(status_code=404, detail="Unknown image.")


@router.get("/branding")
def branding_status(_user: User = Depends(get_current_user)):
    """Which shop images are on file: {"logo": bool, "signature": bool}."""
    return {k: _branding_file(k) is not None for k in _BRANDING_KINDS}


@router.get("/branding/{kind}")
def get_branding_image(kind: str, _user: User = Depends(get_current_user)):
    """The shop's logo or signature image.  404 when none is uploaded."""
    _check_kind(kind)
    f = _branding_file(kind)
    if f is None:
        raise HTTPException(status_code=404, detail=f"No {kind} uploaded.")
    return FileResponse(path=str(f), media_type=mimetypes.guess_type(str(f))[0] or "image/png",
                        headers={"Cache-Control": "no-store"})


@router.post("/branding/{kind}")
async def upload_branding_image(
    kind: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Upload or replace the shop's logo / signature.  Owner / Administrator only."""
    _check_kind(kind)
    if current_user.role.name not in _SETTINGS_ADMIN_ROLES:
        raise HTTPException(status_code=403,
                            detail="Only an Owner or Administrator can change the shop's logo or signature.")

    # Same permissive check as the profile photo: trust the MIME type when it
    # is a known image type, otherwise fall back to the file extension.
    ext = _BRANDING_EXTS.get(file.content_type or "")
    if ext is None:
        name_ext = (file.filename or "").rsplit(".", 1)[-1].lower()
        ext = {"png": "png", "jpg": "jpg", "jpeg": "jpg", "webp": "webp"}.get(name_ext)
    if ext is None:
        raise HTTPException(status_code=400, detail="Use a PNG, JPG or WebP image.")

    data = await file.read()
    if len(data) > _BRANDING_MAX_BYTES:
        raise HTTPException(status_code=400,
                            detail=f"Image too large ({len(data) // 1024} KB). Maximum is 2 MB.")

    old = _branding_file(kind)              # a PNG -> JPG switch must not leave two files
    if old is not None:
        old.unlink()
    (get_branding_dir() / f"{kind}.{ext}").write_bytes(data)
    return {kind: True}


@router.delete("/branding/{kind}")
def delete_branding_image(kind: str, current_user: User = Depends(get_current_user)):
    """Remove the shop's logo / signature.  Owner / Administrator only."""
    _check_kind(kind)
    if current_user.role.name not in _SETTINGS_ADMIN_ROLES:
        raise HTTPException(status_code=403,
                            detail="Only an Owner or Administrator can change the shop's logo or signature.")
    f = _branding_file(kind)
    if f is not None:
        f.unlink()
    return {kind: False}


@router.get("/invoice-numbering")
def invoice_numbering(db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    """
    For the settings screen: the current prefix, whether it is locked for this
    year, what the next bill will be numbered, and the longest prefix allowed.
    Reads only - it never takes a number.
    """
    return {
        "prefix":         doc_numbers.get_invoice_prefix(db),
        "locked":         doc_numbers.prefix_locked(db),
        "next_number":    doc_numbers.peek_next_invoice_number(db),
        "max_length":     doc_numbers.PREFIX_MAX_LEN,
    }
