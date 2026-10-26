"""
Regression test: THE MEDICINES THE REGISTER CHECK CANNOT SEE.

Run:  python3 backend/scripts/test_generic_gaps.py
Needs the backend's own dependencies (fastapi, sqlalchemy); it drives the real
endpoints against a throwaway database under HCC_DATA_DIR.

Schedule H1 names DRUGS and the shop stocks BRANDS, so the register check
reads a product's generic name.  A medicine with no generic name recorded is
therefore invisible to it - however regulated the medicine actually is.  This
pharmacy had 205 of them.

The case that matters is ZOLO 50 TAB: a brand name containing no drug name at
all, whose generic name is Tramadol.  Until someone writes that down, nothing
in the app can know it belongs in the register, and it would be sold over the
counter unrecorded.  So the test checks the whole loop - the gap is listed,
filling it in is saved, and the medicine that was hiding is reported back
immediately rather than waiting to be noticed.

It also checks what must NOT happen: filling in a generic name never flags
anything by itself.  Matches come back as proposals and a person still
decides, exactly as on the review screen.
"""
import os, sys, shutil
from pathlib import Path
sandbox = os.path.join(os.path.expanduser("~"), ".hcc_test_gaps")
shutil.rmtree(sandbox, ignore_errors=True); os.makedirs(sandbox)
os.environ["HCC_DATA_DIR"] = sandbox
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import SessionLocal, init_db
from app.models.inventory import Product
from app.routers.regulated import (
    list_missing_generic, fill_generic_names, list_candidates,
    FillGenericRequest, GenericFill,
)

init_db(); db = SessionLocal()
db.add_all([
    Product(name="MIFEGEST KIT",   generic_name="",   gst_rate=12, min_stock_level=1),
    Product(name="ZOLO 50 TAB",    generic_name=None, gst_rate=12, min_stock_level=1),
    Product(name="SOME SYRUP",     generic_name="",   gst_rate=12, min_stock_level=1),
    Product(name="DOLO 650 TAB",   generic_name="Paracetamol 650mg", gst_rate=12, min_stock_level=1),
])
db.commit()

fails = []
def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: got {got!r}, want {want!r}")
    if not ok: fails.append(label)

print("[1] The gap list")
miss = list_missing_generic(db=db, _=None)
check("three medicines with no generic", sorted(m.name for m in miss),
      ["MIFEGEST KIT", "SOME SYRUP", "ZOLO 50 TAB"])
check("DOLO is not in it", any(m.name == "DOLO 650 TAB" for m in miss), False)
check("register check cannot see them", list_candidates(include_decided=False, db=db, _=None).unmatchable, 3)

print("\n[2] Filling them in - and the one that was hiding")
ids = {p.name: p.id for p in db.query(Product).all()}
res = fill_generic_names(FillGenericRequest(fills=[
    GenericFill(product_id=ids["ZOLO 50 TAB"],  generic_name="Tramadol 50 MG"),
    GenericFill(product_id=ids["SOME SYRUP"],   generic_name="Ambroxol 15mg"),
    GenericFill(product_id=ids["MIFEGEST KIT"], generic_name="Mifepristone + Misoprostol"),
]), db=db, _=None)
check("three saved", res.saved, 3)
check("ONE turned out regulated", [c.name for c in res.now_matching], ["ZOLO 50 TAB"])
check("and it says which drug", res.now_matching[0].matched_drug, "tramadol")
# ZOLO is a brand name that contains no drug name at all -- it was completely
# invisible until its generic name existed.  That is the whole point.
check("MIFEGEST not auto-flagged (MTP is set by hand)",
      any(c.name == "MIFEGEST KIT" for c in res.now_matching), False)

print("\n[3] The gap is closed")
check("nothing left without a generic", len(list_missing_generic(db=db, _=None)), 0)
cands = list_candidates(include_decided=False, db=db, _=None)
check("unmatchable now zero", cands.unmatchable, 0)
check("ZOLO now proposed", [c.name for c in cands.items], ["ZOLO 50 TAB"])
check("still nothing flagged without a person", 
      sum(1 for p in db.query(Product).all() if p.register_category), 0)

print("\n[4] Saving the same name twice is not a change")
res2 = fill_generic_names(FillGenericRequest(fills=[
    GenericFill(product_id=ids["ZOLO 50 TAB"], generic_name="Tramadol 50 MG"),
]), db=db, _=None)
check("nothing saved", res2.saved, 0)

print("\n" + "="*58)
print("ALL PASSED" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
