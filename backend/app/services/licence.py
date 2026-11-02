"""
Curavo subscription: free trial, licence keys, grace period - all OFFLINE.

THE RULES (decided with ARZ, Nov 2026)
--------------------------------------
  * A new shop gets a 30-day FREE TRIAL from the first day the app runs.
  * After paying (UPI, for now), the shop receives a LICENCE KEY from ARZ.
    It is pasted once into "Licence & subscription" and is checked right here,
    on the shop's PC, with no internet.
  * When a paid licence's end date passes there are 15 days of GRACE: a
    warning banner, nothing locked.
  * After that the app is RESTRICTED: BILLING KEEPS WORKING (patients must be
    served), but reports, report exports and backup downloads pause, and the
    owner app will refuse to sync once it exists.  Automatic backups keep
    running regardless - a lapsed subscription must never put data at risk.
  * A trial that ends goes straight to restricted (no grace): grace exists for
    a paying customer whose renewal is late, not as a longer trial.

HOW A KEY CANNOT BE FORGED
--------------------------
A key is a small JSON message (shop name, shop code, end date, ...) plus a
DIGITAL SIGNATURE made with ARZ's PRIVATE key, which never leaves Zahid's Mac
(tools/licence/curavo_licence.py makes keys).  The app holds only the matching
PUBLIC key (below).  The public key can CHECK a signature but cannot MAKE one,
so nobody holding the app - or reading this file - can produce a key, and
changing even one character of a real key (say, the end date) breaks its
signature.  The algorithm is Ed25519, the same one SSH and Signal use; the
`cryptography` library ships with python-jose already, so nothing is added.

HOW A KEY CANNOT BE SHARED
--------------------------
Every installation makes a random SHOP CODE on first run (e.g. 7K3P-9QXM).
ARZ signs each key for one shop code, and the app refuses a key carrying a
different one.

HOW THE CLOCK CANNOT BE TURNED BACK
-----------------------------------
The app remembers the latest date it has ever seen (last_seen_on).  If the PC
clock is set back, "today" stays at that remembered date.

KEY FORMAT
----------
    CURAVO-<payload, base64url>.<signature, base64url>
Spaces and line breaks are ignored when pasting (WhatsApp likes to wrap long
text).  Payload fields:
    v       1                    format version
    serial  12                   ARZ's own running number for the key
    shop    "Sunrise Medicos"    who it was issued to (shown in the app)
    code    "7K3P9QXM"           the shop code it is valid for
    plan    "standard"
    issued  "2026-11-02"
    until   "2027-11-30"         last day of the subscription (inclusive)
"""
import base64
import json
import re
import secrets
from datetime import date, datetime, timedelta

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.licence import LicenceState
from app.models.user import User
from app.services.auth_service import get_current_user

TRIAL_DAYS = 30
GRACE_DAYS = 15

# ARZ Solutions' licence PUBLIC key(s), base64 of the raw 32 bytes.  A list so
# the signing key can be replaced one day without invalidating keys already
# issued: add the new public key here, keep the old one until its keys expire.
# THIS IS NOT A SECRET.  The private half lives only on Zahid's Mac.
PUBLIC_KEYS = [
    "OZIGaDO0XjxYAPoVM5Vo8mD8SYk9IgXXuSfrD2Jlf7Y=",   # ARZ key 1, made 2 Nov 2026
]

KEY_PREFIX = "CURAVO-"
# Domain separation: a signature made for anything else can never pass as a
# licence, and a future v2 format can never be confused with v1.
SIGNING_CONTEXT = b"curavo-licence-v1:"

# Shop-code letters: no 0/O, 1/I/L - it is read out over the phone.
_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
_CODE_LEN = 8

# What a restricted shop cannot use.  The frontend reads this list rather than
# keeping its own, so the two cannot drift apart.
LOCKED_WHEN_RESTRICTED = ["reports", "exports", "backup_download", "owner_app"]


class LicenceKeyError(ValueError):
    """A pasted key is not valid for this shop.  The message is shown as-is."""


def _today() -> date:
    """The PC's date.  A separate function so the guard test can move time."""
    return date.today()


def _fmt(d) -> str:
    """2027-11-30 -> '30 Nov 2027' - how dates read on screen."""
    return f"{d.day} {d.strftime('%b %Y')}" if d else ""


