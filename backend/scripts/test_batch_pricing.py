"""
Regression test: THE SEARCH DROPDOWN MUST QUOTE *THIS BATCH'S* PRICE.

Run:  python3 backend/scripts/test_batch_pricing.py

Background — the bug this guards against
----------------------------------------
products.strip_mrp / products.unit_mrp hold only the price of the LATEST
delivery.  search.py used to read them for every row, so every batch of a
medicine was quoted whichever price was entered last.  Two real symptoms,
both photographed in the shop:

  IROLLA TAB had two batches at ₹266.10 and ₹292.05 a strip.  The dropdown
  offered ₹292.05 for both, and FEFO sells the ₹266.10 batch first — so the
  customer was overcharged ₹25.95 on a strip whose box said otherwise.

  PANTOCID DSR showed TOTAL ₹18.40 on screen and ₹16.81 on the printed
  receipt for the same tablet: the browser priced the bill from the product
  fields while the server charged batch.selling_price.

The invariant
-------------
billing_service charges  batch.selling_price × quantity_in_units.
Whatever the dropdown shows must multiply out to exactly that, in both strip
and unit mode — otherwise the screen and the receipt disagree and the
pharmacist cannot tell which number to collect.

No FastAPI/SQLAlchemy needed: the real _strip_prices source is lifted out of
search.py and run against stub objects, so this tests the shipped code.
"""
import ast
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Optional

SEARCH_PY = Path(__file__).resolve().parents[1] / "app" / "routers" / "search.py"


def load_strip_prices():
    """Extract the real _strip_prices function from search.py and compile it."""
    tree = ast.parse(SEARCH_PY.read_text())
    fn = next(
        (n for n in tree.body
         if isinstance(n, ast.FunctionDef) and n.name == "_strip_prices"),
        None,
    )
    if fn is None:
        sys.exit("FAIL: _strip_prices not found in search.py")
    ns = {"Decimal": Decimal, "Optional": Optional,
          "Product": Product, "Batch": Batch}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), str(SEARCH_PY), "exec"), ns)
    return ns["_strip_prices"]


class Product:
    """Stub of the ORM Product — only the fields _strip_prices touches."""
    def __init__(self, is_strip=False, units_per_strip=None,
                 strip_mrp=None, unit_mrp=None):
        self.is_strip = is_strip
        self.units_per_strip = units_per_strip
        self.strip_mrp = Decimal(str(strip_mrp)) if strip_mrp is not None else None
        self.unit_mrp = Decimal(str(unit_mrp)) if unit_mrp is not None else None


class Batch:
    """Stub of the ORM Batch.  selling_price is the per-unit price billed."""
    def __init__(self, selling_price=None, mrp=None):
        self.selling_price = Decimal(str(selling_price)) if selling_price is not None else None
        self.mrp = Decimal(str(mrp)) if mrp is not None else None


def server_charges(batch, qty_units):
    """Mirror of billing_service: line_total = selling_price x units, 2dp."""
    return float(
        (batch.selling_price * Decimal(str(qty_units)))
        .quantize(Decimal("0.01"))
    )


FAILS = []


def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: got {got!r}, want {want!r}")
    if not ok:
        FAILS.append(label)



# ─── Section 7 helpers: the five-paise overcharge ──────────────────────────
#
# SQLite does not enforce a column's scale, so the full value the frontend
# sent is physically in the file.  SQLAlchemy is what rounds it, on the way
# OUT, to the scale DECLARED ON THE MODEL.  So the scale in models/*.py is
# the thing that decides what the customer is charged, and that is what these
# checks pin down.

MODELS = Path(__file__).resolve().parents[1] / "app" / "models"


def column_scale(module, class_name, field):
    """The declared scale of Column(Numeric(p, s)) for one model field."""
    tree = ast.parse((MODELS / module).read_text())
    for cls in tree.body:
        if not (isinstance(cls, ast.ClassDef) and cls.name == class_name):
            continue
        for node in cls.body:
            if not isinstance(node, ast.Assign):
                continue
            if not any(isinstance(t, ast.Name) and t.id == field
                       for t in node.targets):
                continue
            for inner in ast.walk(node.value):
                if (isinstance(inner, ast.Call)
                        and isinstance(inner.func, ast.Name)
                        and inner.func.id == "Numeric"
                        and len(inner.args) == 2):
                    return ast.literal_eval(inner.args[1])
            return None
    return None


def reads_back_as(stored, scale):
    """Mirror SQLAlchemy: a Numeric(p, s) column quantizes on the way out."""
    return Decimal(str(stored)).quantize(Decimal(1).scaleb(-scale))


def bills_at(printed_strip_price, per_strip, scale):
    """
    What the till actually charges for ONE WHOLE STRIP.

    The batch editor stores printed_price / per_strip as the per-unit price;
    billing_service then charges that price x per_strip units and quantizes
    the line total to paise.  The only variable is the column's scale.
    """
    stored = Decimal(str(printed_strip_price)) / Decimal(per_strip)
    unit = reads_back_as(stored, scale)
    return (unit * Decimal(per_strip)).quantize(Decimal("0.01"),
                                                rounding=ROUND_HALF_UP)


