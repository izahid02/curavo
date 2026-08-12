"""
fix_supplier_credit_totals.py — repair supplier invoice totals that were
calculated with the old (wrong) purchase-GST logic.

WHAT WENT WRONG
---------------
An Indian distributor's invoice takes the trade discount off the rate FIRST and
then charges GST on what is left:

    S.Rate − discount = goods value        →   + GST on the GOODS VALUE = total

The old code did the opposite.  It charged GST on the full rate card price and
treated the discount as a margin-only adjustment that never touched the invoice,
so every DISCOUNTED delivery recorded a bigger debt than the supplier actually
billed:

    COLIZA LIQUID — S.Rate ₹86.10 x 3, disc 5%, GST 5%
        old:  (86.10 x 3) + 5% GST                  = ₹271.22   <-- too much
        new:  (86.10 - 5%) x 3 = ₹245.39, + ₹12.27  = ₹257.66

The error is always an OVER-statement, never an under-statement: the missing
discount is worth more than the extra tax charged on it.  So every difference
this script finds is money the pharmacy does NOT owe.

Deliveries with NO discount are unaffected — both formulas give the same answer
— which is why this script naturally only touches discounted rows.

WHAT THIS SCRIPT DOES
---------------------
For every stock_purchases row it recomputes the correct invoice total and, where
the stored figure is out by more than the tolerance (default 5 paise):

    1. stock_purchases.total_cost      -> the correct goods + GST figure
    2. stock_purchases.gst_on_purchase -> the GST on the DISCOUNTED goods value
    3. the linked supplier_credit_transactions CREDIT row  -> amount reduced by
       the difference, with balance and status recalculated
    4. supplier_credit_accounts        -> total_credit and outstanding reduced to
       match; any part of the difference the pharmacy has ALREADY PAID becomes
       advance_balance, because the supplier is now holding our money

Nothing is written until you type "yes".  A timestamped backup of the database
file is taken first, so a bad run can always be undone by copying it back.

WHAT IT DELIBERATELY DOES NOT TOUCH
-----------------------------------
  * PAYMENT rows.  Money that actually left the till is a fact; only the DEBT
    was mis-stated.
  * Rows whose stored total_cost is 0 or NULL.  Those predate the GST-on-
    purchase work entirely, so "correcting" them would invent a debt that was
    never recorded.  They are listed at the end for a human to look at.
  * cost_price, discount_percent, discount_amount, effective_cost.  Those are
    what the pharmacist typed off the paper invoice — the bug was in the
    arithmetic done with them, not in the figures themselves.

USAGE
-----
    python fix_supplier_credit_totals.py                 # find the DB, report, ask
    python fix_supplier_credit_totals.py --dry-run       # report only, never write
    python fix_supplier_credit_totals.py --db "C:/path/to/pharmacy.db"
    python fix_supplier_credit_totals.py --tolerance 0.01
    python fix_supplier_credit_totals.py --yes           # skip the prompt (careful)

CLOSE THE HEALTH CARE CENTRE APP FIRST.  This script writes to the database, and
a running app holding the file open can block the write or act on stale numbers
afterwards.

Only the Python standard library is used — no virtualenv, no pip install.

EXIT CODES
----------
    0   nothing needed fixing, or the fix was applied successfully
    1   rows need fixing and were reported but not written (dry run / declined)
    2   the database could not be found, opened, or written
"""

import argparse
import os
import platform
import shutil
import sqlite3
import sys
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path


# ---------------------------------------------------------------------------
# Money helpers
# ---------------------------------------------------------------------------
#
# Money is Decimal, never float (CLAUDE.md).  SQLite hands back plain floats, so
# every value is routed through D() which converts via str() — Decimal(0.1) is
# 0.1000000000000000055511151231257827, but Decimal(str(0.1)) is exactly 0.1.

TWOPLACES = Decimal("0.01")


def D(value, default="0"):
    """Coerce anything out of SQLite into a Decimal, treating NULL as `default`."""
    if value is None:
        return Decimal(default)
    return Decimal(str(value))


def money(value):
    """
    Round to paise HALF-UP — the way an invoice does, and the way the app now
    does it (inventory_service._round).  Python's default is HALF-EVEN, which
    would put this script a paisa away from what the app writes for new stock.
    """
    return D(value).quantize(TWOPLACES, rounding=ROUND_HALF_UP)


