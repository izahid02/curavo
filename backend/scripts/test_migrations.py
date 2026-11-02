"""
Migration simulation — proves an update to a customer's PC is safe.

Run it with:
    cd backend && source venv/bin/activate
    python scripts/test_migrations.py

WHAT IT SIMULATES
-----------------
The situation we actually care about is not a fresh install (that always
works) — it is the pharmacy that has been running the app for months and then
installs an update.  Their database already has data AND already has most
columns, but has never seen the db_migrations ledger.

So this script takes a COPY of the real pharmacy.db and runs startup against
the copy, three times, checking something different each time:

    RUN 1  upgrade         — existing DB, empty ledger.  Every column is
                             already present, so all migrations should be
                             ADOPTED into the ledger, none re-run, none failed.
    RUN 2  restart         — the ordinary case, every day after.  Everything
                             should be SKIPPED from the ledger, and not one
                             ALTER statement should be issued.
    RUN 3  real migration  — a column is physically dropped and its ledger row
                             removed, simulating a genuinely new column
                             arriving in an update.  It must be APPLIED and
                             then recorded.

After every run it re-counts the rows in the main tables and fails loudly if
a single one moved.

⚠ THE REAL DATABASE IS NEVER TOUCHED.  Everything happens inside a temporary
folder, which is pointed at by HCC_DATA_DIR *before* app.database is imported
(that env var is how database.py chooses its folder — see get_app_data_dir).
"""
import logging
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

# --------------------------------------------------------------------------
# Point the app at a throwaway copy BEFORE importing anything from app.*
# --------------------------------------------------------------------------
# database.py resolves its folder at import time, so this has to happen first.
# Getting the order wrong here would run the test against the live database.

REPO_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_BACKEND))


def _real_db_path() -> Path:
    """Where the live database sits on this machine (mac/Windows/Linux)."""
    import platform

    if platform.system() == "Windows":
        base = Path(os.environ.get("APPDATA", Path.home()))
    elif platform.system() == "Darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path.home() / ".local" / "share"
    return base / "HCC" / "pharmacy.db"


SANDBOX = Path(tempfile.mkdtemp(prefix="hcc_migration_test_"))
os.environ["HCC_DATA_DIR"] = str(SANDBOX)

source_db = _real_db_path()
target_db = SANDBOX / "pharmacy.db"

# The tables whose row counts must not move.  These are the ones holding the
# pharmacy's actual money and medicine records.
WATCHED_TABLES = [
    "invoices", "invoice_items", "products", "batches", "patients",
    "users", "suppliers", "stock_purchases", "stock_movements",
]


def _build_stand_in_db(db_path: Path) -> None:
    """
    Create a stand-in "customer" database at db_path: all tables, one dummy
    row per watched table, and no db_migrations ledger.

    Rows are written with plain sqlite3, filling only the NOT NULL columns
    with a placeholder of the right type.  The values are meaningless on
    purpose — this test only ever COUNTS rows, so all that matters is that
    something is there to lose.  A plain sqlite3 connection does not switch
    on foreign-key checking, so a dummy row need not point at a real parent.
    """
    # Safe to import here: HCC_DATA_DIR already points at the sandbox, so
    # init_db() creates its tables in the sandbox file, never the real one.
    from app.database import init_db as _create_tables
    _create_tables()

    def placeholder(col_type: str):
        t = (col_type or "").upper()
        if "DATETIME" in t or "TIMESTAMP" in t:
            return "2026-01-01 00:00:00"
        if "DATE" in t:
            return "2026-01-01"
        if "BOOL" in t:
            return 0
        if any(k in t for k in ("INT", "NUMERIC", "DECIMAL", "REAL", "FLOAT")):
            return 1
        return "standin"

    conn = sqlite3.connect(str(db_path))
    try:
        for table in WATCHED_TABLES:
            cols = conn.execute(f"PRAGMA table_info({table})").fetchall()
            # PRAGMA table_info row: (cid, name, type, notnull, default, pk)
            # Skip the integer primary key (SQLite numbers it) and anything
            # with a default; fill every other NOT NULL column.
            needed = [(c[1], c[2]) for c in cols
                      if c[3] and c[4] is None and not c[5]]
            names = ", ".join(n for n, _ in needed)
            marks = ", ".join("?" for _ in needed)
            values = [placeholder(t) for _, t in needed]
            try:
                if needed:
                    conn.execute(f"INSERT INTO {table} ({names}) VALUES ({marks})", values)
                else:
                    conn.execute(f"INSERT INTO {table} DEFAULT VALUES")
            except sqlite3.Error as exc:
                # Not fatal: that table just starts at 0 rows and is still
                # compared before and after.  Say so rather than hide it.
                print(f"   NOTE  could not add a stand-in row to {table}: {exc}")
        # Imitate a shop on an older build: the ledger did not exist yet.
        conn.execute("DROP TABLE IF EXISTS db_migrations")
        conn.commit()
    finally:
        conn.close()


