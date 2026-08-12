"""
Business logic for the Expenditure & Payroll module.

Routers stay thin (CLAUDE.md section 6) — all the real work lives here:

  get_expense_summary(...)          — month totals + per-category split + list
  get_employee_salary_summary(...)  — per-employee payroll picture for a month
  settle_salary(...)                — pay an employee: write SalaryRecord + Expense
  get_cash_register(...)            — live daily cash & bank drawer picture

Money is handled as Decimal throughout.  Sales figures come from the invoices
table (payment_method 'CASH'/'UPI'); expenses come from the expenses table
(payment_mode 'CASH'/'UPI').  The two spellings match on purpose so the cash
register can net them against each other.
"""
from calendar import monthrange
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.billing import Invoice
from app.models.expenditure import CashRegister, Employee, Expense, SalaryRecord
from app.models.user import User
from app.utils.dates import ist_day_bounds_utc

# Every expense category we track.  Kept here so the summary always returns a
# complete, zero-filled breakdown even for categories with no spend this month.
EXPENSE_CATEGORIES = [
    "SALARY", "ADVANCE", "SHOP", "PERSONAL", "UTILITY", "MAINTENANCE", "OTHER",
]

ZERO = Decimal("0.00")


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _dec(value) -> Decimal:
    """Coerce a Numeric / None / int coming from SQLAlchemy into a Decimal."""
    if value is None:
        return ZERO
    return Decimal(str(value))


def _month_bounds(month: int, year: int) -> tuple[date, date]:
    """Return (first_day, last_day) date objects for the given month/year."""
    first = date(year, month, 1)
    last  = date(year, month, monthrange(year, month)[1])
    return first, last


def total_salary(emp: Employee) -> Decimal:
    """Computed total pay = basic + hra + travel + other."""
    return (
        _dec(emp.basic_salary)
        + _dec(emp.hra)
        + _dec(emp.travel_allowance)
        + _dec(emp.other_allowance)
    )


def employee_to_dict(emp: Employee) -> dict:
    """Shape an Employee row for EmployeeOut (adds the computed total_salary)."""
    return {
        "id":               emp.id,
        "name":             emp.name,
        "role":             emp.role,
        "phone":            emp.phone,
        "basic_salary":     _dec(emp.basic_salary),
        "hra":              _dec(emp.hra),
        "travel_allowance": _dec(emp.travel_allowance),
        "other_allowance":  _dec(emp.other_allowance),
        "total_salary":     total_salary(emp),
        "joining_date":     emp.joining_date,
        "is_active":        bool(emp.is_active),
        "created_at":       emp.created_at,
    }


def _expense_to_dict(exp: Expense) -> dict:
    """Shape an Expense row for ExpenseOut, resolving related names."""
    return {
        "id":            exp.id,
        "date":          exp.date,
        "category":      exp.category,
        "description":   exp.description,
        "amount":        _dec(exp.amount),
        "payment_mode":  exp.payment_mode,
        "paid_to":       exp.paid_to,
        "employee_id":   exp.employee_id,
        "employee_name": exp.employee.name if exp.employee else None,
        "reference":     exp.reference,
        "notes":         exp.notes,
        "created_by":    exp.created_by,
        "added_by_name": (exp.creator.full_name or exp.creator.username)
                         if exp.creator else None,
        "created_at":    exp.created_at,
    }


# ---------------------------------------------------------------------------
# Function 1 — monthly expense summary
# ---------------------------------------------------------------------------

