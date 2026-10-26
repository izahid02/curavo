"""
Dashboard summary endpoint.

GET /api/dashboard/summary — returns a single JSON object with all the
numbers shown on the Dashboard screen.  One DB query per metric; no N+1.

All values come from real DB data so the dashboard always reflects the
current state of the pharmacy.
"""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.billing import Invoice, InvoiceItem
from app.models.expenditure import Employee, Expense, SalaryRecord
from app.models.inventory import Batch, Product, StockPurchase
from app.models.patients import Patient
from app.models.supplier_credit import SupplierCreditTransaction
from app.models.user import User
from app.services import costing
from app.services.auth_service import get_current_user
from app.services.inventory_service import count_expiry_alert_products
# Revenue net of partial returns — see app/services/revenue.py for why every
# sales figure has to go through these rather than raw total_amount/quantity.
from app.services.revenue import (
    net_invoice_amount_expr,
    retained_line_total_expr,
    sold_qty_expr,
)
from app.utils.dates import IST, get_today_ist, ist_day_bounds_utc, ist_range_bounds_utc

router = APIRouter(prefix="/dashboard", tags=["Dashboard"])


# ---------------------------------------------------------------------------
# Response shapes
# ---------------------------------------------------------------------------

class TopProduct(BaseModel):
    product_name: str
    units_sold: int
    revenue: float


class RecentInvoice(BaseModel):
    invoice_number: str
    patient_name: str          # "Walk-in" when patient_id is None
    total_amount: float
    payment_method: Optional[str] = None
    invoice_date: str          # ISO-8601 string — easy to parse in JS


class ExpenseCategory(BaseModel):
    category: str
    amount: float


class PatientsToday(BaseModel):
    """
    How many patients walked in today, split into first-timers and repeats.

    `total` counts DISTINCT patients billed today — someone who bought twice is
    one patient, not two.  Walk-ins (invoices with no patient_id) are not
    counted at all, because we have no record to tell "new" from "returning".
    """
    total: int
    new_patients: int
    returning: int


class DashboardSummary(BaseModel):
    today_sales: float
    monthly_sales: float
    inventory_value: float
    expiry_alerts_count: int
    low_stock_count: int
    new_patients_today: int
    patients_today: PatientsToday
    top_products: List[TopProduct]
    recent_invoices: List[RecentInvoice]
    # Expenditure widget: this month's total spend + its two biggest categories
    monthly_expenses: float
    top_expense_categories: List[ExpenseCategory]


class ExpenditureEntry(BaseModel):
    """One outgoing payment, whatever its source."""
    type: str                        # SUPPLIER_PAYMENT / CREDIT_PAYMENT / EXPENSE / SALARY
    description: str
    amount: float
    paid_to: Optional[str] = None
    payment_mode: Optional[str] = None
    date: str                        # IST calendar date, "YYYY-MM-DD" (day grouping)
    time: str                        # IST clock time, "10:30 AM"
    timestamp: str                   # full IST ISO instant — used for sorting


class ExpenditurePeriod(BaseModel):
    """Totals + line-by-line breakdown for one time window."""
    total: float
    supplier_payments: float         # paid at the door when stock arrived
    credit_payments: float           # settling an older supplier debt
    expenses: float                  # expenditure module (rent, utilities, advances…)
    salary: float                    # payroll settlements
    cash: float                      # of the total, how much left as cash
    upi: float                       # …and how much as UPI
    breakdown: List[ExpenditureEntry]


class ExpenditureSummary(BaseModel):
    today: ExpenditurePeriod
    month: ExpenditurePeriod
    month_label: str                 # e.g. "July" — card heading


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _to_float(value) -> float:
    """Convert Decimal / None coming from SQLAlchemy aggregates to float."""
    if value is None:
        return 0.0
    return float(value)


