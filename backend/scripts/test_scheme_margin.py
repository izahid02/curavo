"""
Regression test: ONE DELIVERY, ONE MARGIN.

Run:  python3 backend/scripts/test_scheme_margin.py
Needs the backend's dependencies; it books a real delivery through add_stock()
and sells from it through create_invoice(), against a throwaway database.

The bug this guards
-------------------
The same delivery used to produce three different margins, because three
screens each read a different cost field.  Reported from the shop floor:

    DOLO 650 TAB - 10 strips of 15, Rs.24.86/strip ex-GST, 5% trade discount,
    5+1 scheme, strip MRP Rs.32.12 incl 5% GST.

      Add Stock promised   35.7%
      The batch panel said 18.7%   (rate card: no discount, no free strips)
      Reports said         23.0%   (discount, but no free strips)

Rs.236.16 bought 12 strips, so a strip cost Rs.19.68 and a tablet Rs.1.3122.
35.7% is the only true figure; the other two UNDERSTATE profit, which makes a
healthy line look marginal and leads a pharmacist to price against it.

So the checks below are not "is the number 35.7" but "do all three agree",
which is the property that actually broke.
"""
import os, sys, shutil
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

sandbox = os.path.join(os.path.expanduser("~"), ".hcc_test_margin")
shutil.rmtree(sandbox, ignore_errors=True)
os.makedirs(sandbox)
os.environ["HCC_DATA_DIR"] = sandbox
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import SessionLocal, init_db            # noqa: E402
from app.models.inventory import Batch, Product, Supplier  # noqa: E402
from app.models.user import Role, User                     # noqa: E402
from app.routers.inventory import list_product_batches_detailed  # noqa: E402
from app.schemas.billing import BillItem, CreateInvoiceRequest  # noqa: E402
from app.schemas.inventory import AddStockRequest          # noqa: E402
from app.services import costing                           # noqa: E402
from app.services.billing_service import create_invoice    # noqa: E402
from app.services.inventory_service import add_stock       # noqa: E402

FAILS = []


def check(label, got, want, tol=None):
    ok = abs(float(got) - float(want)) <= tol if tol is not None else got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: got {got}, want {want}")
    if not ok:
        FAILS.append(label)


def main():
    init_db()
    db = SessionLocal()
    role = Role(name="Owner"); db.add(role); db.flush()
    user = User(username="t", full_name="Tester", password_hash="x", role_id=role.id)
    supplier = Supplier(name="MAA DRUG AGENCY")
    product = Product(name="DOLO 650 TAB", generic_name="Paracetamol 650mg",
                      gst_rate=Decimal("5"), min_stock_level=1,
                      is_strip=True, units_per_strip=15, unit="tablet")
    db.add_all([user, supplier, product]); db.commit()

    # The delivery from the screenshot, in the per-unit basis the API receives
    # (the frontend divides a strip price by units_per_strip before sending).
    per = 15
    add_stock(db, AddStockRequest(
        product_id=product.id, supplier_id=supplier.id,
        supplier_invoice_number="wertyu", supplier_invoice_date=date.today(),
        batch_number="w34567", quantity=10 * per,
        expiry_date=(date.today() + timedelta(days=900)).strftime("%Y-%m"),
        mrp=Decimal("32.1195") / per,
        cost_price=Decimal("24.8595") / per,
        discount_percent=Decimal("5"),
        scheme_buy=5, scheme_free=1,
    ), user.id)
    db.commit()

    batch = db.query(Batch).first()

    print("[1] The delivery as booked")
    check("12 strips received (10 paid + 2 free)", batch.quantity_received, 12 * per)
    check("free units recorded", batch.bonus_quantity, 2 * per)

    print("\n[2] The cost of one tablet")
    # Rs.24.8595 less 5% = Rs.23.6165/strip, x10 = Rs.236.165 for 12 strips
    #   -> Rs.19.6804/strip -> Rs.1.3120/tablet
    cost = costing.unit_cost(batch)
    check("about Rs.1.312 a tablet", cost, Decimal("1.312"), tol=0.001)
    check("NOT the rate card Rs.1.657", abs(float(cost) - 1.657) > 0.1, True)
    check("NOT the discount-only Rs.1.574", abs(float(cost) - 1.574) > 0.1, True)
    check("kept to 4dp, not paise", float(cost) != round(float(cost), 2), True)

    print("\n[3] All three screens agree")
    mrp_ex_gst = Decimal("32.1195") / Decimal("1.05") / per       # per tablet
    expected = float(costing.margin_percent(mrp_ex_gst, cost))
    check("the true margin is ~35.7%", expected, 35.7, tol=0.2)

    panel = list_product_batches_detailed(product_id=product.id, db=db, _=None)
    panel_cost = panel.batches[0].purchase_price
    check("batch panel uses the same cost", float(panel_cost), float(cost), tol=0.0001)

    inv = create_invoice(db, CreateInvoiceRequest(
        items=[BillItem(product_id=product.id, quantity=per)],
    ), user.id)
    db.commit()
    check("billing snapshots the same cost", float(inv.items[0].purchase_price),
          float(cost), tol=0.0001)

    # The reported profit on that one strip, the way Reports computes it.
    line_ex_gst = Decimal(str(inv.items[0].line_total)) / Decimal("1.05")
    profit = line_ex_gst - Decimal(str(inv.items[0].purchase_price)) * per
    reported = float(profit / line_ex_gst * 100)
    check("reported margin matches too", reported, 35.7, tol=0.3)

    print("\n[4] No scheme, no discount - nothing changes for an ordinary delivery")
    plain = Product(name="PLAIN TAB", gst_rate=Decimal("5"), min_stock_level=1, unit="unit")
    db.add(plain); db.commit()
    add_stock(db, AddStockRequest(
        product_id=plain.id, supplier_id=supplier.id,
        supplier_invoice_number="x2", supplier_invoice_date=date.today(),
        batch_number="p1", quantity=100,
        expiry_date=(date.today() + timedelta(days=900)).strftime("%Y-%m"),
        mrp=Decimal("10"), cost_price=Decimal("8"),
    ), user.id)
    db.commit()
    pb = db.query(Batch).filter(Batch.product_id == plain.id).first()
    check("cost is simply the rate paid", float(costing.unit_cost(pb)), 8.0, tol=0.0001)

    print("\n" + "=" * 62)
    if FAILS:
        print(f"{len(FAILS)} CHECK(S) FAILED: {FAILS}")
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
