"""
Regression test: PAGES UPLOADED TOGETHER ARE ONE PRESCRIPTION.

Run:  python3 backend/scripts/test_prescription_grouping.py

Background
----------
A doctor's pad routinely runs to two or three sheets.  Each sheet is stored
as its own row in `prescriptions` — that table always allowed many rows per
patient and per invoice — and two columns tie the sheets of one prescription
back together:

    group_id    the same value on every page uploaded in one go
    page_number 1-based position inside that group

The invariant that matters most
-------------------------------
EVERY ROW WRITTEN BEFORE MULTI-PAGE EXISTED HAS group_id = NULL, and the
pharmacy's live database is full of them.  Those rows must each stay their
own single-page prescription.  If ungrouped rows were ever merged, every old
prescription in the shop would collapse into one giant fake prescription —
which is why that case is tested from several angles below.

No FastAPI/SQLAlchemy needed: the real _group_pages/_page_list/_Grouped are
lifted out of prescriptions.py and run against stub rows, so this tests the
shipped code rather than a copy of it.
"""
import ast
import sys
from pathlib import Path

ROUTER = Path(__file__).resolve().parents[1] / "app" / "routers" / "prescriptions.py"

WANTED = {"_Grouped", "_group_pages", "_page_list"}

FAILS = []


def load_grouping():
    """Extract the real grouping helpers from prescriptions.py and compile them."""
    tree = ast.parse(ROUTER.read_text())
    nodes = [
        n for n in tree.body
        if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in WANTED
    ]
    missing = WANTED - {n.name for n in nodes}
    if missing:
        sys.exit(f"FAIL: {', '.join(sorted(missing))} not found in prescriptions.py")
    ns = {}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(ROUTER), "exec"), ns)
    return ns["_group_pages"], ns["_page_list"]


class Row:
    """Stub of a Prescription row — only the fields the grouping touches."""

    def __init__(self, id, group_id=None, page_number=None, invoice_id=None):
        self.id          = id
        self.group_id    = group_id
        self.page_number = page_number
        self.invoice_id  = invoice_id
        self.file_name   = f"page{id}.jpg"
        self.file_size   = 1024
        self.mime_type   = "image/jpeg"


def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: got {got}, want {want}")
    if not ok:
        FAILS.append(label)


def main():
    group_pages, page_list = load_grouping()

    print("[1] Pages uploaded together become ONE prescription")
    g = group_pages([Row(7, "abc", 1), Row(8, "abc", 2), Row(9, "abc", 3)])
    check("three sheets, one prescription", len(g), 1)
    check("it knows it has three pages", len(g[0].pages), 3)
    check("it reads through to page one", g[0].id, 7)

    print("\n[2] THE LIVE-DATA INVARIANT - old rows never merge")
    g = group_pages([Row(1), Row(2), Row(3)])
    check("three legacy rows stay separate", len(g), 3)
    check("each is a single page", [len(x.pages) for x in g], [1, 1, 1])

    print("\n[3] Old and new side by side")
    g = group_pages([Row(1), Row(5, "xy", 1), Row(6, "xy", 2), Row(2)])
    check("four rows, three prescriptions", len(g), 3)
    check("caller's order is preserved", [x.id for x in g], [1, 5, 2])

    print("\n[4] Page order survives arriving out of order")
    g = group_pages([Row(30, "z", 3), Row(10, "z", 1), Row(20, "z", 2)])
    check("sorted by page_number", [p.id for p in g[0].pages], [10, 20, 30])
    check("page one owns the identity", g[0].id, 10)

    print("\n[5] A group whose pages have no page_number falls back to id order")
    g = group_pages([Row(40, "w"), Row(39, "w")])
    check("ordered by id", [p.id for p in g[0].pages], [39, 40])
    check("page numbers filled in", [p["page_number"] for p in page_list(g[0].pages)], [1, 2])

    print("\n[6] Two prescriptions on one invoice stay two prescriptions")
    # This is why grouping is NOT done on invoice_id: a patient can hand over
    # two separate prescriptions against a single bill.
    g = group_pages([Row(1, "a", 1, invoice_id=99), Row(2, "b", 1, invoice_id=99)])
    check("same invoice, still two", len(g), 2)

    print("\n[7] Empty input")
    check("nothing in, nothing out", group_pages([]), [])

    print("\n" + "=" * 62)
    if FAILS:
        print(f"{len(FAILS)} CHECK(S) FAILED: {FAILS}")
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
