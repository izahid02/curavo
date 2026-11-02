"""
Health Care Centre ERP — Backend entry point.

This is the file that "runs" the server. When you start the backend,
FastAPI loads this, sets up the web address routes (called "endpoints"),
and starts listening for requests from the React frontend.

Run it with:  uvicorn app.main:app --reload
Then open:    http://localhost:8000/docs   (auto-generated API explorer)

In production mode, this server also serves the built React frontend
from frontend/dist/ — no separate Vite dev server needed.
"""
import hashlib
import logging
import os
import re
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db, SessionLocal, init_db, get_app_data_dir
from app.routers import auth as auth_router
from app.routers import inventory as inventory_router
from app.routers import billing as billing_router
from app.routers import patients as patients_router
from app.routers import dashboard as dashboard_router
from app.routers import suppliers as suppliers_router
from app.routers import purchasing as purchasing_router
from app.routers import reports as reports_router
from app.routers import followup as followup_router
from app.routers import marketing as marketing_router
from app.routers import search as search_router
from app.routers import interactions as interactions_router
from app.routers import prescriptions as prescriptions_router
from app.routers import credit as credit_router
from app.routers import expenditure as expenditure_router
from app.routers import supplier_credit as supplier_credit_router
from app.routers import settings as settings_router
from app.routers import backup as backup_router
from app.routers import licence as licence_router
from app.routers import cloud as cloud_router
from app.routers import diagnostics as diagnostics_router
from app.routers import owner_app as owner_app_router
from app.routers import regulated as regulated_router


# ---------------------------------------------------------------------------
# Startup: create a default admin user on a fresh installation
# ---------------------------------------------------------------------------
#
# ⚠ EVERY STARTUP MESSAGE IN THIS FILE IS PLAIN ASCII, AND USES logging —
#   NEVER print().  Both halves of that rule matter on Windows:
#
#   1. print() writes to sys.stdout, which on a Windows console defaults to the
#      cp1252 encoding.  cp1252 cannot represent emoji, so print("✅ ...")
#      raises UnicodeEncodeError — a REAL exception, raised at the print call,
#      that aborts whatever function it is sitting in.  That is not theoretical:
#      the emoji print used to sit AFTER the commit inside _seed_admin, so the
#      admin user was created, the print blew up, the except branch caught it,
#      and the log said "Could not create admin user" about an account that
#      existed.  A support call chasing a bug that was purely cosmetic.
#   2. logging goes to the rotating hcc.log file, which main_desktop.py opens
#      with encoding="utf-8".  logging also never lets an encoding problem reach
#      the caller (a failing handler is reported internally, not raised), so a
#      log line can never abort a seed function the way a print can.
#
#   The comments and docstrings in this file still use em-dashes freely — the
#   source is read as UTF-8 and never re-encoded, so only the strings that get
#   WRITTEN OUT at runtime are constrained.  The Assamese message-template text
#   further down is data bound for the database, not console output, and must
#   stay exactly as it is.

def _seed_admin() -> None:
    """
    If there are no users in the database yet, create a default Owner account
    so the pharmacy can log in on the very first run without manually inserting
    rows.

    Credentials:  username = admin   password = admin123
    The owner should change the password after the first login.

    This is the ONE startup step the pharmacy cannot open without: no user row
    means nobody can log in at all.  It therefore keeps its own try/except (on
    top of the per-step guard in lifespan) and says plainly in the log which of
    the three outcomes happened — created / already existed / failed — because
    hcc.log is the only thing a technician can read after a bad Windows launch.
    """
    import traceback

    db = SessionLocal()
    try:
        # Import here (inside the function) to avoid any import-order issues
        # that could appear if the models aren't fully registered yet.
        from app.models.user import Role, User
        from app.services.auth_service import hash_password

        existing = db.query(User).count()
        if existing > 0:
            logging.info(
                f"Admin seed: SKIPPED - {existing} user(s) already exist"
            )
            return  # Users already exist — nothing to do

        # The "Owner" role should already exist from the schema.sql seed data.
        # If for some reason it doesn't (e.g. fresh DB without seed), create it.
        role = db.query(Role).filter(Role.name == "Owner").first()
        if role is None:
            role = Role(name="Owner")
            db.add(role)
            db.flush()   # flush so role.id is assigned before we use it below
            logging.info("Admin seed: 'Owner' role was missing - created it")

        admin = User(
            username="admin",
            full_name="Administrator",
            password_hash=hash_password("admin123"),
            role_id=role.id,
            is_active=True,
        )
        db.add(admin)
        db.commit()
        # Nothing but logging after the commit.  A print() here is what used to
        # turn a SUCCESSFUL seed into a logged failure on Windows (see the note
        # above this function).
        logging.info(
            "Admin seed: CREATED default user 'admin' (password 'admin123'). "
            "WARNING: change this password before going live."
        )
    except Exception as exc:
        db.rollback()
        logging.error(f"Admin seed: FAILED - could not create admin user: {exc}")
        logging.error(traceback.format_exc())
    finally:
        db.close()


def _seed_tags() -> None:
    """
    If the tags table is empty, populate it with 16 common pharmacy tags.

    These tags are used to label patients for targeted follow-ups and
    marketing (e.g. send a promo to all "Diabetes" patients).
    Staff can add more tags from the Patients screen at any time.
    """
    db = SessionLocal()
    try:
        from app.models.patients import Tag

        if db.query(Tag).count() > 0:
            return  # Tags already seeded — nothing to do

        default_tags = [
            "Diabetes",
            "Cardiac",
            "Hypertension",
            "Asthma",
            "Thyroid",
            "Skin Care",
            "Women's Health",
            "Senior Citizen",
            "Child Care",
            "Vitamin Buyer",
            "Prescription Customer",
            "Self Medication",
            "Monthly Customer",
            "High Value Customer",
            "Chronic Patient",
            "New Customer",
        ]
        for name in default_tags:
            db.add(Tag(name=name))
        db.commit()
        logging.info(f"Seeded {len(default_tags)} default patient tags")
    except Exception as exc:
        db.rollback()
        logging.warning(f"Could not seed patient tags: {exc}")
    finally:
        db.close()