if source_db.exists():
    # sqlite3's backup API, not copy2 — the live DB is in WAL mode, so a plain
    # file copy can miss everything committed since the last checkpoint and we
    # would be testing against a stale database.
    src = sqlite3.connect(str(source_db))
    dst = sqlite3.connect(str(target_db))
    src.backup(dst)
    dst.close()
    src.close()
    print(f"Copied live database → sandbox  ({target_db.stat().st_size / 1024:.0f} KB)")

    # Wind the copy back to a PRE-LEDGER state.  The dev machine's database has
    # already run this build (uvicorn --reload does it on every save), so the
    # copy arrives with a full db_migrations table — which would make RUN 1
    # test the boring "already recorded" path instead of the one that actually
    # matters: a customer whose database has data and columns but has never
    # seen a ledger.  Dropping the table reproduces their exact situation.
    conn = sqlite3.connect(str(target_db))
    conn.execute("DROP TABLE IF EXISTS db_migrations")
    conn.commit()
    conn.close()
    print("Dropped db_migrations from the copy → simulates a pre-update customer DB")
else:
    # No pharmacy database on this machine (a fresh checkout, a CI runner, a
    # copy of the code with no patient data).  Testing against an EMPTY file
    # proves nothing: there are no tables before the first startup and no rows
    # after it, so "did the data survive?" has nothing to look at — and the
    # check used to FAIL on that, comparing "table missing" with "0 rows".
    #
    # So build a small stand-in for a customer's database instead: every
    # table, ONE row in each table we watch, and NO ledger — the same shape as
    # a shop that has been trading on an older build.  The four startups below
    # then test exactly what they test against a real copy.
    print("No live database found - building a stand-in customer database.")
    _build_stand_in_db(target_db)

print(f"Sandbox: {SANDBOX}\n")

# Now it is safe to import the app.
from app.database import SessionLocal, init_db          # noqa: E402
from app.main import _backup_on_startup, _run_db_migrations  # noqa: E402
from sqlalchemy import text                              # noqa: E402


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

FAILURES = []


def check(label: str, condition: bool, detail: str = "") -> None:
    """Assert-and-continue, so one failure does not hide the rest."""
    if condition:
        print(f"   PASS  {label}")
    else:
        print(f"   FAIL  {label}  {detail}")
        FAILURES.append(label)


def row_counts() -> dict:
    """Row count per watched table; missing tables are recorded as None."""
    db = SessionLocal()
    out = {}
    try:
        for t in WATCHED_TABLES:
            try:
                out[t] = db.execute(text(f"SELECT COUNT(*) FROM {t}")).scalar()
            except Exception:
                db.rollback()
                out[t] = None
    finally:
        db.close()
    return out


def ledger_names() -> set:
    db = SessionLocal()
    try:
        rows = db.execute(text("SELECT migration_name FROM db_migrations")).fetchall()
        return {r[0] for r in rows}
    except Exception:
        db.rollback()
        return set()
    finally:
        db.close()


class LogCapture(logging.Handler):
    """
    Collects log lines so the test can read the migration summary and, more
    importantly, prove that RUN 2 issued no ALTER statements at all.
    """

    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())

    def summary(self) -> str:
        for line in self.lines:
            if line.startswith("Migrations complete:"):
                return line
        return "(no summary line)"

    def count(self, needle: str) -> int:
        return sum(1 for line in self.lines if needle in line)


def run_startup(label: str) -> LogCapture:
    """One simulated app startup: backup → init_db → migrations."""
    print(f"\n{'=' * 70}\n{label}\n{'=' * 70}")
    cap = LogCapture()
    root = logging.getLogger()
    prev_level = root.level
    root.setLevel(logging.INFO)
    root.addHandler(cap)
    try:
        _backup_on_startup()
        init_db()
        _run_db_migrations()
    finally:
        root.removeHandler(cap)
        root.setLevel(prev_level)
    print(f"   {cap.summary()}")
    return cap


# --------------------------------------------------------------------------
# Baseline
# --------------------------------------------------------------------------
baseline = row_counts()
print("Baseline row counts:")
for t, c in baseline.items():
    print(f"   {t:<18} {c if c is not None else '(table missing)'}")

# How many migrations the app defines, read straight from the source of truth.
import app.main as main_module  # noqa: E402
import inspect  # noqa: E402

migration_sql_count = inspect.getsource(main_module._run_db_migrations).count(
    '"ALTER TABLE '
)
print(f"\nMigrations defined in _run_db_migrations(): {migration_sql_count}")


# --------------------------------------------------------------------------
# RUN 1 — the upgrade.  Existing database, no ledger yet.
# --------------------------------------------------------------------------
cap1 = run_startup("RUN 1 — customer installs the update (existing DB, empty ledger)")

ledger1 = ledger_names()
check("no migration FAILED", cap1.count("Migration FAILED") == 0,
      f"({cap1.count('Migration FAILED')} failures in log)")
check("existing columns were ADOPTED, not re-run",
      f"{migration_sql_count} adopted" in cap1.summary(),
      f"({cap1.summary()})")
