"""
Curavo subscription API.

  GET  /api/licence/status    - trial / active / grace / expired, the shop code,
                                and what (if anything) is paused.  Any logged-in
                                user: the counter staff see the banner too.
  POST /api/licence/activate  - paste a licence key.  Owner / Administrator only,
                                because a key is tied to the shop's payment.

All the rules live in services/licence.py; this file only translates HTTP.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services import licence
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/licence", tags=["Licence"])

_LICENCE_ADMIN_ROLES = {"Owner", "Administrator"}


class ActivateRequest(BaseModel):
    # Generous limit: a key is ~250 characters, plus any spaces/line breaks a
    # messaging app inserted when it was copied.
    key: str = Field(..., min_length=1, max_length=4000)


@router.get("/status")
def licence_status(db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    return licence.licence_status(db)


@router.post("/activate")
def activate_licence(
    body: ActivateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role.name not in _LICENCE_ADMIN_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only an Owner or Administrator can enter a licence key.",
        )
    try:
        return licence.activate(db, body.key)
    except licence.LicenceKeyError as e:
        raise HTTPException(status_code=400, detail=str(e))