def get_expense_summary(db: Session, month: int, year: int) -> dict:
    """
    Return totals + a per-category breakdown + the full list of expenses for the
    given month.

    Shape:
      {
        "total_expenses": Decimal,
        "cash_out": Decimal,
        "upi_out": Decimal,
        "by_category": {"SALARY": ..., "SHOP": ..., ...},
        "expenses": [ExpenseOut-shaped dicts, newest first],
      }
    """
    first, last = _month_bounds(month, year)

    rows = (
        db.query(Expense)
        .filter(Expense.date >= first, Expense.date <= last)
        .order_by(Expense.date.desc(), Expense.id.desc())
        .all()
    )

    # Start every category at zero so the UI always sees a complete breakdown.
    by_category = {cat: ZERO for cat in EXPENSE_CATEGORIES}
    total = cash_out = upi_out = ZERO

    for exp in rows:
        amt = _dec(exp.amount)
        total += amt
        # Unknown categories are folded into OTHER rather than dropped.
        key = exp.category if exp.category in by_category else "OTHER"
        by_category[key] += amt
        if exp.payment_mode == "CASH":
            cash_out += amt
        elif exp.payment_mode == "UPI":
            upi_out += amt

    return {
        "total_expenses": total,
        "cash_out":       cash_out,
        "upi_out":        upi_out,
        "by_category":    by_category,
        "expenses":       [_expense_to_dict(e) for e in rows],
    }


# ---------------------------------------------------------------------------
# Function 2 — per-employee salary summary for a month
# ---------------------------------------------------------------------------

def _advances_for(db: Session, employee_id: int, first: date, last: date) -> list[Expense]:
    """All ADVANCE expenses for one employee within a date range, oldest first."""
    return (
        db.query(Expense)
        .filter(
            Expense.employee_id == employee_id,
            Expense.category == "ADVANCE",
            Expense.date >= first,
            Expense.date <= last,
        )
        .order_by(Expense.date.asc(), Expense.id.asc())
        .all()
    )


def get_employee_salary_summary(db: Session, month: int, year: int) -> list[dict]:
    """
    For every ACTIVE employee, build their payroll picture for the month:
      - salary components + gross
      - advances taken this month (with a per-advance breakdown)
      - net_payable = gross - advances
      - whether a SalaryRecord already exists (PAID / PARTIAL) or not (PENDING)
    """
    first, last = _month_bounds(month, year)

    employees = (
        db.query(Employee)
        .filter(Employee.is_active == True)  # noqa: E712
        .order_by(Employee.name.asc())
        .all()
    )

    result: list[dict] = []
    for emp in employees:
        gross = total_salary(emp)

        advance_rows = _advances_for(db, emp.id, first, last)
        advances_taken = sum((_dec(a.amount) for a in advance_rows), ZERO)
        advances = [
            {
                "date":        a.date,
                "amount":      _dec(a.amount),
                "description": a.description,
            }
            for a in advance_rows
        ]

        net_payable = gross - advances_taken

        # Has this month already been settled?
        record = (
            db.query(SalaryRecord)
            .filter(
                SalaryRecord.employee_id == emp.id,
                SalaryRecord.month == month,
                SalaryRecord.year == year,
            )
            .first()
        )

        result.append({
            "employee":         employee_to_dict(emp),
            "gross_salary":     gross,
            "advances_taken":   advances_taken,
            "net_payable":      net_payable,
            "advances":         advances,
            "status":           record.status if record else "PENDING",
            "salary_record_id": record.id if record else None,
            "amount_paid":      _dec(record.amount_paid) if record else None,
        })

    return result


# ---------------------------------------------------------------------------
# Function 3 — settle (pay) an employee's salary for a month
# ---------------------------------------------------------------------------