check("no ALTER was issued on the upgrade",
      cap1.count("Migration applied") == 0,
      f"({cap1.count('Migration applied')} applied — expected 0)")
check("ledger now records every migration",
      len(ledger1) == migration_sql_count,
      f"(ledger={len(ledger1)}, expected={migration_sql_count})")
check("data intact after run 1", row_counts() == baseline)

after1 = row_counts()


# --------------------------------------------------------------------------
# RUN 2 — the ordinary restart.  Everything must be skipped.
# --------------------------------------------------------------------------
cap2 = run_startup("RUN 2 — customer opens the app again (second start)")

check("no migration FAILED", cap2.count("Migration FAILED") == 0)
check("no ALTER statement was issued", cap2.count("Migration applied") == 0,
      f"({cap2.count('Migration applied')} applied — expected 0)")
check("summary reports all skipped",
      f"{migration_sql_count} skipped" in cap2.summary(),
      f"({cap2.summary()})")
check("ledger unchanged", ledger_names() == ledger1)
check("data intact after run 2", row_counts() == after1)


# --------------------------------------------------------------------------
# RUN 3 — a genuinely NEW column arrives in an update.
# --------------------------------------------------------------------------
# Simulated by physically dropping a column and deleting its ledger row, which
# is the exact state a customer is in when a new version adds a column.
print(f"\n{'=' * 70}\nRUN 3 — simulating a brand-new column in an update\n{'=' * 70}")

VICTIM_TABLE, VICTIM_COLUMN = "invoice_items", "returned_qty"
VICTIM_NAME = f"add_{VICTIM_COLUMN}_to_{VICTIM_TABLE}"

db = SessionLocal()
dropped = False
try:
    # ALTER TABLE ... DROP COLUMN needs SQLite 3.35+ (2021).  If this build is
    # older the scenario is skipped rather than failing the whole run.
    db.execute(text(f"ALTER TABLE {VICTIM_TABLE} DROP COLUMN {VICTIM_COLUMN}"))
    db.execute(text("DELETE FROM db_migrations WHERE migration_name = :n"),
               {"n": VICTIM_NAME})
    db.commit()
    dropped = True
    print(f"   Dropped {VICTIM_TABLE}.{VICTIM_COLUMN} and its ledger row.")
except Exception as exc:
    db.rollback()
    print(f"   SKIPPED — cannot drop column on this SQLite "
          f"({sqlite3.sqlite_version}): {str(exc).splitlines()[0]}")
finally:
    db.close()

if dropped:
    cap3 = run_startup("RUN 3 — startup must re-apply the missing column")
    check("the missing migration was applied",
          cap3.count(f"Migration applied: {VICTIM_NAME}") == 1)
    check("no migration FAILED", cap3.count("Migration FAILED") == 0)
    check("it is back in the ledger", VICTIM_NAME in ledger_names())

    db = SessionLocal()
    try:
        cols = [r[1] for r in db.execute(
            text(f"PRAGMA table_info({VICTIM_TABLE})")).fetchall()]
        check(f"{VICTIM_COLUMN} is back in the schema", VICTIM_COLUMN in cols)
    finally:
        db.close()

    # A fourth start proves the re-applied migration settles down again.
    cap4 = run_startup("RUN 4 — and settles back to skip-everything")
    check("nothing applied on the next start", cap4.count("Migration applied") == 0)


# --------------------------------------------------------------------------
# Backups produced along the way
# --------------------------------------------------------------------------
print(f"\n{'=' * 70}\nBackups created by these startups\n{'=' * 70}")
backups = sorted((SANDBOX / "backups").glob("*.db"))
for b in backups:
    print(f"   {b.name:<32} {b.stat().st_size / 1024:>8.0f} KB")
check("a startup backup was created each run", len(backups) >= 3,
      f"({len(backups)} found)")

# The backup must be a genuinely readable database, not a truncated file —
# open the newest one and read a table out of it.
if backups:
    newest = max(backups, key=lambda p: p.stat().st_mtime)
    try:
        conn = sqlite3.connect(str(newest))
        n = conn.execute("SELECT COUNT(*) FROM invoices").fetchone()[0]
        conn.close()
        check("newest backup opens and contains data",
              n == baseline.get("invoices"),
              f"(backup invoices={n}, live={baseline.get('invoices')})")
    except Exception as exc:
        check("newest backup opens and contains data", False, str(exc))


# --------------------------------------------------------------------------
# Verdict
# --------------------------------------------------------------------------
print(f"\n{'=' * 70}")
if FAILURES:
    print(f"RESULT: {len(FAILURES)} CHECK(S) FAILED")
    for f in FAILURES:
        print(f"   - {f}")
else:
    print("RESULT: ALL CHECKS PASSED — migrations are idempotent and data survived.")
print(f"{'=' * 70}")

shutil.rmtree(SANDBOX, ignore_errors=True)
print(f"Sandbox removed: {SANDBOX}")

sys.exit(1 if FAILURES else 0)
