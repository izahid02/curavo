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
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db, SessionLocal, init_db
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


# ---------------------------------------------------------------------------
# Startup: create a default admin user on a fresh installation
# ---------------------------------------------------------------------------

def _seed_admin() -> None:
    """
    If there are no users in the database yet, create a default Owner account
    so the pharmacy can log in on the very first run without manually inserting
    rows.

    Credentials:  username = admin   password = admin123
    The owner should change the password after the first login.
    """
    db = SessionLocal()
    try:
        # Import here (inside the function) to avoid any import-order issues
        # that could appear if the models aren't fully registered yet.
        from app.models.user import Role, User
        from app.services.auth_service import hash_password

        if db.query(User).count() > 0:
            return  # Users already exist — nothing to do

        # The "Owner" role should already exist from the schema.sql seed data.
        # If for some reason it doesn't (e.g. fresh DB without seed), create it.
        role = db.query(Role).filter(Role.name == "Owner").first()
        if role is None:
            role = Role(name="Owner")
            db.add(role)
            db.flush()   # flush so role.id is assigned before we use it below

        admin = User(
            username="admin",
            full_name="Administrator",
            password_hash=hash_password("admin123"),
            role_id=role.id,
            is_active=True,
        )
        db.add(admin)
        db.commit()
        print("✅ Default admin user created  (username: admin  password: admin123)")
        print("   ⚠️  Change this password before going live.")
    except Exception as exc:
        db.rollback()
        print(f"⚠️  Could not create admin user on startup: {exc}")
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
        print(f"✅ Seeded {len(default_tags)} default patient tags")
    except Exception as exc:
        db.rollback()
        print(f"⚠️  Could not seed patient tags: {exc}")
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
        print(f"✅ Seeded {len(defaults)} default doctors")
    except Exception as exc:
        db.rollback()
        print(f"⚠️  Could not seed doctors on startup: {exc}")
    finally:
        db.close()


