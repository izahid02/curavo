"""
ARZ Solutions - unlock a shop's Curavo cloud backup.  RUNS ON ZAHID'S MAC ONLY.

Cloud backups are locked on the shop PC before upload (see
backend/app/services/backup_crypto.py).  ARZ's RECOVERY key is one of the two
keys that can open them.  Its secret half lives next to the licence key:
    ~/Projects/ARZ-licence-keys/arz_backup_recovery_private.pem
Same rules as the licence key: never in git, never on a server or shop PC,
keep a copy on a pen drive.  Without it, a shop whose PC died cannot be
restored by ARZ.

COMMANDS  (from the curavo folder)
  First time only - make the recovery key pair and print the public key to
  paste into RECOVERY_PUBLIC_KEYS in backend/app/services/backup_crypto.py:
      python3 tools/cloud/curavo_recovery.py init

  What is in a backup (no key needed):
      python3 tools/cloud/curavo_recovery.py info  SHOPCODE_2026-11-02.cbk

  Unlock one (downloaded from the control panel) into a folder:
      python3 tools/cloud/curavo_recovery.py open  SHOPCODE_2026-11-02.cbk  --out ~/Desktop/restore
  The folder then holds pharmacy.db and branding/.  Put them on the shop's
  new PC by the restore steps in CLAUDE.md section 11 (app closed; delete
  pharmacy.db-wal and -shm; then copy pharmacy.db in).
"""
import argparse
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from app.services import backup_crypto  # noqa: E402

DEFAULT_KEYDIR = Path.home() / "Projects" / "ARZ-licence-keys"
PRIVATE_NAME = "arz_backup_recovery_private.pem"


def public_b64(private: X25519PrivateKey) -> str:
    import base64
    return base64.b64encode(private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode("ascii")


def load_private(keydir: Path) -> X25519PrivateKey:
    path = keydir / PRIVATE_NAME
    if not path.exists():
        sys.exit(f"No recovery key at {path}. Run 'init' first (or pass --keydir).")
    return serialization.load_pem_private_key(path.read_bytes(), password=None)


def cmd_init(args):
    keydir = Path(args.keydir).expanduser()
    path = keydir / PRIVATE_NAME
    if path.exists():
        sys.exit(f"A recovery key already exists at {path}. Refusing to overwrite it - "
                 "every backup already uploaded is locked to it.")
    keydir.mkdir(parents=True, exist_ok=True)
    private = X25519PrivateKey.generate()
    path.write_bytes(private.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()))
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    print(f"Recovery key written to {path}")
    print("KEEP IT SECRET. Copy it to a pen drive. Never put it in git or on a server.")
    print()
    print("Public key - paste into RECOVERY_PUBLIC_KEYS in backend/app/services/backup_crypto.py:")
    print(public_b64(private))


def cmd_info(args):
    header = backup_crypto.read_header(Path(args.file).read_bytes())
    header["wraps"] = [w["kind"] for w in header.get("wraps", [])]
    print(json.dumps(header, indent=2, ensure_ascii=False))


def cmd_open(args):
    blob = Path(args.file).read_bytes()
    try:
        payload = backup_crypto.decrypt_backup(blob, recovery_private=load_private(Path(args.keydir).expanduser()))
    except backup_crypto.BackupCryptoError as e:
        sys.exit(str(e))
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    for name, data in backup_crypto.unpack_files(payload).items():
        dest = out / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        print(f"  {dest}  ({len(data):,} bytes)")
    print("Unlocked.")


def main():
    ap = argparse.ArgumentParser(description="ARZ Solutions - Curavo cloud backup recovery")
    ap.add_argument("--keydir", default=str(DEFAULT_KEYDIR))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init", help="create the recovery key pair (once)")
    p = sub.add_parser("info", help="show a backup's header")
    p.add_argument("file")
    p = sub.add_parser("open", help="unlock a backup into a folder")
    p.add_argument("file")
    p.add_argument("--out", required=True)
    args = ap.parse_args()
    {"init": cmd_init, "info": cmd_info, "open": cmd_open}[args.cmd](args)


if __name__ == "__main__":
    main()
