"""
The owner app, from the shop PC's side (account menu -> Owner app on phone).

  GET    /api/owner-app/devices            phones connected, and whether the
                                           cloud is on (the app needs it)
  POST   /api/owner-app/pairings           start "Connect phone": returns the
                                           QR code text (Owner/Admin)
  GET    /api/owner-app/pairings/{id}      the screen polls this every 2 s
                                           while the QR is shown; it checks the
                                           scanning phone's proof and connects it
  DELETE /api/owner-app/devices/{id}       remove a phone (Owner/Admin)

The rules and the locking live in services/owner_app.py; talking to the cloud
goes through services/cloud_agent.py.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.cloud import OwnerDevice, OwnerPairing
from app.models.settings import PharmacySettings
from app.models.user import User
from app.services import licence, owner_app
from app.services.auth_service import get_current_user
from app.services.cloud_agent import CloudError, agent, get_state

router = APIRouter(prefix="/owner-app", tags=["Owner app"])

_OWNER_ROLES = {"Owner", "Administrator"}


def _require_owner(user: User):
    if user.role.name not in _OWNER_ROLES:
        raise HTTPException(status_code=403, detail="Only the owner or an administrator can connect phones.")


def _iso(dt):
    return dt.isoformat() + "Z" if dt else None


@router.get("/devices")
def list_devices(db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    st = get_state(db) if agent.enabled else None
    return {
        "cloud_enabled": agent.enabled,
        "last_summary_at": _iso(st.owner_summary_at) if st else None,
        "max_phones": owner_app.MAX_PHONES,
        "devices": [{"device_id": d.device_id, "name": d.name, "added_at": _iso(d.added_at)}
                    for d in db.query(OwnerDevice).order_by(OwnerDevice.added_at).all()],
    }


@router.post("/pairings", status_code=201)
def start_pairing(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _require_owner(user)
    if licence.is_restricted(db):
        raise HTTPException(status_code=402, detail=licence.RESTRICTED_MESSAGE)
    if db.query(OwnerDevice).count() >= owner_app.MAX_PHONES:
        raise HTTPException(status_code=400, detail=f"At most {owner_app.MAX_PHONES} phones can be connected. Remove one first.")
    p = owner_app.new_pairing(db)
    try:
        agent.owner_call("POST", "/agent/v1/pairings",
                         {"pairing_id": p.pairing_id, "expires_at": p.expires_at.isoformat() + "Z"})
    except CloudError as e:
        p.status = "FAILED"
        db.commit()
        raise HTTPException(status_code=503, detail=str(e))
    ps = db.query(PharmacySettings).order_by(PharmacySettings.id).first()
    return {"pairing_id": p.pairing_id, "expires_at": _iso(p.expires_at),
            "qr": owner_app.qr_payload(p, agent.url, licence.get_state(db).shop_code, ps.pharmacy_name if ps else "")}


@router.get("/pairings/{pairing_id}")
def pairing_status(pairing_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _require_owner(user)
    p = db.query(OwnerPairing).filter(OwnerPairing.pairing_id == pairing_id).first()
    if p is None:
        raise HTTPException(status_code=404, detail="No such code.")
    if p.status == "OPEN" and datetime.utcnow() > p.expires_at:
        p.status = "EXPIRED"
        db.commit()
    if p.status != "OPEN":
        return {"status": p.status, "device_name": p.device_name}
    try:
        claim = agent.owner_call("GET", f"/agent/v1/pairings/{pairing_id}")
    except CloudError:
        return {"status": "OPEN"}                 # try again on the next poll
    if not claim or not claim.get("claim"):
        return {"status": "OPEN"}
    ok, reason = owner_app.accept_claim(db, p, claim["claim"])
    try:
        agent.owner_call("POST", f"/agent/v1/pairings/{pairing_id}/decision", {"approve": ok, "reason": reason})
    except CloudError:
        pass                                      # the phone will see it on its next status check
    if ok:
        agent.run_in_background()                 # the phone gets its first figures straight away
    return {"status": p.status, "device_name": p.device_name, "reason": None if ok else reason}


@router.delete("/devices/{device_id}")
def remove_device(device_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _require_owner(user)
    d = db.query(OwnerDevice).filter(OwnerDevice.device_id == device_id).first()
    if d is None:
        raise HTTPException(status_code=404, detail="No such phone.")
    db.delete(d)
    db.commit()
    try:
        agent.owner_call("DELETE", f"/agent/v1/devices/{device_id}")
    except CloudError:
        pass   # it is gone here, so nothing new is locked for it either way
    return {"ok": True}
