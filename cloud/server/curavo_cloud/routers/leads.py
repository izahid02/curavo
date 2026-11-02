"""
Demo bookings from the website.

  POST  /public/leads               the website's "Book my demo" form (no login)
  GET   /admin/api/leads            ARZ: all bookings, newest first (?status=)
  PATCH /admin/api/leads/{id}       ARZ: move along / add a note

The public endpoint is the only door into this server with no login, so it is
kept narrow:
  * only the fields the form shows, each length-capped; a 10-13 digit phone
  * a hidden "website" field humans never fill - bots do, and are ignored
    (they still get a normal "thank you", so they learn nothing)
  * at most 5 bookings an hour from one address and 200 a day in total
    (counted in memory; the address itself is never stored)
  * only the Curavo website may call it from a browser (CORS, in main.py)
"""
import re
import threading
import time
from collections import defaultdict, deque
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from curavo_cloud.db import get_db
from curavo_cloud.models import AdminAudit, AdminUser, Lead
from curavo_cloud.security import current_admin

router = APIRouter(tags=["Leads"])

STATUSES = ("NEW", "CONTACTED", "TRIAL", "CUSTOMER", "NOT_INTERESTED")
PER_ADDRESS_PER_HOUR = 5
PER_DAY = 200

_lock = threading.Lock()
_by_addr = defaultdict(deque)
_all = deque()


def _allowed(addr: str) -> bool:
    now = time.time()
    with _lock:
        q = _by_addr[addr]
        while q and now - q[0] > 3600:
            q.popleft()
        while _all and now - _all[0] > 86400:
            _all.popleft()
        if len(q) >= PER_ADDRESS_PER_HOUR or len(_all) >= PER_DAY:
            return False
        q.append(now)
        _all.append(now)
        return True


class LeadIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    phone: str = Field(..., min_length=10, max_length=20)
    shop: str = Field(..., min_length=1, max_length=150)
    town: str = Field(default="", max_length=80)
    current: str = Field(default="", max_length=60)
    website: str = Field(default="", max_length=200)     # the honeypot


@router.post("/public/leads", status_code=201)
def create_lead(body: LeadIn, request: Request, db: Session = Depends(get_db)):
    if body.website:                       # a bot filled the hidden field
        return {"ok": True}
    digits = re.sub(r"\D", "", body.phone)
    if not 10 <= len(digits) <= 13:
        raise HTTPException(status_code=400, detail="Please enter a 10-digit mobile number.")
    addr = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
        request.client.host if request.client else "?")
    if not _allowed(addr):
        raise HTTPException(status_code=429, detail="Too many requests. Please message us on WhatsApp.")
    db.add(Lead(name=body.name.strip(), phone=digits[-10:] if len(digits) == 12 and digits.startswith("91") else digits,
                shop=body.shop.strip(), town=body.town.strip() or None,
                current_software=body.current.strip() or None))
    db.commit()
    return {"ok": True}


def _row(l: Lead) -> dict:
    return {"id": l.id, "created_at": l.created_at.isoformat() + "Z", "name": l.name, "phone": l.phone,
            "shop": l.shop, "town": l.town, "current_software": l.current_software, "source": l.source,
            "status": l.status, "notes": l.notes or "",
            "updated_at": l.updated_at.isoformat() + "Z" if l.updated_at else None}


@router.get("/admin/api/leads")
def list_leads(status: str = "", admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    q = db.query(Lead)
    if status:
        q = q.filter(Lead.status == status)
    counts = {s: db.query(Lead).filter(Lead.status == s).count() for s in STATUSES}
    return {"leads": [_row(l) for l in q.order_by(Lead.created_at.desc()).limit(500).all()], "counts": counts}


class LeadPatch(BaseModel):
    status: str | None = None
    notes: str | None = Field(default=None, max_length=5000)


@router.patch("/admin/api/leads/{lead_id}")
def update_lead(lead_id: int, body: LeadPatch, admin: AdminUser = Depends(current_admin),
                db: Session = Depends(get_db)):
    lead = db.get(Lead, lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="No such lead.")
    if body.status is not None:
        if body.status not in STATUSES:
            raise HTTPException(status_code=400, detail="Unknown status.")
        if body.status != lead.status:
            db.add(AdminAudit(admin=admin.username, action="lead_status",
                              detail=f"{lead.shop}: {lead.status} -> {body.status}"))
            lead.status = body.status
    if body.notes is not None:
        lead.notes = body.notes
    lead.updated_at = datetime.utcnow()
    db.commit()
    return _row(lead)
