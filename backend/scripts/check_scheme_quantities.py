"""
check_scheme_quantities.py — find stock quantities inflated by the old
purchase-scheme bug.

WHAT WENT WRONG
---------------
A distributor scheme like "5+1" is quoted in the PACK the pharmacy buys.  On a
strip medicine that means *buy 5 STRIPS, get 1 strip free* — never "buy 5
tablets, get 1 tablet free".

The old code counted the scheme in individual tablets:

    bonus = (paid_units // scheme_buy) * scheme_free          <-- WRONG

which, for a medicine with 20 tablets per strip, treated "5+1" as though every
5 TABLETS earned a free one.  The correct calculation scales the scheme into
units first:

    bonus = (paid_units // (scheme_buy * per_strip)) * (scheme_free * per_strip)

The old maths happened to give the right answer whenever the strip count
divided evenly by the scheme's "buy" figure, which is why it survived casual
testing.  Everywhere else it INVENTED stock that the distributor never
delivered — sometimes a fractional strip, which cannot physically exist:

    7 strips on "5+1"   old: 28 units (1.4 strips)   correct: 20 units (1 strip)
    4 strips on "5+1"   old: 16 units                correct:  0 (does not qualify)
    3 strips on "10+2"  old: 12 units                correct:  0 (does not qualify)

The error is always an OVER-count, never an under-count, so every difference
this script reports is phantom stock.

WHAT THIS SCRIPT DOES
---------------------
Reads the pharmacy database and recomputes what each scheme batch's quantity
SHOULD have been, then prints the ones that disagree.

It is strictly READ-ONLY.  The database is opened in SQLite read-only mode, and
if that is refused (which happens when the app is running and the write-ahead
log needs recovery) the script falls back to working on a throwaway COPY.  It
never writes to, repairs, or migrates the real file.  Nothing is corrected
automatically — a stock quantity is a physical fact about a shelf, so a human
has to count the shelf and decide.

USAGE
-----
    python check_scheme_quantities.py                  # find the DB automatically
    python check_scheme_quantities.py --all            # include the correct rows too
    python check_scheme_quantities.py --csv out.csv    # also write a CSV
    python check_scheme_quantities.py --db "C:/path/to/pharmacy.db"

On the shop PC, close the Health Care Centre app first so the reading is taken
against settled data, then open a terminal in this folder and run the first
command.  Only the Python standard library is used, so no virtualenv and no
`pip install` are needed — any Python 3.8+ will do.

EXIT CODES
----------
    0   no discrepancies found (or nothing to check)
    1   at least one batch disagrees — review the table
    2   the database could not be found or read
"""

import argparse
import csv
import os
import platform
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

# --------------------------------------------------------------------------
# Finding the database
# --------------------------------------------------------------------------


def candidate_db_paths():
    """
    Every place the pharmacy database might reasonably live, best guess first.

    The desktop build picks its folder in main_desktop.get_app_data_dir(), which
    on Windows is %APPDATA%\\HCC (Roaming).  Some notes elsewhere in the project
    mention LOCALAPPDATA, and an older install may genuinely have used it, so we
    probe both rather than guessing wrong and reporting "no database found" on a
    PC that plainly has one.  HCC_DATA_DIR wins when it is set, because that is
    what the frozen .exe exports.
    """
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

    # Last resort: the home folder, in case someone moved it there.
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
    print('    python check_scheme_quantities.py --db "C:/Users/you/AppData/Roaming/HCC/pharmacy.db"')
    return None