def _seed_doctors() -> None:
    """
    If the doctors table is empty, add 3 default specialist doctors.
    More doctors can be added later via the OPD module (Phase 3).
    """
    db = SessionLocal()
    try:
        from app.models.opd import Doctor

        if db.query(Doctor).count() > 0:
            return  # Already seeded

        defaults = [
            ("Dr. General Physician", "General Medicine"),
            ("Dr. Diabetologist",     "Diabetes"),
            ("Dr. Cardiologist",      "Cardiology"),
        ]
        for name, spec in defaults:
            db.add(Doctor(name=name, specialization=spec))
        db.commit()
        logging.info(f"Seeded {len(defaults)} default doctors")
    except Exception as exc:
        db.rollback()
        logging.warning(f"Could not seed doctors on startup: {exc}")
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Migration ledger — a record of WHICH migrations have run
# ---------------------------------------------------------------------------
#
# The old system relied on try/except alone: run every ALTER TABLE on every
# boot and swallow the "duplicate column name" error.  That never crashes, but
# it cannot tell the difference between two very different situations:
#
#     "this column is already there"   (fine — normal on every restart)
#     "this ALTER genuinely failed"    (serious — the app will query a column
#                                       that does not exist)
#
# Both looked identical in the log, so a real failure was invisible.  The
# ledger fixes that by tracking INTENT: a migration that succeeded is written
# down, and one that failed is NOT — so it is retried on the next start
# instead of being silently forgotten.
#
# Table shape (created on first run, then never changed):
#     id              INTEGER PRIMARY KEY AUTOINCREMENT
#     migration_name  TEXT UNIQUE NOT NULL
#     applied_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP

_MIGRATION_LEDGER_DDL = """
CREATE TABLE IF NOT EXISTS db_migrations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    migration_name TEXT UNIQUE NOT NULL,
    applied_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
"""

# Pulls the table and column out of "ALTER TABLE <t> ADD COLUMN <c> <type...>".
# Every migration below is that exact shape, which is what lets the migration
# NAME be derived from the statement instead of typed out by hand — the two can
# then never drift apart.
_ALTER_RE = re.compile(r"ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)", re.IGNORECASE)


def _migration_target(sql: str):
    """Return (table, column) for an ADD COLUMN statement, else (None, None)."""
    m = _ALTER_RE.search(sql)
    return (m.group(1), m.group(2)) if m else (None, None)


def _migration_name(sql: str) -> str:
    """
    The stable identity of a migration, e.g. 'add_returned_qty_to_invoice_items'.

    Derived from the SQL rather than hand-written so a typo cannot point the
    ledger at the wrong statement.  A column name is unique within its table,
    so table+column is a unique key.  Anything that is not an ADD COLUMN (a
    future data migration, say) falls back to a hash of the statement itself.
    """
    table, column = _migration_target(sql)
    if table and column:
        return f"add_{column}_to_{table}"
    return "sql_" + hashlib.sha1(sql.encode()).hexdigest()[:16]


def _ensure_migration_ledger(db) -> None:
    """Create the db_migrations table if this database has never had one."""
    db.execute(text(_MIGRATION_LEDGER_DDL))
    db.commit()


def _applied_migration_names(db) -> set:
    """Every migration_name already recorded, as a set for O(1) lookups."""
    rows = db.execute(text("SELECT migration_name FROM db_migrations")).fetchall()
    return {r[0] for r in rows}


def _record_migration(db, name: str) -> None:
    """
    Write a migration into the ledger.  INSERT OR IGNORE (not plain INSERT)
    because migration_name is UNIQUE — a duplicate must be a no-op, not an
    error that aborts the rest of the run.
    """
    db.execute(
        text("INSERT OR IGNORE INTO db_migrations (migration_name) VALUES (:n)"),
        {"n": name},
    )
    db.commit()


def _column_exists(db, table: str, column: str) -> bool:
    """
    Does this column physically exist right now?

    The ledger records intent, but the SCHEMA is the ground truth — and on an
    existing pharmacy database the two disagree the first time this build runs:
    the columns are all there (added by the old try/except system) while the
    ledger is empty, because nothing was ever writing one.  Checking the real
    schema is what lets those be adopted instead of re-run.

    PRAGMA table_info returns one row per column: (cid, name, type, notnull,
    dflt_value, pk) — so r[1] is the column name.  An unknown table returns no
    rows rather than raising.
    """
    try:
        rows = db.execute(text(f"PRAGMA table_info({table})")).fetchall()
    except Exception:
        db.rollback()
        return False
    return any(r[1] == column for r in rows)


