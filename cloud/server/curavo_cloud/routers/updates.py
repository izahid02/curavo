"""
App updates: which version each shop should run, and the installers.

  GET  /updates/{target}/{arch}/{current_version}   asked by the shop's Curavo
       (Tauri updater).  204 = you are up to date.  200 = JSON describing the
       newer installer: version, notes, pub_date, url, signature (+ critical).
  GET  /updates/files/{filename}                   the installer itself
  GET  /download/windows                           newest release for EVERYONE
                                                   (the website's Download button)

  Panel (ARZ login, or the GitHub build's X-Release-Token):
  GET   /admin/api/releases                        all releases + shops on each
  POST  /admin/api/releases                        upload installer + .sig
  PATCH /admin/api/releases/{id}                   PILOT / ALL / PAUSED, notes

WHO GETS WHAT
  A new release starts as PILOT: only shops marked pilot are offered it.  ARZ
  moves it to ALL once the pilot shops are happy, or PAUSED to hold it back.
  A shop is offered the NEWEST release it is allowed, and only if newer than
  what it runs - Curavo never offers a downgrade.

WHY THE INSTALLER IS SAFE TO SERVE WITHOUT LOGIN
  It is the same file the website offers as a free trial, and the shop PC
  refuses it unless ARZ's UPDATE signature (made on the GitHub build, checked
  against the key built into the app) matches.  The server cannot forge that.
"""
import hashlib
import re
import secrets
from datetime import datetime, timezone

from fastapi import (APIRouter, Depends, File, Form, Header, HTTPException, Request,
                     Response, UploadFile)
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from curavo_cloud.config import settings
from curavo_cloud.db import get_db
from curavo_cloud.models import AdminAudit, AdminUser, Release, Shop
from curavo_cloud.security import current_admin

router = APIRouter(tags=["Updates"])

STATUSES = ("PILOT", "ALL", "PAUSED")
_FILE_RE = re.compile(r"^Curavo_[0-9A-Za-z.\-]+_x64-setup\.exe$")
_VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?$")


def version_key(v: str):
    """
    '0.3.0' > '0.3.0-beta.2' > '0.2.9'.  A plain release outranks any
    pre-release of the same number (semver).  Unparseable -> lowest.
    """
    m = _VERSION_RE.match((v or "").strip().lstrip("v"))
    if not m:
        return (-1, -1, -1, 0, "")
    major, minor, patch, pre = m.groups()
    return (int(major), int(minor), int(patch), 0 if pre else 1, pre or "")


def _base_url(request: Request) -> str:
    return settings.public_url or str(request.base_url).rstrip("/")


def _offer_for(db: Session, shop) -> Release | None:
    allowed = ("ALL", "PILOT") if (shop is not None and shop.pilot) else ("ALL",)
    rows = db.query(Release).filter(Release.status.in_(allowed)).all()
    return max(rows, key=lambda r: version_key(r.version), default=None)


@router.get("/updates/{target}/{arch}/{current_version}")
def check_update(target: str, arch: str, current_version: str, request: Request,
                 x_shop_code: str = Header(default=""), db: Session = Depends(get_db)):
    if target != "windows" or arch != "x86_64":
        return Response(status_code=204)
    shop = None
    if x_shop_code:
        shop = db.query(Shop).filter(Shop.shop_code == x_shop_code.upper().replace("-", "")).first()
        if shop is not None and shop.disabled:
            return Response(status_code=204)
    rel = _offer_for(db, shop)
    if rel is None or version_key(rel.version) <= version_key(current_version):
        return Response(status_code=204)
    pub = (rel.status_changed_at or rel.created_at).replace(tzinfo=timezone.utc)
    return {
        "version": rel.version,
        "notes": rel.notes or "",
        "pub_date": pub.isoformat().replace("+00:00", "Z"),
        "url": f"{_base_url(request)}/updates/files/{rel.filename}",
        "signature": rel.signature,
        "critical": rel.critical,
    }


def _release_path(filename: str):
    if not _FILE_RE.match(filename):
        raise HTTPException(status_code=404)
    path = (settings.release_dir / filename).resolve()
    if path.parent != settings.release_dir.resolve() or not path.exists():
        raise HTTPException(status_code=404)
    return path


@router.get("/updates/files/{filename}")
def get_installer(filename: str):
    return FileResponse(_release_path(filename), media_type="application/octet-stream", filename=filename)


@router.get("/download/windows")
def download_latest(t: str = "", db: Session = Depends(get_db)):
    """The website's Download button.  Needs the 15-minute link My account
    hands an ACTIVE account (curavo_cloud/routers/accounts.py: /account/v1/download)."""
    from curavo_cloud.routers.accounts import download_token_ok
    if not download_token_ok(t):
        raise HTTPException(status_code=403, detail="Download Curavo from your account at curavo.in.")
    rel = _offer_for(db, None)
    if rel is None:
        raise HTTPException(status_code=404, detail="No release available yet.")
    return RedirectResponse(f"/updates/files/{rel.filename}", status_code=302)