def open_readonly(db_path):
    """
    Open the database WITHOUT any possibility of modifying it.

    First choice is SQLite's read-only URI mode.  That can fail on a live
    database whose write-ahead log needs replaying (SQLite must write to do
    that, and read-only mode forbids it) — which is exactly the situation if the
    pharmacy app is open.  Rather than ask the user to fight it, we copy the
    database and its -wal/-shm sidecars to a temporary folder and read the copy.

    Returns (connection, tempdir_or_None). The caller cleans up the tempdir.
    """
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.execute("SELECT COUNT(*) FROM batches").fetchone()
        return conn, None
    except sqlite3.Error as exc:
        print(f"NOTE: read-only open failed ({exc}); working on a temporary copy instead.")

    tmpdir = tempfile.mkdtemp(prefix="hcc_scheme_check_")
    target = Path(tmpdir) / "pharmacy.db"
    shutil.copy2(db_path, target)
    # The -wal file holds recent transactions that are not in the main file yet.
    # Copying it too means we analyse the same data the app sees.
    for suffix in ("-wal", "-shm"):
        side = Path(str(db_path) + suffix)
        if side.exists():
            shutil.copy2(side, Path(str(target) + suffix))
    return sqlite3.connect(target), tmpdir


# --------------------------------------------------------------------------
# The calculation under test
# --------------------------------------------------------------------------


def parse_scheme_label(label):
    """
    Pull (buy, free) out of a label like "5+1".

    Older rows may have a scheme_label but NULL scheme_buy/scheme_free, so the
    label is the fallback source of truth. Returns (None, None) if unparseable.
    """
    if not label or "+" not in str(label):
        return None, None
    left, _, right = str(label).partition("+")
    try:
        buy, free = int(left.strip()), int(right.strip())
    except ValueError:
        return None, None
    if buy <= 0 or free <= 0:
        return None, None
    return buy, free