def settle_salary(
    db: Session,
    employee_id: int,
    month: int,
    year: int,
    amount_paid: Decimal,
    payment_mode: str,
    notes: str | None,
    created_by: int | None,
) -> SalaryRecord:
    """
    Pay an employee for a month.  Does three things in one transaction:

      1. Snapshots the employee's current salary components into a SalaryRecord.
      2. Records the actual amount paid and marks PAID or PARTIAL.
      3. Writes a matching Expense (category='SALARY') so the payment shows up in
         the expense summary and cash register.

    If a SalaryRecord already exists for this employee/month it is reused
    (re-settlement) rather than duplicated.

    The caller is responsible for committing — this function only flushes so the
    new ids are available.
    """
    emp = db.get(Employee, employee_id)
    if emp is None:
        raise ValueError("Employee not found")

    first, last = _month_bounds(month, year)

    # Recompute gross + advances from current data (never trust the client).
    gross = total_salary(emp)
    advance_rows = _advances_for(db, emp.id, first, last)
    total_advances = sum((_dec(a.amount) for a in advance_rows), ZERO)
    net_payable = gross - total_advances

    amount_paid = _dec(amount_paid)
    # PAID when the owner settled the whole net (or more); PARTIAL otherwise.
    status = "PAID" if amount_paid >= net_payable else "PARTIAL"

    record = (
        db.query(SalaryRecord)
        .filter(
            SalaryRecord.employee_id == emp.id,
            SalaryRecord.month == month,
            SalaryRecord.year == year,
        )
        .first()
    )
    if record is None:
        record = SalaryRecord(employee_id=emp.id, month=month, year=year)
        db.add(record)

    # Snapshot the components as they stand right now.
    record.basic_salary     = _dec(emp.basic_salary)
    record.hra              = _dec(emp.hra)
    record.travel_allowance = _dec(emp.travel_allowance)
    record.other_allowance  = _dec(emp.other_allowance)
    record.gross_salary     = gross
    record.total_advances   = total_advances
    record.net_payable      = net_payable
    record.amount_paid      = amount_paid
    record.payment_mode     = payment_mode
    record.status           = status
    record.paid_at          = datetime.utcnow()
    record.notes            = notes
    record.created_by       = created_by

    # Mirror the payment into the expenses ledger so it flows into the monthly
    # summary and the day's cash register.  Dated on the last day of the salary
    # month so it lands in the correct month's expense totals.
    month_name = date(year, month, 1).strftime("%B %Y")
    salary_expense = Expense(
        date=last,
        category="SALARY",
        description=f"Salary paid to {emp.name} for {month_name}",
        amount=amount_paid,
        payment_mode=payment_mode,
        paid_to=emp.name,
        employee_id=emp.id,
        notes=notes,
        created_by=created_by,
    )
    db.add(salary_expense)

    db.flush()   # assign ids; caller commits
    return record


# ---------------------------------------------------------------------------
# Function 4 — live daily cash register
# ---------------------------------------------------------------------------

def _sales_split(db: Session, day: date) -> tuple[Decimal, Decimal]:
    """
    Return (cash_sales, upi_sales) for a single day from non-returned invoices.

    ⚠ DELIBERATELY *NOT* NET OF PARTIAL-RETURN REFUNDS — unlike every other
    revenue query in the app (see app/services/revenue.py).  This is the reason:

    This figure feeds the DRAWER reconciliation in get_cash_register(), where
    the owner compares it against cash they have physically counted.  Every
    invoice here is bucketed by invoice_date, so subtracting invoices.
    refunded_amount would book a refund on the day of the ORIGINAL SALE, not
    the day the money actually left the till.  Refund a ₹400 item today against
    last Tuesday's bill and last Tuesday — a day already counted, closed and
    signed off — would silently turn into a ₹400 shortage.

    Doing it properly needs two things the return flow does not record yet: WHEN
    the refund happened, and in what TENDER (cash back from the drawer vs a UPI
    reversal).  Until those exist, leaving the sale whole keeps every closed day
    stable, which is what a reconciliation tool is for.  A same-day cash refund
    therefore still shows as a drawer shortage on the day — visible and
    explainable, rather than a number that rewrites history.
    """
    # invoice_date is UTC; filter on the UTC window of this IST calendar day so a
    # late-evening IST sale is counted on the correct day (not the previous one).
    day_start, day_end = ist_day_bounds_utc(day)
    rows = (
        db.query(
            Invoice.payment_method,
            func.sum(Invoice.total_amount).label("total"),
        )
        .filter(
            Invoice.invoice_date >= day_start,
            Invoice.invoice_date < day_end,
            Invoice.status != "RETURNED",
        )
        .group_by(Invoice.payment_method)
        .all()
    )
    cash = upi = ZERO
    for method, total in rows:
        if method == "CASH":
            cash += _dec(total)
        elif method == "UPI":
            upi += _dec(total)
    return cash, upi


