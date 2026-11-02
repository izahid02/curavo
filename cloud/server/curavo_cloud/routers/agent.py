"""
The API the Curavo desktop app talks to (backend/app/services/cloud_agent.py).

  POST /agent/v1/register        first contact: shop code -> device token
  POST /agent/v1/heartbeat       "still here": version, licence, health.
                                 The reply can carry a renewed licence key.
  POST /agent/v1/backups         upload one LOCKED backup (raw bytes)
  GET  /agent/v1/backups         this shop's backups (for restore later)
  GET  /agent/v1/backups/{id}    download one
  POST /agent/v1/errors          a batch of error reports

Every endpoint after register needs X-Shop-Code + the device token.
A shop PC must never be harmed by this server being slow or down - the agent
treats every failure as "try again later" - so replies here stay small.
"""
import base64
import json
import re
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from curavo_cloud import storage
from curavo_cloud.db import get_db
from curavo_cloud.models import Backup, ErrorGroup, Heartbeat, Shop
from curavo_cloud.security import current_shop, hash_token

router = APIRouter(prefix="/agent/v1", tags=["Shop PCs"])

_CODE_RE = re.compile(r"^[2-9A-HJ-NP-Z]{8}$")
# A different PC reporting within this long of the last one = two PCs at once.
CONFLICT_WINDOW = timedelta(hours=24)
HEARTBEAT_KEEP_DAYS = 30


def peek_licence(key: str):
    """The (unverified) payload of a licence key - the SHOP verifies the signature."""
    try:
        body = re.sub(r"\s+", "", key)[len("CURAVO-"):].split(".")[0]
        return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except Exception:
        return None


class RegisterIn(BaseModel):
    shop_code: str
    shop_name: str = Field(default="", max_length=150)
    app_version: str = Field(default="", max_length=20)
    machine_fp: str = Field(default="", max_length=64)


@router.post("/register")
def register(body: RegisterIn, db: Session = Depends(get_db)):
    code = re.sub(r"[^A-Z0-9]", "", body.shop_code.upper())
    if not _CODE_RE.match(code):
        raise HTTPException(status_code=400, detail="Invalid shop code.")
    shop = db.query(Shop).filter(Shop.shop_code == code).first()
    if shop is not None and shop.token_hash:
        # Already linked to a PC.  A genuinely new PC (old one died, no backup
        # restored) needs ARZ to press "Reset device" in the panel first.
        raise HTTPException(status_code=409, detail=(
            "This shop code is already linked to another PC. "
            "Ask ARZ Solutions to reset the device link."))
    if shop is None:
        shop = Shop(shop_code=code)
        db.add(shop)
    if shop.disabled:
        raise HTTPException(status_code=403, detail="This shop has been disabled by ARZ Solutions.")
    token = secrets.token_urlsafe(32)
    shop.token_hash = hash_token(token)
    shop.shop_name = body.shop_name or shop.shop_name
    shop.app_version = body.app_version or shop.app_version
    shop.machine_fp = body.machine_fp or shop.machine_fp
    shop.last_seen_at = datetime.utcnow()
    db.commit()
    return {"device_token": token}


class HeartbeatIn(BaseModel):
    shop_name: str = ""
    app_version: str = ""
    os_name: str = ""
    machine_fp: str = ""
    licence: dict = {}
    health: dict = {}


@router.post("/heartbeat")
def heartbeat(body: HeartbeatIn, shop: Shop = Depends(current_shop), db: Session = Depends(get_db)):
    now = datetime.utcnow()

    # Two PCs on one code?  Only counts if the OTHER one was seen recently -
    # a replacement PC after a restore is the normal, harmless case.
    if body.machine_fp and shop.machine_fp and body.machine_fp != shop.machine_fp:
        if shop.last_seen_at and now - shop.last_seen_at < CONFLICT_WINDOW:
            shop.machine_conflict_at = now
            shop.other_machine_fp = shop.machine_fp
    if body.machine_fp:
        shop.machine_fp = body.machine_fp

    shop.shop_name = body.shop_name[:150] or shop.shop_name
    shop.app_version = body.app_version[:20] or shop.app_version
    shop.os_name = body.os_name[:80] or shop.os_name
    shop.last_seen_at = now
    lic = body.licence or {}
    shop.licence_state = (lic.get("state") or "")[:10] or None
    shop.licence_until = (lic.get("valid_until") or lic.get("trial_ends_on") or "")[:10] or None
    shop.licence_serial = lic.get("serial")
    shop.licence_days_left = lic.get("days_left")
    payload = json.dumps(body.model_dump(), separators=(",", ":"))[:20000]
    shop.heartbeat_json = payload
    db.add(Heartbeat(shop_id=shop.id, at=now, app_version=shop.app_version, payload=payload))

    # Deliver a waiting licence key until the shop reports having it.
    reply = {"server_time": now.isoformat() + "Z"}
    if shop.pending_licence_key:
        if lic.get("valid_until") and shop.pending_licence_until and lic["valid_until"] >= shop.pending_licence_until:
            shop.pending_licence_key = None
            shop.pending_licence_until = None
        else:
            reply["licence_key"] = shop.pending_licence_key

    # Housekeeping, cheaply: old heartbeats go.
    db.query(Heartbeat).filter(Heartbeat.shop_id == shop.id,
                               Heartbeat.at < now - timedelta(days=HEARTBEAT_KEEP_DAYS)).delete()
    db.commit()
    return reply