def format_shop_code(code: str) -> str:
    """'7K3P9QXM' -> '7K3P-9QXM' (easier to read out)."""
    return f"{code[:4]}-{code[4:]}" if code and len(code) == 8 else (code or "")


def normalise_shop_code(raw: str) -> str:
    """'7k3p-9qxm ' -> '7K3P9QXM'."""
    return re.sub(r"[^A-Z0-9]", "", (raw or "").upper())


# ---------------------------------------------------------------------------
# The one stored row
# ---------------------------------------------------------------------------

def get_state(db: Session) -> LicenceState:
    """
    This installation's row - created on the first call, which is what starts
    the free trial.  An upgraded shop's trial therefore starts on the day it
    first runs this version, not on the day it first installed the old app.
    """
    row = db.query(LicenceState).order_by(LicenceState.id).first()
    if row is None:
        today = _today()
        row = LicenceState(
            shop_code="".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LEN)),
            trial_started_on=today,
            last_seen_on=today,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _effective_today(db: Session, row: LicenceState) -> date:
    """
    Today's date - but never EARLIER than a date this app has already seen.

    Moves last_seen_on forward when the real date passes it (at most one write
    a day), and ignores a clock that has been set back.
    """
    today = _today()
    if today > row.last_seen_on:
        row.last_seen_on = today
        db.commit()
        return today
    return row.last_seen_on


# ---------------------------------------------------------------------------
# Reading a key
# ---------------------------------------------------------------------------