def _run_db_migrations() -> None:
    """
    Apply incremental column additions that were introduced after the initial
    schema was created.

    Each statement goes through THREE gates, in this order (see the loop below):

      1. In the db_migrations ledger?  → skip, it has already run.
      2. Column physically in the schema? → adopt into the ledger, don't re-run.
      3. Otherwise → run it, and record it in the ledger only if it SUCCEEDS.

    Gate 2 is what makes this safe to ship to a pharmacy that is already
    running the app.  Their database has every column but an empty ledger,
    because the previous system used try/except alone and wrote nothing down.
    Without gate 2 the first upgrade boot would re-attempt 38 doomed ALTERs and
    log 38 errors; with it, they are quietly adopted and never tried again.

    A failure is NOT recorded, on purpose — it is retried on the next start.
    Recording it would mark a missing column as done and leave the app querying
    something that is not there.

    Fresh installs: init_db() (called just before this) creates every column via
    create_all(), so all statements take gate 2 and the ledger is populated
    without a single ALTER running.

    Windows note: the SQLite build inside the frozen .exe can report a different
    error type/message for "duplicate column name" than macOS system SQLite.
    Nothing here matches on an error message — gate 2 asks the schema directly
    via PRAGMA — so the two platforms behave identically.
    """
    # Every incremental column addition, in one ordered list.  The migration
    # NAME is derived from each statement (see _migration_name), so adding a
    # line here is all that is needed — there is no second list to keep in sync.
    migrations = [
        # Phase 3.3 refill prediction
        "ALTER TABLE products ADD COLUMN days_per_unit INTEGER",
        "ALTER TABLE invoice_items ADD COLUMN estimated_finish_date DATE",

        # Phase 3 credit management: amount_paid and credit_amount on invoices
        "ALTER TABLE invoices ADD COLUMN amount_paid NUMERIC(12,2) DEFAULT 0",
        "ALTER TABLE invoices ADD COLUMN credit_amount NUMERIC(12,2) DEFAULT 0",
        "ALTER TABLE invoices ADD COLUMN credit_due_date DATE",

        # Phase 3 follow-up template improvements
        "ALTER TABLE message_templates ADD COLUMN day INTEGER",
        "ALTER TABLE message_templates ADD COLUMN tag_filter VARCHAR(60)",
        "ALTER TABLE message_templates ADD COLUMN is_active INTEGER DEFAULT 1",
        "ALTER TABLE follow_up_schedules ADD COLUMN sent_at TIMESTAMPTZ",

        # Credit: how a repayment was received (CASH / UPI) on PAYMENT rows,
        # and a permanent "was late at some point" marker for defaulter history
        "ALTER TABLE credit_transactions ADD COLUMN payment_mode TEXT",
        "ALTER TABLE credit_transactions ADD COLUMN was_overdue INTEGER DEFAULT 0",

        # Account menu: profile contact details + avatar photo on users
        "ALTER TABLE users ADD COLUMN email TEXT",
        "ALTER TABLE users ADD COLUMN phone TEXT",
        "ALTER TABLE users ADD COLUMN avatar_path TEXT",

        # Strip/unit medicine management (Feature 3).
        #
        # Tablets and capsules arrive in strips but are often sold as loose
        # individual tablets.  Stock is ALWAYS stored in individual units;
        # units_per_strip is what lets the UI show "15 strips (150 units)"
        # and lets billing price a sale either way.
        "ALTER TABLE products ADD COLUMN medicine_type TEXT DEFAULT 'TABLET'",
        "ALTER TABLE products ADD COLUMN is_strip INTEGER DEFAULT 0",
        "ALTER TABLE products ADD COLUMN units_per_strip INTEGER",
        "ALTER TABLE products ADD COLUMN strip_mrp NUMERIC(10,2)",
        "ALTER TABLE products ADD COLUMN unit_mrp NUMERIC(10,2)",

        # Home visit / drip administration charge on an invoice (Feature 4).
        # Stored on the invoice itself rather than as an invoice_item, because
        # it is a SERVICE charge: it has no batch, no stock movement, and — by
        # design — no GST.
        "ALTER TABLE invoices ADD COLUMN home_visit_charge NUMERIC(12,2) DEFAULT 0",
        "ALTER TABLE invoices ADD COLUMN home_visit_notes TEXT",

        # Bonus / scheme purchase (Feature B).
        #
        # Distributors offer schemes like "5+1" (buy 5, get 1 free).  The free
        # units enter stock at zero cost.  We record the scheme on the batch (so
        # a later return values only the PAID units), on the stock purchase (so
        # Purchase History can show "50 paid + 10 bonus = 60 total"), and on the
        # supplier return (so the paid/bonus split is snapshotted at return time).
        "ALTER TABLE batches ADD COLUMN scheme_buy INTEGER",
        "ALTER TABLE batches ADD COLUMN scheme_free INTEGER",
        "ALTER TABLE batches ADD COLUMN scheme_label TEXT",
        "ALTER TABLE batches ADD COLUMN bonus_quantity INTEGER DEFAULT 0",
        "ALTER TABLE batches ADD COLUMN paid_quantity INTEGER",
        "ALTER TABLE batches ADD COLUMN effective_cost_per_unit NUMERIC(10,2)",
        "ALTER TABLE stock_purchases ADD COLUMN scheme_label TEXT",
        "ALTER TABLE stock_purchases ADD COLUMN bonus_quantity INTEGER DEFAULT 0",
        "ALTER TABLE supplier_returns ADD COLUMN scheme_label TEXT",
        "ALTER TABLE supplier_returns ADD COLUMN bonus_returned INTEGER DEFAULT 0",
        "ALTER TABLE supplier_returns ADD COLUMN paid_returned INTEGER",

        # Drug Licence number on a supplier (Fix 1).  Legally required on every
        # medicine purchase record, so it lives beside the GSTIN.
        "ALTER TABLE suppliers ADD COLUMN dl_number TEXT",

        # GST paid on a stock purchase (Fix 7).  cost_price is the ex-GST price
        # of one unit; these two record the tax and the real money owed, so
        # supplier credit stops under-counting by the GST amount.
        "ALTER TABLE stock_purchases ADD COLUMN gst_on_purchase NUMERIC DEFAULT 0",
        "ALTER TABLE stock_purchases ADD COLUMN total_cost NUMERIC DEFAULT 0",

        # Supplier discount on a stock purchase.  A distributor's "5% trade
        # discount" or "₹30 off per strip" lowers what the medicine really cost
        # us, so profit margin and expiry loss must both work off the discounted
        # figure rather than the rate-card price.
        #   discount_percent / discount_amount → the discount, in both shapes
        #   effective_cost                     → cost_price − discount_amount
        # NULL effective_cost on old rows means "no discount recorded"; readers
        # fall back to cost_price.
        "ALTER TABLE stock_purchases ADD COLUMN discount_percent NUMERIC DEFAULT 0",
        "ALTER TABLE stock_purchases ADD COLUMN discount_amount NUMERIC DEFAULT 0",
        "ALTER TABLE stock_purchases ADD COLUMN effective_cost NUMERIC",

        # Partial invoice returns (Fix 2).  A customer brings back ONE medicine
        # off a five-line bill, so a return is tracked per LINE, not per
        # invoice.  Existing rows default to 0 / not-returned, which is exactly
        # right: nothing had been partially returned before this existed.
        #   returned_qty — units of this line handed back so far
        #   is_returned  — convenience flag for returned_qty == quantity
        "ALTER TABLE invoice_items ADD COLUMN returned_qty INTEGER DEFAULT 0",
        "ALTER TABLE invoice_items ADD COLUMN is_returned INTEGER DEFAULT 0",
        # The invoice-level mirror of the same fact: how much has been refunded
        # against this bill.  Every revenue query sums total_amount, which after
        # a partial return overstates what the customer actually paid, so the
        # dashboards and reports subtract this.  Existing rows default to 0 —
        # correct, since nothing could have been partially returned before now.
        "ALTER TABLE invoices ADD COLUMN refunded_amount NUMERIC(12,2) DEFAULT 0",

        # Multi-page prescriptions.
        #
        # A doctor's pad routinely runs to two or three sheets.  Each page is
        # its own prescriptions row (that table always allowed many rows per
        # patient and per invoice), and these two columns are what tie the
        # pages of ONE prescription back together:
        #   group_id    — the same value on every page uploaded in one go
        #   page_number — 1-based position within that group
        #
        # Both are NULL on every row written before this.  A NULL group_id
        # means "a prescription of one page, on its own", which is exactly
        # what those older rows are — so nothing already in the pharmacy's
        # database needs rewriting, and nothing about it displays differently.
        "ALTER TABLE prescriptions ADD COLUMN group_id TEXT",
        "ALTER TABLE prescriptions ADD COLUMN page_number INTEGER",

        # Schedule H1 / MTP register.
        #
        # Which register, if any, a medicine's sale has to be written into:
        # 'H1', 'MTP', or NULL for the ordinary medicines that are most of the
        # shelf.  NULL on every existing row, which is correct — a medicine is
        # only regulated once the pharmacist has CONFIRMED the match, and that
        # confirmation is the whole point of the flagging screen.  Nothing is
        # back-filled automatically: a register built from guesses is worse
        # than no register.
        #
        # The register table itself is created by create_all() (see
        # database.py), because it is a table and not a column.
        "ALTER TABLE products ADD COLUMN register_category TEXT",

        # "Name on invoices" (Curavo, Nov 2026): the name printed on the A4 tax
        # invoice when it differs from the shop's display name.  NULL on every
        # existing row, which means "print the shop name in capitals" — so an
        # upgraded shop's invoices change only if the owner fills it in.
        "ALTER TABLE pharmacy_settings ADD COLUMN invoice_name VARCHAR(150)",

        # Shop name in Assamese, for Assamese patient messages (Curavo, Nov
        # 2026).  NULL = Assamese messages use the ordinary shop name.
        "ALTER TABLE pharmacy_settings ADD COLUMN pharmacy_name_as VARCHAR(150)",

        # Invoice number prefix (Curavo, Nov 2026).  NULL on existing rows;
        # services/doc_numbers.py then continues the shop's own series (read
        # from its last invoice), so an upgrade never changes a shop's numbers.
        "ALTER TABLE pharmacy_settings ADD COLUMN invoice_prefix VARCHAR(8)",
        # Owner app (Nov 2026): the day the morning "needs attention" phone
        # notification was last sent, so it goes out at most once a day even
        # if Curavo is restarted.
        "ALTER TABLE cloud_state ADD COLUMN owner_summary_at DATETIME",
        "ALTER TABLE cloud_state ADD COLUMN owner_push_on DATE",
    ]

    db = SessionLocal()
    try:
        _ensure_migration_ledger(db)
        already = _applied_migration_names(db)

        applied = skipped = adopted = failed = 0
        for sql in migrations:
            name = _migration_name(sql)

            # (1) The ledger already has it — nothing to do.  This is the
            #     normal path on every restart after the first, and it means a
            #     settled database issues ZERO ALTER statements at boot.
            if name in already:
                skipped += 1
                continue

            # (2) Not in the ledger, but the column is physically present.
            #     This is every EXISTING pharmacy database, the first time it
            #     runs this build: the old try/except system added the columns
            #     but kept no record of doing so.  Adopt them into the ledger
            #     so the next boot takes path (1) instead of retrying an ALTER
            #     that is guaranteed to fail.
            table, column = _migration_target(sql)
            if table and column and _column_exists(db, table, column):
                _record_migration(db, name)
                adopted += 1
                continue

            # (3) Genuinely new — run it, and record it ONLY if it succeeds.
            try:
                db.execute(text(sql))
                db.commit()
                _record_migration(db, name)
                applied += 1
                logging.info(f"Migration applied: {name}")
            except Exception as e:
                # Deliberately NOT recorded.  An unrecorded migration is retried
                # on the next start; recording a failure would mark a missing
                # column as done and leave the app querying a column that is not
                # there.  Logged at ERROR because, unlike the old system, this
                # branch no longer catches the ordinary "already exists" case —
                # step (2) handles that — so reaching here is a REAL problem.
                db.rollback()
                failed += 1
                reason = str(e).splitlines()[0]
                logging.error(
                    f"Migration FAILED (will retry on next start): {name} - {reason}"
                )

        # Backfill for was_overdue: anything sitting in OVERDUE right now is, by
        # definition, already late — mark it so day-one data is not silently
        # wrong.  Transactions that were late but have since been paid cannot be
        # recovered (the status was overwritten), so history starts here.
        # Safe to re-run: it only ever sets rows that are currently OVERDUE.
        try:
            db.execute(text(
                "UPDATE credit_transactions SET was_overdue = 1 WHERE status = 'OVERDUE'"
            ))
            db.commit()
        except Exception as e:
            db.rollback()
            logging.info(f"was_overdue backfill skipped: {e}")

        logging.info(
            f"Migrations complete: {applied} applied, {adopted} adopted "
            f"(already in schema), {skipped} skipped (already in ledger), "
            f"{failed} FAILED - {len(migrations)} total"
        )
    finally:
        db.close()


