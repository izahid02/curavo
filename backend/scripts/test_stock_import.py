"""
Regression test: OPENING STOCK FROM EXCEL (Medicines -> Import from Excel).

Run:  python3 backend/scripts/test_stock_import.py
Runs the shop app on a throwaway folder (HCC_DATA_DIR) - never the real data.

What it holds the system to:
  * The template downloads, and an empty template is refused plainly.
  * Every row is checked first; nothing is saved by "check".
  * Strip medicines: strips (+ loose) become TABLETS, per-strip prices become
    per-tablet prices at 4 decimals - and a whole strip then BILLS at exactly
    the MRP typed in the sheet (the Rs 100 / 15 tablets case).
  * Problem rows are skipped with a plain reason (expired, bad type, a syrup
    "in strips", missing MRP, wrong GST...), warnings are imported.
  * Opening stock makes a StockMovement IN, no purchase row, no supplier debt.
  * An existing medicine gets the new batch; uploading the same file twice
    imports nothing twice.
  * A backup is taken before the import; staff cannot import.
  * Possible Schedule H1 medicines are counted, never set.
"""
import io, os, shutil, sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sandbox = Path(os.path.expanduser("~")) / ".hcc_test_stock_import"
shutil.rmtree(sandbox, ignore_errors=True)
sandbox.mkdir(parents=True)
os.environ["HCC_DATA_DIR"] = str(sandbox)          # BEFORE any app import
os.environ.pop("CURAVO_CLOUD_URL", None)
sys.path.insert(0, str(ROOT / "backend"))

from fastapi.testclient import TestClient           # noqa: E402
from openpyxl import Workbook, load_workbook        # noqa: E402

from app.main import app                            # noqa: E402
from app.database import SessionLocal               # noqa: E402
from app.models.inventory import Batch, Product, StockMovement, StockPurchase   # noqa: E402
from app.models.supplier_credit import SupplierCreditTransaction               # noqa: E402

FAILS = []

def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"\n        got:  {got!r}\n        want: {want!r}"))
    if not ok:
        FAILS.append(label)

HEAD = ["Medicine name *", "Type *", "Tablets per strip", "Quantity *", "Loose tablets", "MRP *", "Cost price",
        "GST % *", "Batch no.", "Expiry (MM/YYYY) *", "Generic name", "Manufacturer", "HSN code", "Rack", "Barcode"]

def xlsx(rows, head=HEAD, sheet="Medicines"):
    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    ws.append(head)
    for r in rows:
        ws.append(r)
    b = io.BytesIO()
    wb.save(b)
    return b.getvalue()

soon = (date.today() + timedelta(days=10)).strftime("%m/%Y")
old = (date.today().replace(day=1) - timedelta(days=40)).strftime("%m/%Y")
good = f"{(date.today().year + 2)}"

ROWS = [
    # name,            type,      strip, qty, loose, mrp,    cost,  gst, batch,   expiry,       generic,                maker
    ["SEVEN TAB 100",  "Tablet",  15,    2,   5,     100,    70,    5,   "S1",    f"06/{good}", "Paracetamol 500mg",    "Acme"],
    ["COLIZA LIQUID",  "Drops",   None,  6,   None,  99,     81.8,  5,   "CZ1",   f"03/{good}", "Simethicone",          ""],
    ["NOBATCH CAP",    "capsule", 10,    3,   None,  50,     None,  12,  None,    f"Dec-{good}", "",                    ""],
    ["SOON TAB",       "Tablet",  10,    1,   None,  20,     10,    5,   "SN1",   soon,         "",                     ""],
    ["LEVO 500 TAB",   "Tablet",  10,    1,   None,  60,     40,    12,  "LV1",   f"01/{good}", "Levofloxacin 500mg",   ""],
    # problems
    ["OLD TAB",        "Tablet",  10,    1,   None,  20,     10,    5,   "OLD1",  old,          "", ""],
    ["WEIRD",          "Potion",  None,  1,   None,  20,     10,    5,   "W1",    f"01/{good}", "", ""],
    ["SYRUP STRIPS",   "Syrup",   10,    1,   None,  20,     10,    5,   "SS1",   f"01/{good}", "", ""],
    ["NO MRP TAB",     "Tablet",  10,    1,   None,  None,   10,    5,   "NM1",   f"01/{good}", "", ""],
    ["BAD GST TAB",    "Tablet",  10,    1,   None,  20,     10,    7,   "BG1",   f"01/{good}", "", ""],
    ["BAD EXP TAB",    "Tablet",  10,    1,   None,  20,     10,    5,   "BE1",   "sometime",   "", ""],
    ["SEVEN TAB 100",  "Tablet",  15,    1,   None,  100,    70,    5,   "S1",    f"06/{good}", "", ""],     # same batch twice in file
    [None, None, None, None, None, None, None, None, None, None, None, None],                                      # blank row: ignored
]