def _run_db_migrations() -> None:
    """
    Apply incremental column additions that were introduced after the initial
    schema was created.  Each ALTER TABLE is wrapped in its own try/except so
    that an already-existing column (which raises an error on SQLite) is
    silently skipped rather than aborting the whole migration block.

    Fresh installs: init_db() (called just before this) creates all columns
    via create_all(), so these ALTER TABLE statements are no-ops that raise
    and are caught.

    Existing databases being upgraded: init_db() skips existing tables, so
    these statements add any columns that were added in later phases.

    Phase 3.3 additions:
      products.days_per_unit              — pharmacist override for refill calc
      invoice_items.estimated_finish_date — predicted supply run-out date
    """
    db = SessionLocal()
    try:
        # Wrap each column addition separately — SQLite raises an error if the
        # column already exists (unlike PostgreSQL's IF NOT EXISTS), so we
        # catch and ignore that specific error for each column independently.
        try:
            db.execute(text("ALTER TABLE products ADD COLUMN days_per_unit INTEGER"))
            db.commit()
        except Exception:
            db.rollback()  # column already exists — safe to ignore

        try:
            db.execute(text("ALTER TABLE invoice_items ADD COLUMN estimated_finish_date DATE"))
            db.commit()
        except Exception:
            db.rollback()  # column already exists — safe to ignore

        # Phase 3 credit management: amount_paid and credit_amount on invoices
        for stmt in [
            "ALTER TABLE invoices ADD COLUMN amount_paid NUMERIC(12,2) DEFAULT 0",
            "ALTER TABLE invoices ADD COLUMN credit_amount NUMERIC(12,2) DEFAULT 0",
            "ALTER TABLE invoices ADD COLUMN credit_due_date DATE",
        ]:
            try:
                db.execute(text(stmt))
                db.commit()
            except Exception:
                db.rollback()

        # Phase 3 follow-up template improvements
        for stmt in [
            "ALTER TABLE message_templates ADD COLUMN day INTEGER",
            "ALTER TABLE message_templates ADD COLUMN tag_filter VARCHAR(60)",
            "ALTER TABLE message_templates ADD COLUMN is_active INTEGER DEFAULT 1",
            "ALTER TABLE follow_up_schedules ADD COLUMN sent_at TIMESTAMPTZ",
        ]:
            try:
                db.execute(text(stmt))
                db.commit()
            except Exception:
                db.rollback()  # column already exists — safe to ignore

        # Credit: how a repayment was received (CASH / UPI) on PAYMENT rows
        try:
            db.execute(text("ALTER TABLE credit_transactions ADD COLUMN payment_mode TEXT"))
            db.commit()
        except Exception:
            db.rollback()  # column already exists — safe to ignore

        # Credit: permanent "was late at some point" marker for defaulter history
        try:
            db.execute(text(
                "ALTER TABLE credit_transactions ADD COLUMN was_overdue INTEGER DEFAULT 0"
            ))
            db.commit()
            # Backfill: anything sitting in OVERDUE right now is, by definition,
            # already late — mark it so day-one data is not silently wrong.
            # Transactions that were late but have since been paid cannot be
            # recovered (the status was overwritten), so history starts here.
            db.execute(text(
                "UPDATE credit_transactions SET was_overdue = 1 WHERE status = 'OVERDUE'"
            ))
            db.commit()
        except Exception:
            db.rollback()  # column already exists — safe to ignore

        # Account menu: profile contact details + avatar photo on users
        for stmt in [
            "ALTER TABLE users ADD COLUMN email TEXT",
            "ALTER TABLE users ADD COLUMN phone TEXT",
            "ALTER TABLE users ADD COLUMN avatar_path TEXT",
        ]:
            try:
                db.execute(text(stmt))
                db.commit()
            except Exception:
                db.rollback()  # column already exists — safe to ignore

        # Strip/unit medicine management (Feature 3).
        #
        # Tablets and capsules arrive in strips but are often sold as loose
        # individual tablets.  Stock is ALWAYS stored in individual units;
        # units_per_strip is what lets the UI show "15 strips (150 units)"
        # and lets billing price a sale either way.
        for stmt in [
            "ALTER TABLE products ADD COLUMN medicine_type TEXT DEFAULT 'TABLET'",
            "ALTER TABLE products ADD COLUMN is_strip INTEGER DEFAULT 0",
            "ALTER TABLE products ADD COLUMN units_per_strip INTEGER",
            "ALTER TABLE products ADD COLUMN strip_mrp NUMERIC(10,2)",
            "ALTER TABLE products ADD COLUMN unit_mrp NUMERIC(10,2)",
        ]:
            try:
                db.execute(text(stmt))
                db.commit()
            except Exception:
                db.rollback()  # column already exists — safe to ignore

        # Home visit / drip administration charge on an invoice (Feature 4).
        # Stored on the invoice itself rather than as an invoice_item, because
        # it is a SERVICE charge: it has no batch, no stock movement, and — by
        # design — no GST.
        for stmt in [
            "ALTER TABLE invoices ADD COLUMN home_visit_charge NUMERIC(12,2) DEFAULT 0",
            "ALTER TABLE invoices ADD COLUMN home_visit_notes TEXT",
        ]:
            try:
                db.execute(text(stmt))
                db.commit()
            except Exception:
                db.rollback()  # column already exists — safe to ignore

        # Bonus / scheme purchase (Feature B).
        #
        # Distributors offer schemes like "5+1" (buy 5, get 1 free).  The free
        # units enter stock at zero cost.  We record the scheme on the batch (so
        # a later return values only the PAID units), on the stock purchase (so
        # Purchase History can show "50 paid + 10 bonus = 60 total"), and on the
        # supplier return (so the paid/bonus split is snapshotted at return time).
        for stmt in [
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
        ]:
            try:
                db.execute(text(stmt))
                db.commit()
            except Exception:
                db.rollback()  # column already exists — safe to ignore

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
            print("✅ Seeded default home visit charge (Rs.100)")
    except Exception as exc:
        db.rollback()
        print(f"⚠️  Could not seed home visit charge on startup: {exc}")
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
            print("✅ Admin profile details updated (full_name / email)")
    except Exception as exc:
        db.rollback()
        print(f"⚠️  Could not update admin details: {exc}")
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
                    "recent visit to Health Care Centre. Please remember to take your "
                    "medicines on time. Call us at 6001666271 if you have any questions."
                ),
                body_as = (
                    "প্ৰিয় {patient_name}, স্বাস্থ্য সেৱা কেন্দ্ৰলৈ আপোনাৰ শেহতীয়া "
                    "আগমনৰ পিছত আপুনি সুস্থ হৈ আছে বুলি আশা কৰোঁ। সময়মতে "
                    "ঔষধ খাবলৈ মনত ৰাখিব। যিকোনো প্ৰশ্নৰ বাবে 6001666271 "
                    "নম্বৰত ফোন কৰক।"
                ),
                variables = "{patient_name}",
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
                    "Call 6001666271 anytime."
                ),
                body_as = (
                    "প্ৰিয় {patient_name}, আশা কৰোঁ আপুনি ডায়েবেটিছৰ "
                    "ঔষধ আৰম্ভ কৰাৰ পিছত ভালে আছে। নিয়মিতভাৱে "
                    "ৰক্তশৰ্কৰা পৰীক্ষা কৰিবলৈ মনত ৰাখিব। "
                    "6001666271 ত যিকোনো সময়তে ফোন কৰক।"
                ),
                variables = "{patient_name}",
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
                    "Dear {patient_name}, this is a reminder from Health Care Centre. "
                    "Hope your treatment is going well. If you are running low on medicines, "
                    "visit us or call 6001666271."
                ),
                body_as = (
                    "প্ৰিয় {patient_name}, এইটো স্বাস্থ্য সেৱা কেন্দ্ৰৰ পৰা এটা "
                    "সোঁৱৰণি। আশা কৰোঁ আপোনাৰ চিকিৎসা ভালদৰে চলি আছে। "
                    "ঔষধ শেষ হ'লে আমাৰ ওচৰলৈ আহক বা 6001666271 ত ফোন কৰক।"
                ),
                variables = "{patient_name}",
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
                    "Dear {patient_name}, checking in from Health Care Centre. "
                    "Please ensure you have completed your course of medicines. "
                    "For refills or any concerns, call us at 6001666271."
                ),
                body_as = (
                    "প্ৰিয় {patient_name}, স্বাস্থ্য সেৱা কেন্দ্ৰৰ পৰা খবৰ লৈছোঁ। "
                    "অনুগ্ৰহ কৰি আপোনাৰ ঔষধৰ কোৰ্ছ সম্পূৰ্ণ কৰক। ঔষধ "
                    "নবীকৰণ বা যিকোনো সমস্যাৰ বাবে 6001666271 ত ফোন কৰক।"
                ),
                variables = "{patient_name}",
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
                    "Health Care Centre. If you need a refill for your regular medicines, "
                    "we are here to help. Call 6001666271."
                ),
                body_as = (
                    "প্ৰিয় {patient_name}, আপোনাৰ শেষ আগমনৰ পৰা এমাহ হ'ল। "
                    "যদি আপোনাৰ নিয়মীয়া ঔষধৰ বাবে নবীকৰণৰ প্ৰয়োজন, "
                    "আমি সহায় কৰিবলৈ আছোঁ। 6001666271 ত ফোন কৰক।"
                ),
                variables = "{patient_name}",
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
                    "Please visit Health Care Centre to refill your prescription. "
                    "Call us at 6001666271."
                ),
                body_as = (
                    "প্ৰিয় {patient_name}, আপোনাৰ {medicine_name} শেষ হ'ব পাৰে। "
                    "অনুগ্ৰহ কৰি স্বাস্থ্য সেৱা কেন্দ্ৰত আপোনাৰ "
                    "প্ৰেছক্ৰিপশন পূৰণ কৰিবলৈ আহক। 6001666271 ত ফোন কৰক।"
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
        print(f"✅ Message templates: {inserted} inserted, {updated} updated")
    except Exception as exc:
        db.rollback()
        print(f"⚠️  Could not seed message templates: {exc}")
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
        print(f"✅ Seeded {len(seed_data)} drug interaction rules")
    except Exception as exc:
        db.rollback()
        print(f"⚠️  Could not seed drug interactions: {exc}")
    finally:
        db.close()


def _seed_expenditure_demo() -> None:
    """
    Populate the Expenditure module with a little demo data on a fresh install
    so the new page isn't empty on first open.

    Runs only once — if any employees already exist, the whole seed is skipped
    so the owner's real staff/expenses are never touched on restart.

    Seeds:
      2 employees  — Inzamamul Hoque (Pharmacist), Demo Assistant (Shop Assistant)
      3 expenses for the current month — electricity, rent, and one advance.
    """
    from datetime import date
    from decimal import Decimal

    db = SessionLocal()
    try:
        from app.models.expenditure import Employee, Expense

        if db.query(Employee).count() > 0:
            return  # already seeded — leave real data alone

        # --- Employees ---------------------------------------------------
        emp1 = Employee(
            name="Inzamamul Hoque",
            role="Pharmacist",
            basic_salary=Decimal("8000"),
            hra=Decimal("1500"),
            travel_allowance=Decimal("500"),
            other_allowance=Decimal("0"),
            is_active=True,
        )
        emp2 = Employee(
            name="Demo Assistant",
            role="Shop Assistant",
            basic_salary=Decimal("6000"),
            hra=Decimal("1000"),
            travel_allowance=Decimal("0"),
            other_allowance=Decimal("0"),
            is_active=True,
        )
        db.add_all([emp1, emp2])
        db.flush()   # assign ids so the advance expense can reference emp1

        # --- Expenses for the current month ------------------------------
        today = date.today()
        db.add_all([
            Expense(
                date=today, category="UTILITY", description="Electricity bill",
                amount=Decimal("1500"), payment_mode="CASH", paid_to="Electricity Board",
            ),
            Expense(
                date=today, category="SHOP", description="Shop rent",
                amount=Decimal("5000"), payment_mode="CASH", paid_to="Landlord",
            ),
            Expense(
                date=today, category="ADVANCE", description="Salary advance (personal)",
                amount=Decimal("1000"), payment_mode="CASH", paid_to=emp1.name,
                employee_id=emp1.id,
            ),
        ])
        db.commit()
        print("✅ Seeded 2 demo employees + 3 demo expenses (Expenditure module)")
    except Exception as exc:
        db.rollback()
        print(f"⚠️  Could not seed expenditure demo data: {exc}")
    finally:
        db.close()


async def _daily_credit_reminders_task() -> None:
    """
    Run every 24 hours: queue any credit reminder messages that are due today.
    Wrapped in a try/except so a failure never crashes the application.
    """
    import asyncio
    import logging
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


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """
    Code before the 'yield' runs at startup; code after runs at shutdown.

    Order matters:
      1. init_db()      — create all tables that do not exist yet (SQLite)
      2. _run_db_migrations() — add columns introduced after the schema was created
      3. seed functions — populate default rows if tables are empty
      4. background tasks — start daily credit reminder scheduler
    """
    import asyncio
    init_db()            # create all tables from ORM models (no-op if they exist)
    _run_db_migrations()
    _seed_admin()
    _update_admin_details()
    _seed_tags()
    _seed_doctors()
    _seed_message_templates()
    _seed_drug_interactions()
    # _seed_expenditure_demo()  # disabled — no longer seeds demo employees/expenses on startup
    _seed_home_visit_charge()

    # Start the credit reminder background task
    task = asyncio.create_task(_daily_credit_reminders_task())
    yield   # the application runs here
    task.cancel()  # clean shutdown — stop the background loop


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Health Care Centre ERP",
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
