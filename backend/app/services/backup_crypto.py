"""
Locking (encrypting) a cloud backup before it leaves the shop PC.

WHY: a cloud backup holds every patient's name, phone and purchase history.
It is locked HERE, on the shop's own PC, so the Curavo cloud server only ever
stores scrambled bytes.  Someone who breaks into the server - or the hosting
company - learns nothing.

WHO CAN UNLOCK IT (decided Nov 2026: "ARZ can also unlock them"):
  * ARZ, with the RECOVERY key.  Its secret half lives only on Zahid's Mac
    (~/Projects/ARZ-licence-keys/arz_backup_recovery_private.pem, made by
    tools/cloud/curavo_recovery.py init).  The app ships only the PUBLIC half,
    which can lock but never unlock.  Used when a shop's PC has died.
  * The shop itself, with its own random SHOP KEY kept in its database
    (cloud_state.backup_key).  Lets the same shop re-open its own backups
    without ARZ - useful later for self-service restore.

HOW (the standard "envelope" pattern, the same idea banks and cloud vaults use):
  1. Make a fresh random 32-byte DATA KEY for this one backup.
  2. Lock the backup with it: AES-256-GCM.  GCM also detects tampering - a
     single changed byte makes unlocking fail rather than return garbage.
  3. Lock the DATA KEY twice ("wrap" it), once per person allowed in:
       - for ARZ: X25519 key agreement with ARZ's public key -> HKDF -> AES-GCM
       - for the shop: AES-GCM with the shop key
  4. Write: a short header (who, when, the two wrapped keys) + the locked data.
     The header is also fed into step 2 as "associated data", so nobody can
     swap the header of one backup onto another.

FILE FORMAT (.cbk)
    b"CURAVOBK1\n"                       10 bytes, magic + version
    header length                        4 bytes, big-endian
    header                               JSON, UTF-8
    nonce                                12 bytes
    ciphertext                           AES-GCM(data key, nonce, payload, aad=header)

The payload is a .tar.gz of pharmacy.db plus the branding/ folder (the shop's
logo and signature are part of what has to come back after a disaster).

This file has no FastAPI or database imports on purpose: the ARZ recovery tool
on the Mac imports it directly, so both sides read the format from ONE place.
"""
import base64
import io
import json
import os
import struct
import tarfile

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MAGIC = b"CURAVOBK1\n"
_WRAP_INFO = b"curavo-backup-wrap-v1"

# ARZ's backup-recovery PUBLIC key (raw X25519, base64).  Not a secret: it can
# only LOCK.  A list so the key can be rotated later without losing old backups
# (lock to every key listed; any one of the private halves unlocks).
RECOVERY_PUBLIC_KEYS = [
    "2G/2J7/gFcpTxnBR4GvYpS+jpPzkRh2uigiGHaD5BFw=",   # ARZ recovery key 1, made 2 Nov 2026
]


class BackupCryptoError(ValueError):
    """A backup could not be unlocked (wrong key, damaged or tampered file)."""


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _unb64(s: str) -> bytes:
    return base64.b64decode(s)


def new_shop_key() -> str:
    """A fresh random shop key, base64 - stored in cloud_state.backup_key."""
    return _b64(os.urandom(32))


# ---------------------------------------------------------------------------
# Packing the files
# ---------------------------------------------------------------------------

