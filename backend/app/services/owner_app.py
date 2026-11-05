"""
The owner app (Android): what the shop PC sends to the owner's phone.

HOW IT FLOWS
    shop PC  --summary, locked-->  Curavo cloud  --same locked file-->  phone
The phone cannot reach the shop PC (it sits behind the shop's internet), so
the PC leaves a fresh SUMMARY at the cloud every few minutes (cloud_agent.py)
and the phone collects it.

LOCKED SO ONLY THE OWNER'S PHONES CAN READ IT (decided Nov 2026)
The summary holds the shop's sales and its patients' credit, so it is locked
on this PC before it leaves.  The cloud stores scrambled bytes; ARZ cannot
read a shop's sales.  (Backups are different - ARZ can open those, to restore
a shop.)  How:
  1. a fresh random 32-byte DATA KEY locks the summary (ChaCha20-Poly1305)
  2. the data key is locked once per connected phone ("wrapped"), using the
     phone's own public key: X25519 with a throw-away key -> HKDF-SHA256 ->
     ChaCha20-Poly1305
  3. a phone opens its own wrap with its private key (which never leaves the
     phone), gets the data key, opens the summary
All of these exist in the phone's JavaScript library (@noble/*), and
backend/scripts/test_owner_app.py checks the phone side really opens what
this file locks.

CONNECTING A PHONE (pairing)
  1. Owner presses "Connect phone" on this PC: a pairing id + a random SECRET
     are made, the id is registered at the cloud, and both are shown in a QR.
  2. The phone scans it, makes its own key pair, and sends the cloud its
     public key + proof = HMAC-SHA256(secret, "curavo-pair-v1:" + key + ":" + id)
  3. This PC (polling while the QR is on screen) fetches that, checks the
     proof with the secret only it and the QR know, and approves - or refuses.
  The cloud never sees the secret, so neither the cloud nor anyone who only
  knows the pairing id can connect a phone.  Codes expire in 10 minutes.

WHAT IS IN THE SUMMARY  (all numbers, no prescriptions or full patient lists)
  today / yesterday / month sales, bills, cash-UPI-credit split, money out;
  needs attention (expiry 30/60, low stock, supplier dues, overdue credit);
  every medicine on the shelf with its batches; patients who owe money;
  the last 10 bills.  When the subscription has lapsed: just "paused".
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timedelta
from decimal import Decimal

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.cloud import OwnerDevice, OwnerPairing

PAIRING_MINUTES = 10
MAX_PHONES = 5
SUMMARY_AAD = b"curavo-owner-v1"
WRAP_INFO = b"curavo-owner-wrap-v1"
PAIR_CONTEXT = "curavo-pair-v1"

STOCK_CAP = 5000         # medicines in the stock lookup
CREDIT_CAP = 500         # patients in the credit list
ATTENTION_CAP = 50       # rows per "needs attention" list


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _unb64(s: str) -> bytes:
    return base64.b64decode(s)


def _num(v):
    """Decimal/None -> float rounded to paise (JSON has no Decimal)."""
    if v is None:
        return None
    return round(float(v), 2)


# ---------------------------------------------------------------------------
# Locking
# ---------------------------------------------------------------------------

def _wrap_kek(shared: bytes, epk: bytes, device_pub: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                info=WRAP_INFO + epk + device_pub).derive(shared)


def lock_summary(summary: dict, devices: list) -> dict:
    """
    Lock `summary` for every phone in `devices` (rows with device_id and
    public_key).  Returns a JSON-able dict; nothing in it is readable without
    a phone's private key.
    """
    data_key = ChaCha20Poly1305.generate_key()
    nonce = os.urandom(12)
    body = json.dumps(summary, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    wraps = {}
    for d in devices:
        pub = _unb64(d.public_key)
        eph = X25519PrivateKey.generate()
        epk = eph.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        kek = _wrap_kek(eph.exchange(X25519PublicKey.from_public_bytes(pub)), epk, pub)
        wn = os.urandom(12)
        wraps[d.device_id] = {"epk": _b64(epk), "nonce": _b64(wn),
                              "ct": _b64(ChaCha20Poly1305(kek).encrypt(wn, data_key, d.device_id.encode()))}
    return {"v": 1, "alg": "x25519-hkdf-sha256-chacha20poly1305", "nonce": _b64(nonce),
            "ct": _b64(ChaCha20Poly1305(data_key).encrypt(nonce, body, SUMMARY_AAD)), "wraps": wraps}


def unlock_summary(locked: dict, device_id: str, private_key: X25519PrivateKey) -> dict:
    """The phone's side, in Python - used by the guard test only."""
    w = locked["wraps"][device_id]
    epk = _unb64(w["epk"])
    pub = private_key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    kek = _wrap_kek(private_key.exchange(X25519PublicKey.from_public_bytes(epk)), epk, pub)
    data_key = ChaCha20Poly1305(kek).decrypt(_unb64(w["nonce"]), _unb64(w["ct"]), device_id.encode())
    body = ChaCha20Poly1305(data_key).decrypt(_unb64(locked["nonce"]), _unb64(locked["ct"]), SUMMARY_AAD)
    return json.loads(body)


