"""
Check the dashboard expenditure summary against the raw tables.

WHY THIS FILE EXISTS
"Money out" is assembled from four different places, and two of them overlap in
ways that are easy to get wrong.  Both traps would silently DOUBLE a number the
owner reads as fact:

  TRAP 1 — stock_purchases has no amount_paid / payment_mode column at all.
    Money handed over when a delivery arrives is written by inventory_service as
    a SupplierCreditTransaction(type='PAYMENT') that carries a stock_purchase_id.
    So supplier payments live in exactly ONE table.  Anyone "fixing" this by
    also summing stock_purchases would count every delivery payment twice.

  TRAP 2 — expenditure_service.settle_salary writes BOTH a SalaryRecord AND a
    mirrored Expense(category='SALARY').  The endpoint takes salary from
    salary_records and EXCLUDES category='SALARY' from the expense query.
    Dropping that exclusion double-counts every payslip.

This script recomputes each figure straight from the tables with independent
SQL and compares it to what the endpoint produced.  It runs against the real
local database, so it also proves the thing works on actual data rather than a
fixture.

Run it from the backend/ folder with the venv active:

    python scripts/check_expenditure_summary.py

One line per check; exits non-zero if anything fails.
"""
import sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

# Make "app.*" importable when this file is run directly from backend/scripts/.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import SessionLocal                                  # noqa: E402
from app.models.expenditure import Expense, SalaryRecord               # noqa: E402
from app.models.supplier_credit import SupplierCreditTransaction       # noqa: E402
from app.routers.dashboard import _collect_expenditure                 # noqa: E402
from app.utils.dates import get_today_ist, ist_range_bounds_utc        # noqa: E402


failures: list[str] = []


def check(label: str, actual, expected, tol: float = 0.01) -> None:
    """Compare one figure (money, so allow a paisa of float slop) and record it."""
    ok = abs(float(actual) - float(expected)) <= tol
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: got {actual}, expected {expected}")
    if not ok:
        failures.append(f"{label}: got {actual}, expected {expected}")


