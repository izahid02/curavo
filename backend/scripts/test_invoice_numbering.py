"""
Regression test: INVOICE NUMBERS - GAPLESS, THE SHOP'S OWN PREFIX, GST-LENGTH.

Run:  python3 backend/scripts/test_invoice_numbering.py
Needs the backend's own dependencies (fastapi, sqlalchemy, httpx); it drives
the real endpoints against a throwaway database under HCC_DATA_DIR.

The bugs this guards
--------------------
1. GAPS.  The number used to be taken first and committed on its own, so a bill
   refused later (not enough stock; a Schedule H1 bill without the prescriber's
   details) burned a number no invoice ever carried.  Reproduced on a copy of
   the shop's data: a refused bill took 000006, the next bill became 000007.
   GST requires consecutive numbers.
2. EVERY SHOP WAS "HCC-".  The prefix was typed into the code.
3. LENGTH.  GST caps an invoice number at 16 characters; "-YYYY-NNNNNN" is 12,
   so a prefix may be at most 4.

Checks: a new shop, prefix validation, refused bills leave no gap, the
prefix locks once the year's first bill exists, two bills at once get two
consecutive numbers, an upgraded shop (no prefix saved) continues ITS OWN
series, and purchase orders follow the prefix.
"""
import os, sys, shutil, threading
from datetime import date
from pathlib import Path

sandbox = os.path.join(os.path.expanduser("~"), ".hcc_test_invoice_numbering")
shutil.rmtree(sandbox, ignore_errors=True)
os.makedirs(sandbox)
os.environ["HCC_DATA_DIR"] = sandbox          # BEFORE any app import
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient     # noqa: E402
from sqlalchemy import text                    # noqa: E402
from app.main import app                       # noqa: E402
from app.database import SessionLocal          # noqa: E402

YEAR = date.today().year
FAILS = []

def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"\n        got:  {got!r}\n        want: {want!r}"))
    if not ok:
        FAILS.append(label)

