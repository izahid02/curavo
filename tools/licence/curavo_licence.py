"""
ARZ Solutions - Curavo licence key maker.  RUNS ON ZAHID'S MAC ONLY.

Makes the keys shops paste into "Licence & subscription".  Each key is signed
with ARZ's PRIVATE key; the app checks it with the matching PUBLIC key that is
built into backend/app/services/licence.py.  (Why that cannot be forged: see
the top of that file.)

THE PRIVATE KEY
  Lives in the key folder (default ~/Projects/ARZ-licence-keys, OUTSIDE the
  git repo) as arz_licence_private.pem.
    * Never commit it, email it or put it on a shop PC.  Anyone holding it can
      make unlimited Curavo keys.
    * Keep a copy on a pen drive.  If it is lost, no new keys can be made until
      a new key pair is created AND an app update with the new public key has
      reached every shop.

COMMANDS  (run from the curavo folder, with the backend's Python)
  First time only - make the key pair, and print the public key to paste into
  services/licence.py:
      backend/venv/bin/python tools/licence/curavo_licence.py init

  A shop paid - make its key (12 months from today unless --until is given):
      backend/venv/bin/python tools/licence/curavo_licence.py issue \\
          --code 7K3P-9QXM --shop "Sunrise Medicos" --months 12
      backend/venv/bin/python tools/licence/curavo_licence.py issue \\
          --code 7K3P-9QXM --shop "Sunrise Medicos" --until 2027-11-30

  What is inside a key someone sent you:
      backend/venv/bin/python tools/licence/curavo_licence.py show CURAVO-...

Every key issued is also written to issued.csv in the key folder - your record
of who has which key, and when each one ends.
"""
import argparse
import base64
import calendar
import csv
import json
import os
import re
import sys
from datetime import date
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

# Must match backend/app/services/licence.py exactly.
KEY_PREFIX = "CURAVO-"
SIGNING_CONTEXT = b"curavo-licence-v1:"
_CODE_ALPHABET = set("23456789ABCDEFGHJKMNPQRSTUVWXYZ")

DEFAULT_KEYDIR = Path.home() / "Projects" / "ARZ-licence-keys"
PRIVATE_NAME = "arz_licence_private.pem"
LEDGER_NAME = "issued.csv"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def _load_private(keydir: Path) -> Ed25519PrivateKey:
    path = keydir / PRIVATE_NAME
    if not path.exists():
        sys.exit(f"No private key at {path}. Run 'init' first (or pass --keydir).")
    return serialization.load_pem_private_key(path.read_bytes(), password=None)


def public_key_b64(private: Ed25519PrivateKey) -> str:
    raw = private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(raw).decode("ascii")


def make_key(private: Ed25519PrivateKey, payload: dict) -> str:
    """Sign a payload.  Also used by the guard test with a throwaway key."""
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    sig = private.sign(SIGNING_CONTEXT + body)
    return f"{KEY_PREFIX}{_b64(body)}.{_b64(sig)}"


def _add_months(d: date, months: int) -> date:
    """2026-11-02 + 12 months -> 2027-11-01 (the day BEFORE the same date)."""
    y, m = divmod(d.month - 1 + months, 12)
    y, m = d.year + y, m + 1
    day = min(d.day, calendar.monthrange(y, m)[1])
    return date.fromordinal(date(y, m, day).toordinal() - 1)


def cmd_init(args):
    keydir = Path(args.keydir).expanduser()
    path = keydir / PRIVATE_NAME
    if path.exists():
        sys.exit(f"A private key already exists at {path}. Refusing to overwrite it - "
                 "replacing it would stop every key you have issued from being renewable "
                 "with the same app build.")
    keydir.mkdir(parents=True, exist_ok=True)
    private = Ed25519PrivateKey.generate()
    path.write_bytes(private.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()))
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    print(f"Private key written to {path}")
    print("KEEP IT SECRET. Copy it to a pen drive. Never put it in git.")
    print()
    print("Public key - paste into PUBLIC_KEYS in backend/app/services/licence.py:")
    print(public_key_b64(private))


def cmd_issue(args):
    keydir = Path(args.keydir).expanduser()
    private = _load_private(keydir)

    code = re.sub(r"[^A-Z0-9]", "", args.code.upper())
    if len(code) != 8 or not set(code) <= _CODE_ALPHABET:
        sys.exit(f"'{args.code}' is not a shop code. It looks like 7K3P-9QXM "
                 "(shown in the app under Licence & subscription).")

    today = date.today()
    if args.until:
        until = date.fromisoformat(args.until)
    else:
        until = _add_months(today, args.months)
    if until < today:
        sys.exit(f"--until {until} is in the past.")

    ledger = keydir / LEDGER_NAME
    serial = 1
    if ledger.exists():
        with ledger.open(newline="", encoding="utf-8") as f:
            serial = 1 + sum(1 for _ in csv.DictReader(f))

    payload = {
        "v": 1, "serial": serial, "shop": args.shop.strip(), "code": code,
        "plan": args.plan, "issued": today.isoformat(), "until": until.isoformat(),
    }
    key = make_key(private, payload)

    new_file = not ledger.exists()
    with ledger.open("a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new_file:
            w.writerow(["serial", "issued", "shop", "code", "plan", "until", "key"])
        w.writerow([serial, today.isoformat(), payload["shop"], code, args.plan,
                    until.isoformat(), key])

    print(f"Key #{serial} for {payload['shop']} (shop code {code[:4]}-{code[4:]}), "
          f"valid until {until.isoformat()}:")
    print()
    print(key)
    print()
    print(f"Recorded in {ledger}")


def cmd_show(args):
    key = re.sub(r"\s+", "", args.key)
    if not key.upper().startswith(KEY_PREFIX) or key.count(".") != 1:
        sys.exit("Not a Curavo licence key.")
    body = key[len(KEY_PREFIX):].split(".")[0]
    print(json.dumps(json.loads(_unb64(body)), indent=2, ensure_ascii=False))
    print("(Contents only - the app checks the signature when the key is pasted.)")


def main():
    ap = argparse.ArgumentParser(description="ARZ Solutions - Curavo licence keys")
    ap.add_argument("--keydir", default=str(DEFAULT_KEYDIR),
                    help=f"folder holding the private key (default {DEFAULT_KEYDIR})")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="create ARZ's key pair (once)")

    p = sub.add_parser("issue", help="make a key for a shop")
    p.add_argument("--code", required=True, help="the shop code shown in the app, e.g. 7K3P-9QXM")
    p.add_argument("--shop", required=True, help="the shop's name, as it should show in the app")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--months", type=int, default=12, help="length from today (default 12)")
    g.add_argument("--until", help="last day, YYYY-MM-DD (instead of --months)")
    p.add_argument("--plan", default="standard")

    p = sub.add_parser("show", help="print what is inside a key")
    p.add_argument("key")

    args = ap.parse_args()
    {"init": cmd_init, "issue": cmd_issue, "show": cmd_show}[args.cmd](args)


if __name__ == "__main__":
    main()
