"""
The shop PC's link to the Curavo cloud, as the Backup page shows it.

  GET  /api/cloud/status       is the cloud switched on, when did the last
                               check-in / cloud backup happen, what went wrong
  POST /api/cloud/backup-now   start a cloud backup now (Owner/Admin).  Returns
                               at once; the page polls /status to see it land.
  GET  /api/cloud/update-info  where the desktop shell should look for app
                               updates (frontend/src/lib/updater.jsx).

The work itself is done by services/cloud_agent.py on its own thread.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth_service import get_current_user
from app.services import licence
from app.services.cloud_agent import agent, get_state, update_endpoint

router = APIRouter(prefix="/cloud", tags=["Cloud"])

_CLOUD_ADMIN_ROLES = {"Owner", "Administrator"}


def _iso(dt):
    return dt.isoformat() + "Z" if dt else None


@router.get("/status")
def cloud_status(db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    if not agent.enabled:
        return {"enabled": False}
    st = get_state(db)
    return {
        "enabled": True,
        "registered": bool(st.device_token),
        "busy": agent.busy,
        "last_contact_at": _iso(st.last_contact_at),
        "last_contact_ok": st.last_contact_ok,
        "last_backup_at": _iso(st.last_backup_at),
        "last_backup_size": st.last_backup_size,
        "last_error": st.last_error,
        "last_error_at": _iso(st.last_error_at),
    }


@router.post("/backup-now", status_code=status.HTTP_202_ACCEPTED)
def cloud_backup_now(current_user: User = Depends(get_current_user)):
    if current_user.role.name not in _CLOUD_ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Only an Owner or Administrator can start a cloud backup.")
    if not agent.enabled:
        raise HTTPException(status_code=400, detail="The Curavo cloud is not switched on for this PC.")
    if agent.busy:
        return {"started": False, "message": "A cloud backup is already running."}
    agent.run_in_background(force_backup=True)
    return {"started": True}


@router.get("/update-info")
def update_info(db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    """
    The updater needs the cloud address and this shop's code (so the cloud
    can offer a PILOT release to pilot shops first).  Nothing when the cloud
    is switched off - then the app never looks for updates.
    """
    if not agent.enabled:
        return {"enabled": False}
    return {
        "enabled": True,
        "endpoint": update_endpoint(agent.url),
        "shop_code": licence.get_state(db).shop_code,
    }
