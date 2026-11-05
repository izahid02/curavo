"""
Opening stock from Excel (Medicines -> Import from Excel).  Owner/Admin only.

  GET  /api/stock-import/template   the .xlsx to fill in
  POST /api/stock-import/check      upload -> every row as ok / warning / error.  Saves nothing.
  POST /api/stock-import/import     upload the SAME file -> backup first, then
                                    save the rows that passed, in one go

The rules live in services/stock_import.py.  The file is sent twice on purpose
(check, then import) so nothing is kept between the two steps: what is saved
is always exactly what the owner just looked at, re-checked.
"""
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.routers.backup import _backup_dir, _snapshot_to
from app.services import stock_import
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/stock-import", tags=["Opening stock import"])
log = logging.getLogger(__name__)

MAX_BYTES = 10 * 1024 * 1024
_ROLES = {"Owner", "Administrator"}


def _owner(user: User):
    if user.role.name not in _ROLES:
        raise HTTPException(status_code=403, detail="Only the owner or an administrator can import stock.")


@router.get("/template")
def template(user: User = Depends(get_current_user)):
    _owner(user)
    return Response(stock_import.template_bytes(),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": 'attachment; filename="Curavo-opening-stock.xlsx"'})


async def _read(file: UploadFile) -> bytes:
    content = await file.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="The file is larger than 10 MB. Split it into parts.")
    if not content:
        raise HTTPException(status_code=400, detail="The file is empty.")
    return content


def _checked(db, content):
    try:
        return stock_import.check_rows(db, content)
    except stock_import.ImportFileError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _public(rows):
    return [{k: r[k] for k in ("row", "name", "status", "messages", "summary")} for r in rows]


@router.post("/check")
async def check(file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _owner(user)
    rows = _checked(db, await _read(file))
    return {"rows": _public(rows),
            "counts": {s: sum(1 for r in rows if r["status"] == s) for s in ("ok", "warning", "error")}}


@router.post("/import")
async def do_import(file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _owner(user)
    rows = _checked(db, await _read(file))
    if not any(r["status"] != "error" for r in rows):
        raise HTTPException(status_code=400, detail="No row can be imported. Fix the problems and try again.")
    # A backup first, kept like a manual one (never pruned): an import touches a lot of stock at once.
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = _backup_dir() / f"manual_{stamp}.db"
    n = 2
    while dest.exists():
        dest = _backup_dir() / f"manual_{stamp}_{n}.db"
        n += 1
    try:
        _snapshot_to(dest)
    except Exception:
        log.exception("Backup before import failed")
        raise HTTPException(status_code=500, detail="Could not take a backup first, so nothing was imported.")
    result = stock_import.import_rows(db, rows, user.id)
    log.info("Opening stock import: %s", result)
    return {**result, "backup": dest.name}