with TestClient(app, raise_server_exceptions=False) as c:
    tok = c.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["token"]["access_token"]
    H = {"Authorization": f"Bearer {tok}"}

    print("[1] The template")
    r = c.get("/api/stock-import/template", headers=H)
    check("downloads", (r.status_code, r.headers["content-type"].endswith("spreadsheetml.sheet")), (200, True))
    wb = load_workbook(io.BytesIO(r.content))
    check("has Medicines, How to fill and Example sheets", wb.sheetnames, ["Medicines", "How to fill", "Example"])
    check("headings in order", [c_.value for c_ in wb["Medicines"][1]], HEAD)
    r = c.post("/api/stock-import/check", headers=H, files={"file": ("t.xlsx", r.content)})
    check("empty template -> a plain message", (r.status_code, "No medicines" in r.json()["detail"]), (400, True))
    r = c.post("/api/stock-import/check", headers=H, files={"file": ("x.xlsx", b"not excel")})
    check("not an Excel file -> a plain message", (r.status_code, "not an Excel file" in r.json()["detail"]), (400, True))
    r = c.post("/api/stock-import/check", headers=H, files={"file": ("x.xlsx", xlsx([["A", "Tablet"]], head=["Medicine name", "Type"]))})
    check("missing columns are named", (r.status_code, "Quantity" in r.json()["detail"] or "headings" in r.json()["detail"]), (400, True))

    print("[2] Check: every row judged, nothing saved")
    f = xlsx(ROWS)
    r = c.post("/api/stock-import/check", headers=H, files={"file": ("stock.xlsx", f)})
    check("checked", r.status_code, 200)
    res = {x["row"]: x for x in r.json()["rows"]}
    st = lambda n: res[n]["status"]
    check("strip medicine OK", st(2), "ok")
    check("...described in strips and tablets", res[2]["summary"].startswith("2 strips + 5 loose (35 tablets)"), True)
    check("drops (one by one) OK", st(3), "ok")
    check("no batch / no cost -> warnings, still imported", (st(4), any("OPEN-" in m for m in res[4]["messages"]),
          any("No cost price" in m for m in res[4]["messages"])), ("warning", True, True))
    check("expires within 30 days -> warning", (st(5), "cannot be billed" in " ".join(res[5]["messages"])), ("warning", True))
    check("expired -> problem", (st(7), "expired" in res[7]["messages"][0].lower()), ("error", True))
    check("unknown type -> problem", st(8), "error")
    check("a syrup in strips -> problem", ("Only tablets and capsules" in " ".join(res[9]["messages"])), True)
    check("no MRP -> problem", ("MRP is empty" in " ".join(res[10]["messages"])), True)
    check("GST 7% -> problem", ("GST %" in " ".join(res[11]["messages"])), True)
    check("expiry not a month -> problem", st(12), "error")
    check("same batch twice in the file -> problem", (st(13), "another row" in " ".join(res[13]["messages"])), ("error", True))
    check("blank rows ignored", 14 in res, False)
    check("counts", r.json()["counts"], {"ok": 3, "warning": 2, "error": 7})
    db = SessionLocal()
    check("check saved nothing", db.query(Product).filter(Product.name == "SEVEN TAB 100").count(), 0)
    db.close()

    print("[3] Staff cannot import")
    from app.models.user import Role, User
    from app.services.auth_service import hash_password
    sdb = SessionLocal()
    role = sdb.query(Role).filter(Role.name.notin_(["Owner", "Administrator"])).first()
    if role is None:
        role = Role(name="Pharmacist"); sdb.add(role); sdb.flush()
    sdb.add(User(username="staff9", full_name="Staff", password_hash=hash_password("staff-pass-9"), role_id=role.id))
    sdb.commit(); sdb.close()
    st_tok = c.post("/api/auth/login", json={"username": "staff9", "password": "staff-pass-9"}).json()["token"]["access_token"]
    check("staff -> 403", c.post("/api/stock-import/import", headers={"Authorization": f"Bearer {st_tok}"},
                                  files={"file": ("s.xlsx", f)}).status_code, 403)

    print("[4] Import")
    backups_before = len(list((sandbox / "backups").glob("manual_*.db"))) if (sandbox / "backups").exists() else 0
    r = c.post("/api/stock-import/import", headers=H, files={"file": ("stock.xlsx", f)})
    check("imported", r.status_code, 200)
    out = r.json()
    check("result", (out["medicines_added"], out["batches_added"], out["skipped"]), (5, 5, 7))
    check("possible Schedule H1 counted (Levofloxacin)", out["maybe_schedule_h1"], 1)
    check("a backup was taken first", len(list((sandbox / "backups").glob("manual_*.db"))), backups_before + 1)
    db = SessionLocal()
    p = db.query(Product).filter(Product.name == "SEVEN TAB 100").one()
    b = db.query(Batch).filter(Batch.product_id == p.id).one()
    check("strip product", (p.is_strip, p.units_per_strip, p.medicine_type, p.strip_mrp, p.gst_rate), (True, 15, "TABLET", Decimal("100.00"), Decimal("5.00")))
    check("stock in TABLETS (2 x 15 + 5)", (b.quantity_available, b.quantity_received), (35, 35))
    check("per-tablet MRP at 4 decimals", (b.mrp, b.selling_price), (Decimal("6.6667"), Decimal("6.6667")))
    check("per-tablet cost before GST", (b.purchase_price, b.effective_cost_per_unit), (Decimal("4.6667"), Decimal("4.6667")))
    check("expiry = last day of the month", (b.expiry_date.month, b.expiry_date.day), (6, 30))
    check("details kept", (p.generic_name, p.manufacturer), ("Paracetamol 500mg", "Acme"))
    check("Schedule H1 NOT set by the import", db.query(Product).filter(Product.name == "LEVO 500 TAB").one().register_category, None)
    mv = db.query(StockMovement).filter(StockMovement.batch_id == b.id).all()
    check("one movement IN, marked opening stock", [(m.movement_type, m.quantity, m.reference) for m in mv], [("IN", 35, "OPENING-IMPORT")])
    check("no purchase rows", db.query(StockPurchase).count(), 0)
    check("no supplier debt", db.query(SupplierCreditTransaction).count(), 0)
    d = db.query(Product).filter(Product.name == "COLIZA LIQUID").one()
    db_b = db.query(Batch).filter(Batch.product_id == d.id).one()
    check("drops: pieces, price per piece", (d.is_strip, db_b.quantity_available, db_b.mrp), (False, 6, Decimal("99.0000")))
    nb = db.query(Batch).join(Product).filter(Product.name == "NOBATCH CAP").one()
    check("blank batch -> OPEN-YYMM", nb.batch_number, f"OPEN-{str(int(good))[2:]}12")
    seven_id, seven_batch = p.id, b.id
    db.close()

    print("[5] A whole strip bills at exactly the printed MRP")
    r = c.post("/api/billing/invoices", headers=H, json={"items": [{"product_id": seven_id, "batch_id": seven_batch, "quantity": 15}],
                                                       "payment_method": "CASH"})
    check("bill made", r.status_code in (200, 201), True)
    check("15 tablets = Rs 100.00, not 100.05", Decimal(str(r.json()["total_amount"])), Decimal("100.00"))

    print("[6] The same file again imports nothing twice")
    r = c.post("/api/stock-import/check", headers=H, files={"file": ("stock.xlsx", f)})
    again = {x["row"]: x for x in r.json()["rows"]}
    check("known batch -> problem 'already in stock'", (again[2]["status"], "already in stock" in " ".join(again[2]["messages"])), ("error", True))
    check("nothing importable", r.json()["counts"]["ok"] + r.json()["counts"]["warning"], 0)
    check("import refused plainly", c.post("/api/stock-import/import", headers=H, files={"file": ("stock.xlsx", f)}).status_code, 400)

    print("[7] An existing medicine gets the new batch; its identity stays")
    f2 = xlsx([["seven tab 100", "Tablet", 15, 1, None, 105, 72, 12, "S2", f"09/{good}", "", "Other maker"],
               ["SEVEN TAB 100", "Tablet", 10, 1, None, 105, 72, 5, "S3", f"09/{good}", "", ""]])
    r = c.post("/api/stock-import/check", headers=H, files={"file": ("more.xlsx", f2)})
    rr = r.json()["rows"]
    check("same name, any case -> new batch, GST difference only warned", (rr[0]["status"], "GST" in " ".join(rr[0]["messages"])), ("warning", True))
    check("a different 'per strip' -> problem", (rr[1]["status"], "Already in Curavo as 15 per strip" in " ".join(rr[1]["messages"])), ("error", True))
    c.post("/api/stock-import/import", headers=H, files={"file": ("more.xlsx", f2)})
    db = SessionLocal()
    p = db.query(Product).filter(Product.name == "SEVEN TAB 100").one()
    check("no second medicine made", db.query(Product).filter(Product.name.ilike("seven tab 100")).count(), 1)
    check("two batches now", db.query(Batch).filter(Batch.product_id == p.id).count(), 2)
    check("its GST and maker unchanged", (p.gst_rate, p.manufacturer), (Decimal("5.00"), "Acme"))
    check("shows the newest strip price", p.strip_mrp, Decimal("105.00"))
    db.close()

    print("[8] Other spreadsheets: heading not on row 1, other heading names, Excel dates")
    from datetime import datetime as dt
    wb = Workbook(); ws = wb.active; ws.title = "Stock"
    ws.append(["My shop stock list"]); ws.append([])
    ws.append(["Item Name", "Form", "Pack", "Qty", "M.R.P", "Rate", "GST", "Batch", "Exp"])
    ws.append(["MARG STYLE TAB", "Tablet", 10, 4, 45, 30, 5, "MG1", dt(int(good), 11, 1)])
    bio = io.BytesIO(); wb.save(bio)
    r = c.post("/api/stock-import/check", headers=H, files={"file": ("marg.xlsx", bio.getvalue())})
    check("read", r.status_code, 200)
    row = r.json()["rows"][0]
    check("understood", (row["status"], row["summary"].startswith("4 strips (40 tablets)")), ("ok", True))

    print("[9] Imported stock works on every other screen (it has no purchase row)")
    for label, url in [("expiry alerts", "/api/inventory/alerts/expiry"), ("batch panel", f"/api/inventory/batches/{seven_id}"),
                       ("medicine search", "/api/search/medicines?q=SEVEN"), ("products list", "/api/inventory/products?search=SEVEN"),
                       ("inventory report", "/api/reports/inventory"), ("low stock", "/api/inventory/alerts/low-stock"),
                       ("dashboard", "/api/dashboard/summary"), ("purchase history", "/api/inventory/purchase-history/by-supplier")]:
        check(f"{label} opens", c.get(url, headers=H).status_code, 200)
    exp = c.get("/api/inventory/alerts/expiry", headers=H).json()
    check("the soon-expiring import shows in the 30-day alert",
          any("SOON TAB" in str(x) for x in exp.get("expires_30", [])), True)
    srch = c.get("/api/search/medicines?q=SEVEN", headers=H).json()
    rows_ = srch if isinstance(srch, list) else srch.get("results", srch.get("items", []))
    check("search offers both batches", sorted(x.get("batch_number") for x in rows_ if x.get("batch_number")), ["S1", "S2"])

shutil.rmtree(sandbox, ignore_errors=True)
print("\n" + "=" * 58)
print("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