def correct_bonus(paid_units, buy, free, per_pack):
    """
    The bonus the distributor actually gives, in individual units.

    This is the same formula as inventory_service._compute_scheme() — if that
    ever changes, change this too or the script will report false alarms.
    """
    per = per_pack if per_pack and per_pack > 0 else 1
    buy_units = buy * per
    free_units = free * per
    if buy_units <= 0:
        return 0
    return (paid_units // buy_units) * free_units


def old_bonus(paid_units, buy, free):
    """The buggy formula, kept so the report can explain where a figure came from."""
    if not buy:
        return 0
    return (paid_units // buy) * free


# --------------------------------------------------------------------------
# Analysis
# --------------------------------------------------------------------------


def analyse(conn):
    """
    Recompute every scheme batch and return (rows, skipped).

    `rows` are dicts ready to print; `skipped` are batches we could not check,
    with a reason — those need a human eye rather than being silently dropped.
    """
    conn.row_factory = sqlite3.Row
    batches = conn.execute(
        """
        SELECT b.id                AS batch_id,
               b.batch_number      AS batch_number,
               b.quantity_received AS quantity_received,
               b.quantity_available AS quantity_available,
               b.paid_quantity     AS paid_quantity,
               b.bonus_quantity    AS bonus_quantity,
               b.scheme_buy        AS scheme_buy,
               b.scheme_free       AS scheme_free,
               b.scheme_label      AS scheme_label,
               b.expiry_date       AS expiry_date,
               p.name              AS medicine_name,
               p.is_strip          AS is_strip,
               p.units_per_strip   AS units_per_strip
        FROM batches b
        JOIN products p ON p.id = b.product_id
        WHERE b.scheme_label IS NOT NULL
           OR (b.scheme_buy IS NOT NULL AND b.scheme_free IS NOT NULL)
        ORDER BY p.name, b.id
        """
    ).fetchall()

    rows, skipped = [], []

    for b in batches:
        buy, free = b["scheme_buy"], b["scheme_free"]
        if not buy or not free:
            buy, free = parse_scheme_label(b["scheme_label"])
        if not buy or not free:
            skipped.append((b["batch_id"], b["medicine_name"],
                            f"scheme '{b['scheme_label']}' could not be read"))
            continue

        # paid_quantity is what the pharmacy actually bought. It was added later
        # than the scheme columns, so fall back to received-minus-bonus for rows
        # written before it existed.
        paid = b["paid_quantity"]
        if paid is None:
            received = b["quantity_received"] or 0
            paid = received - (b["bonus_quantity"] or 0)
        if paid is None or paid <= 0:
            skipped.append((b["batch_id"], b["medicine_name"],
                            "paid quantity is missing or zero"))
            continue

        # Pack size comes from the product's CURRENT configuration. If someone
        # has since changed units_per_strip, or switched the medicine in or out
        # of strip mode, this reading reflects the new setting — see the caveat
        # printed at the end of the report.
        is_strip = bool(b["is_strip"])
        per_pack = b["units_per_strip"] if is_strip and b["units_per_strip"] else 1

        stored_qty = b["quantity_received"] or 0
        good_bonus = correct_bonus(paid, buy, free, per_pack)
        correct_qty = paid + good_bonus
        difference = stored_qty - correct_qty

        rows.append({
            "batch_id":          b["batch_id"],
            "medicine_name":     b["medicine_name"],
            "scheme_label":      b["scheme_label"] or f"{buy}+{free}",
            "stored_quantity":   stored_qty,
            "correct_quantity":  correct_qty,
            "difference":        difference,
            # Context columns — not requested, but they are what turns a number
            # into an action: which shelf, how much is left, is it still sellable.
            "batch_number":      b["batch_number"] or "",
            "is_strip":          is_strip,
            "units_per_strip":   per_pack,
            "paid_quantity":     paid,
            "stored_bonus":      b["bonus_quantity"] or 0,
            "correct_bonus":     good_bonus,
            "old_formula_bonus": old_bonus(paid, buy, free),
            "quantity_available": b["quantity_available"] or 0,
            "available_after_fix": (b["quantity_available"] or 0) - difference,
            "expiry_date":       b["expiry_date"] or "",
        })

    return rows, skipped


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------

COLUMNS = [
    ("batch_id",         "BATCH",     6,  "right"),
    ("medicine_name",    "MEDICINE",  30, "left"),
    ("scheme_label",     "SCHEME",    8,  "left"),
    ("stored_quantity",  "STORED",    9,  "right"),
    ("correct_quantity", "CORRECT",   9,  "right"),
    ("difference",       "DIFF",      7,  "right"),
]


def fmt_row(row):
    out = []
    for key, _title, width, align in COLUMNS:
        text = str(row[key])
        if len(text) > width:
            text = text[: width - 1] + "\u2026"
        out.append(text.rjust(width) if align == "right" else text.ljust(width))
    return "  ".join(out)


def print_report(rows, skipped, db_path, show_all):
    bad = [r for r in rows if r["difference"] != 0]
    shown = rows if show_all else bad

    print()
    print("=" * 78)
    print("  PURCHASE SCHEME QUANTITY CHECK")
    print("=" * 78)
    print(f"  Database : {db_path}")
    print(f"  Scanned  : {len(rows)} batch(es) recorded with a purchase scheme")
    print(f"  Affected : {len(bad)} batch(es) with a wrong quantity")
    print("=" * 78)

    if not rows:
        print("\nNo batches carry a purchase scheme, so nothing can be affected.")
        print("Nothing to do.\n")
        return

    if not bad and not show_all:
        print("\nAll scheme batches match the corrected calculation. Nothing to fix.\n")
        return

    header = "  ".join(
        (title.rjust(width) if align == "right" else title.ljust(width))
        for _key, title, width, align in COLUMNS
    )
    print()
    print(header)
    print("-" * len(header))
    for r in sorted(shown, key=lambda x: -abs(x["difference"])):
        print(fmt_row(r))
    print("-" * len(header))

    if bad:
        total = sum(r["difference"] for r in bad)
        print(f"\nTotal phantom stock across all affected batches: {total} unit(s)")

        print("\nDETAIL — what to do with each one")
        print("(units_per_strip is the medicine's current setting)")
        for r in sorted(bad, key=lambda x: -abs(x["difference"])):
            per = r["units_per_strip"]
            print(f"\n  Batch {r['batch_id']} — {r['medicine_name']}"
                  f"{(' (batch no. ' + r['batch_number'] + ')') if r['batch_number'] else ''}")
            print(f"    Scheme {r['scheme_label']} on a medicine of {per} unit(s) per strip"
                  f"{'' if r['is_strip'] else '  [not a strip medicine]'}")
            print(f"    Bought      : {r['paid_quantity']} units"
                  + (f" = {r['paid_quantity'] / per:g} strips" if per > 1 else ""))
            print(f"    Bonus given : {r['stored_bonus']} units   (old formula produced "
                  f"{r['old_formula_bonus']})")
            print(f"    Bonus due   : {r['correct_bonus']} units"
                  + (f" = {r['correct_bonus'] / per:g} strips" if per > 1 else ""))
            print(f"    Recorded    : {r['stored_quantity']} units received")
            print(f"    Should be   : {r['correct_quantity']} units received")
            print(f"    Phantom     : {r['difference']} unit(s) that were never delivered")
            print(f"    On shelf now: {r['quantity_available']} units"
                  f"  ->  {r['available_after_fix']} after removing the phantom units")
            if r["available_after_fix"] < 0:
                print("    *** WARNING: this goes NEGATIVE. More units were billed than")
                print("        really existed, so some sales drew on stock that was never")
                print("        there. Count this medicine physically before adjusting.")
            if r["expiry_date"]:
                print(f"    Expiry      : {r['expiry_date']}")

    if skipped:
        print(f"\n{len(skipped)} batch(es) could NOT be checked automatically:")
        for batch_id, name, reason in skipped:
            print(f"    Batch {batch_id} — {name}: {reason}")

    print("""
CAVEATS — read before acting
  * This script changes nothing. Correcting stock means counting the physical
    shelf, then using Inventory to record an adjustment, so the stock_movements
    audit trail keeps its "every change has a reason" guarantee.
  * The pack size used above is the medicine's CURRENT units_per_strip. If that
    setting was edited after the batch was received, the "correct" figure here
    is computed against today's setting, not the one in force at the time.
  * Batches received AFTER the scheme fix are already correct and will show a
    difference of 0. Seeing them listed under --all is expected.
  * The difference is always positive or zero: the old formula could only ever
    over-count, never under-count.
""")


def write_csv(rows, path, show_all):
    """Write the full detail to CSV — easier to work through on a long list."""
    out = rows if show_all else [r for r in rows if r["difference"] != 0]
    if not out:
        print(f"Nothing to write to {path}.")
        return
    fields = list(out[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(out)
    print(f"Wrote {len(out)} row(s) to {path}")


# --------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Find stock quantities inflated by the old purchase-scheme bug. "
                    "Read-only: it never modifies the database.",
    )
    parser.add_argument("--db", help="Path to pharmacy.db (default: find it automatically)")
    parser.add_argument("--all", action="store_true",
                        help="List every scheme batch, not just the wrong ones")
    parser.add_argument("--csv", metavar="FILE", help="Also write the results to a CSV file")
    args = parser.parse_args()

    db_path = locate_db(args.db)
    if db_path is None:
        return 2

    try:
        conn, tmpdir = open_readonly(db_path)
    except (sqlite3.Error, OSError) as exc:
        print(f"ERROR: could not open {db_path}: {exc}")
        return 2

    try:
        rows, skipped = analyse(conn)
    except sqlite3.Error as exc:
        print(f"ERROR: could not read the database: {exc}")
        print("If this says 'no such column', the database predates the scheme")
        print("feature entirely — in which case no batch can be affected.")
        return 2
    finally:
        conn.close()
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)

    print_report(rows, skipped, db_path, args.all)
    if args.csv:
        write_csv(rows, args.csv, args.all)

    return 1 if any(r["difference"] != 0 for r in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
