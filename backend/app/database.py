"""
Database connection — SQLite (desktop / offline mode).

Why SQLite instead of PostgreSQL for the desktop build:
  - No server process to install or manage.
  - The entire database is one file (pharmacy.db) in the app-data folder.
  - Perfectly fast for a single-PC pharmacy workload.
  - WAL mode allows concurrent reads while a write is in progress.

Key objects exported:
  engine       — the SQLAlchemy connection pool
  SessionLocal — factory for per-request sessions
  Base         — base class all ORM models inherit from
  get_db()     — FastAPI dependency that hands each request its own session
  init_db()    — called at startup to create tables that don't exist yet
  get_next_doc_number() — atomic counter used for invoice / PO / GRN numbers
"""
import os
import platform
import sqlite3
from pathlib import Path

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker, declarative_base


# ---------------------------------------------------------------------------
# App-data directory (OS-specific)
# ---------------------------------------------------------------------------

def get_app_data_dir() -> Path:
    """
    Return the correct folder for storing the database file, logs and images.
    Creates the folder if it does not exist yet.

    Desktop mode (frozen .exe):
        main_desktop.py sets the HCC_DATA_DIR environment variable to the
        per-user app-data folder BEFORE importing this module.  When that var
        is present we use it verbatim — this is what makes the packaged app
        write its database into AppData instead of next to the executable.

    Web / dev mode (env var NOT set) — fall back to the OS convention:
        Windows : C:/Users/<user>/AppData/Roaming/HCC/
        macOS   : ~/Library/Application Support/HCC/
        Linux   : ~/.local/share/HCC/
    """
    # 1) Desktop app: honour the directory chosen by main_desktop.py.
    env_dir = os.environ.get("HCC_DATA_DIR")
    if env_dir:
        app_dir = Path(env_dir)
        app_dir.mkdir(parents=True, exist_ok=True)
        return app_dir

    # 2) Development fallback (OS-specific default location).
    if platform.system() == "Windows":
        # .get() (not [...]) avoids a KeyError on a Windows env missing APPDATA.
        base = Path(os.environ.get("APPDATA", Path.home()))
    elif platform.system() == "Darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path.home() / ".local" / "share"
    app_dir = base / "HCC"
    app_dir.mkdir(parents=True, exist_ok=True)
    return app_dir


APP_DIR = get_app_data_dir()

# Full path: e.g.  sqlite:////Users/alice/Library/Application Support/HCC/pharmacy.db
DATABASE_URL = f"sqlite:///{APP_DIR / 'pharmacy.db'}"


def get_prescriptions_dir() -> Path:
    """
    Return (and create if missing) the folder where prescription image files
    are stored on disk.  Only the file PATH is stored in the DB — the actual
    image bytes live here so the SQLite database stays small.

    Windows : C:/Users/<user>/AppData/Roaming/HCC/prescriptions/
    macOS   : ~/Library/Application Support/HCC/prescriptions/
    """
    d = get_app_data_dir() / "prescriptions"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_branding_dir() -> Path:
    """
    Return (and create if missing) the folder holding the SHOP's own images:
    logo.<ext> and signature.<ext>, printed on receipts and tax invoices.

    They used to be HCC_LOGO.png / HCC_SIGNATURE.png inside the app itself,
    which put one shop's signature into every installer.  Now each shop
    uploads its own from Pharmacy Settings.

    Windows : C:/Users/<user>/AppData/Roaming/HCC/branding/
    macOS   : ~/Library/Application Support/HCC/branding/
    """
    d = get_app_data_dir() / "branding"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_avatars_dir() -> Path:
    """
    Return (and create if missing) the folder where user profile photos are
    stored on disk.  Same pattern as prescriptions: only the filename is kept
    in the users.avatar_path column; the image bytes live here.

    Windows : C:/Users/<user>/AppData/Roaming/HCC/avatars/
    macOS   : ~/Library/Application Support/HCC/avatars/
    """
    d = get_app_data_dir() / "avatars"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

engine = create_engine(
    DATABASE_URL,
    # SQLite requires this when the same connection is used from multiple
    # threads (FastAPI handles requests in a thread pool).
    connect_args={"check_same_thread": False},
)


@event.listens_for(engine, "connect")
def set_sqlite_pragmas(dbapi_conn, _):
    """
    Three PRAGMAs applied once per physical connection:

    journal_mode=WAL
        Write-Ahead Logging lets readers proceed while a write is in
        progress.  Default journal mode blocks readers during writes.

    foreign_keys=ON
        SQLite ignores foreign-key constraints unless you turn this on.
        We want FK violations to raise an error, not silently succeed.

    synchronous=NORMAL
        Writes are journalled after each transaction (not each statement).
        Faster than FULL while still being crash-safe on power loss.
    """
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()


# ---------------------------------------------------------------------------
# Session factory + ORM base
# ---------------------------------------------------------------------------

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# All ORM model classes inherit from this Base so SQLAlchemy knows which
# Python class maps to which database table.
Base = declarative_base()


