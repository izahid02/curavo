"""
Owner app relay: the cloud passes LOCKED summaries from a shop PC to the
owner's phones, and helps a phone and a PC find each other when connecting.
It can read neither the summaries nor the pairing secret.

Shop PC (shop device token):
  POST   /agent/v1/pairings                    a QR code is on screen
  GET    /agent/v1/pairings/{id}               has a phone claimed it?
  POST   /agent/v1/pairings/{id}/decision      PC checked the proof: approve/refuse
  POST   /agent/v1/owner-summary               newest locked summary (+ optional push)
  DELETE /agent/v1/devices/{device_id}         owner removed a phone on the PC

Phone (its own device token, X-Device-Id):
  POST   /mobile/v1/pair                       I scanned this QR, here is my key + proof
  GET    /mobile/v1/status                     PENDING / ACTIVE / REMOVED
  GET    /mobile/v1/summary                    my copy of the newest locked summary
  POST   /mobile/v1/push-token                 where to send notifications
  POST   /mobile/v1/unlink                     disconnect this phone
"""
import json
import re
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from curavo_cloud import push
from curavo_cloud.db import get_db
from curavo_cloud.models import MobileDevice, OwnerPairingCloud, OwnerSummary, Shop
from curavo_cloud.security import current_shop, hash_token

router = APIRouter(tags=["Owner app"])

MAX_PAIRING_MINUTES = 15
MAX_SUMMARY_BYTES = 3 * 1024 * 1024


# ---------------------------------------------------------------------------
# Shop PC side
# ---------------------------------------------------------------------------

class PairingIn(BaseModel):
    pairing_id: str = Field(..., min_length=8, max_length=40)
    expires_at: str = ""


@router.post("/agent/v1/pairings", status_code=201)
def open_pairing(body: PairingIn, shop: Shop = Depends(current_shop), db: Session = Depends(get_db)):
    if db.query(OwnerPairingCloud).filter(OwnerPairingCloud.pairing_id == body.pairing_id).first():
        raise HTTPException(status_code=409, detail="Pairing id already used.")
    db.add(OwnerPairingCloud(shop_id=shop.id, pairing_id=body.pairing_id,
                             expires_at=datetime.utcnow() + timedelta(minutes=MAX_PAIRING_MINUTES)))
    db.commit()
    return {"ok": True}


def _pairing_for_shop(db, shop, pairing_id) -> OwnerPairingCloud:
    p = db.query(OwnerPairingCloud).filter(OwnerPairingCloud.pairing_id == pairing_id,
                                           OwnerPairingCloud.shop_id == shop.id).first()
    if p is None:
        raise HTTPException(status_code=404, detail="No such pairing.")
    return p


@router.get("/agent/v1/pairings/{pairing_id}")
def pairing_claim(pairing_id: str, shop: Shop = Depends(current_shop), db: Session = Depends(get_db)):
    p = _pairing_for_shop(db, shop, pairing_id)
    return {"status": p.status, "claim": json.loads(p.claim_json) if p.status == "CLAIMED" and p.claim_json else None}


class DecisionIn(BaseModel):
    approve: bool
    reason: str = Field(default="", max_length=300)


@router.post("/agent/v1/pairings/{pairing_id}/decision")
def pairing_decision(pairing_id: str, body: DecisionIn, shop: Shop = Depends(current_shop),
                     db: Session = Depends(get_db)):
    p = _pairing_for_shop(db, shop, pairing_id)
    claim = json.loads(p.claim_json) if p.claim_json else {}
    dev = db.query(MobileDevice).filter(MobileDevice.device_id == claim.get("device_id"),
                                        MobileDevice.shop_id == shop.id).first()
    p.status = "APPROVED" if body.approve else "REJECTED"
    p.reason = body.reason
    if dev is not None:
        dev.status = "ACTIVE" if body.approve else "REMOVED"
    db.commit()
    return {"ok": True}


class SummaryIn(BaseModel):
    locked: dict
    device_ids: list[str] = Field(default_factory=list, max_length=20)
    push: dict | None = None


@router.post("/agent/v1/owner-summary")
def store_summary(body: SummaryIn, shop: Shop = Depends(current_shop), db: Session = Depends(get_db)):
    text = json.dumps(body.locked, separators=(",", ":"))
    if len(text) > MAX_SUMMARY_BYTES:
        raise HTTPException(status_code=413, detail="Summary too large.")
    row = db.get(OwnerSummary, shop.id)
    if row is None:
        row = OwnerSummary(shop_id=shop.id, locked=text)
        db.add(row)
    row.locked, row.updated_at, row.size = text, datetime.utcnow(), len(text)
    # Self-healing: if the PC's "approve" never arrived, a summary locked FOR a
    # waiting phone proves the PC accepted it.
    for d in db.query(MobileDevice).filter(MobileDevice.shop_id == shop.id, MobileDevice.status == "PENDING",
                                           MobileDevice.device_id.in_(list((body.locked.get("wraps") or {}).keys()))).all():
        d.status = "ACTIVE"
    sent = 0
    if body.push and body.push.get("body"):
        tokens = [d.push_token for d in db.query(MobileDevice).filter(
            MobileDevice.shop_id == shop.id, MobileDevice.status == "ACTIVE",
            MobileDevice.device_id.in_(body.device_ids)).all()]
        sent = push.notify(tokens, str(body.push.get("title") or shop.shop_name or "Curavo"), str(body.push["body"]))
    db.commit()
    return {"ok": True, "pushed": sent}


