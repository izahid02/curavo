"""
The ARZ control panel's API (the screens live in cloud/admin).

  POST  /admin/api/login                      username + password -> token
  GET   /admin/api/me
  POST  /admin/api/change-password
  GET   /admin/api/overview                   the numbers on the first screen
  GET   /admin/api/shops                      every shop, one row each
  GET   /admin/api/shops/{code}               one shop: backups, errors, heartbeats
  PATCH /admin/api/shops/{code}               notes / disable
  POST  /admin/api/shops/{code}/reset-device  let a new PC take the shop over
  POST  /admin/api/shops/{code}/clear-conflict
  POST  /admin/api/shops/{code}/licence       queue a licence key for delivery
  GET   /admin/api/shops/{code}/backups/{id}  download a LOCKED backup
  GET   /admin/api/errors                     all error groups, newest first
  POST  /admin/api/errors/{id}/resolve | /reopen
  GET   /admin/api/audit                      what was done in the panel

Every route except login needs the ARZ login token.
"""
import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from curavo_cloud import storage
from curavo_cloud.db import get_db
from curavo_cloud.models import (Account, AdminAudit, AdminUser, Backup, ErrorGroup, Heartbeat, Lead,
                                 MobileDevice, OwnerSummary, Shop)
from curavo_cloud.routers.agent import peek_licence
from curavo_cloud.security import check_password, current_admin, hash_password, make_admin_token

router = APIRouter(prefix="/admin/api", tags=["Control panel"])

# What "online" and "backup OK" mean.  The agent checks in every 15 minutes
# and backs up once a day.
ONLINE_WITHIN = timedelta(minutes=35)
BACKUP_OK_WITHIN = timedelta(hours=30)
BACKUP_LATE_WITHIN = timedelta(hours=72)


def _iso(dt):
    return dt.isoformat() + "Z" if dt else None


def _audit(db, admin, action, shop=None, detail=""):
    db.add(AdminAudit(admin=admin.username, action=action, shop_id=shop.id if shop else None, detail=detail))


def _backup_status(shop, now):
    if not shop.last_backup_at:
        return "NONE"
    age = now - shop.last_backup_at
    return "OK" if age <= BACKUP_OK_WITHIN else ("LATE" if age <= BACKUP_LATE_WITHIN else "MISSING")


def _shop_row(shop: Shop, open_errors: int, now: datetime) -> dict:
    return {
        "shop_code": shop.shop_code,
        "shop_name": shop.shop_name,
        "registered_at": _iso(shop.registered_at),
        "last_seen_at": _iso(shop.last_seen_at),
        "online": bool(shop.last_seen_at and now - shop.last_seen_at <= ONLINE_WITHIN),
        "app_version": shop.app_version,
        "os_name": shop.os_name,
        "licence_state": shop.licence_state,
        "licence_until": shop.licence_until,
        "licence_days_left": shop.licence_days_left,
        "licence_serial": shop.licence_serial,
        "last_backup_at": _iso(shop.last_backup_at),
        "last_backup_size": shop.last_backup_size,
        "backup_status": _backup_status(shop, now),
        "open_errors": open_errors,
        "machine_conflict_at": _iso(shop.machine_conflict_at),
        "device_linked": bool(shop.token_hash),
        "disabled": shop.disabled,
        "pending_licence_until": shop.pending_licence_until,
        "pilot": bool(shop.pilot),
        "notes": shop.notes or "",
    }


def _open_error_counts(db) -> dict:
    rows = (db.query(ErrorGroup.shop_id, func.count(ErrorGroup.id))
            .filter(ErrorGroup.resolved_at.is_(None)).group_by(ErrorGroup.shop_id).all())
    return dict(rows)


def _owner_of(db, shop):
    """The Curavo account that owns this shop, in short - or None."""
    a = db.get(Account, shop.account_id) if shop.account_id else None
    return {"id": a.id, "email": a.email, "name": a.name, "plan": a.plan, "paid_until": a.paid_until} if a else None


def _get_shop(db, code) -> Shop:
    shop = db.query(Shop).filter(Shop.shop_code == code.upper().replace("-", "")).first()
    if shop is None:
        raise HTTPException(status_code=404, detail="No such shop.")
    return shop


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------

class LoginIn(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginIn, db: Session = Depends(get_db)):
    user = db.query(AdminUser).filter(AdminUser.username == body.username.strip()).first()
    if user is None or not check_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Wrong username or password.")
    return {"token": make_admin_token(user.username), "username": user.username}