def _seed_home_visit_charge() -> None:
    """
    Make sure exactly one home-visit charge settings row exists (Feature 4).

    This is a settings row, not a log — the billing screen reads it to pre-fill
    the amount, and the pharmacist can still override it per bill.  We only
    ever create it when missing, so an owner who changed ₹100 to ₹150 does not
    get it reset on the next restart.
    """
    db = SessionLocal()
    try:
        from app.models.supplier_credit import HomeVisitCharge

        existing = db.query(HomeVisitCharge).first()
        if existing is None:
            db.add(HomeVisitCharge(
                name="Home Visit / Drip Administration Charge",
                default_amount=100.00,
                is_active=True,
            ))
            db.commit()
            logging.info("Seeded default home visit charge (Rs.100)")
    except Exception as exc:
        db.rollback()
        logging.warning(f"Could not seed home visit charge on startup: {exc}")
    finally:
        db.close()


def _seed_pharmacy_settings() -> None:
    """
    Make sure exactly one pharmacy_settings row exists (Fix 7).

    Like the home-visit charge above, this is a SETTINGS row, not a log: we
    only ever create it when missing, so an owner who renamed the shop does
    not find "Health Care Centre" back on the sign after a restart.
    """
    db = SessionLocal()
    try:
        from app.models.settings import PharmacySettings

        existing = db.query(PharmacySettings).first()
        if existing is None:
            # A NEW install starts as "My Pharmacy" (it used to start as HCC).
            # Only ever runs on an empty table, so an existing shop's name is
            # never touched.
            db.add(PharmacySettings(
                pharmacy_name="My Pharmacy",
                pharmacy_tagline="Pharmacy & Medical Store",
            ))
            db.commit()
            logging.info("Seeded default pharmacy settings")
    except Exception as exc:
        db.rollback()
        logging.warning(f"Could not seed pharmacy settings on startup: {exc}")
    finally:
        db.close()


def _update_admin_details() -> None:
    """
    Give the seeded admin account a proper display name and email so the new
    account menu shows real details instead of blanks.

    Only fills fields that are still empty — never overwrites details the
    owner has already edited from the Profile screen.
    """
    db = SessionLocal()
    try:
        from app.models.user import User

        admin = db.query(User).filter(User.username == "admin").first()
        if admin is None:
            return  # no admin account — nothing to update

        changed = False
        if not admin.full_name or admin.full_name.strip() == "":
            admin.full_name = "Administrator"
            changed = True
        if not admin.email:
            admin.email = "admin@healthcarecentre.com"
            changed = True

        if changed:
            db.commit()
            logging.info("Admin profile details updated (full_name / email)")
    except Exception as exc:
        db.rollback()
        logging.warning(f"Could not update admin details: {exc}")
    finally:
        db.close()