def rupees(value):
    """Format a Decimal as ₹1,234.56 for the report (no locale needed)."""
    if value is None:
        return "—"
    neg = value < 0
    whole, _, frac = f"{abs(money(value)):.2f}".partition(".")
    # Indian grouping: last three digits, then pairs (12,34,567).
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        whole = ",".join(parts + [tail])
    return ("-" if neg else "") + "Rs." + whole + "." + frac


# ---------------------------------------------------------------------------
# Finding the database
# ---------------------------------------------------------------------------
#
# Same probing order as check_scheme_quantities.py — keep the two in step.


def candidate_db_paths():
    """Every place the pharmacy database might reasonably live, best guess first."""
    seen = []

    def add(p):
        if p is not None and p not in seen:
            seen.append(p)

    env_dir = os.environ.get("HCC_DATA_DIR")
    if env_dir:
        add(Path(env_dir) / "pharmacy.db")

    system = platform.system()
    if system == "Windows":
        for var in ("APPDATA", "LOCALAPPDATA"):
            base = os.environ.get(var)
            if base:
                add(Path(base) / "HCC" / "pharmacy.db")
        add(Path.home() / "AppData" / "Roaming" / "HCC" / "pharmacy.db")
        add(Path.home() / "AppData" / "Local" / "HCC" / "pharmacy.db")
    elif system == "Darwin":
        add(Path.home() / "Library" / "Application Support" / "HCC" / "pharmacy.db")
    else:
        add(Path.home() / ".local" / "share" / "HCC" / "pharmacy.db")

    add(Path.home() / "HCC" / "pharmacy.db")
    return seen


def locate_db(explicit=None):
    """Return the path to the database, or None with a helpful message printed."""
    if explicit:
        p = Path(explicit).expanduser()
        if p.is_file():
            return p
        print(f"ERROR: no database file at {p}")
        return None

    tried = candidate_db_paths()
    for p in tried:
        if p.is_file():
            return p

    print("ERROR: could not find pharmacy.db. Looked in:")
    for p in tried:
        print(f"    {p}")
    print("\nPass the path explicitly, e.g.:")
    print('    python fix_supplier_credit_totals.py --db "C:/Users/you/AppData/Roaming/HCC/pharmacy.db"')
    return None


def backup_db(db_path):
    """
    Copy the database next to itself with a timestamp, BEFORE any write.

    This script moves money between columns.  If anything about the result looks
    wrong, closing the app and copying this file back over pharmacy.db restores
    the exact state from before the run.  copy2 preserves the timestamps so the
    backup is obviously a snapshot and not the live file.
    """
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = db_path.with_name(f"{db_path.stem}.backup-{stamp}{db_path.suffix}")
    shutil.copy2(db_path, target)
    return target


# ---------------------------------------------------------------------------
# The calculation
# ---------------------------------------------------------------------------


def correct_totals(cost_price, quantity, gst_rate, discount_percent,
                   discount_amount, effective_cost):
    """
    Recompute one purchase line the way the distributor's invoice does it.

    Returns (goods_total, gst_total, invoice_total, post_discount_per_unit),
    or None when the row has nothing to work from (no cost recorded).

    WHICH DISCOUNT FIGURE WINS, and why there are three:
      1. effective_cost   — the post-discount rate the app stored at the time.
                            Most trustworthy: it is the exact number the rest of
                            the app already values this stock at.
      2. discount_percent — "5% trade discount", the shape most invoices use.
      3. discount_amount  — a flat "Rs.4.31 off per unit".
    On a well-formed row all three agree; the fallback chain only matters for
    rows written before every column existed.

    The arithmetic mirrors inventory_service.compute_purchase_totals() exactly,
    including the rounding order — goods total to paise FIRST, then GST computed
    on that rounded figure, which is what a printed invoice does.  Getting this
    wrong by a paisa would leave rows that the app would want to "fix" again.
    """
    cost = D(cost_price)
    qty  = D(quantity)
    rate = D(gst_rate)

    if cost <= 0 or qty <= 0:
        return None

    eff = D(effective_cost, "0")
    if eff <= 0:
        pct = D(discount_percent)
        amt = D(discount_amount)
        if pct > 0:
            eff = cost * (Decimal("100") - pct) / Decimal("100")
        elif amt > 0:
            eff = cost - amt
        else:
            eff = cost
    # A discount can wipe out the cost but never invert it.
    if eff < 0:
        eff = Decimal("0")

    goods_total = money(eff * qty)
    gst_total   = money(goods_total * rate / Decimal("100"))
    return goods_total, gst_total, goods_total + gst_total, eff


# ---------------------------------------------------------------------------
# Scanning
# ---------------------------------------------------------------------------

