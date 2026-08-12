"""
Check the Add Stock purchase maths against REAL distributor invoices.

WHY THIS FILE EXISTS
The purchase calculation is the one place in the app where an arithmetic slip
turns into real money: it decides what we owe the supplier, what the medicine
cost us, and therefore every profit and expiry-loss figure downstream.  This
script pins it to invoices we have on paper, so a future change that "looks
fine" but shifts the order of discount and GST fails loudly instead of quietly
mis-stating supplier debt.

HOW A DISTRIBUTOR'S INVOICE WORKS (the rule being tested):
    S.Rate  −  trade discount  =  goods value
    goods value  +  GST on the GOODS VALUE  =  line total
GST is charged AFTER the discount, never on the rate card.

Run it from the backend/ folder with the venv active:

    python scripts/check_purchase_totals.py

It prints one line per check and exits non-zero if anything fails, so it can be
wired into a build later.
"""
import sys
from decimal import Decimal
from pathlib import Path

# Make "app.*" importable when this file is run directly from backend/scripts/.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.inventory_service import compute_purchase_totals  # noqa: E402


# Every failure is collected so one run reports ALL the problems, not just the
# first one — much faster to fix.
failures: list[str] = []


def check(label: str, actual, expected) -> None:
    """Compare one figure and record the result."""
    actual_d   = Decimal(str(actual))
    expected_d = Decimal(str(expected))
    ok = actual_d == expected_d
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {label:<34} {actual_d}   (expected {expected_d})")
    if not ok:
        failures.append(f"{label}: got {actual_d}, expected {expected_d}")


# ---------------------------------------------------------------------------
# Test 1 — COLIZA LIQUID, straight off a real invoice
# ---------------------------------------------------------------------------
# S.Rate ₹86.10 · Qty 3 · Discount 5% · GST 5% · not a strip medicine
#
#   discount    = 86.10 × 5%        = ₹4.305/unit
#   post-disc   = 86.10 − 4.305     = ₹81.795/unit
#   GST         = 81.795 × 5%       = ₹4.0898/unit
#   total/unit  = 81.795 + 4.0898   = ₹85.8848
#   goods (×3)  = 245.385           → ₹245.39
#   GST (on it) = 245.39 × 5%       = ₹12.27
#   INVOICE     = 245.39 + 12.27    = ₹257.66      (the old, wrong maths: 271.67)
print("\nTest 1 — COLIZA LIQUID: S.Rate 86.10, qty 3, disc 5%, GST 5%")
t1 = compute_purchase_totals(
    paid_quantity=3,
    cost_price=Decimal("86.10"),
    gst_rate=Decimal("5"),
    discount_percent=Decimal("5"),
)
check("post-discount per unit", t1["post_discount_per_unit"], "81.7950")
check("effective_cost (stored)", t1["effective_cost"],        "81.7950")
check("GST per unit",            t1["gst_per_unit"],          "4.0898")
check("total per unit",          t1["total_per_unit"],        "85.8848")
check("goods total",             t1["goods_total"],           "245.39")
check("GST total",               t1["gst_total"],             "12.27")
check("INVOICE TOTAL",           t1["invoice_total"],         "257.66")
# The invoice must not be the old pre-discount figure (258.30 + 12.92 = 271.22
# in the old code's rounding, ~271.67 in the report that prompted this fix).
if Decimal(str(t1["invoice_total"])) >= Decimal("271"):
    failures.append("invoice_total still looks like the pre-discount figure")

# ---------------------------------------------------------------------------
# Test 2 — a strip medicine, priced per strip
# ---------------------------------------------------------------------------
# S.Rate ₹60/strip of 15 · Qty 10 strips (=150 units) · Disc 5% · GST 5%
#
#   S.Rate/unit      = 60 / 15   = ₹4.00
#   post-disc/unit   = 4.00 − 0.20 = ₹3.80
#   GST/unit         = 3.80 × 5% = ₹0.19
#   total/unit       = ₹3.99
#   goods (×150)     = ₹570.00
#   GST              = ₹28.50
#   INVOICE          = ₹598.50
print("\nTest 2 — strip medicine: 60.00/strip of 15, 10 strips, disc 5%, GST 5%")
t2 = compute_purchase_totals(
    paid_quantity=150,                 # 10 strips × 15 units
    cost_price=Decimal("60.00"),       # per STRIP …
    gst_rate=Decimal("5"),
    discount_percent=Decimal("5"),
    units_per_strip=15,                # … so tell the helper to divide it down
    is_strip=True,
)
check("S.Rate per unit",         t2["s_rate"],                 "4.0000")
check("post-discount per unit",  t2["post_discount_per_unit"], "3.8000")
check("GST per unit",            t2["gst_per_unit"],           "0.1900")
check("total per unit",          t2["total_per_unit"],         "3.9900")
check("goods total",             t2["goods_total"],            "570.00")
check("GST total",               t2["gst_total"],              "28.50")
check("INVOICE TOTAL",           t2["invoice_total"],          "598.50")