# ---------------------------------------------------------------------------
# Pairing
# ---------------------------------------------------------------------------

def pairing_proof(secret_b64: str, device_pub_b64: str, pairing_id: str) -> str:
    msg = f"{PAIR_CONTEXT}:{device_pub_b64}:{pairing_id}".encode("utf-8")
    return hmac.new(_unb64(secret_b64), msg, hashlib.sha256).hexdigest()


CHECK_CONTEXT = b"curavo-phone-check-v1:"


def check_code(public_key_b64: str) -> str:
    """
    6 digits made from a phone's public key.  The phone shows the same digits
    (mobile/src/lockbox.js checkCode); the owner compares them before pressing
    Allow, so a key swapped on the way (by anyone, the cloud included) shows up
    as a different number.
    """
    n = int.from_bytes(hashlib.sha256(CHECK_CONTEXT + public_key_b64.encode("ascii")).digest()[:4], "big")
    d = f"{n % 1_000_000:06d}"
    return f"{d[:3]} {d[3:]}"


def accept_phone(db: Session, request: dict) -> tuple[bool, str]:
    """The owner pressed Allow for a phone that signed in with the shop's Curavo account."""
    try:
        pub = request["public_key"]
        if len(_unb64(pub)) != 32:
            raise ValueError
    except Exception:
        return False, "The phone sent an invalid key."
    if db.query(OwnerDevice).filter(OwnerDevice.device_id == request["device_id"]).first():
        return True, "Connected."
    if db.query(OwnerDevice).count() >= MAX_PHONES:
        return False, f"At most {MAX_PHONES} phones can be connected. Remove one first."
    db.add(OwnerDevice(device_id=request["device_id"], name=(request.get("name") or "Phone")[:80],
                       public_key=pub, added_at=datetime.utcnow()))
    db.commit()
    return True, "Connected."


def new_pairing(db: Session) -> OwnerPairing:
    now = datetime.utcnow()
    # Old codes are useless; tidy them away.
    db.query(OwnerPairing).filter(OwnerPairing.expires_at < now - timedelta(days=1)).delete()
    p = OwnerPairing(pairing_id=secrets.token_urlsafe(12), secret=_b64(os.urandom(32)),
                     created_at=now, expires_at=now + timedelta(minutes=PAIRING_MINUTES), status="OPEN")
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def qr_payload(pairing: OwnerPairing, cloud_url: str, shop_code: str, shop_name: str) -> str:
    """What the QR code on the PC screen holds (the phone app reads it)."""
    return json.dumps({"curavo": 1, "c": cloud_url, "s": shop_code, "n": shop_name,
                       "p": pairing.pairing_id, "k": pairing.secret}, separators=(",", ":"))


def accept_claim(db: Session, pairing: OwnerPairing, claim: dict) -> tuple[bool, str]:
    """
    A phone claimed this pairing at the cloud.  Check its proof; on success add
    it as an owner device.  Returns (accepted, reason).
    """
    if pairing.status != "OPEN":
        return False, "This code was already used."
    if datetime.utcnow() > pairing.expires_at:
        pairing.status = "EXPIRED"
        db.commit()
        return False, "This code has expired. Press Connect phone again."
    try:
        pub = claim["public_key"]
        if len(_unb64(pub)) != 32:
            raise ValueError
    except Exception:
        pairing.status = "FAILED"
        db.commit()
        return False, "The phone sent an invalid key."
    want = pairing_proof(pairing.secret, pub, pairing.pairing_id)
    if not hmac.compare_digest(want, str(claim.get("proof", ""))):
        pairing.status = "FAILED"
        db.commit()
        return False, "The phone could not prove it scanned this code."
    if db.query(OwnerDevice).count() >= MAX_PHONES:
        pairing.status = "FAILED"
        db.commit()
        return False, f"At most {MAX_PHONES} phones can be connected. Remove one first."
    db.add(OwnerDevice(device_id=claim["device_id"], name=(claim.get("name") or "Phone")[:80],
                       public_key=pub, added_at=datetime.utcnow()))
    pairing.status = "DONE"
    pairing.device_name = (claim.get("name") or "Phone")[:80]
    db.commit()
    return True, "Connected."