def get_db():
    """
    FastAPI dependency — hands each incoming request its own DB session.
    The session is always closed in the `finally` block, even if the
    request raises an exception.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Table initialisation
# ---------------------------------------------------------------------------

def init_db():
    """
    Create every table that does not yet exist in the database file.

    This is called once at server startup (in main.py's lifespan).
    It is a no-op for tables that already exist, so it is safe to call
    on every restart without wiping data.

    We import all model modules here so their table definitions are
    registered into Base.metadata before create_all() runs.
    """
    # These imports have side-effects: they register each model's table
    # with Base.metadata.  All must be imported before create_all().
    import app.models.user              # noqa: F401
    import app.models.inventory         # noqa: F401
    import app.models.patients          # noqa: F401
    import app.models.billing           # noqa: F401
    import app.models.purchasing        # noqa: F401
    import app.models.followup          # noqa: F401
    import app.models.marketing         # noqa: F401
    import app.models.opd               # noqa: F401
    import app.models.drug_interactions # noqa: F401
    import app.models.prescription      # noqa: F401
    import app.models.credit             # noqa: F401
    import app.models.expenditure        # noqa: F401
    import app.models.supplier_credit    # noqa: F401
    # Shop-wide identity (Fix 7).  It is a brand-new TABLE, not a column, so it
    # is created here by create_all() rather than by an ALTER in main.py.
    import app.models.settings           # noqa: F401
    # The Schedule H1 / MTP register.  Also a brand-new TABLE, so it arrives
    # the same way; the products.register_category COLUMN that decides what
    # goes into it is an ALTER in main.py, as columns always are.
    import app.models.regulated          # noqa: F401
    # Curavo subscription state (trial start, shop code, licence key).  A new
    # TABLE, so it also arrives through create_all().
    import app.models.licence            # noqa: F401

    Base.metadata.create_all(bind=engine)


# ---------------------------------------------------------------------------
# Atomic document-number counter (replaces PostgreSQL SELECT FOR UPDATE)
# ---------------------------------------------------------------------------

def get_next_doc_number(doc_type: str, year: int) -> int:
    """
    Atomically increment and return the next sequence number for the given
    document type and year.

    Why a separate table instead of scanning the highest existing row?
        Scanning invoices/purchase_orders for the maximum number and then
        inserting a new row with +1 is not atomic — two concurrent threads
        can read the same maximum before either one writes, producing a
        duplicate number.

    Why BEGIN IMMEDIATE?
        SQLite normally uses deferred transactions: the write lock is only
        acquired at the first DML statement.  Two threads could both pass the
        SELECT before either acquires the write lock.  BEGIN IMMEDIATE grabs
        the write lock at transaction start, so the second caller blocks
        until the first one commits — making the read-increment-write atomic.

    Why a direct stdlib sqlite3 connection instead of the SQLAlchemy engine?
        SQLAlchemy's SQLite dialect does not expose BEGIN IMMEDIATE through
        execution_options (valid levels are READ UNCOMMITTED, SERIALIZABLE,
        AUTOCOMMIT).  Opening a fresh stdlib sqlite3 connection with
        isolation_level=None (manual-transaction / autocommit mode) lets us
        issue BEGIN IMMEDIATE explicitly without fighting the ORM layer.
        This connection is completely independent of the caller's session,
        so it can commit its own micro-transaction before the outer request
        transaction finishes.

    Args:
        doc_type: 'INVOICE', 'PO', or 'GRN'
        year:     4-digit year (e.g. 2026)

    Returns:
        The new sequence integer (e.g. 42).  The caller formats it as needed.
    """
    db_path = str(APP_DIR / "pharmacy.db")

    # isolation_level=None → autocommit / manual-transaction mode.
    # In this mode sqlite3 never issues an implicit BEGIN, which lets us
    # issue BEGIN IMMEDIATE ourselves before the first SELECT.
    conn = sqlite3.connect(db_path, isolation_level=None)
    try:
        cur = conn.cursor()
        cur.execute("BEGIN IMMEDIATE")
        try:
            cur.execute(
                "SELECT last_number FROM doc_counters "
                "WHERE doc_type = ? AND year = ?",
                (doc_type, year),
            )
            row = cur.fetchone()

            if row is None:
                seq = 1
                cur.execute(
                    "INSERT INTO doc_counters (doc_type, year, last_number) "
                    "VALUES (?, ?, 1)",
                    (doc_type, year),
                )
            else:
                seq = row[0] + 1
                cur.execute(
                    "UPDATE doc_counters SET last_number = ? "
                    "WHERE doc_type = ? AND year = ?",
                    (seq, doc_type, year),
                )

            cur.execute("COMMIT")
        except Exception:
            cur.execute("ROLLBACK")
            raise
        finally:
            cur.close()

        return seq
    finally:
        conn.close()