def _b64decode(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def decode_key(raw: str) -> dict:
    """
    Check a pasted key's signature and return its payload.

    Raises LicenceKeyError with a plain-English reason.  Does NOT check the
    shop code or the dates - activate() does that, against this shop.
    """
    key = re.sub(r"\s+", "", raw or "")
    if not key.upper().startswith(KEY_PREFIX):
        raise LicenceKeyError("This is not a Curavo licence key. It should start with CURAVO-")
    body = key[len(KEY_PREFIX):]
    if body.count(".") != 1:
        raise LicenceKeyError("The licence key is incomplete. Please copy the whole key again.")
    payload_b64, sig_b64 = body.split(".")
    try:
        payload_bytes = _b64decode(payload_b64)
        signature = _b64decode(sig_b64)
    except Exception:
        raise LicenceKeyError("The licence key is damaged. Please copy the whole key again.")

    message = SIGNING_CONTEXT + payload_bytes
    for pub in PUBLIC_KEYS:
        try:
            Ed25519PublicKey.from_public_bytes(base64.b64decode(pub)).verify(signature, message)
            break
        except (InvalidSignature, ValueError):
            continue
    else:
        raise LicenceKeyError(
            "This licence key could not be verified. It may have been typed or "
            "copied wrongly - please paste the key exactly as ARZ Solutions sent it."
        )

    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
        if payload.get("v") != 1:
            raise LicenceKeyError("This licence key is for a newer version of Curavo. Please update the app.")
        payload["until"] = date.fromisoformat(payload["until"])
        payload["code"] = normalise_shop_code(payload["code"])
    except LicenceKeyError:
        raise
    except Exception:
        raise LicenceKeyError("The licence key is damaged. Please copy the whole key again.")
    return payload


def _stored_payload(row: LicenceState):
    """The accepted key's payload, re-verified - or None if there is none."""
    if not row.licence_key:
        return None
    try:
        payload = decode_key(row.licence_key)
    except LicenceKeyError:
        return None     # a key edited in the database simply stops counting
    return payload if payload["code"] == row.shop_code else None


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

def licence_status(db: Session) -> dict:
    """
    Everything the app shows about the subscription, worked out fresh.

    state is one of:
      TRIAL    free trial running                       nothing locked
      ACTIVE   paid, end date not reached               nothing locked
      GRACE    paid, ended up to GRACE_DAYS ago         nothing locked, warning
      EXPIRED  trial over, or grace over                restricted
    """
    row = get_state(db)
    today = _effective_today(db, row)
    trial_ends_on = row.trial_started_on + timedelta(days=TRIAL_DAYS - 1)
    payload = _stored_payload(row)

    out = {
        "shop_code":        format_shop_code(row.shop_code),
        "today":            today.isoformat(),
        "trial_days":       TRIAL_DAYS,
        "grace_days":       GRACE_DAYS,
        "trial_started_on": row.trial_started_on.isoformat(),
        "trial_ends_on":    trial_ends_on.isoformat(),
        "licensed_to":      None,
        "plan":             None,
        "serial":           None,
        "valid_until":      None,
        "grace_ends_on":    None,
    }

    if payload:
        until = payload["until"]
        grace_end = until + timedelta(days=GRACE_DAYS)
        out.update(
            licensed_to=payload.get("shop"), plan=payload.get("plan"),
            serial=payload.get("serial"), valid_until=until.isoformat(),
            grace_ends_on=grace_end.isoformat(),
        )
        if today <= until:
            left = (until - today).days + 1
            out.update(state="ACTIVE", days_left=left,
                       headline=f"Subscribed until {_fmt(until)}",
                       detail=(f"{left} day{'s' if left != 1 else ''} left. "
                               "Send your shop code to ARZ Solutions before then to renew."
                               if left <= 15 else ""))
        elif today <= grace_end:
            left = (grace_end - today).days + 1
            out.update(state="GRACE", days_left=left,
                       headline=f"Subscription ended on {_fmt(until)}",
                       detail=(f"Please renew within {left} day{'s' if left != 1 else ''}. "
                               f"After {_fmt(grace_end)}, reports, exports and backup "
                               "downloads pause. Billing keeps working."))
        else:
            out.update(state="EXPIRED", days_left=0,
                       headline="Subscription has ended",
                       detail=("Billing keeps working. Reports, exports and backup "
                               "downloads are paused until a new licence key is entered."))
    elif today <= trial_ends_on:
        left = (trial_ends_on - today).days + 1
        out.update(state="TRIAL", days_left=left,
                   headline=f"Free trial: {left} day{'s' if left != 1 else ''} left",
                   detail=(f"The trial ends on {_fmt(trial_ends_on)}. To subscribe, send "
                           "your shop code to ARZ Solutions."))
    else:
        out.update(state="EXPIRED", days_left=0,
                   headline="Free trial has ended",
                   detail=("Billing keeps working. Reports, exports and backup downloads "
                           "are paused until a licence key is entered."))

    out["restricted"] = out["state"] == "EXPIRED"
    out["locked_features"] = list(LOCKED_WHEN_RESTRICTED) if out["restricted"] else []
    return out


def is_restricted(db: Session) -> bool:
    return licence_status(db)["restricted"]


# ---------------------------------------------------------------------------
# Activation
# ---------------------------------------------------------------------------

def activate(db: Session, raw_key: str) -> dict:
    """
    Accept a pasted key for this shop, or raise LicenceKeyError saying why not.
    Returns the new status.
    """
    row = get_state(db)
    payload = decode_key(raw_key)
    if payload["code"] != row.shop_code:
        raise LicenceKeyError(
            f"This key was made for shop code {format_shop_code(payload['code'])}, "
            f"but this PC's shop code is {format_shop_code(row.shop_code)}. "
            "Please send the code shown here to ARZ Solutions."
        )

    today = _effective_today(db, row)
    if payload["until"] + timedelta(days=GRACE_DAYS) < today:
        raise LicenceKeyError(f"This licence key has already ended ({_fmt(payload['until'])}).")

    current = _stored_payload(row)
    if current and payload["until"] < current["until"]:
        raise LicenceKeyError(
            f"This key ends on {_fmt(payload['until'])}, earlier than the licence already "
            f"active (until {_fmt(current['until'])}). Nothing was changed."
        )

    row.licence_key = re.sub(r"\s+", "", raw_key)
    row.activated_at = datetime.utcnow()
    db.commit()
    return licence_status(db)


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------

RESTRICTED_MESSAGE = (
    "This is paused because the Curavo subscription has ended. Billing keeps "
    "working. Enter a licence key in Licence & subscription to continue."
)


def require_full_licence(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),   # log-in is checked FIRST (401 before 402)
) -> None:
    """
    FastAPI dependency for everything that pauses when the subscription lapses.

    402 Payment Required is the HTTP status made for exactly this; the frontend
    recognises it and shows the renewal screen instead of a generic error.
    Never put this on billing, stock, patients or automatic backups.
    """
    if is_restricted(db):
        raise HTTPException(status_code=402, detail=RESTRICTED_MESSAGE)
