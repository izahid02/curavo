"""
Where locked backup files live: <data>/backups/<SHOPCODE>/<YYYYMMDD_HHMMSS>_<id>.cbk

Kept behind three small functions so moving to object storage later (S3-style,
when one disk is no longer enough) touches only this file.
"""
import hashlib
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy.orm import Session

from curavo_cloud.config import settings
from curavo_cloud.models import Backup, Shop

MAGIC = b"CURAVOBK1\n"     # must match backend/app/services/backup_crypto.py
# Even when everything is older than the retention window, keep this many -
# a shop that has been offline for six weeks must still have SOMETHING to restore.
KEEP_AT_LEAST = 7


def shop_dir(shop: Shop) -> Path:
    d = settings.backup_dir / shop.shop_code
    d.mkdir(parents=True, exist_ok=True)
    return d


def path_for(shop: Shop, backup: Backup) -> Path:
    return shop_dir(shop) / backup.filename


async def save_stream(shop: Shop, stream, tmp_name: str):
    """
    Write an upload to disk as it arrives (never the whole file in memory),
    enforcing the size limit.  Returns (path, size, sha256, first_bytes).
    """
    tmp = shop_dir(shop) / tmp_name
    h = hashlib.sha256()
    size = 0
    head = b""
    with tmp.open("wb") as f:
        async for chunk in stream:
            size += len(chunk)
            if size > settings.max_backup_bytes:
                f.close()
                tmp.unlink(missing_ok=True)
                raise ValueError("too_large")
            if len(head) < len(MAGIC):
                head += chunk[: len(MAGIC) - len(head)]
            h.update(chunk)
            f.write(chunk)
    return tmp, size, h.hexdigest(), head


def prune(db: Session, shop: Shop) -> int:
    """Delete this shop's backups older than the retention window (keeping KEEP_AT_LEAST)."""
    cutoff = datetime.utcnow() - timedelta(days=settings.backup_days)
    rows = (db.query(Backup).filter(Backup.shop_id == shop.id)
            .order_by(Backup.uploaded_at.desc()).all())
    removed = 0
    for b in rows[KEEP_AT_LEAST:]:
        if b.uploaded_at < cutoff:
            path_for(shop, b).unlink(missing_ok=True)
            db.delete(b)
            removed += 1
    return removed
