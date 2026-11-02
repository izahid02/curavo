"""
Regression test: PATIENT MESSAGES COME FROM *THIS* SHOP, NEVER FROM HCC.

Run:  python3 backend/scripts/test_shop_identity.py
Needs the backend's own dependencies (fastapi, sqlalchemy); it runs against a
throwaway database under HCC_DATA_DIR - the real pharmacy DB is never touched.

The bug this guards
-------------------
Curavo grew out of one pharmacy's app.  HCC's name and phone number were typed
into the follow-up / refill templates (English AND Assamese), the credit
reminders and the follow-up fallback text.  The templates are UPSERTED on every
start, so once Curavo was on a second shop's PC, every patient of that shop
would have been told to "call 6001666271" and thanked for visiting "Health
Care Centre" - by a pharmacy that is not theirs.

Templates now carry {shop_name} / {shop_name_as} / {shop_phone}, filled from
Pharmacy Settings by services/shop_identity.py.  This test checks:

  1. HCC's name / phone are not typed into any message source again.
  2. With HCC's details in settings, HCC's messages are word-for-word what
     they were before (HCC is a live shop - its patients must see no change).
  3. Another shop's messages carry ITS name and phone, with no HCC trace and
     no unfilled {placeholder}.
  4. A shop with no phone / no Assamese name still gets a readable message.
"""
import os, sys, shutil
from pathlib import Path

sandbox = os.path.join(os.path.expanduser("~"), ".hcc_test_shop_identity")
shutil.rmtree(sandbox, ignore_errors=True)
os.makedirs(sandbox)
os.environ["HCC_DATA_DIR"] = sandbox          # BEFORE any app import
BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from datetime import date                                   # noqa: E402
from decimal import Decimal                                 # noqa: E402
from app.database import SessionLocal, init_db              # noqa: E402
from app.main import (_run_db_migrations, _seed_message_templates,  # noqa: E402
                      _seed_pharmacy_settings)
from app.models.followup import MessageTemplate             # noqa: E402
from app.models.settings import PharmacySettings            # noqa: E402
from app.services.credit_service import _render_messages    # noqa: E402
from app.services.followup_service import _render_message   # noqa: E402
from app.services.shop_identity import shop_vars            # noqa: E402

FAILS = []

def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"\n        got:  {got!r}\n        want: {want!r}"))
    if not ok:
        FAILS.append(label)

HCC_TRACES = ["Health Care Centre", "Health Care \"", "6001666271", "স্বাস্থ্য সেৱা কেন্দ্ৰ"]

# ---------------------------------------------------------------------------
print("[1] No shop's name or phone is typed into message sources")
import inspect                                              # noqa: E402
import app.main as main_mod                                  # noqa: E402
import app.services.credit_service as credit_mod             # noqa: E402
import app.services.followup_service as followup_mod         # noqa: E402
sources = {
    "main._seed_message_templates": inspect.getsource(main_mod._seed_message_templates),
    "credit_service._render_messages": inspect.getsource(credit_mod._render_messages),
    "followup_service.compose_message": inspect.getsource(followup_mod.compose_message),
}
for where, src in sources.items():
    check(f"{where} carries no HCC name/phone", [t for t in HCC_TRACES if t in src], [])

# ---------------------------------------------------------------------------
init_db(); _run_db_migrations(); _seed_pharmacy_settings(); _seed_message_templates()
db = SessionLocal()

def set_shop(name, name_as=None, phone=None):
    row = db.query(PharmacySettings).first()
    row.pharmacy_name, row.pharmacy_name_as, row.pharmacy_phone = name, name_as, phone
    db.commit()

def day2(lang):
    t = db.query(MessageTemplate).filter(MessageTemplate.code == "FOLLOWUP_DAY2").first()
    body = t.body_en if lang == "en" else t.body_as
    return _render_message(body, {"patient_name": "Rupam Das", **shop_vars(db)})

print("[2] A brand-new install does not start as HCC")
check("fresh install shop name", db.query(PharmacySettings).first().pharmacy_name, "My Pharmacy")

# ---------------------------------------------------------------------------
print("[3] HCC's messages are unchanged (HCC's details entered in settings)")
set_shop("Health Care Centre", "স্বাস্থ্য সেৱা কেন্দ্ৰ", "6001666271")
check("Day 2 English",
      day2("en"),
      "Dear Rupam Das, we hope you are feeling better after your recent visit to "
      "Health Care Centre. Please remember to take your medicines on time. Call us "
      "at 6001666271 if you have any questions.")
check("Day 2 Assamese",
      day2("as"),
      "প্ৰিয় Rupam Das, স্বাস্থ্য সেৱা কেন্দ্ৰলৈ আপোনাৰ শেহতীয়া "
      "আগমনৰ পিছত আপুনি সুস্থ হৈ আছে বুলি আশা কৰোঁ। সময়মতে "
      "ঔষধ খাবলৈ মনত ৰাখিব। যিকোনো প্ৰশ্নৰ বাবে 6001666271 "
      "নম্বৰত ফোন কৰক।")
en, as_ = _render_messages("Mamoni Begum", Decimal("572"), date(2026, 11, 17), "3_DAYS_BEFORE", shop_vars(db))
check("credit reminder English", en,
      "Dear Mamoni Begum, your payment of ₹572 to Health Care Centre is due on 17 Nov 2026. "
      "Please arrange payment. Call 6001666271 for help.")
check("credit reminder Assamese starts with HCC's Assamese name",
      as_.startswith("প্ৰিয় Mamoni Begum, স্বাস্থ্য সেৱা কেন্দ্ৰলৈ"), True)

# ---------------------------------------------------------------------------
print("[4] Another shop gets ITS name and phone - no HCC, no {placeholders}")
set_shop("Sunrise Medicos", "ছানৰাইজ মেডিক'ছ", "98640 12345")
all_text = []
for t in db.query(MessageTemplate).all():
    for body in (t.body_en, t.body_as):
        if body:
            all_text.append(_render_message(body, {"patient_name": "P", "medicine_name": "M",
                                                   "medicine_list": "M", "purchase_date": "D",
                                                   **shop_vars(db)}))
for kind in ("3_DAYS_BEFORE", "DUE_DATE", "2_DAYS_AFTER"):
    all_text += list(_render_messages("P", Decimal("100"), date(2026, 11, 17), kind, shop_vars(db)))
blob = "\n".join(all_text)
check("no HCC name/phone in any rendered message", [t for t in HCC_TRACES if t in blob], [])
check("no unfilled shop placeholder", [p for p in ("{shop_name}", "{shop_name_as}", "{shop_phone}") if p in blob], [])
check("English uses the shop name", "Sunrise Medicos" in day2("en"), True)
check("English uses the shop phone", "98640 12345" in day2("en"), True)
check("Assamese uses the Assamese name", day2("as").startswith("প্ৰিয় Rupam Das, ছানৰাইজ মেডিক'ছলৈ"), True)

# ---------------------------------------------------------------------------
print("[5] Missing phone / Assamese name still reads sensibly")
set_shop("Sunrise Medicos", None, None)
check("no phone -> the shop's name instead of a blank",
      "Call us at Sunrise Medicos if you have any questions." in day2("en"), True)
check("no Assamese name -> the ordinary name", day2("as").startswith("প্ৰিয় Rupam Das, Sunrise Medicosলৈ"), True)

db.close()
shutil.rmtree(sandbox, ignore_errors=True)
print("\n" + "=" * 58)
print("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