def _seed_message_templates() -> None:
    """
    Upsert the canonical set of follow-up message templates.

    We upsert (update-or-insert by code) so that:
      - A fresh database gets all templates inserted on first startup.
      - An existing database gets updated content (e.g. new phone number,
        new Assamese text, new tag-specific variants) on the next startup.

    Each template carries:
      code        — unique key (e.g. FOLLOWUP_DAY2)
      day         — numeric follow-up day (2/5/10/30); NULL for non-follow-up
      tag_filter  — patient tag that prefers this template (NULL = general)
      body_en     — English text with {patient_name} placeholder
      body_as     — Assamese text with {patient_name} placeholder

    The shop's own name and phone are PLACEHOLDERS too - {shop_name},
    {shop_name_as}, {shop_phone} - filled from Pharmacy Settings by
    services/shop_identity.py when a message is queued.  These templates
    are upserted on every start, so a shop's name or phone must never be
    typed in here: it would overwrite every other shop's messages too.
      is_active   — 1 = live, 0 = soft-disabled
    """
    db = SessionLocal()
    try:
        from app.models.followup import MessageTemplate

        # All templates we want in the database.
        # The compose-message endpoint picks templates by matching day + tag_filter.
        # Diabetic variant is preferred over the general one for Diabetes-tagged patients.
        TEMPLATES = [
            # ── Day 2 — General ────────────────────────────────────────────────
            dict(
                code       = "FOLLOWUP_DAY2",
                name       = "Day 2 Follow-Up (General)",
                language   = "BOTH",
                channel    = "SMS",
                day        = 2,
                tag_filter = None,
                is_active  = 1,
                body_en = (
                    "Dear {patient_name}, we hope you are feeling better after your "
                    "recent visit to {shop_name}. Please remember to take your "
                    "medicines on time. Call us at {shop_phone} if you have any questions."
                ),
                body_as = (
                    "প্ৰিয় {patient_name}, {shop_name_as}লৈ আপোনাৰ শেহতীয়া "
                    "আগমনৰ পিছত আপুনি সুস্থ হৈ আছে বুলি আশা কৰোঁ। সময়মতে "
                    "ঔষধ খাবলৈ মনত ৰাখিব। যিকোনো প্ৰশ্নৰ বাবে {shop_phone} "
                    "নম্বৰত ফোন কৰক।"
                ),
                variables = "{patient_name}, {shop_name}, {shop_name_as}, {shop_phone}",
            ),
            # ── Day 2 — Diabetic variant ────────────────────────────────────
            dict(
                code       = "FOLLOWUP_DAY2_DIABETES",
                name       = "Day 2 Follow-Up (Diabetes)",
                language   = "BOTH",
                channel    = "SMS",
                day        = 2,
                tag_filter = "Diabetes",
                is_active  = 1,
                body_en = (
                    "Dear {patient_name}, we hope you are managing well after starting "
                    "your diabetes medicines. Remember to check your blood sugar regularly. "
                    "Call {shop_phone} anytime."
                ),
                body_as = (
                    "প্ৰিয় {patient_name}, আশা কৰোঁ আপুনি ডায়েবেটিছৰ "
                    "ঔষধ আৰম্ভ কৰাৰ পিছত ভালে আছে। নিয়মিতভাৱে "
                    "ৰক্তশৰ্কৰা পৰীক্ষা কৰিবলৈ মনত ৰাখিব। "
                    "{shop_phone} ত যিকোনো সময়তে ফোন কৰক।"
                ),
                variables = "{patient_name}, {shop_name}, {shop_name_as}, {shop_phone}",
            ),
            # ── Day 5 — General ────────────────────────────────────────────────
            dict(
                code       = "FOLLOWUP_DAY5",
                name       = "Day 5 Follow-Up (General)",
                language   = "BOTH",
                channel    = "SMS",
                day        = 5,
                tag_filter = None,
                is_active  = 1,
                body_en = (
                    "Dear {patient_name}, this is a reminder from {shop_name}. "
                    "Hope your treatment is going well. If you are running low on medicines, "
                    "visit us or call {shop_phone}."
                ),
                body_as = (
                    "প্ৰিয় {patient_name}, এইটো {shop_name_as}ৰ পৰা এটা "
                    "সোঁৱৰণি। আশা কৰোঁ আপোনাৰ চিকিৎসা ভালদৰে চলি আছে। "
                    "ঔষধ শেষ হ'লে আমাৰ ওচৰলৈ আহক বা {shop_phone} ত ফোন কৰক।"
                ),
                variables = "{patient_name}, {shop_name}, {shop_name_as}, {shop_phone}",
            ),
            # ── Day 10 — General ───────────────────────────────────────────────
            dict(
                code       = "FOLLOWUP_DAY10",
                name       = "Day 10 Check-In (General)",
                language   = "BOTH",
                channel    = "SMS",
                day        = 10,
                tag_filter = None,
                is_active  = 1,
                body_en = (
                    "Dear {patient_name}, checking in from {shop_name}. "
                    "Please ensure you have completed your course of medicines. "
                    "For refills or any concerns, call us at {shop_phone}."
                ),
                body_as = (
                    "প্ৰিয় {patient_name}, {shop_name_as}ৰ পৰা খবৰ লৈছোঁ। "
                    "অনুগ্ৰহ কৰি আপোনাৰ ঔষধৰ কোৰ্ছ সম্পূৰ্ণ কৰক। ঔষধ "
                    "নবীকৰণ বা যিকোনো সমস্যাৰ বাবে {shop_phone} ত ফোন কৰক।"
                ),
                variables = "{patient_name}, {shop_name}, {shop_name_as}, {shop_phone}",
            ),
            # ── Day 30 — General ───────────────────────────────────────────────
            dict(
                code       = "FOLLOWUP_DAY30",
                name       = "Day 30 Wellness (General)",
                language   = "BOTH",
                channel    = "SMS",
                day        = 30,
                tag_filter = None,
                is_active  = 1,
                body_en = (
                    "Dear {patient_name}, it has been a month since your last visit to "
                    "{shop_name}. If you need a refill for your regular medicines, "
                    "we are here to help. Call {shop_phone}."
                ),
                body_as = (
                    "প্ৰিয় {patient_name}, আপোনাৰ শেষ আগমনৰ পৰা এমাহ হ'ল। "
                    "যদি আপোনাৰ নিয়মীয়া ঔষধৰ বাবে নবীকৰণৰ প্ৰয়োজন, "
                    "আমি সহায় কৰিবলৈ আছোঁ। {shop_phone} ত ফোন কৰক।"
                ),
                variables = "{patient_name}, {shop_name}, {shop_name_as}, {shop_phone}",
            ),
            # ── Refill Reminder ────────────────────────────────────────────────
            dict(
                code       = "REFILL_REMINDER",
                name       = "Refill Reminder",
                language   = "BOTH",
                channel    = "SMS",
                day        = None,
                tag_filter = None,
                is_active  = 1,
                body_en = (
                    "Dear {patient_name}, your {medicine_name} supply may be running low. "
                    "Please visit {shop_name} to refill your prescription. "
                    "Call us at {shop_phone}."
                ),
                body_as = (
                    "প্ৰিয় {patient_name}, আপোনাৰ {medicine_name} শেষ হ'ব পাৰে। "
                    "অনুগ্ৰহ কৰি {shop_name_as}ত আপোনাৰ "
                    "প্ৰেছক্ৰিপশন পূৰণ কৰিবলৈ আহক। {shop_phone} ত ফোন কৰক।"
                ),
                variables = "{patient_name},{medicine_name}",
            ),
        ]

        inserted = updated = 0
        for t_data in TEMPLATES:
            existing = (
                db.query(MessageTemplate)
                .filter(MessageTemplate.code == t_data["code"])
                .first()
            )
            if existing:
                # Update all fields so template content improvements take effect
                for k, v in t_data.items():
                    setattr(existing, k, v)
                updated += 1
            else:
                db.add(MessageTemplate(**t_data))
                inserted += 1

        db.commit()
        logging.info(f"Message templates: {inserted} inserted, {updated} updated")
    except Exception as exc:
        db.rollback()
        logging.warning(f"Could not seed message templates: {exc}")
    finally:
        db.close()


