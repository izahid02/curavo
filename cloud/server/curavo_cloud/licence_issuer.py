"""
The cloud issues a shop's licence key by itself when its owner's account has
paid - so nobody copies shop codes or keys any more.

It signs with the cloud's OWN key (ARZ online key, made 4 Nov 2026), never
the master key on Zahid's Mac.  The desktop app trusts both
(backend/app/services/licence.py PUBLIC_KEYS).  The key reaches the PC the way
a panel-sent key always has: pending_licence_key, delivered on the next
check-in.  Same format, byte for byte, as tools/licence/curavo_licence.py.

Key file: CURAVO_ONLINE_LICENCE_KEY (a path) or <data>/online_licence_key.pem.
No file = issuing switched off (ARZ can still send keys from the panel).
"""
import base64
import json
import logging
import os
from datetime import date, datetime
from pathlib import Path

from cryptography.hazmat.primitives import serialization

from curavo_cloud.config import settings
from curavo_cloud.models import Account, IssuedKey, Shop

SIGNING_CONTEXT = b"curavo-licence-v1:"
KEY_PREFIX = "CURAVO-"
SERIAL_BASE = 100000          # cloud-made keys are #100001 and up; Mac-made ones stay small
log = logging.getLogger("curavo.licence")


def _key_path() -> Path:
    return Path(os.environ.get("CURAVO_ONLINE_LICENCE_KEY") or settings.data_dir / "online_licence_key.pem")


def _private():
    p = _key_path()
    if not p.exists():
        return None
    return serialization.load_pem_private_key(p.read_bytes(), password=None)


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def enabled() -> bool:
    return _key_path().exists()


def issue_if_paid(db, shop: Shop, acc: Account):
    """
    If `acc` has paid beyond what `shop` already has waiting, sign a key up to
    acc.paid_until and queue it for the shop's next check-in.  Returns the
    IssuedKey or None.  The caller commits.
    """
    if acc is None or not acc.paid_until or shop.account_id != acc.id:
        return None
    if date.fromisoformat(acc.paid_until) < date.today():
        return None
    if shop.pending_licence_until and shop.pending_licence_until >= acc.paid_until:
        return None
    # Already reported active up to then by the shop itself?
    if shop.licence_until and shop.licence_state == "ACTIVE" and shop.licence_until >= acc.paid_until:
        return None
    private = _private()
    if private is None:
        log.warning("Online licence key missing - cannot issue a key for shop %s", shop.shop_code)
        return None
    row = IssuedKey(shop_id=shop.id, account_id=acc.id, until=acc.paid_until, plan=acc.plan or "YEARLY", key="")
    db.add(row)
    db.flush()
    payload = {"v": 1, "serial": SERIAL_BASE + row.id, "shop": (shop.shop_name or acc.shop_name or "").strip(),
               "code": shop.shop_code, "plan": row.plan, "issued": date.today().isoformat(),
               "until": acc.paid_until}
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    row.key = f"{KEY_PREFIX}{_b64(body)}.{_b64(private.sign(SIGNING_CONTEXT + body))}"
    shop.pending_licence_key = row.key
    shop.pending_licence_until = acc.paid_until
    shop.pending_licence_set_at = datetime.utcnow()
    return row