with TestClient(app) as c:
    tok = c.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["token"]["access_token"]
    H = {"Authorization": f"Bearer {tok}"}

    def ok(r, what):
        assert r.status_code < 300, f"{what}: {r.status_code} {r.text[:300]}"
        return r.json()

    def numbering():
        return ok(c.get("/api/settings/invoice-numbering", headers=H), "numbering")

    def set_prefix(p):
        return c.put("/api/settings/pharmacy", headers=H, json={"pharmacy_name": "Test Shop", "invoice_prefix": p})

    # One supplier and one medicine with plenty of stock (100 units)
    sup = ok(c.post("/api/suppliers/", headers=H, json={"name": "Test Distributor"}), "supplier")
    prod = ok(c.post("/api/inventory/products", headers=H, json={"name": "TEST TAB", "gst_rate": "5", "medicine_type": "TABLET"}), "product")
    ok(c.post("/api/inventory/add-stock", headers=H, json={
        "product_id": prod["id"], "supplier_id": sup["id"], "supplier_invoice_number": "T-1",
        "supplier_invoice_date": str(date.today()), "batch_number": "B1", "quantity": 100,
        "expiry_date": f"{YEAR + 2}-12", "mrp": "10", "cost_price": "6",
        "payment_mode": "CASH", "supplier_invoice_total": "630.00", "amount_paid": "630.00"}), "stock")

    def bill(qty=1, **extra):
        return c.post("/api/billing/invoices", headers=H,
                      json={"items": [{"product_id": prod["id"], "quantity": qty}], "payment_method": "CASH", **extra})

    # ------------------------------------------------------------------
    print("[1] A brand-new shop")
    n = numbering()
    check("prefix before any setup", n["prefix"], "INV")
    check("not locked before the first bill", n["locked"], False)
    check("next number preview", n["next_number"], f"INV-{YEAR}-000001")

    print("[2] Prefix validation (GST: whole number max 16 characters)")
    check("'SUNRISE' (7 chars) refused", set_prefix("SUNRISE").status_code, 400)
    check("'S M' refused", set_prefix("S M").status_code, 400)
    check("' sm- ' accepted", set_prefix(" sm- ").status_code, 200)
    check("...and saved as 'SM'", numbering()["prefix"], "SM")

    print("[3] First bill")
    first = ok(bill(), "bill 1")["invoice_number"]
    check("first invoice number", first, f"SM-{YEAR}-000001")
    check("within GST's 16 characters", len(first) <= 16, True)

    print("[4] Refused bills leave NO gap")
    check("bill for more than the stock is refused", bill(qty=999).status_code, 400)
    check("next bill continues the series", ok(bill(), "bill 2")["invoice_number"], f"SM-{YEAR}-000002")
    db = SessionLocal()
    db.execute(text("UPDATE products SET register_category = 'H1' WHERE id = :i"), {"i": prod["id"]}); db.commit()
    check("Schedule H1 bill without details is refused", bill().status_code, 400)
    db.execute(text("UPDATE products SET register_category = NULL WHERE id = :i"), {"i": prod["id"]}); db.commit()
    check("next bill still continues", ok(bill(), "bill 3")["invoice_number"], f"SM-{YEAR}-000003")
    movements = db.execute(text(
        "SELECT reference FROM stock_movements WHERE movement_type = 'SALE' ORDER BY id")).scalars().all()
    check("stock movements carry their invoice numbers",
          movements, [f"SM-{YEAR}-00000{i}" for i in (1, 2, 3)])

    print("[5] The prefix locks once this year's first bill exists")
    check("numbering says locked", numbering()["locked"], True)
    check("changing to 'XY' is refused (409)", set_prefix("XY").status_code, 409)
    check("re-saving the same prefix is fine", set_prefix("SM").status_code, 200)
    check("saving with the prefix blank keeps it", set_prefix("").status_code, 200)
    check("prefix unchanged", numbering()["prefix"], "SM")

    print("[6] Two bills at the same moment get two consecutive numbers")
    got, errs = [], []
    def worker():
        for _ in range(5):
            r = bill()
            (got if r.status_code < 300 else errs).append(r.json().get("invoice_number") if r.status_code < 300 else r.text[:120])
    threads = [threading.Thread(target=worker) for _ in range(2)]
    [t.start() for t in threads]; [t.join() for t in threads]
    check("no errors under concurrency", errs, [])
    check("10 distinct numbers", len(set(got)), 10)
    check("exactly 000004 .. 000013", sorted(got), [f"SM-{YEAR}-{i:06d}" for i in range(4, 14)])

    print("[7] An upgraded shop (no prefix saved) continues ITS OWN series")
    db.execute(text("UPDATE invoices SET invoice_number = replace(invoice_number, 'SM-', 'HCC-')"))
    db.execute(text("UPDATE pharmacy_settings SET invoice_prefix = NULL")); db.commit()
    check("prefix read from the last invoice", numbering()["prefix"], "HCC")
    check("next bill", ok(bill(), "upgrade bill")["invoice_number"], f"HCC-{YEAR}-000014")
    db.expire_all()
    check("...and the prefix is now saved", db.execute(text("SELECT invoice_prefix FROM pharmacy_settings")).scalar(), "HCC")

    print("[8] Purchase orders follow the shop's prefix")
    from app.services.purchasing_service import get_next_po_number
    check("PO number prefix", get_next_po_number(db).startswith(f"HCC-PO-{YEAR}-"), True)

    print("[9] The ledger agrees: no gaps, no duplicates")
    nums = db.execute(text("SELECT invoice_number FROM invoices ORDER BY invoice_number")).scalars().all()
    seqs = sorted(int(x[-6:]) for x in nums)
    check("invoice sequence is 1..N with no holes", seqs, list(range(1, len(seqs) + 1)))
    db.close()

shutil.rmtree(sandbox, ignore_errors=True)
print("\n" + "=" * 58)
print("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
