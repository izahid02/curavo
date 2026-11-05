"""
The owner app signs in with the Curavo account, then asks the shop PC to let
this phone in (decided 4 Nov 2026; the QR code stays as a fallback).

Phone, before signing in:
  POST /mobile/v1/sign-in-link           "Continue with Google": {code, url, poll}
  GET  /mobile/v1/sign-in-link/{code}    ?poll=...  -> {status, token?}  (polled)
The owner, in a browser on curavo.in (signed in, Google works there):
  GET/POST /account/v1/link/{code}       answered by routers/device_link.py
Phone, signed in (account session, from /account/v1/login, /google or the link):
  GET  /mobile/v1/my-shops               the shop PCs linked to this account
  POST /mobile/v1/connect                {shop_code, public_key, name}
                                         -> {device_id, device_token, check_code}
Shop PC (its device token):
  GET  /agent/v1/phone-requests          phones waiting for Allow / Refuse
  POST /agent/v1/phone-requests/{id}/decision   {allow, reason}

WHY THE CHECK CODE.  The PC adds the phone's PUBLIC KEY as an owner device,
and only keys the PC added can open the figures.  The cloud relays that key;
if it ever swapped in a key of its own, the 6 digits on the PC (made from the
key the PC received) would not match the 6 digits on the phone (made from
its real key).  The owner compares them before pressing Allow.  check_code()
here, owner_app.check_code() on the PC and checkCode() in mobile/src/lockbox.js
must give the same digits - test_phone_connect.py proves it.
"""
import base64
import hashlib
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from curavo_cloud.config import settings
from curavo_cloud.db import get_db
from curavo_cloud.models import Account, MobileDevice, PhoneRequest, PhoneSignIn, Shop
from curavo_cloud.routers.accounts import _throttle, current_account, make_session
from curavo_cloud.routers.device_link import ALPHABET, _clean, _fmt
from curavo_cloud.security import current_shop, hash_token

router = APIRouter(tags=["Phone sign-in"])

REQUEST_MINUTES = 15
SIGN_IN_MINUTES = 10
MAX_WAITING_PER_SHOP = 3
CHECK_CONTEXT = b"curavo-phone-check-v1:"


def check_code(public_key_b64: str) -> str:
    """6 digits made from the phone's public key, shown on both the phone and the PC."""
    n = int.from_bytes(hashlib.sha256(CHECK_CONTEXT + public_key_b64.encode("ascii")).digest()[:4], "big")
    d = f"{n % 1_000_000:06d}"
    return f"{d[:3]} {d[3:]}"


# ---------------------------------------------------------------------------
# "Continue with Google" on the phone, through curavo.in
# ---------------------------------------------------------------------------

@router.post("/mobile/v1/sign-in-link", status_code=201)
def start_sign_in(request: Request, db: Session = Depends(get_db)):
    _throttle(request)
    while True:
        code = "".join(secrets.choice(ALPHABET) for _ in range(8))
        if not db.query(PhoneSignIn).filter(PhoneSignIn.code == code).first():
            break
    poll = secrets.token_urlsafe(24)
    row = PhoneSignIn(code=code, poll_hash=hash_token(poll),
                      expires_at=datetime.utcnow() + timedelta(minutes=SIGN_IN_MINUTES))
    db.add(row)
    db.commit()
    return {"code": _fmt(code), "url": f"{settings.site_url}/link?code={_fmt(code)}", "poll": poll,
            "expires_at": row.expires_at.isoformat() + "Z"}


@router.get("/mobile/v1/sign-in-link/{code}")
def poll_sign_in(code: str, poll: str = "", db: Session = Depends(get_db)):
    row = db.query(PhoneSignIn).filter(PhoneSignIn.code == _clean(code)).first()
    if row is None or not secrets.compare_digest(row.poll_hash, hash_token(poll or "")):
        raise HTTPException(status_code=404, detail="No such code.")
    if row.status == "PENDING" and datetime.utcnow() > row.expires_at:
        row.status = "EXPIRED"
        db.commit()
    out = {"status": row.status}
    if row.status == "APPROVED":
        acc = db.get(Account, row.account_id)
        if acc is None or acc.disabled:
            raise HTTPException(status_code=403, detail="This account cannot sign in.")
        out["token"] = make_session(acc)
        out["account"] = {"email": acc.email, "name": acc.name or ""}
        row.status = "USED"            # handed over once
        db.commit()
    return out


def describe_phone_code(db, code: str):
    """For curavo.in/link: None if `code` is not a phone sign-in."""
    row = db.query(PhoneSignIn).filter(PhoneSignIn.code == _clean(code)).first()
    if row is None:
        return None
    if row.status != "PENDING":
        raise HTTPException(status_code=409, detail="This code was already used. Start again on the phone.")
    if datetime.utcnow() > row.expires_at:
        raise HTTPException(status_code=410, detail="This code has expired. Start again on the phone.")
    return row


# ---------------------------------------------------------------------------
# Phone, signed in: choose the shop and ask its PC
# ---------------------------------------------------------------------------