@router.delete("/agent/v1/devices/{device_id}")
def remove_device(device_id: str, shop: Shop = Depends(current_shop), db: Session = Depends(get_db)):
    dev = db.query(MobileDevice).filter(MobileDevice.device_id == device_id, MobileDevice.shop_id == shop.id).first()
    if dev is not None:
        dev.status = "REMOVED"
        db.commit()
    return {"ok": True}


def active_device_ids(db, shop) -> list:
    """For the heartbeat reply: phones still connected (not removed)."""
    return [d.device_id for d in db.query(MobileDevice).filter(
        MobileDevice.shop_id == shop.id, MobileDevice.status != "REMOVED").all()]


# ---------------------------------------------------------------------------
# Phone side
# ---------------------------------------------------------------------------

class PairIn(BaseModel):
    shop_code: str = Field(..., max_length=16)
    pairing_id: str = Field(..., max_length=40)
    public_key: str = Field(..., max_length=64)
    proof: str = Field(..., max_length=128)
    name: str = Field(default="Phone", max_length=80)


@router.post("/mobile/v1/pair", status_code=201)
def phone_pair(body: PairIn, db: Session = Depends(get_db)):
    code = re.sub(r"[^A-Z0-9]", "", body.shop_code.upper())
    shop = db.query(Shop).filter(Shop.shop_code == code).first()
    p = db.query(OwnerPairingCloud).filter(OwnerPairingCloud.pairing_id == body.pairing_id).first()
    if shop is None or p is None or p.shop_id != shop.id:
        raise HTTPException(status_code=404, detail="This code is not valid. Press Connect phone again on the shop PC.")
    if p.status != "OPEN":
        raise HTTPException(status_code=409, detail="This code was already used. Press Connect phone again on the shop PC.")
    if datetime.utcnow() > p.expires_at:
        raise HTTPException(status_code=410, detail="This code has expired. Press Connect phone again on the shop PC.")
    device_id = secrets.token_urlsafe(12)
    token = secrets.token_urlsafe(32)
    db.add(MobileDevice(device_id=device_id, shop_id=shop.id, name=body.name.strip() or "Phone",
                        token_hash=hash_token(token), status="PENDING"))
    p.status = "CLAIMED"
    p.claim_json = json.dumps({"device_id": device_id, "public_key": body.public_key,
                               "proof": body.proof, "name": body.name.strip() or "Phone"})
    db.commit()
    return {"device_id": device_id, "device_token": token, "shop_name": shop.shop_name}


def _phone(x_device_id: str, authorization: str, db) -> MobileDevice:
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    dev = db.query(MobileDevice).filter(MobileDevice.device_id == x_device_id).first()
    if dev is None or not token or not secrets.compare_digest(dev.token_hash, hash_token(token)):
        raise HTTPException(status_code=401, detail="This phone is not connected.")
    return dev


def phone_any_status(x_device_id: str = Header(default=""), authorization: str = Header(default=""),
                     db: Session = Depends(get_db)) -> MobileDevice:
    """For /status only: a refused phone may still ask why."""
    return _phone(x_device_id, authorization, db)


def current_phone(x_device_id: str = Header(default=""), authorization: str = Header(default=""),
                  db: Session = Depends(get_db)) -> MobileDevice:
    dev = _phone(x_device_id, authorization, db)
    if dev.status == "REMOVED":
        raise HTTPException(status_code=401, detail="This phone was disconnected from the shop.")
    return dev


@router.get("/mobile/v1/status")
def phone_status(dev: MobileDevice = Depends(phone_any_status), db: Session = Depends(get_db)):
    shop = db.get(Shop, dev.shop_id)
    p = db.query(OwnerPairingCloud).filter(OwnerPairingCloud.claim_json.contains(dev.device_id)).first()
    from curavo_cloud.routers.phone_connect import refused_reason
    reason = p.reason if p is not None and p.status == "REJECTED" else refused_reason(db, dev.device_id)
    if dev.status == "PENDING" and reason:          # the PC's answer is no, or nobody answered in time
        dev.status = "REMOVED"
        db.commit()
    return {"status": dev.status, "shop_name": shop.shop_name if shop else "", "reason": reason}


@router.get("/mobile/v1/summary")
def phone_summary(dev: MobileDevice = Depends(current_phone), db: Session = Depends(get_db)):
    if dev.status != "ACTIVE":
        raise HTTPException(status_code=403, detail="Waiting for the shop PC to approve this phone.")
    dev.last_seen_at = datetime.utcnow()
    db.commit()
    row = db.get(OwnerSummary, dev.shop_id)
    if row is None:
        return Response(status_code=204)
    locked = json.loads(row.locked)
    wrap = (locked.get("wraps") or {}).get(dev.device_id)
    if wrap is None:
        # Connected after this summary was made: the next one (within ~5 min) includes it.
        return Response(status_code=204)
    return {"updated_at": row.updated_at.isoformat() + "Z",
            "locked": {"v": locked.get("v"), "nonce": locked["nonce"], "ct": locked["ct"], "wrap": wrap}}


class TokenIn(BaseModel):
    token: str = Field(..., max_length=200)


@router.post("/mobile/v1/push-token")
def phone_push_token(body: TokenIn, dev: MobileDevice = Depends(current_phone), db: Session = Depends(get_db)):
    dev.push_token = body.token
    db.commit()
    return {"ok": True}


@router.post("/mobile/v1/unlink")
def phone_unlink(dev: MobileDevice = Depends(current_phone), db: Session = Depends(get_db)):
    dev.status = "REMOVED"
    db.commit()
    return {"ok": True}