# ---------------------------------------------------------------------------
# Panel
# ---------------------------------------------------------------------------

def _uploader(request: Request, x_release_token: str = Header(default=""),
              db: Session = Depends(get_db)) -> str:
    """ARZ in the panel, or the GitHub build holding CURAVO_RELEASE_TOKEN."""
    if settings.release_token and x_release_token and secrets.compare_digest(x_release_token, settings.release_token):
        return "github-build"
    admin = current_admin(request.headers.get("authorization", ""), db)
    return admin.username


def _row(r: Release, on_it: int) -> dict:
    return {"id": r.id, "version": r.version, "notes": r.notes or "", "critical": r.critical,
            "status": r.status, "filename": r.filename, "size": r.size, "sha256": r.sha256,
            "created_at": r.created_at.isoformat() + "Z" if r.created_at else None,
            "status_changed_at": r.status_changed_at.isoformat() + "Z" if r.status_changed_at else None,
            "shops_on_it": on_it}


@router.get("/admin/api/releases")
def list_releases(admin: AdminUser = Depends(current_admin), db: Session = Depends(get_db)):
    counts = {}
    for (v,) in db.query(Shop.app_version).all():
        counts[v] = counts.get(v, 0) + 1
    rows = sorted(db.query(Release).all(), key=lambda r: version_key(r.version), reverse=True)
    return {
        "releases": [_row(r, counts.get(r.version, 0)) for r in rows],
        "versions_in_use": sorted(([v or "unknown", n] for v, n in counts.items()),
                                  key=lambda x: version_key(x[0]), reverse=True),
        "pilot_shops": db.query(Shop).filter(Shop.pilot.is_(True)).count(),
    }


@router.post("/admin/api/releases", status_code=201)
async def upload_release(
    installer: UploadFile = File(...),
    signature: str = Form(...),
    notes: str = Form(default=""),
    critical: bool = Form(default=False),
    who: str = Depends(_uploader),
    db: Session = Depends(get_db),
):
    name = installer.filename or ""
    if not _FILE_RE.match(name):
        raise HTTPException(status_code=400, detail="Expected the installer the build makes, e.g. Curavo_0.3.0_x64-setup.exe")
    version = name[len("Curavo_"):-len("_x64-setup.exe")]
    if version_key(version)[0] < 0:
        raise HTTPException(status_code=400, detail=f"'{version}' is not a version number.")
    if db.query(Release).filter(Release.version == version).first():
        raise HTTPException(status_code=409, detail=f"Version {version} is already uploaded.")
    sig = signature.strip()
    if len(sig) < 40:
        raise HTTPException(status_code=400, detail="Paste the whole .sig file made by the build.")

    tmp = settings.release_dir / f".upload_{secrets.token_hex(6)}"
    h, size = hashlib.sha256(), 0
    with tmp.open("wb") as f:
        while chunk := await installer.read(1024 * 1024):
            size += len(chunk)
            h.update(chunk)
            f.write(chunk)
    if size < 1024 * 1024:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="That file is too small to be a Curavo installer.")
    tmp.rename(settings.release_dir / name)

    rel = Release(version=version, notes=notes.strip()[:5000], critical=critical, status="PILOT",
                  filename=name, signature=sig, size=size, sha256=h.hexdigest())
    db.add(rel)
    db.add(AdminAudit(admin=who, action="upload_release", detail=f"{version} ({size:,} bytes)"))
    db.commit()
    return _row(rel, 0)


class ReleasePatch(BaseModel):
    status: str | None = None
    notes: str | None = None
    critical: bool | None = None


@router.patch("/admin/api/releases/{release_id}")
def update_release(release_id: int, body: ReleasePatch, admin: AdminUser = Depends(current_admin),
                   db: Session = Depends(get_db)):
    rel = db.get(Release, release_id)
    if rel is None:
        raise HTTPException(status_code=404, detail="No such release.")
    if body.status is not None:
        if body.status not in STATUSES:
            raise HTTPException(status_code=400, detail="Status must be PILOT, ALL or PAUSED.")
        if body.status != rel.status:
            rel.status = body.status
            rel.status_changed_at = datetime.utcnow()
            db.add(AdminAudit(admin=admin.username, action=f"release_{body.status.lower()}", detail=rel.version))
    if body.notes is not None:
        rel.notes = body.notes[:5000]
    if body.critical is not None:
        rel.critical = body.critical
    db.commit()
    return _row(rel, db.query(Shop).filter(Shop.app_version == rel.version).count())