def _ist_parts(ts: Optional[datetime], fallback_day: Optional[date] = None):
    """
    Turn a stored timestamp into the three display/sorting fields we need.

    Stored timestamps are naive UTC (see utils/dates.py), so we attach UTC and
    convert to IST before formatting — otherwise a 9 PM IST payment would show
    up with the previous day's date and a wrong clock time.

    `fallback_day` is used for rows whose *business* date is authoritative (an
    Expense carries an explicit `date` column that may differ from the moment it
    was typed in), and as a safety net when the timestamp is NULL.
    """
    if ts is None:
        day = fallback_day or get_today_ist()
        return day.isoformat(), "", datetime(day.year, day.month, day.day).isoformat()

    aware = ts.replace(tzinfo=timezone.utc) if ts.tzinfo is None else ts
    ist = aware.astimezone(IST)
    day = fallback_day or ist.date()
    # "%I:%M %p" keeps the leading zero: "09:00 AM", "02:15 PM".
    return day.isoformat(), ist.strftime("%I:%M %p"), ist.isoformat()


def _collect_expenditure(db: Session, day_from: date, day_to: date) -> ExpenditurePeriod:
    """
    Every rupee that left the pharmacy between two IST calendar dates (inclusive).

    FOUR sources, deliberately chosen so nothing is counted twice — see the
    comment on each block.  The two traps are documented because both would
    silently double the number on screen:

      1. stock_purchases has NO amount_paid / payment_mode column.  Money handed
         over at delivery is written by inventory_service as a
         SupplierCreditTransaction(type='PAYMENT') carrying a stock_purchase_id.
         So supplier payments have exactly ONE home, and the presence of that
         stock_purchase_id is what separates "paid at the door" from "settled an
         old debt" — it is not a second table to query.

      2. expenditure_service.settle_salary writes BOTH a SalaryRecord AND a
         mirrored Expense(category='SALARY').  We therefore take salary from
         salary_records only and EXCLUDE category='SALARY' from the expense
         query.  salary_records is the better of the two because it is dated by
         paid_at — the day the cash actually left — whereas the mirrored expense
         is dated to the last day of the salary month, so an August settlement
         of July's salary would otherwise never appear on any day's card.
    """
    # created_at columns are naive UTC → convert the IST date span to a UTC window.
    start_utc, end_utc = ist_range_bounds_utc(day_from, day_to)

    entries: List[ExpenditureEntry] = []
    supplier_total = Decimal("0")
    credit_total   = Decimal("0")
    expense_total  = Decimal("0")
    salary_total   = Decimal("0")

    # --- 1 + 2. Supplier money (both kinds live in one table) ---------------
    # outerjoin, because a debt-settlement PAYMENT has no stock_purchase_id.
    payment_rows = (
        db.query(SupplierCreditTransaction, StockPurchase)
        .outerjoin(StockPurchase,
                   StockPurchase.id == SupplierCreditTransaction.stock_purchase_id)
        .filter(
            SupplierCreditTransaction.type == "PAYMENT",
            SupplierCreditTransaction.created_at >= start_utc,
            SupplierCreditTransaction.created_at < end_utc,
        )
        .all()
    )
    for tx, purchase in payment_rows:
        amount = Decimal(str(tx.amount or 0))
        if amount <= 0:
            continue
        supplier_name = tx.supplier.name if tx.supplier else "Supplier"
        iso_day, clock, stamp = _ist_parts(tx.created_at)

        if purchase is not None:
            # Paid at the door when the delivery arrived.
            supplier_total += amount
            description = "Stock Purchase"
            if purchase.supplier_invoice_number:
                description += f" · Invoice #{purchase.supplier_invoice_number}"
            entry_type = "SUPPLIER_PAYMENT"
        else:
            # Paying down an older outstanding balance.
            credit_total += amount
            description = "Supplier Credit Payment"
            entry_type = "CREDIT_PAYMENT"

        entries.append(ExpenditureEntry(
            type=entry_type,
            description=description,
            amount=float(amount),
            paid_to=supplier_name,
            payment_mode=tx.payment_mode,
            date=iso_day, time=clock, timestamp=stamp,
        ))

    # --- 3. Expenditure module ----------------------------------------------
    # `date` is a plain DATE column holding the business date, so compare it to
    # the IST dates directly (no UTC window).  SALARY is excluded — see trap 2.
    expense_rows = (
        db.query(Expense)
        .filter(
            Expense.date >= day_from,
            Expense.date <= day_to,
            Expense.category != "SALARY",
        )
        .all()
    )
    for exp in expense_rows:
        amount = Decimal(str(exp.amount or 0))
        if amount <= 0:
            continue
        expense_total += amount
        # The business date wins over the moment it was typed in; the clock time
        # still comes from created_at.
        iso_day, clock, stamp = _ist_parts(exp.created_at, fallback_day=exp.date)
        entries.append(ExpenditureEntry(
            type="EXPENSE",
            description=exp.description or exp.category,
            amount=float(amount),
            paid_to=exp.paid_to,
            payment_mode=exp.payment_mode,
            date=iso_day, time=clock, timestamp=stamp,
        ))

    # --- 4. Payroll settlements ---------------------------------------------
    salary_rows = (
        db.query(SalaryRecord)
        .filter(
            SalaryRecord.status.in_(["PAID", "PARTIAL"]),
            SalaryRecord.paid_at.isnot(None),
            SalaryRecord.paid_at >= start_utc,
            SalaryRecord.paid_at < end_utc,
        )
        .all()
    )
    for rec in salary_rows:
        amount = Decimal(str(rec.amount_paid or 0))
        if amount <= 0:
            continue
        salary_total += amount
        name = rec.employee.name if rec.employee else "Employee"
        month_name = date(rec.year, rec.month, 1).strftime("%B %Y")
        iso_day, clock, stamp = _ist_parts(rec.paid_at)
        entries.append(ExpenditureEntry(
            type="SALARY",
            description=f"Salary · {month_name}",
            amount=float(amount),
            paid_to=name,
            payment_mode=rec.payment_mode,
            date=iso_day, time=clock, timestamp=stamp,
        ))

    # Newest first — the panel reads top-down as "most recent thing I paid".
    entries.sort(key=lambda e: e.timestamp, reverse=True)

    # Cash / UPI split for the panel footer.  Anything with an unrecognised or
    # missing mode is left out of both rather than guessed at.
    cash = sum((Decimal(str(e.amount)) for e in entries if e.payment_mode == "CASH"), Decimal("0"))
    upi  = sum((Decimal(str(e.amount)) for e in entries if e.payment_mode == "UPI"),  Decimal("0"))

    total = supplier_total + credit_total + expense_total + salary_total

    return ExpenditurePeriod(
        total=float(total),
        supplier_payments=float(supplier_total),
        credit_payments=float(credit_total),
        expenses=float(expense_total),
        salary=float(salary_total),
        cash=float(cash),
        upi=float(upi),
        breakdown=entries,
    )


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.get("/summary", response_model=DashboardSummary)
def get_dashboard_summary(
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),   # auth guard
):
    """
    Return every number shown on the Dashboard in a single round-trip per metric.

    We use SQLAlchemy aggregate functions (func.sum, func.count) so PostgreSQL
    does the heavy lifting — no Python loops over large result sets.
    """
    today       = get_today_ist()               # today's IST calendar date
    first_day   = today.replace(day=1)          # first day of current month

    # invoice_date is stored in UTC; convert the IST "today" / "this month" spans
    # into UTC windows so late-evening IST sales land on the right day.
    day_start, day_end     = ist_day_bounds_utc(today)
    month_start, _month_end = ist_day_bounds_utc(first_day)

    # ------------------------------------------------------------------
    # 1. Today's sales — sum of completed invoices created today (IST)
    # ------------------------------------------------------------------
    # net_invoice_amount_expr() = total_amount − refunded_amount, so a bill the
    # customer partly brought back reports what they are left having paid.
    # With no refund it is total_amount exactly, so an ordinary day is unchanged.
    today_sales = _to_float(
        db.query(func.sum(net_invoice_amount_expr()))
        .filter(
            Invoice.invoice_date >= day_start,
            Invoice.invoice_date < day_end,
            Invoice.status != "RETURNED",
        )
        .scalar()
    )

    # ------------------------------------------------------------------
    # 2. Monthly sales — same but from the 1st of this month (IST)
    # ------------------------------------------------------------------
    monthly_sales = _to_float(
        db.query(func.sum(net_invoice_amount_expr()))
        .filter(
            Invoice.invoice_date >= month_start,
            Invoice.status != "RETURNED",
        )
        .scalar()
    )

    # ------------------------------------------------------------------
    # 3. Inventory value — qty × purchase_price for non-expired stock
    # ------------------------------------------------------------------
    inventory_value = _to_float(
        db.query(func.sum(Batch.quantity_available * costing.unit_cost_column()))
        .filter(
            Batch.quantity_available > 0,
            Batch.expiry_date >= today,
        )
        .scalar()
    )

    # ------------------------------------------------------------------
    # 4. Expiry alerts — ONE canonical definition shared with the sidebar badge
    #    and the Expiry Alerts page: distinct products with at least one in-stock
    #    batch that is expired or expiring within EXPIRY_ALERT_HORIZON_DAYS (60).
    #    (Previously this card counted batches and excluded expired stock, so it
    #    disagreed with the other two places.)  The dashboard card's subtitle
    #    says "Within 60 days" for the same reason — it must track that constant.
    # ------------------------------------------------------------------
    expiry_alerts_count: int = count_expiry_alert_products(db)

    # ------------------------------------------------------------------
    # 5. Low stock count — products whose non-expired stock < min_stock_level
    #
    # We build a subquery that totals available qty per product (excluding
    # expired batches), then outer-join it to products and compare.
    # Products with NO non-expired batches get coalesced to 0.
    # ------------------------------------------------------------------
    stock_subq = (
        db.query(
            Batch.product_id,
            func.sum(Batch.quantity_available).label("total_qty"),
        )
        .filter(
            Batch.expiry_date >= today,
            Batch.quantity_available > 0,
        )
        .group_by(Batch.product_id)
        .subquery()
    )

    low_stock_count: int = (
        db.query(func.count(Product.id))
        .outerjoin(stock_subq, Product.id == stock_subq.c.product_id)
        .filter(
            Product.is_active == True,
            func.coalesce(stock_subq.c.total_qty, 0) < Product.min_stock_level,
        )
        .scalar()
        or 0
    )

    # ------------------------------------------------------------------
    # 6. New patients today
    # ------------------------------------------------------------------
    new_patients_today: int = (
        db.query(func.count(Patient.id))
        .filter(Patient.registration_date == today)
        .scalar()
        or 0
    )

    # ------------------------------------------------------------------
    # 6b. Patients seen today — total, split into new vs returning
    #
    # "Seen today" = has at least one invoice dated today (IST) that is linked
    # to a patient record.  Walk-in invoices carry no patient_id, so they are
    # skipped: with no record we cannot say whether they are new or returning.
    #
    # We pull the distinct patient IDs first and count them in Python rather
    # than using COUNT(DISTINCT …) inline, because we need the same ID list
    # again for the "new" half.  A single pharmacy day is a few dozen patients
    # at most, so the list is tiny.
    #
    # "New" means: of the people seen TODAY, how many registered TODAY.  Note
    # this is deliberately NOT the same as new_patients_today above, which
    # counts every registration today including patients who registered but did
    # not buy anything.  Subtracting that number would let `returning` go
    # negative; asking "which of today's buyers are first-timers" cannot.
    # ------------------------------------------------------------------
    today_patient_ids = [
        row[0] for row in (
            db.query(Invoice.patient_id)
            .filter(
                Invoice.patient_id.isnot(None),
                Invoice.invoice_date >= day_start,
                Invoice.invoice_date < day_end,
            )
            .distinct()
            .all()
        )
    ]
    total_seen_today = len(today_patient_ids)

    new_seen_today = 0
    if today_patient_ids:
        new_seen_today = (
            db.query(func.count(Patient.id))
            .filter(
                Patient.id.in_(today_patient_ids),
                Patient.registration_date == today,
            )
            .scalar()
            or 0
        )

    patients_today = PatientsToday(
        total=total_seen_today,
        new_patients=new_seen_today,
        returning=total_seen_today - new_seen_today,
    )

    # ------------------------------------------------------------------
    # 7. Top 5 products by units sold this month
    # ------------------------------------------------------------------
    top_rows = (
        db.query(
            Product.name,
            # Units KEPT and the money for them — a medicine that was billed
            # and then handed straight back is not a top seller.
            func.sum(sold_qty_expr()).label("units_sold"),
            func.sum(retained_line_total_expr()).label("revenue"),
        )
        .join(InvoiceItem, InvoiceItem.product_id == Product.id)
        .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
        .filter(
            # month_start is the UTC instant that IST month-start maps to —
            # func.date() on a UTC timestamp would misfile the first few hours
            # of the 1st onto the previous month.
            Invoice.invoice_date >= month_start,
            Invoice.status != "RETURNED",
        )
        .group_by(Product.id, Product.name)
        .order_by(func.sum(sold_qty_expr()).desc())
        .limit(5)
        .all()
    )
    top_products = [
        TopProduct(
            product_name=row.name,
            units_sold=int(row.units_sold or 0),
            revenue=_to_float(row.revenue),
        )
        for row in top_rows
    ]

    # ------------------------------------------------------------------
    # 8. Last 5 invoices with patient name (or "Walk-in")
    # ------------------------------------------------------------------
    recent_rows = (
        db.query(Invoice)
        .order_by(Invoice.invoice_date.desc())
        .limit(5)
        .all()
    )
    recent_invoices = [
        RecentInvoice(
            invoice_number=inv.invoice_number,
            # invoice.patient is lazy-loaded here (one extra query max per row,
            # but only 5 rows so it's negligible)
            patient_name=inv.patient.name if inv.patient else "Walk-in",
            total_amount=_to_float(inv.total_amount),
            payment_method=inv.payment_method,
            invoice_date=inv.invoice_date.isoformat(),
        )
        for inv in recent_rows
    ]

    # ------------------------------------------------------------------
    # 9. This month's expenses — total spend + the two biggest categories
    # ------------------------------------------------------------------
    from app.models.expenditure import Expense   # local import: avoids any

    expense_rows = (
        db.query(
            Expense.category,
            func.sum(Expense.amount).label("total"),
        )
        .filter(
            Expense.date >= first_day,
            Expense.date <= today,
        )
        .group_by(Expense.category)
        .order_by(func.sum(Expense.amount).desc())
        .all()
    )
    monthly_expenses = _to_float(sum((row.total or 0) for row in expense_rows))
    top_expense_categories = [
        ExpenseCategory(category=row.category, amount=_to_float(row.total))
        for row in expense_rows[:2]   # top 2 categories only
    ]

    return DashboardSummary(
        today_sales=today_sales,
        monthly_sales=monthly_sales,
        inventory_value=inventory_value,
        expiry_alerts_count=expiry_alerts_count,
        low_stock_count=low_stock_count,
        new_patients_today=new_patients_today,
        patients_today=patients_today,
        top_products=top_products,
        recent_invoices=recent_invoices,
        monthly_expenses=monthly_expenses,
        top_expense_categories=top_expense_categories,
    )


@router.get("/expenditure-summary", response_model=ExpenditureSummary)
def get_expenditure_summary(
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),   # auth guard
):
    """
    All money OUT of the pharmacy, for today and for the current month.

    "Out" means every source combined: paying a supplier at the door, settling
    an older supplier debt, an expenditure-module entry (rent, utilities, staff
    advances), and a payroll settlement.  Each period carries both the totals
    (for the dashboard card) and the full line-by-line breakdown (for the
    slide-in history panel), so the card and the panel can never disagree —
    they are computed from the same list.

    Both windows are IST calendar windows: "today" is the IST day, "month" runs
    from the 1st of the IST month up to and including today.
    """
    today     = get_today_ist()
    first_day = today.replace(day=1)

    return ExpenditureSummary(
        today=_collect_expenditure(db, today, today),
        month=_collect_expenditure(db, first_day, today),
        month_label=today.strftime("%B"),
    )