# ---------------------------------------------------------------------------
# The summary itself
# ---------------------------------------------------------------------------

LOGO_PX = 128            # the phone shows it at 40 px; 128 stays sharp on any screen


def logo_thumbnail():
    """
    The shop's logo (Pharmacy Settings) as a small PNG data URI for the phone,
    or None when no logo is uploaded.  Made once and kept beside the logo
    (logo-thumb.png), remade only when the logo changes, so a 2 MB upload
    never travels to the phone - only a few KB.  Never raises: a broken image
    just means no logo on the phone.
    """
    from app.database import get_branding_dir
    try:
        folder = get_branding_dir()
        src = next((folder / f"logo.{e}" for e in ("png", "jpg", "webp") if (folder / f"logo.{e}").exists()), None)
        if src is None:
            return None
        thumb = folder / "logo-thumb.png"
        if not thumb.exists() or thumb.stat().st_mtime < src.stat().st_mtime:
            from PIL import Image
            with Image.open(src) as im:
                im = im.convert("RGBA")
                im.thumbnail((LOGO_PX, LOGO_PX))
                im.save(thumb, "PNG", optimize=True)
        return "data:image/png;base64," + _b64(thumb.read_bytes())
    except Exception:
        return None


def _sales_by_mode(db: Session, start, end) -> dict:
    """Net sales (after returns) and bill count between two UTC instants, by payment mode."""
    from app.models.billing import Invoice
    from app.services.revenue import net_invoice_amount_expr
    rows = (db.query(Invoice.payment_method, func.count(Invoice.id), func.coalesce(func.sum(net_invoice_amount_expr()), 0))
            .filter(Invoice.status != "RETURNED", Invoice.invoice_date >= start, Invoice.invoice_date < end)
            .group_by(Invoice.payment_method).all())
    out = {"sales": 0.0, "bills": 0, "cash": 0.0, "upi": 0.0, "credit": 0.0, "other": 0.0}
    for mode, n, amount in rows:
        amount = float(amount or 0)
        out["sales"] += amount
        out["bills"] += int(n)
        key = {"CASH": "cash", "UPI": "upi", "CREDIT": "credit"}.get((mode or "").upper(), "other")
        out[key] += amount
    return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in out.items()}


def _stock(db: Session) -> list:
    """Every medicine with sellable stock, with its batches (earliest expiry first)."""
    from app.models.inventory import Batch, Product
    from app.utils.dates import get_today_ist
    today = get_today_ist()
    rows = (db.query(Product, Batch).join(Batch, Batch.product_id == Product.id)
            .filter(Product.is_active == True, Batch.quantity_available > 0, Batch.expiry_date >= today)  # noqa: E712
            .order_by(Product.name, Batch.expiry_date).all())
    by_product: dict = {}
    for p, b in rows:
        e = by_product.get(p.id)
        if e is None:
            if len(by_product) >= STOCK_CAP:
                continue
            e = by_product[p.id] = {"n": p.name, "g": p.generic_name or "", "u": p.units_per_strip if p.is_strip else None,
                                    "r": p.rack_location or "", "q": 0, "min": p.min_stock_level or 0, "b": []}
        e["q"] += int(b.quantity_available)
        e["b"].append([b.batch_number, b.expiry_date.isoformat(), int(b.quantity_available),
                       _num(b.selling_price * (p.units_per_strip if p.is_strip and p.units_per_strip else 1))])
    return list(by_product.values())