@router.get("/me")
def me(admin: AdminUser = Depends(current_admin)):
    return {"username": admin.username}


class PasswordIn(BaseModel):
    current: str
    new: str = Field(..., min_length=10, max_length=200)


@router.post("/change-password")
def change_password(body: PasswordIn, admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    if not check_password(body.current, admin.password_hash):
        raise HTTPException(status_code=400, detail="Current password is wrong.")
    admin.password_hash = hash_password(body.new)
    _audit(db, admin, "change_password")
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Overview + shops
# ---------------------------------------------------------------------------

@router.get("/overview")
def overview(admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    shops = db.query(Shop).all()
    counts = _open_error_counts(db)
    rows = [_shop_row(s, counts.get(s.id, 0), now) for s in shops]
    day_ago = now - timedelta(hours=24)
    return {
        "shops": len(rows),
        "online": sum(r["online"] for r in rows),
        "backups_ok": sum(r["backup_status"] == "OK" for r in rows),
        "backups_attention": [r for r in rows if r["backup_status"] != "OK" and not r["disabled"]],
        "licences": {st: sum(r["licence_state"] == st for r in rows)
                     for st in ("TRIAL", "ACTIVE", "GRACE", "EXPIRED")},
        "licences_attention": sorted(
            [r for r in rows if r["licence_state"] in ("GRACE", "EXPIRED")
             or (r["licence_state"] in ("TRIAL", "ACTIVE") and (r["licence_days_left"] or 99) <= 15)],
            key=lambda r: (r["licence_days_left"] or 0)),
        "conflicts": [r for r in rows if r["machine_conflict_at"]],
        "errors_open": sum(counts.values()),
        "errors_24h": db.query(ErrorGroup).filter(ErrorGroup.last_seen >= day_ago,
                                                  ErrorGroup.resolved_at.is_(None)).count(),
        "storage_bytes": db.query(func.coalesce(func.sum(Backup.size), 0)).scalar(),
        "new_leads": db.query(Lead).filter(Lead.status == "NEW").count(),
        "server_time": _iso(now),
    }


@router.get("/shops")
def list_shops(admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    counts = _open_error_counts(db)
    shops = db.query(Shop).order_by(Shop.shop_name, Shop.shop_code).all()
    return [_shop_row(s, counts.get(s.id, 0), now) for s in shops]


@router.get("/shops/{code}")
def shop_detail(code: str, admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    shop = _get_shop(db, code)
    errors = (db.query(ErrorGroup).filter(ErrorGroup.shop_id == shop.id)
              .order_by(ErrorGroup.resolved_at.isnot(None), ErrorGroup.last_seen.desc()).limit(200).all())
    backups = db.query(Backup).filter(Backup.shop_id == shop.id).order_by(Backup.uploaded_at.desc()).all()
    beats = (db.query(Heartbeat).filter(Heartbeat.shop_id == shop.id)
             .order_by(Heartbeat.at.desc()).limit(96).all())
    open_count = sum(1 for e in errors if e.resolved_at is None)
    try:
        last = json.loads(shop.heartbeat_json) if shop.heartbeat_json else None
    except ValueError:
        last = None
    return {
        **_shop_row(shop, open_count, now),
        "last_heartbeat": last,
        "backups": [{"id": b.id, "uploaded_at": _iso(b.uploaded_at), "created_at": b.created_at,
                     "size": b.size, "app_version": b.app_version, "sha256": b.sha256} for b in backups],
        "errors": [_error_row(e, shop) for e in errors],
        "heartbeats": [{"at": _iso(h.at), "app_version": h.app_version} for h in beats],
        "account": _owner_of(db, shop),
        # Owner app: which phones, and when the PC last left figures for them.
        # The figures themselves are locked for the phones - not readable here.
        "phones": [{"name": d.name, "status": d.status, "connected_at": _iso(d.created_at),
                    "last_seen_at": _iso(d.last_seen_at), "push": bool(d.push_token)}
                   for d in db.query(MobileDevice).filter(MobileDevice.shop_id == shop.id,
                                                          MobileDevice.status != "REMOVED")
                   .order_by(MobileDevice.created_at).all()],
        "owner_summary_at": _iso(getattr(db.get(OwnerSummary, shop.id), "updated_at", None)),
    }


class ShopPatch(BaseModel):
    notes: str | None = Field(default=None, max_length=5000)
    disabled: bool | None = None
    pilot: bool | None = None       # gets new releases first


@router.patch("/shops/{code}")
def update_shop(code: str, body: ShopPatch, admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    shop = _get_shop(db, code)
    if body.notes is not None:
        shop.notes = body.notes
        _audit(db, admin, "notes", shop)
    if body.disabled is not None and body.disabled != shop.disabled:
        shop.disabled = body.disabled
        _audit(db, admin, "disable" if body.disabled else "enable", shop)
    if body.pilot is not None and body.pilot != shop.pilot:
        shop.pilot = body.pilot
        _audit(db, admin, "pilot_on" if body.pilot else "pilot_off", shop)
    db.commit()
    return {"ok": True}


@router.post("/shops/{code}/reset-device")
def reset_device(code: str, admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    """The next PC that registers with this shop code takes it over."""
    shop = _get_shop(db, code)
    shop.token_hash = None
    shop.machine_conflict_at = None
    _audit(db, admin, "reset_device", shop)
    db.commit()
    return {"ok": True}


@router.post("/shops/{code}/clear-conflict")
def clear_conflict(code: str, admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    shop = _get_shop(db, code)
    shop.machine_conflict_at = None
    shop.other_machine_fp = None
    _audit(db, admin, "clear_conflict", shop)
    db.commit()
    return {"ok": True}


class LicenceIn(BaseModel):
    key: str = Field(..., min_length=10, max_length=4000)


@router.post("/shops/{code}/licence")
def queue_licence(code: str, body: LicenceIn, admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    """
    Queue a key made on the Mac (tools/licence/curavo_licence.py) for automatic
    delivery: the shop's next heartbeat picks it up and activates it.  Only the
    key's shape and shop code are checked here; the SHOP checks the signature.
    """
    shop = _get_shop(db, code)
    payload = peek_licence(body.key)
    if not payload or "until" not in payload or "code" not in payload:
        raise HTTPException(status_code=400, detail="That is not a Curavo licence key.")
    if payload["code"].replace("-", "").upper() != shop.shop_code:
        raise HTTPException(status_code=400, detail=(
            f"This key was made for shop code {payload['code']}, not {shop.shop_code}."))
    shop.pending_licence_key = "".join(body.key.split())
    shop.pending_licence_until = payload["until"]
    shop.pending_licence_set_at = datetime.utcnow()
    _audit(db, admin, "queue_licence", shop, f"serial {payload.get('serial')} until {payload['until']}")
    db.commit()
    return {"ok": True, "until": payload["until"], "serial": payload.get("serial")}


@router.get("/shops/{code}/backups/{backup_id}")
def download_backup(code: str, backup_id: int, admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    """The LOCKED file.  Unlock it on the Mac with tools/cloud/curavo_recovery.py."""
    shop = _get_shop(db, code)
    b = db.query(Backup).filter(Backup.id == backup_id, Backup.shop_id == shop.id).first()
    if b is None:
        raise HTTPException(status_code=404, detail="Backup not found.")
    _audit(db, admin, "download_backup", shop, b.filename)
    db.commit()
    return FileResponse(storage.path_for(shop, b), media_type="application/octet-stream",
                        filename=f"{shop.shop_code}_{b.filename}")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

def _error_row(e: ErrorGroup, shop: Shop) -> dict:
    return {
        "id": e.id, "shop_code": shop.shop_code, "shop_name": shop.shop_name,
        "source": e.source, "kind": e.kind, "message": e.message, "stack": e.stack,
        "route": e.route, "app_version": e.app_version, "count": e.count,
        "first_seen": _iso(e.first_seen), "last_seen": _iso(e.last_seen),
        "resolved_at": _iso(e.resolved_at), "regressed": e.regressed,
    }


@router.get("/errors")
def list_errors(status: str = "open", admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    q = db.query(ErrorGroup, Shop).join(Shop, Shop.id == ErrorGroup.shop_id)
    if status == "open":
        q = q.filter(ErrorGroup.resolved_at.is_(None))
    elif status == "resolved":
        q = q.filter(ErrorGroup.resolved_at.isnot(None))
    return [_error_row(e, s) for e, s in q.order_by(ErrorGroup.last_seen.desc()).limit(500).all()]


def _set_resolved(db, admin, error_id, resolved: bool):
    row = db.query(ErrorGroup, Shop).join(Shop, Shop.id == ErrorGroup.shop_id).filter(ErrorGroup.id == error_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="No such error.")
    e, shop = row
    e.resolved_at = datetime.utcnow() if resolved else None
    if resolved:
        e.regressed = False
    _audit(db, admin, "resolve_error" if resolved else "reopen_error", shop, f"{e.kind}: {e.message[:100]}")
    db.commit()
    return _error_row(e, shop)


@router.post("/errors/{error_id}/resolve")
def resolve_error(error_id: int, admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    return _set_resolved(db, admin, error_id, True)


@router.post("/errors/{error_id}/reopen")
def reopen_error(error_id: int, admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    return _set_resolved(db, admin, error_id, False)


@router.get("/audit")
def audit(admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    rows = (db.query(AdminAudit, Shop).outerjoin(Shop, Shop.id == AdminAudit.shop_id)
            .order_by(AdminAudit.at.desc()).limit(200).all())
    return [{"at": _iso(a.at), "admin": a.admin, "action": a.action, "detail": a.detail,
             "shop_code": s.shop_code if s else None, "shop_name": s.shop_name if s else None}
            for a, s in rows]


# ---------------------------------------------------------------------------
# Customer accounts (the owners who sign in on curavo.in)
# ---------------------------------------------------------------------------

def _account_row(db, a) -> dict:
    shops = db.query(Shop).filter(Shop.account_id == a.id).all()
    return {"id": a.id, "email": a.email, "name": a.name, "email_verified": a.email_verified,
            "google": bool(a.google_sub), "created_at": _iso(a.created_at), "last_login_at": _iso(a.last_login_at),
            "disabled": a.disabled, "shop_name": a.shop_name, "phone": a.phone, "town": a.town, "gstin": a.gstin,
            "plan": a.plan, "paid_until": a.paid_until,
            "shops": [{"shop_code": s.shop_code, "shop_name": s.shop_name} for s in shops]}


@router.get("/accounts")
def list_accounts(admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    return [_account_row(db, a) for a in db.query(Account).order_by(Account.created_at.desc()).limit(1000).all()]


class AccountPatch(BaseModel):
    plan: str | None = None
    paid_until: str | None = None      # YYYY-MM-DD, or "" to clear
    disabled: bool | None = None


PLANS = ("MONTHLY", "HALF_YEARLY", "YEARLY", "FOUNDING")


@router.patch("/accounts/{account_id}")
def update_account(account_id: int, body: AccountPatch, admin: AdminUser = Depends(current_admin),
                   db: Session = Depends(get_db)):
    """
    Set an account's subscription by hand (HCC, pilot shops, a UPI payment)
    until online payments exist.  A paid-until date makes the cloud issue the
    licence key for every shop linked to the account, delivered on its next
    check-in.
    """
    from datetime import date
    from curavo_cloud import licence_issuer
    a = db.get(Account, account_id)
    if a is None:
        raise HTTPException(status_code=404, detail="No such account.")
    if body.plan is not None:
        if body.plan and body.plan not in PLANS:
            raise HTTPException(status_code=400, detail=f"Plan must be one of {', '.join(PLANS)}.")
        a.plan = body.plan or None
    if body.paid_until is not None:
        if body.paid_until:
            try:
                date.fromisoformat(body.paid_until)
            except ValueError:
                raise HTTPException(status_code=400, detail="Paid until must be a date like 2027-11-30.")
        a.paid_until = body.paid_until or None
    if body.disabled is not None:
        a.disabled = body.disabled
        if body.disabled:
            a.session_version = (a.session_version or 1) + 1      # signed out everywhere
    _audit(db, admin, "account_update", None, f"{a.email}: plan={a.plan} paid_until={a.paid_until} disabled={a.disabled}")
    issued = [licence_issuer.issue_if_paid(db, s, a) for s in db.query(Shop).filter(Shop.account_id == a.id).all()]
    db.commit()
    return {**_account_row(db, a), "keys_sent": sum(1 for k in issued if k is not None),
            "issuing_enabled": licence_issuer.enabled()}


@router.post("/shops/{code}/unlink-account")
def unlink_account(code: str, admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    """Free a shop from its account (it moved owner) - the next owner links it again."""
    shop = _get_shop(db, code)
    _audit(db, admin, "unlink_account", shop, str(shop.account_id))
    shop.account_id = None
    db.commit()
    return {"ok": True}