def _seed_drug_interactions() -> None:
    """
    Populate drug_interactions with the most clinically important pairings
    if the table is empty.  These cover HIGH-severity (life-threatening) and
    MODERATE-severity interactions commonly seen in a retail pharmacy.

    Run only once on a fresh installation — if any rows already exist, the
    seed is skipped so that staff edits are not overwritten on restart.
    """
    db = SessionLocal()
    try:
        from app.models.drug_interactions import DrugInteraction

        if db.query(DrugInteraction).count() > 0:
            return  # Already seeded — nothing to do

        seed_data = [
            # (drug_a, drug_b, severity, description, recommendation)
            ("warfarin",      "aspirin",        "HIGH",     "Increased bleeding risk",          "Avoid combination"),
            ("warfarin",      "ibuprofen",       "HIGH",     "Increased bleeding risk",          "Avoid combination"),
            ("warfarin",      "naproxen",        "HIGH",     "Increased bleeding risk",          "Avoid combination"),
            ("metformin",     "alcohol",         "MODERATE", "Lactic acidosis risk",             "Counsel patient"),
            ("methotrexate",  "ibuprofen",       "HIGH",     "Methotrexate toxicity",            "Avoid combination"),
            ("methotrexate",  "aspirin",         "HIGH",     "Methotrexate toxicity",            "Avoid combination"),
            ("simvastatin",   "erythromycin",    "HIGH",     "Rhabdomyolysis risk",              "Avoid combination"),
            ("simvastatin",   "clarithromycin",  "HIGH",     "Rhabdomyolysis risk",              "Avoid combination"),
            ("clopidogrel",   "omeprazole",      "MODERATE", "Reduced antiplatelet effect",      "Consider alternative PPI"),
            ("ssri",          "tramadol",        "HIGH",     "Serotonin syndrome risk",          "Avoid combination"),
            ("lithium",       "ibuprofen",       "HIGH",     "Lithium toxicity",                 "Avoid combination"),
            ("digoxin",       "amiodarone",      "HIGH",     "Digoxin toxicity",                 "Reduce digoxin dose"),
            ("insulin",       "alcohol",         "MODERATE", "Hypoglycemia risk",                "Counsel patient"),
            ("ciprofloxacin", "antacid",         "MODERATE", "Reduced absorption",               "Give 2 hours apart"),
            ("tetracycline",  "antacid",         "MODERATE", "Reduced absorption",               "Give 2 hours apart"),
        ]

        for drug_a, drug_b, severity, description, recommendation in seed_data:
            db.add(DrugInteraction(
                drug_a=drug_a,
                drug_b=drug_b,
                severity=severity,
                description=description,
                recommendation=recommendation,
            ))
        db.commit()
        logging.info(f"Seeded {len(seed_data)} drug interaction rules")
    except Exception as exc:
        db.rollback()
        logging.warning(f"Could not seed drug interactions: {exc}")
    finally:
        db.close()



async def _daily_credit_reminders_task() -> None:
    """
    Run every 24 hours: queue any credit reminder messages that are due today.
    Wrapped in a try/except so a failure never crashes the application.
    """
    import asyncio
    while True:
        try:
            from app.services.credit_service import send_due_credit_reminders
            db = SessionLocal()
            try:
                sent = send_due_credit_reminders(db)
                if sent:
                    logging.info(f"[credit] Queued {sent} reminder message(s)")
            finally:
                db.close()
        except Exception as exc:
            logging.warning(f"[credit] Daily reminder task failed: {exc}")
        # Sleep 24 hours before next run
        await asyncio.sleep(86_400)


# ---------------------------------------------------------------------------
# Automatic backup, taken BEFORE anything touches the database
# ---------------------------------------------------------------------------

# How many automatic startup backups to keep.  Seven is roughly a week of
# daily opens for a shop that starts the app once each morning.
STARTUP_BACKUPS_TO_KEEP = 7