def build_summary(db: Session) -> dict:
    """Everything the phone shows, as plain JSON.  Read-only on the shop's data."""
    from app.models.billing import Invoice
    from app.models.patients import Patient
    from app.models.settings import PharmacySettings
    from app.routers.dashboard import _collect_expenditure
    from app.services import credit_service, inventory_service, licence, supplier_credit_service
    from app.services.revenue import net_invoice_amount_expr
    from app.utils.dates import get_today_ist, ist_day_bounds_utc

    lic = licence.licence_status(db)
    ps = db.query(PharmacySettings).order_by(PharmacySettings.id).first()
    base = {"v": 1, "generated_at": datetime.utcnow().isoformat() + "Z",
            "shop": {"name": ps.pharmacy_name if ps else "", "code": lic["shop_code"], "logo": logo_thumbnail()},
            "licence": {"state": lic["state"], "days_left": lic.get("days_left"), "headline": lic["headline"]}}
    if lic["restricted"]:
        # Decided Nov 2026: the owner app pauses with reports when the
        # subscription lapses.  Nothing about the shop's trade is sent.
        return {**base, "restricted": True}

    today = get_today_ist()
    t0, t1 = ist_day_bounds_utc(today)
    y0, y1 = ist_day_bounds_utc(today - timedelta(days=1))
    m0, _ = ist_day_bounds_utc(today.replace(day=1))

    money_out = _collect_expenditure(db, today, today)
    expiry = inventory_service.get_expiry_alerts(db)
    low = inventory_service.get_low_stock_products(db)
    dues = supplier_credit_service.get_due_rows(db, within_days=7)
    credit = credit_service.get_all_credit_summary(db)

    def exp_rows(rows):
        return [{"name": r["product_name"], "batch": r["batch_number"], "expiry": r["expiry_date"].isoformat(),
                 "days": r["days_to_expiry"], "qty": int(r["quantity_available"]),
                 "strip": r["units_per_strip"] if r["is_strip"] else None, "supplier": r["supplier_name"]}
                for r in rows[:ATTENTION_CAP]]

    recent = (db.query(Invoice).filter(Invoice.status != "RETURNED")
              .order_by(Invoice.invoice_date.desc()).limit(10).all())
    names = {p.id: p.name for p in db.query(Patient).filter(
        Patient.id.in_([i.patient_id for i in recent if i.patient_id])).all()} if recent else {}

    return {
        **base,
        "restricted": False,
        "today": {**_sales_by_mode(db, t0, t1), "money_out": _num(money_out.total)},
        "yesterday": _sales_by_mode(db, y0, y1),
        "month": _sales_by_mode(db, m0, t1),
        "attention": {
            "expired": exp_rows(expiry["expired"]),
            "expiring_30": exp_rows(expiry["expires_30"]),
            "expiring_60": exp_rows(expiry["expires_60"]),
            "low_stock": [{"name": r["name"], "stock": int(r["current_stock"]), "min": int(r["min_stock_level"] or 0)}
                          for r in low[:ATTENTION_CAP]],
            "supplier_due": [{"supplier": r["supplier_name"], "amount": _num(r["amount_due"]),
                              "due": r["due_date"].isoformat(), "days": r["days_until_due"]}
                             for r in (dues["overdue"] + dues["upcoming"])[:ATTENTION_CAP]],
            "credit_overdue": {"patients": credit["overdue_count"], "amount": _num(credit["overdue_amount"])},
        },
        "credit": {
            "total": _num(credit["total_outstanding"]),
            "patients": [{"name": r["name"], "phone": r["phone"], "amount": _num(r["outstanding"]),
                          "oldest_due": r["oldest_due_date"].isoformat() if r["oldest_due_date"] else None,
                          "overdue": bool(r["is_overdue"])}
                         for r in sorted(credit["patients"], key=lambda r: -float(r["outstanding"] or 0))[:CREDIT_CAP]],
        },
        "stock": _stock(db),
        "recent_bills": [{"no": i.invoice_number, "at": i.invoice_date.isoformat() if i.invoice_date else None,
                          "patient": names.get(i.patient_id), "mode": i.payment_method,
                          "amount": _num((i.total_amount or 0) - (getattr(i, "refunded_amount", 0) or 0))}
                         for i in recent],
    }


def attention_counts(summary: dict) -> dict:
    """Counts only - this is what a push notification may say (no money)."""
    a = summary.get("attention") or {}
    return {"expiring": len(a.get("expired", [])) + len(a.get("expiring_30", [])),
            "low_stock": len(a.get("low_stock", [])),
            "dues_today": sum(1 for d in a.get("supplier_due", []) if (d.get("days") is not None and d["days"] <= 0))}


def push_text(shop_name: str, counts: dict):
    """The once-a-day morning notification - or None when nothing needs doing."""
    parts = []
    if counts["expiring"]:
        parts.append(f"{counts['expiring']} medicine{'s' if counts['expiring'] != 1 else ''} expiring within 30 days")
    if counts["low_stock"]:
        parts.append(f"{counts['low_stock']} low on stock")
    if counts["dues_today"]:
        parts.append(f"{counts['dues_today']} supplier payment{'s' if counts['dues_today'] != 1 else ''} due")
    if not parts:
        return None
    return {"title": shop_name or "Curavo", "body": "Needs attention: " + ", ".join(parts) + "."}