def main():
    _strip_prices = load_strip_prices()

    # ── 1. IROLLA TAB — the two batches that were mispriced in the shop ─────
    print("\n[1] IROLLA TAB - two batches, genuinely different prices")
    irolla = Product(is_strip=True, units_per_strip=15,
                     strip_mrp=292.05, unit_mrp=19.47)   # product = LATEST only
    b6019 = Batch(selling_price="17.74")   # Jan 2028 - FEFO, sold first
    b6199 = Batch(selling_price="19.47")   # Jun 2028

    s1, u1, _ = _strip_prices(irolla, b6019)
    s2, u2, _ = _strip_prices(irolla, b6199)
    check("batch 6019 strip price", s1, 266.10)
    check("batch 6019 unit price", u1, 17.74)
    check("batch 6199 strip price", s2, 292.05)
    check("batch 6199 unit price", u2, 19.47)
    check("the two batches no longer share a price", s1 != s2, True)

    # ── 2. PANTOCID DSR — screen Rs.18.40 vs receipt Rs.16.81 ───────────────
    print("\n[2] PANTOCID DSR - the screen/receipt mismatch")
    panto = Product(is_strip=True, units_per_strip=15,
                    strip_mrp=276.00, unit_mrp=18.40)    # stale product price
    sold = Batch(selling_price="16.81")
    _, unit_now, _ = _strip_prices(panto, sold)
    check("unit price equals the receipt", unit_now, 16.81)
    check("stale product price is not used", unit_now != 18.40, True)

    # ── 3. THE INVARIANT: screen total == server total, both modes ──────────
    # This is the test that matters.  A price that looks tidy but multiplies
    # out to something else is the bug wearing a different hat.
    print("\n[3] Screen must multiply out to exactly what the server charges")
    for label, per, unit_price, prod_strip in [
        ("IROLLA  (divides evenly)", 15, "17.74", 266.10),
        ("Rs.100 strip of 15",       15, "6.67",  100.00),  # 6.67x15 = 100.05
        ("Rs.45 strip of 10",        10, "4.50",   45.00),
        ("odd price, 12/strip",      12, "3.33",   40.00),  # 3.33x12 = 39.96
    ]:
        prod = Product(is_strip=True, units_per_strip=per, strip_mrp=prod_strip)
        batch = Batch(selling_price=unit_price)
        strip_shown, unit_shown, _ = _strip_prices(prod, batch)

        # Strip mode: frontend bills strip_shown x 1 strip; server bills per units
        check(f"{label} - 1 strip screen == server",
              round(strip_shown, 2), server_charges(batch, per))
        # Unit mode: 7 loose tablets
        check(f"{label} - 7 tablets screen == server",
              round(unit_shown * 7, 2), server_charges(batch, 7))

    # ── 4. Non-strip medicine is never quoted per strip ─────────────────────
    print("\n[4] Syrup / injection - no strip price at all")
    syrup = Product(is_strip=False)
    s, u, per = _strip_prices(syrup, Batch(selling_price="388.10"))
    check("no strip price", s, None)
    check("unit price is the batch price", u, 388.10)
    check("units_per_strip is None", per, None)

    # ── 5. Out-of-stock row has no batch to derive from ─────────────────────
    print("\n[5] Out-of-stock row falls back to the product")
    s, u, _ = _strip_prices(irolla, None)
    check("product strip price", s, 292.05)
    check("product unit price", u, 19.47)

    # ── 6. Legacy batches written before selling_price was populated ────────
    print("\n[6] Legacy batch with selling_price NULL falls back to mrp")
    s, u, _ = _strip_prices(irolla, Batch(selling_price=None, mrp="17.74"))
    check("uses batch.mrp", u, 17.74)
    check("strip derived from it", s, 266.10)

    # ── 7. A WHOLE STRIP MUST BILL AT THE PRICE PRINTED ON THE PACK ─────────
    #
    # A Rs.100 strip of 15 is Rs.6.6667 a tablet.  Stored at 2dp it reads back
    # as Rs.6.67 and 15 of them bill at Rs.100.05 -- five paise of overcharge
    # on a price printed on the box, on every strip, for every strip medicine.
    print("\n[7] Whole strip bills at the printed price (the 5-paise bug)")

    for field, module, cls in (
        ("selling_price", "inventory.py", "Batch"),
        ("mrp",           "inventory.py", "Batch"),
        ("unit_mrp",      "inventory.py", "Product"),
        ("unit_price",    "billing.py",   "InvoiceItem"),
    ):
        check(f"{cls}.{field} keeps 4 decimals",
              column_scale(module, cls, field), 4)

    # Prices that do not divide cleanly -- the ones that actually bite.
    for printed, per in (("100.00", 15), ("26.72", 20), ("16.81", 15),
                         ("245.50", 12), ("99.99", 7)):
        check(f"Rs.{printed} strip of {per} bills at Rs.{printed}",
              float(bills_at(printed, per, 4)), float(Decimal(printed)))

    # Prices that DO divide cleanly were never broken; they must stay correct.
    for printed, per in (("86.10", 15), ("292.05", 15), ("266.10", 15)):
        check(f"Rs.{printed} strip of {per} still exact",
              float(bills_at(printed, per, 4)), float(Decimal(printed)))

    # Proof this test is pointed at the right thing: at 2dp it DOES overcharge.
    check("2dp would overcharge a Rs.100 strip of 15",
          float(bills_at("100.00", 15, 2)), 100.05)

    print("\n" + "=" * 62)
    if FAILS:
        print(f"{len(FAILS)} CHECK(S) FAILED: {FAILS}")
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