SCAN_SQL = """
    SELECT sp.id                       AS purchase_id,
           sp.supplier_invoice_number  AS invoice_no,
           sp.quantity                 AS quantity,
           sp.cost_price               AS cost_price,
           sp.discount_percent         AS discount_percent,
           sp.discount_amount          AS discount_amount,
           sp.effective_cost           AS effective_cost,
           sp.gst_on_purchase          AS gst_on_purchase,
           sp.total_cost               AS total_cost,
           sp.supplier_id              AS supplier_id,
           p.name                      AS product_name,
           p.gst_rate                  AS gst_rate,
           b.batch_number              AS batch_number,
           s.name                      AS supplier_name
      FROM stock_purchases sp
      JOIN products  p ON p.id = sp.product_id
 LEFT JOIN batches   b ON b.id = sp.batch_id
 LEFT JOIN suppliers s ON s.id = sp.supplier_id
  ORDER BY sp.id
"""

CREDIT_SQL = """
    SELECT id, amount, paid_amount, balance, status
      FROM supplier_credit_transactions
     WHERE stock_purchase_id = ?
       AND type = 'CREDIT'
  ORDER BY id
"""


def scan(conn, tolerance):
    """
    Work out what needs fixing.  Reads only — no writes happen here.

    Returns (fixes, skipped) where each fix is a dict describing one purchase
    row and, if it has one, the credit transaction that hangs off it.
    """
    fixes, skipped = [], []

    for row in conn.execute(SCAN_SQL):
        r = dict(row)
        computed = correct_totals(
            r["cost_price"], r["quantity"], r["gst_rate"],
            r["discount_percent"], r["discount_amount"], r["effective_cost"],
        )
        if computed is None:
            continue        # no cost recorded — nothing to recompute against

        goods, gst, correct_total, eff = computed
        stored_total = D(r["total_cost"])

        # Rows from before the GST-on-purchase work have no stored total at all.
        # Writing one now would invent a debt that was never recorded, so they
        # are reported instead of touched.
        if stored_total <= 0:
            skipped.append({**r, "reason": "no total_cost recorded (pre-dates the GST fix)",
                            "correct_total": correct_total})
            continue

        diff = money(stored_total - correct_total)
        if abs(diff) <= tolerance:
            continue        # already right, or within rounding noise

        credit = conn.execute(CREDIT_SQL, (r["purchase_id"],)).fetchall()

        # How much of the correction cannot come off open debt because it has
        # already been paid — that part can only become an advance.  Worked out
        # here so the report can warn about it before anything is written; the
        # same split is applied for real in apply_fixes().
        open_balance = sum((D(c["balance"]) for c in credit), Decimal("0"))
        advance_portion = money(max(Decimal("0"), diff - open_balance)) if credit else Decimal("0")

        fixes.append({
            **r,
            "effective":     eff,
            "goods":         goods,
            "gst":           gst,
            "stored_total":  money(stored_total),
            "correct_total": money(correct_total),
            "diff":          diff,          # positive = we over-stated the debt
            "advance_portion": advance_portion,
            "credit_rows":   [dict(c) for c in credit],
        })

    return fixes, skipped


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def report(fixes, skipped, tolerance):
    """
    Print what was found.

    Returns (total over-statement, total that will become an advance) so the
    confirmation prompt can restate both before anything is written.
    """
    print()
    print("=" * 78)
    print("  SUPPLIER INVOICE TOTALS — rows calculated with the old GST logic")
    print("=" * 78)

    if not fixes:
        print("\n  Nothing to fix. Every stored invoice total already matches the")
        print(f"  correct calculation (within {rupees(tolerance)}).")
    total_diff = Decimal("0")
    total_advance = Decimal("0")

    for f in fixes:
        total_diff += f["diff"]
        pct = D(f["discount_percent"])
        print()
        print(f"  #{f['purchase_id']}  {f['product_name']}")
        print(f"      Batch          {f['batch_number'] or '—'}"
              f"   Invoice {f['invoice_no'] or '—'}"
              f"   Supplier {f['supplier_name'] or '—'}")
        print(f"      S.Rate         {rupees(D(f['cost_price']))} x {f['quantity']}"
              f"   Discount {pct}%   GST {D(f['gst_rate'])}%")
        print(f"      Correct        goods {rupees(f['goods'])} + GST {rupees(f['gst'])}"
              f" = {rupees(f['correct_total'])}")
        print(f"      Stored (old)   {rupees(f['stored_total'])}")
        print(f"      Over-stated by {rupees(f['diff'])}")

        if not f["credit_rows"]:
            print("      Credit         none linked — this delivery was paid at the door,")
            print("                     so only the purchase record is corrected. Check what")
            print("                     was actually handed over against the paper invoice.")
        for c in f["credit_rows"]:
            print(f"      Credit tx #{c['id']}  amount {rupees(D(c['amount']))}"
                  f"  paid {rupees(D(c['paid_amount']))}"
                  f"  balance {rupees(D(c['balance']))}  [{c['status']}]")

        # Part of the correction lands on debt that has ALREADY been paid, which
        # can only become an advance.  Flag it: the pharmacist may instead have
        # handed over the smaller, correct figure all along, in which case the
        # PAYMENT row is the thing that is wrong — and only they can know that.
        if f["advance_portion"] > 0:
            total_advance += f["advance_portion"]
            print(f"      NOTE           {rupees(f['advance_portion'])} of this was already paid,")
            print("                     so it becomes an ADVANCE with this supplier. If you")
            print("                     actually handed over the smaller correct amount, fix")
            print("                     the payment on the supplier ledger instead.")

    if fixes:
        print()
        print("-" * 78)
        print(f"  {len(fixes)} row(s) to correct — {rupees(total_diff)} of debt that was"
              " never really owed.")
        if total_advance > 0:
            print(f"  Of that, {rupees(total_advance)} had already been paid and will be"
                  " held as an advance.")

    if skipped:
        print()
        print("-" * 78)
        print(f"  {len(skipped)} row(s) NOT touched (listed so you can check them by hand):")
        for s in skipped:
            print(f"      #{s['purchase_id']}  {s['product_name']}"
                  f"  (invoice {s['invoice_no'] or '—'}) — {s['reason']};"
                  f" correct total would be {rupees(s['correct_total'])}")

    return total_diff, total_advance