def _expense_split(db: Session, day: date) -> tuple[Decimal, Decimal]:
    """Return (cash_out, upi_out) for a single day from the expenses table."""
    rows = (
        db.query(
            Expense.payment_mode,
            func.sum(Expense.amount).label("total"),
        )
        .filter(Expense.date == day)
        .group_by(Expense.payment_mode)
        .all()
    )
    cash = upi = ZERO
    for mode, total in rows:
        if mode == "CASH":
            cash += _dec(total)
        elif mode == "UPI":
            upi += _dec(total)
    return cash, upi


def get_cash_register(db: Session, day: date) -> dict:
    """
    Build the full daily picture for `day`.

    Opening balances come from the stored CashRegister row (if any).  The "in"
    (sales) and "out" (expenses) numbers are always calculated live from the
    invoices and expenses tables, so they never go stale.  Expected closing
    balances = opening + in - out.  If the owner has recorded an actual counted
    balance, the difference (actual - expected) is included so a shortage stands
    out.

    Does NOT create a row — use set_opening()/record_closing() to persist.
    """
    reg = db.query(CashRegister).filter(CashRegister.date == day).first()

    opening_cash = _dec(reg.opening_cash) if reg else ZERO
    opening_bank = _dec(reg.opening_bank) if reg else ZERO

    cash_in, upi_in   = _sales_split(db, day)
    cash_out, upi_out = _expense_split(db, day)

    expected_cash = opening_cash + cash_in - cash_out
    expected_bank = opening_bank + upi_in - upi_out

    actual_cash = _dec(reg.closing_cash) if reg and reg.closing_cash is not None else None
    actual_bank = _dec(reg.closing_bank) if reg and reg.closing_bank is not None else None

    diff_cash = (actual_cash - expected_cash) if actual_cash is not None else None
    diff_bank = (actual_bank - expected_bank) if actual_bank is not None else None

    return {
        "date":                day,
        "opening_cash":        opening_cash,
        "opening_bank":        opening_bank,
        "cash_in":             cash_in,
        "upi_in":              upi_in,
        "cash_out":            cash_out,
        "upi_out":             upi_out,
        "closing_cash":        expected_cash,
        "closing_bank":        expected_bank,
        "actual_closing_cash": actual_cash,
        "actual_closing_bank": actual_bank,
        "difference_cash":     diff_cash,
        "difference_bank":     diff_bank,
        "notes":               reg.notes if reg else None,
    }


def set_opening(
    db: Session,
    day: date,
    opening_cash: Decimal,
    opening_bank: Decimal,
    created_by: int | None,
) -> CashRegister:
    """Get-or-create the day's register row and set its opening balances."""
    reg = db.query(CashRegister).filter(CashRegister.date == day).first()
    if reg is None:
        reg = CashRegister(date=day, created_by=created_by)
        db.add(reg)
    reg.opening_cash = _dec(opening_cash)
    reg.opening_bank = _dec(opening_bank)
    reg.updated_at   = datetime.utcnow()
    db.flush()
    return reg


def record_closing(
    db: Session,
    day: date,
    actual_closing_cash: Decimal,
    actual_closing_bank: Decimal,
    notes: str | None,
    created_by: int | None,
) -> CashRegister:
    """Get-or-create the day's register row and store the counted balances."""
    reg = db.query(CashRegister).filter(CashRegister.date == day).first()
    if reg is None:
        reg = CashRegister(date=day, created_by=created_by)
        db.add(reg)
    reg.closing_cash = _dec(actual_closing_cash)
    reg.closing_bank = _dec(actual_closing_bank)
    if notes is not None:
        reg.notes = notes
    reg.updated_at = datetime.utcnow()
    db.flush()
    return reg
