"""
Dashboard summary endpoint.

GET /api/dashboard/summary — returns a single JSON object with all the
numbers shown on the Dashboard screen.  One DB query per metric; no N+1.

All values come from real DB data so the dashboard always reflects the
current state of the pharmacy.
"""
from datetime import date, timedelta
from decimal import Decimal
from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.billing import Invoice, InvoiceItem
from app.models.inventory import Batch, Product
from app.models.patients import Patient
from app.models.user import User
from app.services.auth_service import get_current_user
from app.services.inventory_service import count_expiry_alert_products
from app.utils.dates import get_today_ist, ist_day_bounds_utc

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


class DashboardSummary(BaseModel):
    today_sales: float
    monthly_sales: float
    inventory_value: float
    expiry_alerts_count: int
    low_stock_count: int
    new_patients_today: int
    top_products: List[TopProduct]
    recent_invoices: List[RecentInvoice]
    # Expenditure widget: this month's total spend + its two biggest categories
    monthly_expenses: float
    top_expense_categories: List[ExpenseCategory]


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _to_float(value) -> float:
    """Convert Decimal / None coming from SQLAlchemy aggregates to float."""
    if value is None:
        return 0.0
    return float(value)


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
    ninety_days = today + timedelta(days=90)

    # invoice_date is stored in UTC; convert the IST "today" / "this month" spans
    # into UTC windows so late-evening IST sales land on the right day.
    day_start, day_end     = ist_day_bounds_utc(today)
    month_start, _month_end = ist_day_bounds_utc(first_day)

    # ------------------------------------------------------------------
    # 1. Today's sales — sum of completed invoices created today (IST)
    # ------------------------------------------------------------------
    today_sales = _to_float(
        db.query(func.sum(Invoice.total_amount))
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
        db.query(func.sum(Invoice.total_amount))
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
        db.query(func.sum(Batch.quantity_available * Batch.purchase_price))
        .filter(
            Batch.quantity_available > 0,
            Batch.expiry_date >= today,
        )
        .scalar()
    )

    # ------------------------------------------------------------------
    # 4. Expiry alerts — ONE canonical definition shared with the sidebar badge
    #    and the Expiry Alerts page: distinct products with at least one in-stock
    #    batch that is expired or expiring within 90 days. (Previously this card
    #    counted batches and excluded expired stock, so it disagreed with the
    #    other two places.)
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
    # 7. Top 5 products by units sold this month
    # ------------------------------------------------------------------
    top_rows = (
        db.query(
            Product.name,
            func.sum(InvoiceItem.quantity).label("units_sold"),
            func.sum(InvoiceItem.line_total).label("revenue"),
        )
        .join(InvoiceItem, InvoiceItem.product_id == Product.id)
        .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
        .filter(
            func.date(Invoice.invoice_date) >= first_day,
            Invoice.status != "RETURNED",
        )
        .group_by(Product.id, Product.name)
        .order_by(func.sum(InvoiceItem.quantity).desc())
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
        top_products=top_products,
        recent_invoices=recent_invoices,
        monthly_expenses=monthly_expenses,
        top_expense_categories=top_expense_categories,
    )
