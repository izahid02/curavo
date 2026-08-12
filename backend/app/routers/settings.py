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

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.settings import PharmacySettings
from app.models.user import User
from app.schemas.settings import PharmacySettingsOut, PharmacySettingsUpdate
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/settings", tags=["Settings"])

# Who may rename the pharmacy.  This is the identity printed on every tax
# invoice, so it is an ownership decision, not a counter operation.
# Administrator is included because on a single-PC install the owner often IS
# the administrator account.
_SETTINGS_ADMIN_ROLES = {"Owner", "Administrator"}

# The defaults a brand-new install starts with.  Kept here (not only in the
# model) so the lazy get-or-create below reads in one place.
DEFAULT_NAME    = "Health Care Centre"
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

    row.pharmacy_name = body.pharmacy_name.strip()
    # For the optional fields, a blank string means "clear it" — storing NULL
    # rather than "" keeps every reader's `value or fallback` check honest.
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