@router.post("/backups", status_code=201)
async def upload_backup(
    request: Request,
    x_backup_created: str = Header(default=""),
    x_backup_sha256: str = Header(default=""),
    x_app_version: str = Header(default=""),
    shop: Shop = Depends(current_shop),
    db: Session = Depends(get_db),
):
    tmp_name = f".upload_{secrets.token_hex(8)}"
    try:
        tmp, size, digest, head = await storage.save_stream(shop, request.stream(), tmp_name)
    except ValueError:
        raise HTTPException(status_code=413, detail="Backup is larger than the server accepts.")
    if head != storage.MAGIC:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Not a locked Curavo backup.")
    if x_backup_sha256 and x_backup_sha256.lower() != digest:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Upload was damaged in transit; please retry.")

    now = datetime.utcnow()
    b = Backup(shop_id=shop.id, uploaded_at=now, created_at=x_backup_created[:32],
               size=size, sha256=digest, app_version=x_app_version[:20], filename="")
    db.add(b)
    db.flush()
    b.filename = f"{now:%Y%m%d_%H%M%S}_{b.id}.cbk"
    tmp.rename(storage.path_for(shop, b))
    shop.last_backup_at = now
    shop.last_backup_size = size
    storage.prune(db, shop)
    db.commit()
    return {"id": b.id, "size": size, "sha256": digest}


@router.get("/backups")
def list_backups(shop: Shop = Depends(current_shop), db: Session = Depends(get_db)):
    rows = db.query(Backup).filter(Backup.shop_id == shop.id).order_by(Backup.uploaded_at.desc()).all()
    return [{"id": b.id, "uploaded_at": b.uploaded_at.isoformat() + "Z", "created_at": b.created_at,
             "size": b.size, "sha256": b.sha256, "app_version": b.app_version} for b in rows]


@router.get("/backups/{backup_id}")
def download_backup(backup_id: int, shop: Shop = Depends(current_shop), db: Session = Depends(get_db)):
    b = db.query(Backup).filter(Backup.id == backup_id, Backup.shop_id == shop.id).first()
    if b is None:
        raise HTTPException(status_code=404, detail="Backup not found.")
    return FileResponse(storage.path_for(shop, b), media_type="application/octet-stream",
                        filename=f"{shop.shop_code}_{b.filename}")


class ErrorIn(BaseModel):
    fingerprint: str = Field(..., max_length=64)
    source: str = Field(default="backend", max_length=20)
    kind: str = Field(default="", max_length=120)
    message: str = Field(default="", max_length=4000)
    stack: str = Field(default="", max_length=20000)
    route: str = Field(default="", max_length=200)
    app_version: str = Field(default="", max_length=20)
    count: int = Field(default=1, ge=1, le=1_000_000)
    first_seen: str = ""
    last_seen: str = ""


class ErrorsIn(BaseModel):
    errors: list[ErrorIn] = Field(default_factory=list, max_length=200)


def _ts(s: str, fallback: datetime) -> datetime:
    try:
        return datetime.fromisoformat(s.replace("Z", "")) if s else fallback
    except ValueError:
        return fallback


@router.post("/errors")
def report_errors(body: ErrorsIn, shop: Shop = Depends(current_shop), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    for e in body.errors:
        g = db.query(ErrorGroup).filter(ErrorGroup.shop_id == shop.id,
                                        ErrorGroup.fingerprint == e.fingerprint).first()
        last = _ts(e.last_seen, now)
        if g is None:
            g = ErrorGroup(shop_id=shop.id, fingerprint=e.fingerprint, count=0,
                           first_seen=_ts(e.first_seen, now))
            db.add(g)
        elif g.resolved_at and last > g.resolved_at:
            # Marked fixed, but it happened again - reopen and flag it.
            g.resolved_at = None
            g.regressed = True
        g.source, g.kind, g.message = e.source, e.kind, e.message
        g.stack, g.route, g.app_version = e.stack, e.route, e.app_version
        g.count = (g.count or 0) + e.count
        g.last_seen = max(g.last_seen or last, last)
    db.commit()
    return {"accepted": len(body.errors)}