@router.get("/mobile/v1/my-shops")
def my_shops(acc: Account = Depends(current_account), db: Session = Depends(get_db)):
    shops = db.query(Shop).filter(Shop.account_id == acc.id).order_by(Shop.last_seen_at.desc()).all()
    return {"account": {"email": acc.email, "name": acc.name or ""},
            "shops": [{"shop_code": _fmt(s.shop_code), "shop_name": s.shop_name or "Shop PC",
                       "last_seen_at": s.last_seen_at.isoformat() + "Z" if s.last_seen_at else None}
                      for s in shops]}


class ConnectIn(BaseModel):
    shop_code: str = Field(..., max_length=16)
    public_key: str = Field(..., min_length=40, max_length=64)
    name: str = Field(default="Phone", max_length=80)


@router.post("/mobile/v1/connect", status_code=201)
def connect(body: ConnectIn, acc: Account = Depends(current_account), db: Session = Depends(get_db)):
    try:
        if len(base64.b64decode(body.public_key, validate=True)) != 32:
            raise ValueError
    except Exception:
        raise HTTPException(status_code=400, detail="The phone sent an invalid key.")
    code = "".join(ch for ch in body.shop_code.upper() if ch.isalnum())
    shop = db.query(Shop).filter(Shop.shop_code == code).first()
    if shop is None or shop.account_id != acc.id:
        raise HTTPException(status_code=404, detail="This shop PC is not linked to your account.")
    now = datetime.utcnow()
    waiting = db.query(PhoneRequest).filter(PhoneRequest.shop_id == shop.id, PhoneRequest.status == "PENDING",
                                            PhoneRequest.expires_at > now).count()
    if waiting >= MAX_WAITING_PER_SHOP:
        raise HTTPException(status_code=429, detail="Several phones are already waiting. Answer them on the shop PC first.")
    name = body.name.strip()[:80] or "Phone"
    device_id = secrets.token_urlsafe(12)
    token = secrets.token_urlsafe(32)
    db.add(MobileDevice(device_id=device_id, shop_id=shop.id, name=name, token_hash=hash_token(token), status="PENDING"))
    db.add(PhoneRequest(request_id=secrets.token_urlsafe(12), shop_id=shop.id, account_id=acc.id, device_id=device_id,
                        name=name, public_key=body.public_key, expires_at=now + timedelta(minutes=REQUEST_MINUTES)))
    db.commit()
    return {"device_id": device_id, "device_token": token, "shop_name": shop.shop_name or "",
            "check_code": check_code(body.public_key), "expires_minutes": REQUEST_MINUTES}


def refused_reason(db, device_id: str):
    """For /mobile/v1/status: why the PC said no (None if it did not)."""
    r = db.query(PhoneRequest).filter(PhoneRequest.device_id == device_id).first()
    if r is None:
        return None
    if r.status == "REFUSED":
        return r.reason or "The shop PC did not allow this phone."
    if r.status == "EXPIRED" or (r.status == "PENDING" and datetime.utcnow() > r.expires_at):
        return "Nobody answered on the shop PC in time. Try again while Curavo is open there."
    return None


# ---------------------------------------------------------------------------
# Shop PC: Allow / Refuse
# ---------------------------------------------------------------------------

@router.get("/agent/v1/phone-requests")
def waiting_requests(shop: Shop = Depends(current_shop), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    out = []
    for r in db.query(PhoneRequest).filter(PhoneRequest.shop_id == shop.id, PhoneRequest.status == "PENDING").all():
        if now > r.expires_at:
            r.status = "EXPIRED"
            dev = db.query(MobileDevice).filter(MobileDevice.device_id == r.device_id).first()
            if dev is not None and dev.status == "PENDING":
                dev.status = "REMOVED"
            continue
        acc = db.get(Account, r.account_id)
        out.append({"request_id": r.request_id, "device_id": r.device_id, "name": r.name or "Phone",
                    "public_key": r.public_key, "account_email": acc.email if acc else "",
                    "created_at": r.created_at.isoformat() + "Z"})
    db.commit()
    return {"requests": out}


class DecisionIn(BaseModel):
    allow: bool
    reason: str = Field(default="", max_length=300)


@router.post("/agent/v1/phone-requests/{request_id}/decision")
def decide(request_id: str, body: DecisionIn, shop: Shop = Depends(current_shop), db: Session = Depends(get_db)):
    r = db.query(PhoneRequest).filter(PhoneRequest.request_id == request_id, PhoneRequest.shop_id == shop.id).first()
    if r is None:
        raise HTTPException(status_code=404, detail="No such request.")
    if r.status != "PENDING":
        return {"ok": True, "status": r.status}
    dev = db.query(MobileDevice).filter(MobileDevice.device_id == r.device_id, MobileDevice.shop_id == shop.id).first()
    r.status, r.decided_at = ("APPROVED" if body.allow else "REFUSED"), datetime.utcnow()
    r.reason = None if body.allow else (body.reason or "The shop PC did not allow this phone.")
    if dev is not None:
        dev.status = "ACTIVE" if body.allow else "REMOVED"
    db.commit()
    return {"ok": True, "status": r.status}