# The frontend sends per-UNIT prices (it divides strips itself), so the same
# delivery entered that way must produce the identical invoice — otherwise the
# preview on screen and the stored debt disagree.
print("\nTest 2b — same delivery, entered per unit (how the frontend sends it)")
t2b = compute_purchase_totals(
    paid_quantity=150,
    cost_price=Decimal("4.0000"),      # 60 / 15, as the browser computes it
    gst_rate=Decimal("5"),
    discount_percent=Decimal("5"),
)
check("INVOICE TOTAL matches 2",  t2b["invoice_total"], t2["invoice_total"])
check("effective_cost matches 2", t2b["effective_cost"], t2["effective_cost"])

# ---------------------------------------------------------------------------
# Test 3 — the discount line equals percent × the whole goods value
# ---------------------------------------------------------------------------
# The Add Stock forms now state the saving across the WHOLE line — "5% of
# ₹258.30 = ₹12.91 saved" — so gross_goods and discount_total are the two
# figures on screen and must reconcile exactly with goods_total.  Note the
# discount is derived by SUBTRACTION (gross - goods), not as 5% of 258.30 =
# 12.915 -> 12.92; going the other way would leave the printed breakdown a
# paisa short of its own total.
print("\nTest 3 — the whole-line discount figures the form displays")
check("gross goods",     t1["gross_goods"],    "258.30")
check("discount total",  t1["discount_total"], "12.91")   # 258.30 - 245.39
check("derived percent", t1["discount_percent"], "5.00")

# ---------------------------------------------------------------------------
# Test 4 — no discount at all still behaves (nothing regressed)
# ---------------------------------------------------------------------------
# 100 units at ₹20 with 12% GST: ₹2,000 goods + ₹240 tax = ₹2,240.
print("\nTest 4 — no discount: 100 × ₹20, GST 12%")
t4 = compute_purchase_totals(
    paid_quantity=100, cost_price=Decimal("20"), gst_rate=Decimal("12"),
)
check("effective_cost = S.Rate", t4["effective_cost"], "20.0000")
check("goods total",             t4["goods_total"],    "2000.00")
check("GST total",               t4["gst_total"],      "240.00")
check("INVOICE TOTAL",           t4["invoice_total"],  "2240.00")

# ---------------------------------------------------------------------------
# Test 5 — the "Supplier invoice total" override still wins
# ---------------------------------------------------------------------------
# When the paper invoice says something else (freight, rounding), the typed
# figure is what we owe — but the breakdown lines stay as computed so the panel
# still adds up.
print("\nTest 5 — supplier invoice total override")
t5 = compute_purchase_totals(
    paid_quantity=3, cost_price=Decimal("86.10"), gst_rate=Decimal("5"),
    discount_percent=Decimal("5"), supplier_invoice_total=Decimal("260.00"),
)
check("INVOICE TOTAL (override)", t5["invoice_total"], "260.00")
check("total_cost (computed)",    t5["total_cost"],    "257.66")

# ---------------------------------------------------------------------------
# Test 6 — the invoice breakdown reconciles line by line
# ---------------------------------------------------------------------------
# gross − discount = goods, and goods + GST = total.  If these drift by a paisa
# the pharmacist sees a breakdown that does not add up, which reads as a bug
# even when the total is right.
print("\nTest 6 — the printed breakdown adds up")
check("gross − discount = goods",
      Decimal(str(t1["gross_goods"])) - Decimal(str(t1["discount_total"])),
      t1["goods_total"])
check("goods + GST = total",
      Decimal(str(t1["goods_total"])) + Decimal(str(t1["gst_total"])),
      t1["total_cost"])

# ---------------------------------------------------------------------------
# Test 7 — profit margin, both sides ex-GST
# ---------------------------------------------------------------------------
# MRP is GST-INCLUSIVE, the cost is not.  Comparing them directly overstates
# the margin, so the MRP must have its tax extracted first:
#     mrp_ex_gst = mrp × 100 / (100 + gst_rate)
#     margin     = (mrp_ex_gst − effective_cost) / mrp_ex_gst × 100
print("\nTest 7 — margin uses ex-GST MRP vs post-discount cost")
mrp        = Decimal("100")
gst        = Decimal("5")
mrp_ex_gst = mrp * Decimal("100") / (Decimal("100") + gst)
cost       = Decimal(str(t1["effective_cost"]))
margin     = (mrp_ex_gst - cost) / mrp_ex_gst * Decimal("100")
check("MRP ex-GST",  round(mrp_ex_gst, 2), "95.24")
check("margin %",    round(margin, 1),     "14.1")

# ---------------------------------------------------------------------------
print()
if failures:
    print(f"{len(failures)} CHECK(S) FAILED:")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)

print("All purchase-total checks passed.")