# ---------------------------------------------------------------------------
# Applying
# ---------------------------------------------------------------------------


def apply_fixes(conn, fixes):
    """
    Write the corrections inside ONE transaction — either every row moves or
    none does, so the ledger can never be left half-corrected.

    Per purchase row:
      total_cost / gst_on_purchase  ->  the recomputed figures

    Per linked CREDIT transaction (there is normally one, or none):
      amount   -= diff                      the debt we really took on
      balance   = max(0, amount - paid)     what is still open
      status    = CLEARED / PARTIAL / PENDING (OVERDUE is kept while open)

    Per supplier account, the same difference is unwound:
      total_credit -= diff
      outstanding  -= the part of the difference that was still UNPAID
      advance      += the part that had ALREADY BEEN PAID
    The split matters.  If a ₹271.67 debt was never paid, reducing it to ₹257.66
    simply removes ₹14.01 of outstanding.  If it was paid in full, the ₹14.01 has
    already left the till — the supplier is holding our money, which is exactly
    what advance_balance means, and it will be consumed by their next delivery.
    """
    cur = conn.cursor()
    purchases_fixed = 0
    credits_fixed   = 0
    account_moves   = {}       # supplier_id -> [credit_delta, outstanding_delta, advance_delta]

    for f in fixes:
        cur.execute(
            "UPDATE stock_purchases SET total_cost = ?, gst_on_purchase = ? WHERE id = ?",
            (float(f["correct_total"]), float(f["gst"]), f["purchase_id"]),
        )
        purchases_fixed += 1

        # The whole difference has to come off the debt.  Split it across the
        # (usually single) credit row, oldest first, so a delivery that somehow
        # spawned two credit rows still nets out correctly.
        remaining = f["diff"]
        for c in f["credit_rows"]:
            if remaining <= 0:
                break
            amount   = money(D(c["amount"]))
            paid     = money(D(c["paid_amount"]))
            balance  = money(D(c["balance"]))

            take       = min(remaining, amount)      # never push an amount negative
            new_amount = money(amount - take)
            new_balance = money(max(Decimal("0"), new_amount - paid))
            remaining  = money(remaining - take)

            # How much of the reduction actually cancels open debt, and how much
            # was already handed over and therefore becomes an advance.
            outstanding_delta = money(balance - new_balance)
            advance_delta     = money(take - outstanding_delta)

            if new_balance <= 0:
                new_status = "CLEARED"
            elif paid > 0:
                new_status = "PARTIAL"
            elif c["status"] == "OVERDUE":
                new_status = "OVERDUE"        # still open and still late
            else:
                new_status = "PENDING"

            cur.execute(
                "UPDATE supplier_credit_transactions"
                "   SET amount = ?, balance = ?, status = ?"
                " WHERE id = ?",
                (float(new_amount), float(new_balance), new_status, c["id"]),
            )
            credits_fixed += 1

            move = account_moves.setdefault(f["supplier_id"],
                                            [Decimal("0"), Decimal("0"), Decimal("0")])
            move[0] += take                 # total_credit comes down
            move[1] += outstanding_delta    # outstanding comes down
            move[2] += advance_delta        # advance goes up

    # Roll the per-supplier totals into the denormalised account caches.
    accounts_fixed = 0
    for supplier_id, (credit_delta, outstanding_delta, advance_delta) in account_moves.items():
        acc = cur.execute(
            "SELECT id, total_credit, outstanding, advance_balance"
            "  FROM supplier_credit_accounts WHERE supplier_id = ?",
            (supplier_id,),
        ).fetchone()
        if acc is None:
            continue        # no account row: nothing cached to correct

        # Clamp at zero.  These are caches of a ledger, and a negative "we owe"
        # is meaningless — the advance column is where the other direction lives.
        new_total_credit = money(max(Decimal("0"), D(acc["total_credit"]) - credit_delta))
        new_outstanding  = money(max(Decimal("0"), D(acc["outstanding"]) - outstanding_delta))
        new_advance      = money(D(acc["advance_balance"]) + advance_delta)

        cur.execute(
            "UPDATE supplier_credit_accounts"
            "   SET total_credit = ?, outstanding = ?, advance_balance = ?"
            " WHERE id = ?",
            (float(new_total_credit), float(new_outstanding), float(new_advance), acc["id"]),
        )
        accounts_fixed += 1

    return purchases_fixed, credits_fixed, accounts_fixed


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Correct supplier invoice totals calculated with the old purchase-GST logic.",
    )
    parser.add_argument("--db", help="path to pharmacy.db (default: find it automatically)")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would change and exit without writing")
    parser.add_argument("--yes", action="store_true",
                        help="skip the confirmation prompt (for unattended runs)")
    parser.add_argument("--tolerance", type=float, default=0.05,
                        help="ignore differences at or below this many rupees (default 0.05)")
    args = parser.parse_args()

    db_path = locate_db(args.db)
    if db_path is None:
        return 2
    tolerance = money(args.tolerance)

    print(f"Database:  {db_path}")
    print(f"Tolerance: {rupees(tolerance)}")

    try:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
    except sqlite3.Error as exc:
        print(f"ERROR: could not open the database: {exc}")
        return 2

    try:
        fixes, skipped = scan(conn, tolerance)
        total_diff, total_advance = report(fixes, skipped, tolerance)

        if not fixes:
            print()
            return 0

        if args.dry_run:
            print("\n  Dry run — nothing was written.")
            print("  Re-run without --dry-run to apply these corrections.")
            return 1

        # --- Confirmation ---------------------------------------------------
        print()
        print("  This will UPDATE the database:")
        print(f"    - {len(fixes)} stock_purchases row(s): total_cost + gst_on_purchase")
        print("    - the linked supplier credit transactions and account balances")
        print(f"    - reducing recorded supplier debt by {rupees(total_diff)}")
        if total_advance > 0:
            print(f"    - of which {rupees(total_advance)} becomes an advance"
                  " (already paid — see the NOTEs above)")
        print("\n  Close the Health Care Centre app first if it is running.")
        if args.yes:
            print("  --yes given, proceeding without asking.")
        else:
            answer = input("\n  Type 'yes' to apply, anything else to cancel: ").strip().lower()
            if answer != "yes":
                print("\n  Cancelled. Nothing was written.")
                return 1

        # --- Backup, then write ---------------------------------------------
        try:
            backup = backup_db(db_path)
            print(f"\n  Backup saved: {backup}")
        except OSError as exc:
            print(f"\nERROR: could not write a backup ({exc}). Refusing to change the")
            print("       database without one.")
            return 2

        try:
            with conn:      # commits on success, rolls back on any exception
                purchases, credits, accounts = apply_fixes(conn, fixes)
        except sqlite3.Error as exc:
            print(f"\nERROR: the update failed and was rolled back: {exc}")
            print(f"       The database is unchanged. Backup: {backup}")
            return 2

        print()
        print("=" * 78)
        print(f"  FIXED {purchases} purchase row(s)")
        print(f"        {credits} supplier credit transaction(s)")
        print(f"        {accounts} supplier account balance(s)")
        print(f"        {rupees(total_diff)} of over-stated debt removed")
        print("=" * 78)
        print("\n  Check the Suppliers > Credit screen to confirm the new balances,")
        print(f"  and keep the backup until you are happy:\n    {backup}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