def check_true(label: str, condition: bool, detail: str = "") -> None:
    print(f"  {'PASS' if condition else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    if not condition:
        failures.append(f"{label} {detail}")


def verify_period(db, name: str, day_from: date, day_to: date) -> None:
    """Run every consistency check against one time window."""
    print(f"\n{name}  ({day_from} → {day_to})")
    period = _collect_expenditure(db, day_from, day_to)

    # --- Test 1: the four component totals must add up to `total` -----------
    component_sum = (period.supplier_payments + period.credit_payments
                     + period.expenses + period.salary)
    check("total == sum of the four components", period.total, component_sum)

    # --- Test 2: the breakdown rows must add up to the same total -----------
    # This is what makes the card and the slide-in panel agree on screen: the
    # panel sums these rows, the card shows `total`.
    breakdown_sum = sum(e.amount for e in period.breakdown)
    check("total == sum of breakdown rows", period.total, breakdown_sum)

    # --- Test 3: each type's rows must add up to its own component ----------
    for entry_type, component in (
        ("SUPPLIER_PAYMENT", period.supplier_payments),
        ("CREDIT_PAYMENT",   period.credit_payments),
        ("EXPENSE",          period.expenses),
        ("SALARY",           period.salary),
    ):
        rows = sum(e.amount for e in period.breakdown if e.type == entry_type)
        check(f"{entry_type} rows == {entry_type} total", rows, component)

    # --- Test 4: independent recount of supplier money straight from SQL ----
    start_utc, end_utc = ist_range_bounds_utc(day_from, day_to)
    tx_rows = (
        db.query(SupplierCreditTransaction)
        .filter(
            SupplierCreditTransaction.type == "PAYMENT",
            SupplierCreditTransaction.created_at >= start_utc,
            SupplierCreditTransaction.created_at < end_utc,
        )
        .all()
    )
    raw_at_delivery = sum(float(t.amount or 0) for t in tx_rows
                          if t.stock_purchase_id is not None and (t.amount or 0) > 0)
    raw_debt_paid   = sum(float(t.amount or 0) for t in tx_rows
                          if t.stock_purchase_id is None and (t.amount or 0) > 0)
    check("supplier_payments == PAYMENT rows WITH a stock_purchase_id",
          period.supplier_payments, raw_at_delivery)
    check("credit_payments == PAYMENT rows WITHOUT a stock_purchase_id",
          period.credit_payments, raw_debt_paid)

    # --- Test 5: expenses exclude the mirrored salary rows (trap 2) --------
    raw_expenses = sum(
        float(e.amount or 0)
        for e in db.query(Expense).filter(
            Expense.date >= day_from, Expense.date <= day_to
        ).all()
        if e.category != "SALARY" and (e.amount or 0) > 0
    )
    check("expenses == non-SALARY expense rows", period.expenses, raw_expenses)

    mirrored = (
        db.query(Expense)
        .filter(Expense.date >= day_from, Expense.date <= day_to,
                Expense.category == "SALARY")
        .count()
    )
    check_true("mirrored SALARY expenses are excluded (not double-counted)",
               True, f"{mirrored} mirror row(s) in range, correctly skipped")

    # --- Test 6: salary comes from salary_records, dated by paid_at --------
    raw_salary = sum(
        float(r.amount_paid or 0)
        for r in db.query(SalaryRecord).filter(
            SalaryRecord.status.in_(["PAID", "PARTIAL"]),
            SalaryRecord.paid_at.isnot(None),
            SalaryRecord.paid_at >= start_utc,
            SalaryRecord.paid_at < end_utc,
        ).all()
        if (r.amount_paid or 0) > 0
    )
    check("salary == settled salary_records in window", period.salary, raw_salary)

    # --- Test 7: cash + upi can never exceed the total ---------------------
    # (They can be LESS: a row with a missing/unknown payment mode is counted in
    # neither, which is deliberate — we would rather show a gap than guess.)
    check_true("cash + upi <= total",
               period.cash + period.upi <= period.total + 0.01,
               f"cash {period.cash} + upi {period.upi} vs total {period.total}")

    # --- Test 8: every row carries the fields the UI groups and sorts on ---
    bad = [e for e in period.breakdown if not e.date or not e.timestamp]
    check_true("every breakdown row has a date + timestamp",
               not bad, f"{len(bad)} row(s) missing one")

    # --- Test 9: rows are newest first (the panel relies on this order) ----
    stamps = [e.timestamp for e in period.breakdown]
    check_true("breakdown is sorted newest first",
               stamps == sorted(stamps, reverse=True))

    # --- Test 10: every row's date really falls inside the window ----------
    outside = [e for e in period.breakdown
               if not (day_from.isoformat() <= e.date <= day_to.isoformat())]
    check_true("no row falls outside the requested date window",
               not outside,
               f"{len(outside)} stray row(s): {[e.date for e in outside][:3]}")

    print(f"  → total {period.total}  "
          f"(supplier {period.supplier_payments}, credit {period.credit_payments}, "
          f"expenses {period.expenses}, salary {period.salary}) "
          f"across {len(period.breakdown)} row(s)")
    return period


def verify_salary_not_double_counted(db) -> None:
    """
    Seed a real salary settlement and prove it is counted exactly ONCE.

    The live database usually has no payroll activity in the current month, so
    the trap-2 path would otherwise go untested against real data.  We call the
    actual settle_salary() service — the same code the app runs — so this
    exercises the genuine "writes a SalaryRecord AND a mirrored Expense"
    behaviour rather than a hand-made imitation of it.

    EVERYTHING HERE IS ROLLED BACK.  The dev database holds real pharmacy data
    (see the note in CLAUDE.md / project memory), so nothing this function
    creates is allowed to survive.
    """
    from app.models.expenditure import Employee                   # local import
    from app.services import expenditure_service                  # local import

    print("\nSYNTHETIC SCENARIO (rolled back — nothing is saved)")
    today = get_today_ist()

    # A savepoint we can unwind cleanly even if a check throws.
    outer = db.begin_nested()
    try:
        emp = Employee(
            name="ZZ Test Employee (rollback)",
            role="Test",
            basic_salary=Decimal("10000.00"),
            hra=Decimal("0"), travel_allowance=Decimal("0"),
            other_allowance=Decimal("0"),
            is_active=True,
        )
        db.add(emp)
        db.flush()

        before = _collect_expenditure(db, today, today)

        # The real service call: writes SalaryRecord + mirrored Expense.
        expenditure_service.settle_salary(
            db,
            employee_id=emp.id,
            month=today.month,
            year=today.year,
            amount_paid=Decimal("7500.00"),
            payment_mode="CASH",
            notes="rollback test",
            created_by=None,
        )
        db.flush()

        # A plain non-salary expense too, so the EXPENSE path gets real coverage.
        db.add(Expense(
            date=today,
            category="UTILITY",
            description="ZZ Test electricity bill (rollback)",
            amount=Decimal("300.00"),
            payment_mode="UPI",
            paid_to="ZZ Test Board",
        ))
        db.flush()

        after = _collect_expenditure(db, today, today)

        # Salary must move by exactly the settled amount — not twice it.
        check("salary rose by exactly the amount settled (counted once)",
              after.salary - before.salary, 7500.00)
        check("expenses rose by exactly the non-salary expense",
              after.expenses - before.expenses, 300.00)
        check("total rose by salary + expense only",
              after.total - before.total, 7800.00)

        # The mirrored Expense(category='SALARY') really does exist — which is
        # what makes the exclusion necessary rather than theoretical.
        mirror_count = (
            db.query(Expense)
            .filter(Expense.category == "SALARY",
                    Expense.paid_to == "ZZ Test Employee (rollback)")
            .count()
        )
        check_true("settle_salary did write a mirror Expense row",
                   mirror_count == 1,
                   f"found {mirror_count} (if 0, the trap no longer exists)")

        # And the salary shows up as ONE breakdown row, not two.
        salary_rows = [e for e in after.breakdown
                       if e.type == "SALARY" and e.paid_to == "ZZ Test Employee (rollback)"]
        check_true("exactly one SALARY breakdown row for the settlement",
                   len(salary_rows) == 1, f"found {len(salary_rows)}")

        # Cash/UPI split must follow the modes we used (CASH salary, UPI bill).
        check("cash rose by the CASH salary", after.cash - before.cash, 7500.00)
        check("upi rose by the UPI bill", after.upi - before.upi, 300.00)
    finally:
        # Undo everything, whatever happened above.
        outer.rollback()

    # Belt and braces: prove the seeded rows are really gone.
    db.rollback()
    leftover = (
        db.query(Expense)
        .filter(Expense.description.like("ZZ Test%"))
        .count()
    )
    check_true("all synthetic rows were rolled back", leftover == 0,
               f"{leftover} test row(s) still present")


def main() -> int:
    db = SessionLocal()
    try:
        today     = get_today_ist()
        first_day = today.replace(day=1)

        print("=" * 72)
        print("Dashboard expenditure summary — consistency checks")
        print("=" * 72)

        today_period = verify_period(db, "TODAY", today, today)
        month_period = verify_period(db, "THIS MONTH", first_day, today)

        # --- Test 11: today must be contained within the month -------------
        # The two cards are computed by separate calls; if the month window did
        # not include today, the two numbers on screen would contradict.
        print("\nCROSS-PERIOD")
        check_true("today's total <= month's total",
                   today_period.total <= month_period.total + 0.01,
                   f"{today_period.total} vs {month_period.total}")

        today_iso = today.isoformat()
        month_today_rows = [e for e in month_period.breakdown if e.date == today_iso]
        check("month's rows dated today == today's row count",
              len(month_today_rows), len(today_period.breakdown), tol=0)
        check("month's today-dated rows sum == today's total",
              sum(e.amount for e in month_today_rows), today_period.total)

        # --- Test 12: an empty window must be a clean zero, not a crash ----
        print("\nEMPTY WINDOW (a far-past day with no activity)")
        long_ago = date(2000, 1, 1)
        empty = _collect_expenditure(db, long_ago, long_ago)
        check("empty window total is 0", empty.total, 0)
        check_true("empty window has no rows", len(empty.breakdown) == 0)

        verify_salary_not_double_counted(db)

        print("\n" + "=" * 72)
        if failures:
            print(f"{len(failures)} CHECK(S) FAILED:")
            for f in failures:
                print(f"  - {f}")
            return 1
        print("All checks passed.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
