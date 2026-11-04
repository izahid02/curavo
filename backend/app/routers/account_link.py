"""
The owner's Curavo account on THIS PC (decided 4 Nov 2026).

  GET  /api/account                    linked or not, and to which email
  POST /api/account/link               start "Sign in with your Curavo account"
                                       (Owner/Admin) -> {code, url, expires_at}
  GET  /api/account/link/{code}        the screen polls every 2 s; when the
                                       owner presses Allow on curavo.in this
                                       PC is linked, and the subscription
                                       (licence key) follows within a minute
  POST /api/auth/account-login         login screen: start a sign-in with the
                                       account (no login needed - it is the
                                       login) -> {code, url}
  GET  /api/auth/account-login/{code}  poll; APPROVED -> the same answer as
                                       /api/auth/login, for the PC user that
                                       linked the account

How the owner signs in when the internet is down: with that PC user's own
username and password (set in Edit Profile / Change Password) - that is the
"offline sign-in", and it never needs the cloud.  Staff keep their own PC
logins; they never use the owner's account.
"""
import threading
import time
from collections import deque
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.schemas.auth import LoginResponse, TokenResponse, UserInfo
from app.services.auth_service import create_access_token, get_current_user
from app.services.cloud_agent import CloudError, agent, get_state

router = APIRouter(tags=["Curavo account"])

_OWNER_ROLES = {"Owner", "Administrator"}
LOGIN_STARTS_PER_HOUR = 20
_starts = deque()
_starts_lock = threading.Lock()


def _iso(dt):
    return dt.isoformat() + "Z" if dt else None


def _cloud_or_503():
    if not agent.enabled:
        raise HTTPException(status_code=503, detail="The Curavo cloud is not switched on for this PC.")


@router.get("/account")
def account_status(db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    st = get_state(db)
    linked_user = db.get(User, st.account_user_id) if st.account_user_id else None
    return {"cloud_enabled": agent.enabled, "linked": bool(st.account_id),
            "email": st.account_email, "name": st.account_name, "linked_at": _iso(st.account_linked_at),
            "offline_user": linked_user.username if linked_user else None}


@router.post("/account/link", status_code=201)
def start_link(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if user.role.name not in _OWNER_ROLES:
        raise HTTPException(status_code=403, detail="Only the owner or an administrator can link the Curavo account.")
    _cloud_or_503()
    try:
        return agent.owner_call("POST", "/agent/v1/account-link", {"purpose": "LINK"})
    except CloudError as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.get("/account/link/{code}")
def poll_link(code: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if user.role.name not in _OWNER_ROLES:
        raise HTTPException(status_code=403, detail="Only the owner or an administrator can link the Curavo account.")
    try:
        r = agent.owner_call("GET", f"/agent/v1/account-link/{code}")
    except CloudError:
        return {"status": "PENDING"}            # try again on the next poll
    if r.get("status") == "APPROVED":
        acc = r["account"]
        st = get_state(db)
        st.account_id, st.account_email, st.account_name = acc["id"], acc["email"], acc.get("name") or None
        st.account_linked_at = datetime.utcnow()
        st.account_user_id = user.id            # signing in with the account = this PC user
        db.commit()
        agent.run_in_background()               # fetch a waiting licence key now
        return {"status": "APPROVED", "account": {"email": acc["email"], "name": acc.get("name") or ""},
                "offline_user": user.username}
    return {"status": r.get("status", "PENDING")}


@router.post("/auth/account-login", status_code=201)
def start_account_login(db: Session = Depends(get_db)):
    _cloud_or_503()
    st = get_state(db)
    if not st.account_id or not st.account_user_id:
        raise HTTPException(status_code=409, detail="This PC is not linked to a Curavo account yet. "
                                                    "Sign in with your PC username and password.")
    now = time.time()
    with _starts_lock:
        while _starts and now - _starts[0] > 3600:
            _starts.popleft()
        if len(_starts) >= LOGIN_STARTS_PER_HOUR:
            raise HTTPException(status_code=429, detail="Too many sign-in attempts. Use your PC username and password.")
        _starts.append(now)
    try:
        r = agent.owner_call("POST", "/agent/v1/account-link", {"purpose": "LOGIN"})
    except CloudError:
        raise HTTPException(status_code=503, detail="No internet right now. Sign in with your PC username and password.")
    return {"code": r["code"], "url": r["url"], "expires_at": r["expires_at"]}


@router.get("/auth/account-login/{code}")
def poll_account_login(code: str, db: Session = Depends(get_db)):
    try:
        r = agent.owner_call("GET", f"/agent/v1/account-link/{code}")
    except CloudError:
        return {"status": "PENDING"}
    if r.get("status") != "APPROVED":
        return {"status": r.get("status", "PENDING")}
    st = get_state(db)
    if r["account"]["id"] != st.account_id:
        raise HTTPException(status_code=403, detail="That account is not the one linked to this PC.")
    user = db.get(User, st.account_user_id)
    if user is None:
        raise HTTPException(status_code=409, detail="The PC user linked to your account no longer exists. "
                                                    "Sign in with a PC username and password.")
    return {"status": "APPROVED", **LoginResponse(
        token=TokenResponse(access_token=create_access_token({"sub": user.username})),
        user=UserInfo(id=user.id, username=user.username, full_name=user.full_name, role_name=user.role.name),
    ).model_dump()}