def pack_files(files: dict) -> bytes:
    """{name inside the archive: bytes} -> .tar.gz bytes."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, data in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mtime = 0
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def unpack_files(blob: bytes) -> dict:
    """.tar.gz bytes -> {name: bytes}.  Regular files only; no paths outside."""
    out = {}
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        for m in tar.getmembers():
            if not m.isfile() or m.name.startswith("/") or ".." in m.name.split("/"):
                continue
            out[m.name] = tar.extractfile(m).read()
    return out


# ---------------------------------------------------------------------------
# Wrapping the data key
# ---------------------------------------------------------------------------

def _arz_kek(shared: bytes, epk: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                info=_WRAP_INFO + epk).derive(shared)


def _wrap_for_arz(data_key: bytes, recovery_pub_b64: str) -> dict:
    pub = X25519PublicKey.from_public_bytes(_unb64(recovery_pub_b64))
    eph = X25519PrivateKey.generate()
    epk = eph.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    kek = _arz_kek(eph.exchange(pub), epk)
    nonce = os.urandom(12)
    return {"kind": "arz", "key_id": recovery_pub_b64[:8], "epk": _b64(epk),
            "nonce": _b64(nonce), "ct": _b64(AESGCM(kek).encrypt(nonce, data_key, b"arz"))}


def _wrap_for_shop(data_key: bytes, shop_key_b64: str) -> dict:
    nonce = os.urandom(12)
    return {"kind": "shop", "nonce": _b64(nonce),
            "ct": _b64(AESGCM(_unb64(shop_key_b64)).encrypt(nonce, data_key, b"shop"))}


# ---------------------------------------------------------------------------
# Lock / unlock
# ---------------------------------------------------------------------------

def encrypt_backup(payload: bytes, meta: dict, shop_key_b64: str,
                   recovery_keys=None) -> bytes:
    """
    Lock `payload` (the .tar.gz).  `meta` goes into the readable header (shop
    code, time, app version) - never put patient data in it.
    """
    recovery_keys = RECOVERY_PUBLIC_KEYS if recovery_keys is None else recovery_keys
    data_key = AESGCM.generate_key(bit_length=256)
    wraps = [_wrap_for_arz(data_key, k) for k in recovery_keys]
    wraps.append(_wrap_for_shop(data_key, shop_key_b64))
    header = json.dumps({"v": 1, **meta, "cipher": "AES-256-GCM", "wraps": wraps},
                        separators=(",", ":")).encode("utf-8")
    nonce = os.urandom(12)
    ct = AESGCM(data_key).encrypt(nonce, payload, header)
    return MAGIC + struct.pack(">I", len(header)) + header + nonce + ct


def read_header(blob: bytes) -> dict:
    """The readable part of a .cbk (no key needed)."""
    if not blob.startswith(MAGIC):
        raise BackupCryptoError("Not a Curavo cloud backup.")
    (n,) = struct.unpack(">I", blob[len(MAGIC):len(MAGIC) + 4])
    return json.loads(blob[len(MAGIC) + 4:len(MAGIC) + 4 + n])


def _split(blob: bytes):
    if not blob.startswith(MAGIC):
        raise BackupCryptoError("Not a Curavo cloud backup.")
    start = len(MAGIC) + 4
    (n,) = struct.unpack(">I", blob[len(MAGIC):start])
    header_bytes = blob[start:start + n]
    rest = blob[start + n:]
    return header_bytes, json.loads(header_bytes), rest[:12], rest[12:]


def decrypt_backup(blob: bytes, *, recovery_private=None, shop_key_b64=None) -> bytes:
    """
    Unlock a .cbk with EITHER ARZ's recovery private key (an X25519PrivateKey)
    OR the shop key.  Returns the .tar.gz payload.
    """
    header_bytes, header, nonce, ct = _split(blob)
    data_key = None
    for w in header.get("wraps", []):
        try:
            if w["kind"] == "arz" and recovery_private is not None:
                epk = _unb64(w["epk"])
                kek = _arz_kek(recovery_private.exchange(X25519PublicKey.from_public_bytes(epk)), epk)
                data_key = AESGCM(kek).decrypt(_unb64(w["nonce"]), _unb64(w["ct"]), b"arz")
            elif w["kind"] == "shop" and shop_key_b64:
                data_key = AESGCM(_unb64(shop_key_b64)).decrypt(_unb64(w["nonce"]), _unb64(w["ct"]), b"shop")
        except Exception:
            continue
        if data_key:
            break
    if not data_key:
        raise BackupCryptoError("This key cannot unlock this backup.")
    try:
        return AESGCM(data_key).decrypt(nonce, ct, header_bytes)
    except Exception:
        raise BackupCryptoError("The backup file is damaged or has been changed.")