def _backup_on_startup() -> None:
    """
    Copy the database to a timestamped file before migrations run.

    This is the safety net for the whole upgrade story: if an update ever
    corrupts data, the state from just before that update is still on disk.
    It runs FIRST in the lifespan — ahead of init_db() and the migrations —
    because a backup taken after a bad migration has already lost the thing
    you wanted to recover.

    ⚠ WHY THIS DOES NOT USE shutil.copy2
    ------------------------------------
    The database runs in WAL mode (see database.py's PRAGMA block).  In WAL
    mode a committed transaction is written to a SEPARATE pharmacy.db-wal file
    and only folded back into pharmacy.db at a checkpoint.  Between
    checkpoints, pharmacy.db can be badly out of date — on this dev machine
    pharmacy.db was 528 KB from Jul 30 while pharmacy.db-wal held 3.7 MB of
    newer data.  Copying pharmacy.db alone would have produced a backup
    missing two weeks of sales, and it would have looked like it worked.

    sqlite3's online backup API reads through the WAL and writes ONE
    self-contained file, so the result is a complete, consistent snapshot that
    can be restored by itself.  It is also safe to run while the app holds the
    database open, which matters because uvicorn may already have connections.

    Failure here is logged and swallowed: not being able to take a backup is a
    reason to warn the owner, never a reason to stop the pharmacy opening.
    """
    import sqlite3
    from datetime import datetime

    try:
        db_path = get_app_data_dir() / "pharmacy.db"
        if not db_path.exists():
            logging.info("Startup backup skipped: no database yet (first run)")
            return

        backup_dir = get_app_data_dir() / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = backup_dir / f"startup_{timestamp}.db"
        # The timestamp only resolves to the SECOND, so two starts inside the
        # same second would land on the same filename and the second would
        # overwrite the first.  That is not hypothetical: `uvicorn --reload`
        # restarts several times in a row while a file is being edited, and it
        # cost us four of five backups the first time this was tested.  Add a
        # suffix rather than silently replacing an existing snapshot.
        counter = 2
        while backup_path.exists():
            backup_path = backup_dir / f"startup_{timestamp}_{counter}.db"
            counter += 1

        # Online backup API — consistent snapshot, WAL included.
        source = sqlite3.connect(str(db_path))
        try:
            dest = sqlite3.connect(str(backup_path))
            try:
                source.backup(dest)
            finally:
                dest.close()
        finally:
            source.close()

        size_kb = backup_path.stat().st_size / 1024
        logging.info(f"Startup backup created: {backup_path.name} ({size_kb:.0f} KB)")

        # Prune: keep only the newest STARTUP_BACKUPS_TO_KEEP automatic backups.
        # Sorted oldest-first, so [:-7] is "everything except the newest 7".
        # Only startup_*.db is touched — manual backups are never deleted.
        startup_backups = sorted(
            backup_dir.glob("startup_*.db"),
            key=lambda p: p.stat().st_mtime,
        )
        for old in startup_backups[:-STARTUP_BACKUPS_TO_KEEP]:
            try:
                old.unlink()
                logging.info(f"Old startup backup removed: {old.name}")
            except Exception as exc:
                logging.warning(f"Could not remove old backup {old.name}: {exc}")

    except Exception as exc:
        # A missing backup must never block startup — log loudly and continue.
        logging.error(f"Startup backup FAILED (continuing anyway): {exc}")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """
    Code before the 'yield' runs at startup; code after runs at shutdown.

    Order matters:
      0. _backup_on_startup()  — snapshot the DB before ANYTHING touches it
      1. init_db()      — create all tables that do not exist yet (SQLite)
      2. _run_db_migrations() — add columns introduced after the schema was created
      3. seed functions — populate default rows if tables are empty
      4. background tasks — start daily credit reminder scheduler
    """
    import asyncio
    import traceback

    # Step 0 — the backup comes before init_db() and before the migrations,
    # because a snapshot taken afterwards has already lost whatever a bad
    # migration destroyed.  This function never raises (see its docstring).
    _backup_on_startup()

    # init_db() is the single most likely place for the desktop build to die:
    # it imports every ORM model and issues CREATE TABLE against the SQLite
    # file in AppData.  If the folder is not writable, or a model import
    # fails inside the frozen exe, we want the reason in hcc.log — not a
    # silent exit.  We re-raise so startup fails loudly rather than serving a
    # half-initialised app.
    try:
        init_db()        # create all tables from ORM models (no-op if they exist)
        logging.info("Database initialized successfully")
    except Exception as e:
        logging.error(f"Database init failed: {e}")
        logging.error(traceback.format_exc())
        raise            # re-raise so startup fails loudly

    # ⚠ EVERY STEP IS ISOLATED — ONE FAILURE MUST NEVER STOP THE REST.
    #
    # These steps are NOT independent in importance: seed_admin is the only one
    # the pharmacy genuinely cannot open without (no user row = nobody can log
    # in), and it sits in the middle of a list of purely cosmetic seeds.  If the
    # loop stopped at the first exception, a broken message template — content,
    # not correctness — would lock the owner out of their own shop.  So each
    # step gets its own try/except and the loop always runs to the end.
    #
    # Order still matters even though failures don't stop it: migrations run
    # first because seed_admin INSERTs a User through the ORM, and the ORM model
    # knows about columns (email, phone, avatar_path) that only exist after the
    # migrations have added them.  update_admin_details then needs that same
    # email column, so it follows seed_admin.
    #
    # Each step is logged individually, so if the app ever dies mid-startup the
    # LAST line in hcc.log names exactly which step was running.
    steps = [
        ("run_db_migrations",     _run_db_migrations),
        ("seed_admin",            _seed_admin),
        ("update_admin_details",  _update_admin_details),
        ("seed_tags",             _seed_tags),
        ("seed_doctors",          _seed_doctors),
        ("seed_message_templates", _seed_message_templates),
        ("seed_drug_interactions", _seed_drug_interactions),
        ("seed_home_visit_charge", _seed_home_visit_charge),
        ("seed_pharmacy_settings", _seed_pharmacy_settings),
    ]
    failed_steps = []
    for name, step in steps:
        try:
            logging.info(f"Startup step: {name}...")
            step()
            logging.info(f"Startup step: {name} OK")
        except Exception as e:
            # Seeding default rows is convenience, not correctness — a failure
            # here must never stop the pharmacy from opening the app, so we log
            # and continue instead of re-raising (unlike init_db above).
            failed_steps.append(name)
            logging.error(f"Startup step '{name}' FAILED (continuing): {e}")
            logging.error(traceback.format_exc())

    # A single summary line, so a technician reading hcc.log after a bad launch
    # sees what broke without scrolling back through every step.
    if failed_steps:
        logging.error(
            f"Startup finished with {len(failed_steps)} failed step(s): "
            f"{', '.join(failed_steps)} - application is still serving"
        )
    else:
        logging.info("All startup steps complete - application is ready")

    # Start the credit reminder background task
    task = asyncio.create_task(_daily_credit_reminders_task())

    # The Curavo cloud helper (check-ins, daily locked backup, error reports).
    # Its own thread; does nothing at all when no cloud URL is configured.
    from app.services.cloud_agent import agent as cloud_agent
    cloud_agent.start()

    yield   # the application runs here
    task.cancel()  # clean shutdown — stop the background loop
    cloud_agent.stop()


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Curavo API",
    description="Pharmacy ERP & OPD Management System — Phase 1",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS = lets the React frontend (a different address) talk to this backend.
#
# Two very different frontends call this API:
#   1. The Vite dev server            → http://localhost:5173
#   2. The Tauri desktop webview      → tauri://localhost      (macOS/Linux)
#                                        http://tauri.localhost (Windows/WebView2)
# In the desktop build the static bundle is served by Tauri from that special
# origin, and its fetch() calls to http://127.0.0.1:<port> are CROSS-origin —
# so without these entries every request would be blocked by CORS.
#
# We keep allow_credentials=True (the JWT rides in the Authorization header),
# which forbids the "*" wildcard, so we list the exact dev origins and match
# the Tauri origins with a regex.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_origin_regex=r"^(tauri://localhost|https?://tauri\.localhost)$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

# All auth endpoints live at /api/auth/...
# (e.g. POST /api/auth/login, GET /api/auth/me)
app.include_router(auth_router.router, prefix="/api")

# All inventory endpoints live at /api/inventory/...
# (e.g. GET /api/inventory/products, POST /api/inventory/batches/receive)
app.include_router(inventory_router.router, prefix="/api")

# All billing endpoints live at /api/billing/...
# (e.g. POST /api/billing/invoices, GET /api/billing/invoices/{number})
app.include_router(billing_router.router, prefix="/api")

