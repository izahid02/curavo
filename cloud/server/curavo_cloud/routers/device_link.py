"""
"Sign in with your Curavo account" on a shop PC (see models.DeviceLink).

Shop PC (its device token):
  POST /agent/v1/account-link            {purpose: LINK|LOGIN} -> {code, url, expires_at}
  GET  /agent/v1/account-link/{code}     -> {status, account?}   (polled every 2 s)
The owner, in a browser on curavo.in, signed in:
  GET  /account/v1/link/{code}           -> which shop is asking
  POST /account/v1/link/{code}           {allow: true|false}

The code is short (8 characters, no look-alike letters) and lasts 10
minutes; it can only be answered by a signed-in account, and only once.  A
shop already linked to one account cannot be taken over by another - ARZ
must unlink it in the panel.
"""
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from curavo_cloud import licence_issuer
from curavo_cloud.config import settings
from curavo_cloud.db import get_db
from curavo_cloud.models import Account, DeviceLink, Shop
from curavo_cloud.routers.accounts import current_account
from curavo_cloud.security import current_shop

router = APIRouter(tags=["Account link"])

ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
LINK_MINUTES = 10
MAX_OPEN_PER_SHOP = 5


def _fmt(code: str) -> str:
    return f"{code[:4]}-{code[4:]}"


def _clean(code: str) -> str:
    return "".join(ch for ch in (code or "").upper() if ch in ALPHABET)[:8]


class StartIn(BaseModel):
    purpose: str = "LINK"


@router.post("/agent/v1/account-link", status_code=201)
def start(body: StartIn, shop: Shop = Depends(current_shop), db: Session = Depends(get_db)):
    purpose = body.purpose.upper()
    if purpose not in ("LINK", "LOGIN"):
        raise HTTPException(status_code=400, detail="Unknown purpose.")
    if purpose == "LOGIN" and not shop.account_id:
        raise HTTPException(status_code=409, detail="This PC is not linked to a Curavo account yet.")
    now = datetime.utcnow()
    open_now = db.query(DeviceLink).filter(DeviceLink.shop_id == shop.id, DeviceLink.status == "PENDING",
                                           DeviceLink.expires_at > now).count()
    if open_now >= MAX_OPEN_PER_SHOP:
        raise HTTPException(status_code=429, detail="Too many sign-in codes at once. Wait a few minutes.")
    while True:
        code = "".join(secrets.choice(ALPHABET) for _ in range(8))
        if not db.query(DeviceLink).filter(DeviceLink.code == code).first():
            break
    link = DeviceLink(code=code, shop_id=shop.id, purpose=purpose, expires_at=now + timedelta(minutes=LINK_MINUTES))
    db.add(link)
    db.commit()
    return {"code": _fmt(code), "url": f"{settings.site_url}/link?code={_fmt(code)}",
            "expires_at": link.expires_at.isoformat() + "Z"}


@router.get("/agent/v1/account-link/{code}")
def poll(code: str, shop: Shop = Depends(current_shop), db: Session = Depends(get_db)):
    link = db.query(DeviceLink).filter(DeviceLink.code == _clean(code), DeviceLink.shop_id == shop.id).first()
    if link is None:
        raise HTTPException(status_code=404, detail="No such code.")
    if link.status == "PENDING" and datetime.utcnow() > link.expires_at:
        link.status = "EXPIRED"
        db.commit()
    out = {"status": link.status}
    if link.status == "APPROVED":
        acc = db.get(Account, link.account_id)
        out["account"] = {"id": acc.id, "email": acc.email, "name": acc.name or "",
                          "subscription": {"plan": acc.plan, "paid_until": acc.paid_until}}
        link.status = "USED"           # answered once; a second poll sees USED
        db.commit()
    return out


def _pending(db, code: str) -> DeviceLink:
    link = db.query(DeviceLink).filter(DeviceLink.code == _clean(code)).first()
    if link is None:
        raise HTTPException(status_code=404, detail="This code is not valid. Check it on the PC screen.")
    if link.status != "PENDING":
        raise HTTPException(status_code=409, detail="This code was already used. Start again on the PC.")
    if datetime.utcnow() > link.expires_at:
        raise HTTPException(status_code=410, detail="This code has expired. Start again on the PC.")
    return link


@router.get("/account/v1/link/{code}")
def describe(code: str, acc: Account = Depends(current_account), db: Session = Depends(get_db)):
    from curavo_cloud.routers.phone_connect import describe_phone_code
    if describe_phone_code(db, code) is not None:          # the owner app asking to sign in
        return {"purpose": "PHONE", "shop_name": "", "shop_code": "", "already_yours": True,
                "linked_to_other_account": False}
    link = _pending(db, code)
    shop = db.get(Shop, link.shop_id)
    other = shop.account_id and shop.account_id != acc.id
    return {"purpose": link.purpose, "shop_name": shop.shop_name or "", "shop_code": _fmt(shop.shop_code),
            "already_yours": shop.account_id == acc.id, "linked_to_other_account": bool(other)}


class DecideIn(BaseModel):
    allow: bool


@router.post("/account/v1/link/{code}")
def decide(code: str, body: DecideIn, acc: Account = Depends(current_account), db: Session = Depends(get_db)):
    from curavo_cloud.routers.phone_connect import describe_phone_code
    phone = describe_phone_code(db, code)
    if phone is not None:                                  # sign the owner app in with this account
        if not acc.email_verified:
            raise HTTPException(status_code=403, detail="Please confirm your email first.")
        phone.status = "APPROVED" if body.allow else "REFUSED"
        phone.account_id = acc.id if body.allow else None
        db.commit()
        return {"ok": True, "status": phone.status}
    link = _pending(db, code)
    shop = db.get(Shop, link.shop_id)
    if not acc.email_verified:
        raise HTTPException(status_code=403, detail="Please confirm your email first.")
    if not body.allow:
        link.status, link.decided_at = "REFUSED", datetime.utcnow()
        db.commit()
        return {"ok": True, "status": "REFUSED"}
    if shop.account_id and shop.account_id != acc.id:
        raise HTTPException(status_code=409, detail="This PC belongs to a different Curavo account. "
                                                    "Ask ARZ Solutions if it should move to yours.")
    if link.purpose == "LOGIN" and shop.account_id != acc.id:
        raise HTTPException(status_code=409, detail="This PC is not linked to your account.")
    shop.account_id = acc.id
    link.status, link.account_id, link.decided_at = "APPROVED", acc.id, datetime.utcnow()
    issued = licence_issuer.issue_if_paid(db, shop, acc)
    db.commit()
    return {"ok": True, "status": "APPROVED", "licence_sent": issued is not None}
