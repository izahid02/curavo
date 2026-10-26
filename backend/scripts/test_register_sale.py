"""
Regression test: THE REGISTER GATE AND THE SNAPSHOT.

Run:  python3 backend/scripts/test_register_sale.py

Needs the backend's own dependencies (fastapi, sqlalchemy). Unlike the other
guard scripts this one drives the real create_invoice() against a throwaway
SQLite database under HCC_DATA_DIR, because the wiring IS what it checks.

Two failures it exists to catch, both of which fail quietly:

  1. A bill holding a Schedule H1 medicine or an MTP kit must be REFUSED until
     the patient's name, phone and address and the prescriber's name and
     address are all there - and the refusal must leave no invoice, no
     register row and no stock deducted.  A half-written sale is worse than a
     refused one.

  2. Register rows are SNAPSHOTS.  Editing the patient afterwards must not
     change what the register says.  If this ever breaks, every entry in a
     three-year legal record rewrites itself whenever someone fixes a phone
     number.

Ordinary medicines must be untouched by all of it - checked first, because a
register that gets in the way of normal selling will be worked around.
"""
import os, sys, shutil
from pathlib import Path
from datetime import date, timedelta
from decimal import Decimal
sandbox = os.path.join(os.path.expanduser("~"), ".hcc_test_register")
shutil.rmtree(sandbox, ignore_errors=True); os.makedirs(sandbox)
os.environ["HCC_DATA_DIR"] = sandbox
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from app.database import SessionLocal, init_db
from app.models.inventory import Batch, Product
from app.models.patients import Patient
from app.models.user import User, Role
from app.models.regulated import RegulatedSale
from app.schemas.billing import BillItem, CreateInvoiceRequest
from app.services.billing_service import create_invoice

init_db(); db = SessionLocal()
role = Role(name="Owner"); db.add(role); db.flush()
user = User(username="zahid", full_name="Zahid", password_hash="x", role_id=role.id)
db.add(user); db.flush()

def product(name, generic, cat, per=15):
    p = Product(name=name, generic_name=generic, gst_rate=12, min_stock_level=10,
                is_strip=True, units_per_strip=per, register_category=cat, unit="tablet")
    db.add(p); db.flush()
    b = Batch(product_id=p.id, batch_number="B1", mrp=Decimal("6.6667"),
              purchase_price=Decimal("4"), selling_price=Decimal("6.6667"),
              expiry_date=date.today()+timedelta(days=400),
              quantity_received=300, quantity_available=300)
    db.add(b); db.flush()
    return p, b

ultracet, b1 = product("ULTRACET TAB", "Tramadol + Paracetamol", "H1")
dolo,     b2 = product("DOLO 650 TAB", "Paracetamol 650mg", None)
db.commit()

bare = Patient(name="Walk In", patient_type="GENERAL", registration_date=date.today())
full = Patient(name="Kohinur Begum", mobile="6001309960", address="Birat Nagar Chariali, Dhubri",
               patient_type="GENERAL", registration_date=date.today())
db.add_all([bare, full]); db.commit()

fails = []
def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: got {got!r}, want {want!r}")
    if not ok: fails.append(label)

def bill(**kw):
    return CreateInvoiceRequest(items=[BillItem(product_id=kw.pop("pid"), quantity=kw.pop("qty"))], **kw)

print("[1] An ordinary medicine is untouched by any of this")
inv = create_invoice(db, bill(pid=dolo.id, qty=15, patient_id=None), user.id); db.commit()
check("sale completes with no patient at all", bool(inv.invoice_number), True)
check("nothing written to the register", db.query(RegulatedSale).count(), 0)

print("\n[2] A Schedule H1 medicine is refused until the details are there")
for label, kw in (
    ("no patient",        dict(patient_id=None, referred_by="Dr A H Anchari", referred_by_address="Chamber, Dhubri")),
    ("patient, no phone or address", dict(patient_id=bare.id, referred_by="Dr A H Anchari", referred_by_address="Chamber, Dhubri")),
    ("no doctor",         dict(patient_id=full.id)),
    ("doctor, no address", dict(patient_id=full.id, referred_by="Dr A H Anchari")),
):
    try:
        create_invoice(db, bill(pid=ultracet.id, qty=15, **kw), user.id)
        db.rollback(); check(label + " -> refused", False, True)
    except HTTPException as e:
        db.rollback()
        check(label + " -> refused", e.status_code, 400)
        if label == "patient, no phone or address":
            check("   message names the medicine", "ULTRACET TAB" in e.detail, True)
            check("   message names what is missing", "patient phone number" in e.detail, True)

check("still nothing in the register", db.query(RegulatedSale).count(), 0)
check("and no stock was taken", db.query(Batch).get(b1.id).quantity_available, 300)

print("\n[3] With everything present the sale goes through and is recorded")
inv = create_invoice(db, bill(pid=ultracet.id, qty=30, patient_id=full.id,
                              referred_by="Dr A H Anchari",
                              referred_by_address="Chamber, Birat Nagar Chariali"), user.id)
db.commit()
rows = db.query(RegulatedSale).all()
check("one register row", len(rows), 1)
r = rows[0]
check("category", r.category, "H1")
check("drug named", r.drug_matched, "tramadol")
check("gazette entry recorded", r.notification, "G.S.R. 588(E) dated 30.08.2013")
check("quantity in units", r.quantity, 30)
check("quantity as a person reads it", r.quantity_label, "2 strips (30 units)")
check("patient copied", (r.patient_name, r.patient_phone), ("Kohinur Begum", "6001309960"))
check("prescriber copied", r.prescriber_name, "Dr A H Anchari")
check("prescriber address copied", r.prescriber_address, "Chamber, Birat Nagar Chariali")
check("linked to the invoice", r.invoice_number, inv.invoice_number)
check("dispenser recorded", r.dispensed_by_name, "Zahid")

print("\n[4] THE SNAPSHOT: editing the patient later must not rewrite history")
full.mobile = "9999999999"; full.address = "Somewhere else"
db.commit(); db.expire_all()
r = db.query(RegulatedSale).first()
check("register keeps the old phone", r.patient_phone, "6001309960")
check("register keeps the old address", r.patient_address, "Birat Nagar Chariali, Dhubri")

print("\n" + "="*58)
print("ALL PASSED" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
