"""
Curavo cloud server - receives shop check-ins, locked backups and error reports,
and serves the ARZ control panel.

Run (dev):
    cd cloud/server
    CURAVO_ADMIN_PASSWORD='choose-a-long-one' uvicorn curavo_cloud.main:app --port 8100

The control panel's built screens (cloud/admin -> npm run build) are served at
/ when present; the API lives under /agent/v1 (shop PCs) and /admin/api (ARZ).
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from curavo_cloud.config import settings
from curavo_cloud.db import Base, SessionLocal, engine
from curavo_cloud.models import AdminUser
from curavo_cloud.routers import accounts, admin, agent, device_link, leads, owner, updates
from curavo_cloud.security import hash_password

PANEL_DIST = Path(__file__).resolve().parents[2] / "admin" / "dist"


def _seed_admin():
    db = SessionLocal()
    try:
        if db.query(AdminUser).count() == 0:
            if not settings.admin_password:
                logging.warning("No control-panel account yet. Set CURAVO_ADMIN_PASSWORD and restart.")
                return
            db.add(AdminUser(username=settings.admin_user, password_hash=hash_password(settings.admin_password)))
            db.commit()
            logging.info("Control-panel account '%s' created.", settings.admin_user)
    finally:
        db.close()


# Columns added after a table first existed.  create_all() makes new TABLES
# but never adds a column to an existing one, so each is added here once.
# (Same idea as the desktop app's migration ledger, kept tiny on purpose.)
_ADDED_COLUMNS = [
    ("shops", "pilot", "BOOLEAN NOT NULL DEFAULT 0"),
    ("shops", "account_id", "INTEGER"),          # the owner's Curavo account
    ("accounts", "requested_plan", "VARCHAR(20)"),
    ("accounts", "requested_at", "DATETIME"),
    ("accounts", "free_month_used", "BOOLEAN NOT NULL DEFAULT 0"),
    ("accounts", "on_free_month", "BOOLEAN NOT NULL DEFAULT 0"),
]


def _add_missing_columns():
    from sqlalchemy import inspect, text
    insp = inspect(engine)
    with engine.begin() as conn:
        for table, column, ddl in _ADDED_COLUMNS:
            if table in insp.get_table_names() and column not in {c["name"] for c in insp.get_columns(table)}:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
                logging.info("Added column %s.%s", table, column)


@asynccontextmanager
async def lifespan(_app):
    Base.metadata.create_all(bind=engine)
    _add_missing_columns()
    _seed_admin()
    yield


app = FastAPI(title="Curavo Cloud", lifespan=lifespan, docs_url=None, redoc_url=None)
app.include_router(agent.router)
app.include_router(admin.router)
app.include_router(updates.router)
app.include_router(leads.router)
app.include_router(owner.router)
app.include_router(accounts.router)
app.include_router(device_link.router)

# Only the Curavo website may send the demo form from a browser.  (Shop PCs and
# the panel are not affected: the PCs do not use a browser, and the panel is
# served from this same server.)
# The website also signs owners in and shows "My account", so it may send the
# Authorization header and use GET/PATCH too.
app.add_middleware(CORSMiddleware, allow_origins=settings.site_origins,
                   allow_methods=["GET", "POST", "PATCH", "DELETE"], allow_headers=["Content-Type", "Authorization"])


@app.get("/health")
def health():
    return {"ok": True}


# The control panel (a single-page app): assets as files, every other path -> index.html
if PANEL_DIST.exists():
    app.mount("/assets", StaticFiles(directory=PANEL_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def panel(path: str):
        if path.startswith(("admin/api", "agent/", "updates/", "download/", "public/", "mobile/", "account/")):
            from fastapi import HTTPException
            raise HTTPException(status_code=404)
        f = (PANEL_DIST / path).resolve()
        if path and f.is_file() and PANEL_DIST in f.parents:
            return FileResponse(f)
        return FileResponse(PANEL_DIST / "index.html")