# All patient endpoints live at /api/patients/...
# (e.g. GET /api/patients, POST /api/patients, GET /api/patients/{id})
app.include_router(patients_router.router, prefix="/api")

# Dashboard summary endpoint: GET /api/dashboard/summary
app.include_router(dashboard_router.router, prefix="/api")

# Suppliers endpoints: GET/POST/PUT/DELETE /api/suppliers/
app.include_router(suppliers_router.router, prefix="/api")

# Purchasing endpoints: /api/purchasing/orders and /api/purchasing/grn
app.include_router(purchasing_router.router, prefix="/api")

# Reports endpoints: /api/reports/sales, /inventory, /profit, /patients
app.include_router(reports_router.router, prefix="/api")

# Follow-Up System endpoints: /api/followup/schedules, /messages, /responses, /stats
app.include_router(followup_router.router, prefix="/api")

# Marketing Automation endpoints: /api/marketing/campaigns
app.include_router(marketing_router.router, prefix="/api")

# Smart medicine search: GET /api/search/medicines?q=...
app.include_router(search_router.router, prefix="/api")

# Drug interaction checker: POST /api/interactions/check
app.include_router(interactions_router.router, prefix="/api")

# Prescription image upload & retrieval: /api/prescriptions/*
app.include_router(prescriptions_router.router, prefix="/api")

# Credit Management: /api/credit/transactions, /payment, /summary, etc.
app.include_router(credit_router.router, prefix="/api")

# Expenditure & Payroll: /api/expenditure/expenses, /employees, /salary, /cash-register
app.include_router(expenditure_router.router, prefix="/api")

# Supplier Credit (money WE owe suppliers): /api/supplier-credit/summary,
# /suppliers, /supplier/{id}, /payment, /due-soon
app.include_router(supplier_credit_router.router, prefix="/api")

# Shop-wide identity: GET /api/settings/pharmacy (public — the login screen and
# the receipt both read it), PUT /api/settings/pharmacy (Owner/Admin only).
app.include_router(settings_router.router, prefix="/api")
app.include_router(backup_router.router, prefix="/api")

# Curavo subscription: GET /api/licence/status, POST /api/licence/activate.
# The rules (30-day trial, 15-day grace, what pauses) are in services/licence.py.
app.include_router(licence_router.router, prefix="/api")

# Curavo cloud link: GET /api/cloud/status, POST /api/cloud/backup-now.
app.include_router(cloud_router.router, prefix="/api")
# Screens report their own crashes: POST /api/diagnostics/client-error.
app.include_router(diagnostics_router.router, prefix="/api")
# Owner app on the phone: connect / list / remove phones.
app.include_router(owner_app_router.router, prefix="/api")


# ---------------------------------------------------------------------------
# Error reports (services/error_reports.py)
# ---------------------------------------------------------------------------
# Any request that crashes is noted for the ARZ control panel before the
# usual 500 reply goes back.  ERROR-level log lines are noted too.
from fastapi import Request as _Request                      # noqa: E402
from fastapi.responses import JSONResponse as _JSONResponse  # noqa: E402
from app.services import error_reports as _error_reports      # noqa: E402

_error_reports.install_log_handler()


@app.exception_handler(Exception)
async def _report_unhandled(request: _Request, exc: Exception):
    _error_reports.record_exception(exc, "backend", f"{request.method} {request.url.path}")
    return _JSONResponse(status_code=500, content={"detail": "Internal server error"})

# Schedule H1 / MTP register: which medicines belong in it
# (/api/regulated/candidates, /apply, /check) and the medicines with no
# generic name, which are the ones matching can never see
# (/api/regulated/missing-generic).
app.include_router(regulated_router.router, prefix="/api")


@app.get("/health")
async def health():
    """
    Basic liveness check — returns immediately without touching the DB.
    Tauri's startup poller (src-tauri/src/main.rs) hits this to know the
    backend sidecar is up before it reveals the app window.
    """
    from app.version import VERSION
    return {
        "status": "ok",
        "version": VERSION,
        "db": "sqlite",
    }


@app.get("/port")
async def get_port():
    """
    Returns the port this server is listening on.

    In normal dev mode the port is always 8000.  In the frozen desktop
    build, main_desktop.py picks a free port and stores it in the
    HCC_PORT environment variable so this endpoint can report it back
    to the Tauri frontend during its startup readiness check.
    """
    port = int(os.environ.get("HCC_PORT", "8000"))
    return {"port": port}


@app.get("/health/db")
def health_db(db: Session = Depends(get_db)):
    """Confirms the backend can actually reach the PostgreSQL database."""
    db.execute(text("SELECT 1"))
    return {"database": "connected"}


# ---------------------------------------------------------------------------
# Serve the built React frontend (production mode)
#
# The React app is built with `npm run build` inside frontend/.
# That produces frontend/dist/ containing index.html + hashed JS/CSS files.
#
# We serve it here so only ONE process (this backend) needs to run —
# no separate Vite dev server required for normal day-to-day use.
#
# How it works:
#   - /assets/* → served directly from frontend/dist/assets/ (JS, CSS, images)
#   - Everything else → returns index.html (React Router handles the routing)
#
# API routes (/api/*) are registered ABOVE this block and always take
# priority — FastAPI matches routes top-to-bottom, so /api/... is never
# caught by the catch-all below.
# ---------------------------------------------------------------------------

# When frozen by PyInstaller, __file__ is unreliable and the temp-extract
# directory is exposed as sys._MEIPASS.  At that point the frontend/dist
# bundle is placed directly inside _MEIPASS.
#
# When running normally (dev or plain Python):
#   Path(__file__).parent = backend/app/
#   .parent.parent.parent  = hcc_erp_app/          (3 levels up)
#   / "frontend/dist"      = hcc_erp_app/frontend/dist  ✓
_BASE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).parent.parent.parent))
_frontend_dist = str(_BASE_DIR / "frontend" / "dist")

if os.path.exists(_frontend_dist):
    # Mount the hashed JS/CSS/font bundles that Vite produces.
    # These have content-hashed filenames so browsers cache them safely.
    app.mount(
        "/assets",
        StaticFiles(directory=os.path.join(_frontend_dist, "assets")),
        name="assets",
    )

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        """
        Catch-all that handles two cases:

        1. Real file in dist/ root (HCC_LOGO.png, favicon.svg, etc.)
           → serve the file with the correct Content-Type.

        2. React Router path (/billing, /inventory, /login, etc.)
           → serve index.html so React can take over client-side routing.
        """
        candidate = os.path.join(_frontend_dist, full_path)
        if os.path.isfile(candidate):
            # FileResponse guesses the MIME type from the file extension,
            # so PNG, SVG, and other assets get the right Content-Type.
            return FileResponse(candidate)
        return FileResponse(os.path.join(_frontend_dist, "index.html"))
