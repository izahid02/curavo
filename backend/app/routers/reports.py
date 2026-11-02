"""
Reports API — four read-only analytics endpoints.

All routes require a valid login (JWT auth). No data is ever modified here.
All routes are prefixed with /api/reports.

Endpoints:
  GET /api/reports/sales      — revenue, cost, profit, daily breakdown, top products/departments
  GET /api/reports/inventory  — current stock snapshot, expiry summary, low stock
  GET /api/reports/profit     — profit summary, 6-month trend, product profitability
  GET /api/reports/patients   — patient stats, department breakdown, top patients

Date-range endpoints accept:
  date_from — YYYY-MM-DD (default: first day of current month)
  date_to   — YYYY-MM-DD (default: today)
"""
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import case, func, distinct
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.billing import Invoice, InvoiceItem
from app.models.inventory import Batch, Department, Product
from app.models.patients import Patient, patient_departments_table
from app.models.user import User
from app.services import costing
from app.services.auth_service import get_current_user
from app.services.licence import require_full_licence
# The single definition of "how much actually stayed sold" after a partial
# return.  Every revenue figure in this file goes through these.
from app.services.revenue import (
    net_invoice_amount_expr,
    retained_line_total_expr,
    sold_qty_expr,
)

# Reports (and the PDF/Excel exports built from them) pause when the Curavo
# subscription has lapsed - see services/licence.py.  Billing never does.
router = APIRouter(
    prefix="/reports", tags=["Reports"],
    dependencies=[Depends(require_full_licence)],
)


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def _f(value) -> float:
    """Convert Decimal/None from SQLAlchemy aggregates to float."""
    return 0.0 if value is None else float(value)


def _default_range() -> tuple[date, date]:
    """First day of current month → today."""
    today = date.today()
    return today.replace(day=1), today


def _resolve_dates(date_from: Optional[date], date_to: Optional[date]) -> tuple[date, date]:
    """Fill in None values with defaults."""
    first, today = _default_range()
    return (date_from or first), (date_to or today)


# ---------------------------------------------------------------------------
# Profit maths — ONE definition, shared by every report on this page
# ---------------------------------------------------------------------------
# WHY THIS EXISTS
# ---------------
# A bill discount is stored on the INVOICE (invoices.discount_amount), not on
# the individual lines.  invoices.subtotal is the PRE-discount ex-GST value, so
# using it as "revenue" silently ignores every rupee given away.  A 100%
# discount used to report a full profit — the pharmacy handed the medicine over
# for free and the report called it a good day.
#
# The fix is to push each invoice's discount back down onto its lines in
# proportion to what each line contributed to the bill, then take the ex-GST
# part of what is LEFT.  Every profit figure in this file goes through the two
# helpers below, so the summary cards, the daily table, the monthly trend and
# the product tables can never drift apart.


def _discount_ratio():
    """
    SQL expression: what FRACTION of this invoice was discounted away (0.0–1.0).

    The denominator is the GST-INCLUSIVE bill (subtotal + GST + home visit),
    because that is the figure the discount was actually taken off — the
    customer is handed one total, not an ex-GST one.  Dividing by `subtotal`
    alone would over-state the ratio by the GST factor and subtract more than
    was really given away.

    Real example — HCC-2026-000017: subtotal 95.29 + GST 4.76 = 100.05 bill,
    discount 100.00 → ratio 0.9995.  Almost the whole bill was a giveaway.

    Clamped to 1.0 because a discount is occasionally keyed in slightly ABOVE
    the bill (HCC-2026-000003: ₹400 off a ₹400.20 bill, but ₹400 > the ₹381.14
    subtotal).  Without the clamp the line revenue would go NEGATIVE, which
    would then over-state the loss.  The floor is a free item, never a refund.
    """
    gross_bill = (
        Invoice.subtotal
        + Invoice.gst_amount
        + func.coalesce(Invoice.home_visit_charge, 0)
    )
    # nullif → a zero-value bill divides to NULL instead of raising; the outer
    # coalesce turns that back into "nothing was discounted".
    raw = func.coalesce(Invoice.discount_amount, 0) * 1.0 / func.nullif(gross_bill, 0)
    return func.coalesce(
        case((raw > 1.0, 1.0), (raw < 0.0, 0.0), else_=raw),
        0.0,
    )


def _net_revenue_expr():
    """
    SQL expression: REAL revenue for one invoice line — what the pharmacy keeps.

    Four things happen, in this order:
      0. retained_line_total → qty × MRP for the units the customer KEPT
      1.                       (GST-inclusive, pre-discount)
      2. × (1 − ratio)       → this line's share of the bill discount removed
      3. × 100/(100 + rate)  → GST stripped out (it belongs to the government)

    ⚠ STEP 0 IS THE PARTIAL-RETURN CORRECTION.  This used to start from the
    stored line_total, which is what was ORIGINALLY sold.  On a partially
    returned invoice those units are back on the shelf, so counting them as
    revenue both overstated the sale and double-counted the stock (the same
    tablets also sit in inventory value).  retained_line_total_expr() returns
    the stored line_total unchanged when nothing came back, so every existing
    figure is byte-for-byte what it was.

    The discount RATIO is deliberately still computed from the ORIGINAL bill
    (see _discount_ratio): the discount was negotiated on the whole bill as it
    stood, and the share carried by the lines the customer kept does not change
    because a different line went back.

    Requires InvoiceItem joined to Invoice — every caller below does that.
    """
    return (
        retained_line_total_expr()
        * (1.0 - _discount_ratio())
        * 100
        / (100 + InvoiceItem.gst_rate)
    )


def _cost_expr():
    """SQL expression: cost of one invoice line.

    purchase_price is snapshotted onto the line at sale time (it is the batch's
    effective cost after any supplier discount) so historical profit never
    changes when a later delivery is cheaper.  It is already ex-GST, which is
    why it can be compared directly with the ex-GST revenue above.

    ⚠ Costed on the units KEPT, not the units billed.  Returned stock went back
    onto the shelf at its original cost, so charging it to cost-of-goods here
    would book the same purchase twice — once as a sale that did not stick, and
    again as inventory we still own.
    """
    return sold_qty_expr() * InvoiceItem.purchase_price


def _margin_pct(profit: float, revenue: float, cost: float) -> float:
    """
    Margin as a percentage, with the giveaway case handled explicitly.

    revenue > 0  → the ordinary case
    revenue == 0 → everything was discounted away.  We paid `cost` and got
                   nothing back, so the loss is total: −100%.  (Returning 0
                   here would make a free giveaway look break-even.)
    both zero    → nothing happened; 0, not a fake −100%.
    """
    if revenue > 0:
        return round(profit / revenue * 100, 2)
    if cost > 0:
        return -100.0
    return 0.0


# ---------------------------------------------------------------------------
# Shared Pydantic models
# ---------------------------------------------------------------------------

class Period(BaseModel):
    from_date: str
    to_date: str


# ===========================================================================
# SALES REPORT
# ===========================================================================

class SalesSummary(BaseModel):
    total_revenue: float
    total_cost: float
    gross_profit: float
    profit_margin_pct: float
    total_invoices: int
    total_items_sold: int
    cash_sales: float
    upi_sales: float
    credit_sales: float


class DailyRow(BaseModel):
    date: str
    revenue: float
    invoices_count: int
    profit: float


class TopProductRow(BaseModel):
    product_name: str
    units_sold: int
    revenue: float
    profit: float


class TopDepartmentRow(BaseModel):
    department_name: str
    revenue: float
    invoices_count: int


class SalesReport(BaseModel):
    period: Period
    summary: SalesSummary
    daily_breakdown: List[DailyRow]
    top_products: List[TopProductRow]
    top_departments: List[TopDepartmentRow]


@router.get("/sales", response_model=SalesReport)
def get_sales_report(
    date_from: Optional[date] = Query(None, description="Start date (default: first of this month)"),
    date_to: Optional[date] = Query(None, description="End date (default: today)"),
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    """
    Sales report for the given date range.

    Breaks down revenue, cost, and profit across summary stats, a
    per-day table, top 10 products, and top 5 departments.
    """
    date_from, date_to = _resolve_dates(date_from, date_to)

    # ------------------------------------------------------------------
    # 1. Invoice-level summary: revenue, counts, payment method splits
    #    (no join to invoice_items — one row per invoice)
    # ------------------------------------------------------------------
    inv_row = (
        db.query(
            func.count(Invoice.id).label("total_invoices"),
            # total_amount is already net of the discount (it is what the
            # customer actually handed over).  It is NOT net of a later partial
            # return, though — hence net_invoice_amount_expr(), which subtracts
            # invoices.refunded_amount.  With no refund it is total_amount
            # exactly, so an untouched invoice reports what it always did.
            func.sum(net_invoice_amount_expr()).label("total_revenue"),
            # CASE returns the net amount when payment matches, else 0
            func.sum(
                case((Invoice.payment_method == "CASH", net_invoice_amount_expr()), else_=0)
            ).label("cash_sales"),
            func.sum(
                case((Invoice.payment_method == "UPI", net_invoice_amount_expr()), else_=0)
            ).label("upi_sales"),
            # The app only uses CASH / UPI / CREDIT (never "CARD"). CREDIT sales
            # were previously missing from the breakdown entirely, so the three
            # cards did not add up to Total Revenue. Count CREDIT here.
            func.sum(
                case((Invoice.payment_method == "CREDIT", net_invoice_amount_expr()), else_=0)
            ).label("credit_sales"),
        )
        .filter(
            func.date(Invoice.invoice_date) >= date_from,
            func.date(Invoice.invoice_date) <= date_to,
            Invoice.status != "RETURNED",
        )
        .one()
    )

    total_invoices  = int(inv_row.total_invoices or 0)
    total_revenue   = _f(inv_row.total_revenue)
    cash_sales   = _f(inv_row.cash_sales)
    upi_sales    = _f(inv_row.upi_sales)
    credit_sales = _f(inv_row.credit_sales)

    # ------------------------------------------------------------------
    # 2. Net revenue, cost and items sold: join invoice_items → invoices
    #    (aggregating item-level columns — no duplication risk)
    #
    #    Revenue is summed HERE rather than from Invoice.subtotal, because the
    #    discount has to be spread across the lines before GST can be stripped
    #    off what is left — see _net_revenue_expr().
    # ------------------------------------------------------------------
    cost_row = (
        db.query(
            # Units the customer KEPT — returned stock is back on the shelf.
            func.sum(sold_qty_expr()).label("total_items"),
            func.sum(_net_revenue_expr()).label("net_revenue"),
            func.sum(_cost_expr()).label("total_cost"),
        )
        .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
        .filter(
            func.date(Invoice.invoice_date) >= date_from,
            func.date(Invoice.invoice_date) <= date_to,
            Invoice.status != "RETURNED",
        )
        .one()
    )

    total_items_sold = int(cost_row.total_items or 0)
    taxable_revenue  = _f(cost_row.net_revenue)   # post-discount, excl-GST
    total_cost = _f(cost_row.total_cost)
    # Profit uses the post-discount excl-GST revenue, not total_revenue.
    # The GST collected is owed to the government — it is not profit.
    gross_profit      = taxable_revenue - total_cost
    profit_margin_pct = _margin_pct(gross_profit, taxable_revenue, total_cost)

    # ------------------------------------------------------------------
    # 3. Daily breakdown — two queries (one for revenue, one for cost)
    #    then merged in Python to avoid JOIN duplication.
    # ------------------------------------------------------------------
    daily_rev_rows = (
        db.query(
            func.date(Invoice.invoice_date).label("day"),
            func.count(Invoice.id).label("inv_count"),
            # Net of refunds, matching the summary card above.
            func.sum(net_invoice_amount_expr()).label("revenue"),
        )
        .filter(
            func.date(Invoice.invoice_date) >= date_from,
            func.date(Invoice.invoice_date) <= date_to,
            Invoice.status != "RETURNED",
        )
        .group_by(func.date(Invoice.invoice_date))
        .order_by(func.date(Invoice.invoice_date))
        .all()
    )

    # Per-day net revenue AND cost come from the same item-level query, so a
    # day's profit is built from the same discounted figures as the summary.
    daily_cost_rows = (
        db.query(
            func.date(Invoice.invoice_date).label("day"),
            func.sum(_net_revenue_expr()).label("net_revenue"),
            func.sum(_cost_expr()).label("cost"),
        )
        .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
        .filter(
            func.date(Invoice.invoice_date) >= date_from,
            func.date(Invoice.invoice_date) <= date_to,
            Invoice.status != "RETURNED",
        )
        .group_by(func.date(Invoice.invoice_date))
        .all()
    )

    profit_by_day = {
        str(r.day): _f(r.net_revenue) - _f(r.cost) for r in daily_cost_rows
    }
    daily_breakdown = [
        DailyRow(
            date=str(r.day),
            revenue=_f(r.revenue),
            invoices_count=int(r.inv_count or 0),
            # profit = post-discount excl-GST revenue − cost
            profit=profit_by_day.get(str(r.day), 0.0),
        )
        for r in daily_rev_rows
    ]

    # ------------------------------------------------------------------
    # 4. Top 10 products by revenue
    #    All columns come from InvoiceItem so no duplication from the JOIN.
    # ------------------------------------------------------------------
    product_rows = (
        db.query(
            Product.name,
            func.sum(sold_qty_expr()).label("units_sold"),
            # Revenue = post-discount, excl-GST value of the line (see helper).
            func.sum(_net_revenue_expr()).label("revenue"),
            # Profit = that revenue − purchase cost (purchase_price is excl. GST)
            func.sum(_net_revenue_expr() - _cost_expr()).label("profit"),
        )
        .join(InvoiceItem, InvoiceItem.product_id == Product.id)
        .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
        .filter(
            func.date(Invoice.invoice_date) >= date_from,
            func.date(Invoice.invoice_date) <= date_to,
            Invoice.status != "RETURNED",
        )
        .group_by(Product.id, Product.name)
        .order_by(func.sum(_net_revenue_expr()).desc())
        .limit(10)
        .all()
    )

    top_products = [
        TopProductRow(
            product_name=r.name,
            units_sold=int(r.units_sold or 0),
            revenue=_f(r.revenue),
            profit=_f(r.profit),
        )
        for r in product_rows
    ]

    # ------------------------------------------------------------------
    # 5. Top 5 departments by revenue from their products' line totals
    # ------------------------------------------------------------------
    dept_rows = (
        db.query(
            Department.name,
            # Revenue = post-discount excl-GST value — same helper as above, so
            # the department table always reconciles with the product table.
            func.sum(_net_revenue_expr()).label("revenue"),
            func.count(distinct(Invoice.id)).label("invoices_count"),
        )
        .join(Product, Product.department_id == Department.id)
        .join(InvoiceItem, InvoiceItem.product_id == Product.id)
        .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
        .filter(
            func.date(Invoice.invoice_date) >= date_from,
            func.date(Invoice.invoice_date) <= date_to,
            Invoice.status != "RETURNED",
        )
        .group_by(Department.id, Department.name)
        .order_by(func.sum(_net_revenue_expr()).desc())
        .limit(5)
        .all()
    )

    top_departments = [
        TopDepartmentRow(
            department_name=r.name,
            revenue=_f(r.revenue),
            invoices_count=int(r.invoices_count or 0),
        )
        for r in dept_rows
    ]

    return SalesReport(
        period=Period(from_date=str(date_from), to_date=str(date_to)),
        summary=SalesSummary(
            total_revenue=total_revenue,
            total_cost=total_cost,
            gross_profit=gross_profit,
            profit_margin_pct=profit_margin_pct,
            total_invoices=total_invoices,
            total_items_sold=total_items_sold,
            cash_sales=cash_sales,
            upi_sales=upi_sales,
            credit_sales=credit_sales,
        ),
        daily_breakdown=daily_breakdown,
        top_products=top_products,
        top_departments=top_departments,
    )


# ===========================================================================
# INVENTORY REPORT
# ===========================================================================

class InventorySummary(BaseModel):
    total_products: int
    total_batches: int
    inventory_value: float
    retail_value: float
    potential_profit: float
    low_stock_count: int
    expiry_alerts_count: int


class LowStockProduct(BaseModel):
    product_name: str
    current_stock: int
    min_stock_level: int
    department: str


class ExpiryBucket(BaseModel):
    count: int
    estimated_loss: float


class ExpirySummary(BaseModel):
    expired: ExpiryBucket
    within_7: ExpiryBucket
    within_30: ExpiryBucket
    within_60: ExpiryBucket
    within_90: ExpiryBucket


class TopValueProduct(BaseModel):
    product_name: str
    qty: int
    purchase_price: float
    total_value: float


class InventoryReport(BaseModel):
    summary: InventorySummary
    low_stock_products: List[LowStockProduct]
    expiry_summary: ExpirySummary
    top_value_products: List[TopValueProduct]


def _expiry_bucket(db: Session, today: date, d_start: Optional[date], d_end: Optional[date]) -> ExpiryBucket:
    """
    Count batches and sum estimated loss for a given expiry date window.
    d_start=None means 'no lower bound' (for expired: expiry_date < today).
    d_end=None means 'no upper bound'.
    """
    q = db.query(
        func.count(Batch.id).label("cnt"),
        func.sum(Batch.quantity_available * costing.unit_cost_column()).label("loss"),
    ).filter(Batch.quantity_available > 0)

    if d_start is not None:
        q = q.filter(Batch.expiry_date >= d_start)
    if d_end is not None:
        q = q.filter(Batch.expiry_date <= d_end)

    row = q.one()
    return ExpiryBucket(count=int(row.cnt or 0), estimated_loss=_f(row.loss))


@router.get("/inventory", response_model=InventoryReport)
def get_inventory_report(
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    """
    Current inventory snapshot — no date filter.

    Returns stock values, low-stock products, expiry risk buckets,
    and the top 10 products by stock value.
    """
    today = date.today()
    d7 = today + timedelta(days=7)
    d30 = today + timedelta(days=30)
    d60 = today + timedelta(days=60)
    d90 = today + timedelta(days=90)

    # ------------------------------------------------------------------
    # Summary counts and values
    # ------------------------------------------------------------------
    total_products: int = db.query(func.count(Product.id)).filter(Product.is_active == True).scalar() or 0

    total_batches: int = (
        db.query(func.count(Batch.id))
        .filter(Batch.quantity_available > 0, Batch.expiry_date >= today)
        .scalar()
        or 0
    )

    value_row = (
        db.query(
            func.sum(Batch.quantity_available * costing.unit_cost_column()).label("inv_value"),
            func.sum(Batch.quantity_available * Batch.selling_price).label("ret_value"),
        )
        .filter(Batch.quantity_available > 0, Batch.expiry_date >= today)
        .one()
    )
    inventory_value = _f(value_row.inv_value)
    retail_value = _f(value_row.ret_value)
    potential_profit = retail_value - inventory_value

    expiry_alerts_count: int = (
        db.query(func.count(Batch.id))
        .filter(
            Batch.quantity_available > 0,
            Batch.expiry_date >= today,
            Batch.expiry_date <= d90,
        )
        .scalar()
        or 0
    )

    # ------------------------------------------------------------------
    # Low stock: products where total non-expired qty < min_stock_level
    # Uses a subquery so PostgreSQL does the filtering, not Python loops
    # ------------------------------------------------------------------
    stock_subq = (
        db.query(
            Batch.product_id,
            func.sum(Batch.quantity_available).label("total_qty"),
        )
        .filter(Batch.expiry_date >= today, Batch.quantity_available > 0)
        .group_by(Batch.product_id)
        .subquery()
    )

    low_rows = (
        db.query(
            Product.name,
            func.coalesce(stock_subq.c.total_qty, 0).label("current_stock"),
            Product.min_stock_level,
            Department.name.label("dept_name"),
        )
        .outerjoin(stock_subq, Product.id == stock_subq.c.product_id)
        .outerjoin(Department, Product.department_id == Department.id)
        .filter(
            Product.is_active == True,
            func.coalesce(stock_subq.c.total_qty, 0) < Product.min_stock_level,
        )
        .order_by(func.coalesce(stock_subq.c.total_qty, 0))
        .all()
    )

    low_stock_count = len(low_rows)
    low_stock_products = [
        LowStockProduct(
            product_name=r.name,
            current_stock=int(r.current_stock or 0),
            min_stock_level=r.min_stock_level,
            department=r.dept_name or "—",
        )
        for r in low_rows
    ]

    # ------------------------------------------------------------------
    # Expiry buckets — 5 separate range queries
    # ------------------------------------------------------------------
    expiry_summary = ExpirySummary(
        # Expired: expiry_date < today (regardless of quantity — already gone bad)
        expired=_expiry_bucket(db, today, None, today - timedelta(days=1)),
        # Within 7 days: today <= expiry_date <= today+7
        within_7=_expiry_bucket(db, today, today, d7),
        # Within 30: today+8 to today+30
        within_30=_expiry_bucket(db, today, d7 + timedelta(days=1), d30),
        # Within 60: today+31 to today+60
        within_60=_expiry_bucket(db, today, d30 + timedelta(days=1), d60),
        # Within 90: today+61 to today+90
        within_90=_expiry_bucket(db, today, d60 + timedelta(days=1), d90),
    )

    # ------------------------------------------------------------------
    # Top 10 products by inventory value
    # Group only by product — use weighted avg purchase_price across batches
    # so one row per product even when batches have different prices.
    # ------------------------------------------------------------------
    value_products = (
        db.query(
            Product.name,
            func.sum(Batch.quantity_available).label("qty"),
            func.sum(Batch.quantity_available * costing.unit_cost_column()).label("total_value"),
        )
        .join(Batch, Batch.product_id == Product.id)
        .filter(
            Batch.quantity_available > 0,
            Batch.expiry_date >= today,
            Product.is_active == True,
        )
        .group_by(Product.id, Product.name)
        .order_by(func.sum(Batch.quantity_available * costing.unit_cost_column()).desc())
        .limit(10)
        .all()
    )

    top_value_products = [
        TopValueProduct(
            product_name=r.name,
            qty=int(r.qty or 0),
            # Weighted average purchase price = total_value / qty
            purchase_price=round(_f(r.total_value) / int(r.qty) if r.qty else 0.0, 2),
            total_value=_f(r.total_value),
        )
        for r in value_products
    ]

    return InventoryReport(
        summary=InventorySummary(
            total_products=total_products,
            total_batches=total_batches,
            inventory_value=inventory_value,
            retail_value=retail_value,
            potential_profit=potential_profit,
            low_stock_count=low_stock_count,
            expiry_alerts_count=expiry_alerts_count,
        ),
        low_stock_products=low_stock_products,
        expiry_summary=expiry_summary,
        top_value_products=top_value_products,
    )


# ===========================================================================
# PROFIT REPORT
# ===========================================================================

class ProfitSummary(BaseModel):
    revenue: float
    cost: float
    gross_profit: float
    profit_margin_pct: float
    operating_expenses: float   # placeholder — always 0 until Phase 3 finance module
    net_profit: float           # same as gross_profit until operating_expenses are tracked
    # How many sold line-items had NO recorded purchase price (cost). These are
    # left out of the product profitability table so they don't show fake profit.
    excluded_items: int = 0


class MonthlyTrendRow(BaseModel):
    month: str
    revenue: float
    cost: float
    profit: float
    margin_pct: float


class ProductProfitRow(BaseModel):
    product_name: str
    units_sold: int
    revenue: float
    cost: float
    profit: float
    margin_pct: float


class ProfitReport(BaseModel):
    period: Period
    summary: ProfitSummary
    monthly_trend: List[MonthlyTrendRow]        # always last 6 months, ignores date filter
    product_profitability: List[ProductProfitRow]


@router.get("/profit", response_model=ProfitReport)
def get_profit_report(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    """
    Profit analysis for the given date range.

    The monthly trend section always shows the last 6 calendar months
    regardless of what date_from/date_to you pass.
    """
    date_from, date_to = _resolve_dates(date_from, date_to)

    # ------------------------------------------------------------------
    # Summary: same structure as sales report but profit-focused
    # ------------------------------------------------------------------
    # Revenue and cost are summed from the same item-level query so both sides
    # of the subtraction cover exactly the same set of lines.
    #
    # Revenue is NOT Invoice.subtotal: that is the PRE-discount figure, so a
    # bill given away at 100% off would still be counted as full revenue and
    # reported as profit.  _net_revenue_expr() takes each line's share of the
    # bill discount off first, then strips the GST.
    totals_row = (
        db.query(
            func.sum(_net_revenue_expr()).label("rev"),
            func.sum(_cost_expr()).label("cost"),
        )
        .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
        .filter(
            func.date(Invoice.invoice_date) >= date_from,
            func.date(Invoice.invoice_date) <= date_to,
            Invoice.status != "RETURNED",
        )
        .one()
    )
    revenue = _f(totals_row.rev)
    cost = _f(totals_row.cost)
    # If everything was discounted away, revenue is 0 and this correctly
    # becomes −cost: the stock left the shelf and no money came back.
    gross_profit = revenue - cost
    profit_margin_pct = _margin_pct(gross_profit, revenue, cost)

    # ------------------------------------------------------------------
    # Monthly trend — last 6 calendar months (fixed, not affected by filter)
    # ------------------------------------------------------------------
    today = date.today()
    current_year = today.year
    current_month = today.month

    # Build the list of (year, month) tuples for the last 6 months
    months: list[tuple[int, int]] = []
    for offset in range(5, -1, -1):   # 5 months ago → current month
        m = current_month - offset
        y = current_year
        while m <= 0:
            m += 12
            y -= 1
        months.append((y, m))

    trend_start = date(months[0][0], months[0][1], 1)

    # Revenue AND cost per (year, month) — one item-level query, so each
    # month's revenue is discount-adjusted exactly like the summary above.
    monthly_rows = (
        db.query(
            func.extract("year",  Invoice.invoice_date).label("yr"),
            func.extract("month", Invoice.invoice_date).label("mo"),
            func.sum(_net_revenue_expr()).label("revenue"),
            func.sum(_cost_expr()).label("cost"),
        )
        .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
        .filter(
            func.date(Invoice.invoice_date) >= trend_start,
            Invoice.status != "RETURNED",
        )
        .group_by(
            func.extract("year",  Invoice.invoice_date),
            func.extract("month", Invoice.invoice_date),
        )
        .all()
    )

    rev_by_month  = {(int(r.yr), int(r.mo)): _f(r.revenue) for r in monthly_rows}
    cost_by_month = {(int(r.yr), int(r.mo)): _f(r.cost)    for r in monthly_rows}

    monthly_trend = []
    for y, m in months:
        rev  = rev_by_month.get((y, m), 0.0)
        c    = cost_by_month.get((y, m), 0.0)
        prof = rev - c
        marg = _margin_pct(prof, rev, c)
        monthly_trend.append(MonthlyTrendRow(
            month=date(y, m, 1).strftime("%b %Y"),
            revenue=rev,
            cost=c,
            profit=prof,
            margin_pct=marg,
        ))

    # ------------------------------------------------------------------
    # Product profitability — top 15 by profit in the date range
    # ------------------------------------------------------------------
    # Revenue = post-discount value, excl. GST
    # Profit  = that revenue − purchase cost
    # Sorting by this expression means a product sold at a heavy discount now
    # sinks down the table (or off it) instead of being credited with a profit
    # it never earned.
    profit_expr = func.sum(_net_revenue_expr() - _cost_expr())

    # Items with no recorded purchase price (cost = 0) would otherwise show
    # their full selling price as "profit", which is misleading.  We exclude
    # them from the profitability table and count them so the UI can say how
    # many were left out.
    excluded_items: int = (
        db.query(func.count(InvoiceItem.id))
        .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
        .filter(
            func.date(Invoice.invoice_date) >= date_from,
            func.date(Invoice.invoice_date) <= date_to,
            Invoice.status != "RETURNED",
            InvoiceItem.purchase_price <= 0,
        )
        .scalar()
        or 0
    )

    prod_rows = (
        db.query(
            Product.name,
            func.sum(sold_qty_expr()).label("units_sold"),
            func.sum(_net_revenue_expr()).label("revenue"),
            func.sum(_cost_expr()).label("cost"),
        )
        .join(InvoiceItem, InvoiceItem.product_id == Product.id)
        .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
        .filter(
            func.date(Invoice.invoice_date) >= date_from,
            func.date(Invoice.invoice_date) <= date_to,
            Invoice.status != "RETURNED",
            # Only items whose cost we actually recorded — see excluded_items above.
            InvoiceItem.purchase_price > 0,
        )
        .group_by(Product.id, Product.name)
        .order_by(profit_expr.desc())
        .limit(15)
        .all()
    )

    product_profitability = []
    for r in prod_rows:
        rev  = _f(r.revenue)
        c    = _f(r.cost)
        # Fully discounted product: rev is 0, so this is −c, a real loss.
        prof = rev - c
        marg = _margin_pct(prof, rev, c)
        product_profitability.append(ProductProfitRow(
            product_name=r.name,
            units_sold=int(r.units_sold or 0),
            revenue=rev,
            cost=c,
            profit=prof,
            margin_pct=marg,
        ))

    return ProfitReport(
        period=Period(from_date=str(date_from), to_date=str(date_to)),
        summary=ProfitSummary(
            revenue=revenue,
            cost=cost,
            gross_profit=gross_profit,
            profit_margin_pct=profit_margin_pct,
            operating_expenses=0.0,
            net_profit=gross_profit,
            excluded_items=excluded_items,
        ),
        monthly_trend=monthly_trend,
        product_profitability=product_profitability,
    )


# ===========================================================================
# PATIENT REPORT
# ===========================================================================

class PatientSummary(BaseModel):
    total_patients: int
    new_patients: int
    prescription_patients: int
    self_medication_patients: int
    patients_with_purchases: int


class DeptBreakdownRow(BaseModel):
    department_name: str
    patient_count: int


class TopPatientRow(BaseModel):
    patient_name: str
    mobile: Optional[str]
    total_spent: float
    visit_count: int


class RegistrationTrendRow(BaseModel):
    date: str
    new_patients: int


class PatientReport(BaseModel):
    period: Period
    summary: PatientSummary
    department_breakdown: List[DeptBreakdownRow]
    top_patients: List[TopPatientRow]
    registration_trend: List[RegistrationTrendRow]


@router.get("/patients", response_model=PatientReport)
def get_patients_report(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    """
    Patient analytics for the given date range.

    total/prescription/self_medication counts are all-time totals.
    new_patients and patients_with_purchases are date-range filtered.
    """
    date_from, date_to = _resolve_dates(date_from, date_to)

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    total_patients: int = db.query(func.count(Patient.id)).scalar() or 0

    new_patients: int = (
        db.query(func.count(Patient.id))
        .filter(
            Patient.registration_date >= date_from,
            Patient.registration_date <= date_to,
        )
        .scalar()
        or 0
    )

    prescription_patients: int = (
        db.query(func.count(Patient.id))
        .filter(Patient.patient_type == "PRESCRIPTION")
        .scalar()
        or 0
    )

    self_medication_patients: int = (
        db.query(func.count(Patient.id))
        .filter(Patient.patient_type == "SELF_MEDICATION")
        .scalar()
        or 0
    )

    patients_with_purchases: int = (
        db.query(func.count(distinct(Invoice.patient_id)))
        .filter(
            Invoice.patient_id.isnot(None),
            func.date(Invoice.invoice_date) >= date_from,
            func.date(Invoice.invoice_date) <= date_to,
            Invoice.status != "RETURNED",
        )
        .scalar()
        or 0
    )

    # ------------------------------------------------------------------
    # Department breakdown — count patients per department (all-time)
    # ------------------------------------------------------------------
    dept_rows = (
        db.query(
            Department.name.label("dept_name"),
            func.count(patient_departments_table.c.patient_id).label("patient_count"),
        )
        .join(patient_departments_table, patient_departments_table.c.department_id == Department.id)
        .group_by(Department.id, Department.name)
        .order_by(func.count(patient_departments_table.c.patient_id).desc())
        .all()
    )

    department_breakdown = [
        DeptBreakdownRow(department_name=r.dept_name, patient_count=int(r.patient_count or 0))
        for r in dept_rows
    ]

    # ------------------------------------------------------------------
    # Top 10 patients by purchase value in date range
    # ------------------------------------------------------------------
    top_patient_rows = (
        db.query(
            Patient.name,
            Patient.mobile,
            # Net of refunds — a patient who brought half the bill back is not
            # the pharmacy's best customer for the full amount.
            func.sum(net_invoice_amount_expr()).label("total_spent"),
            func.count(Invoice.id).label("visit_count"),
        )
        .join(Invoice, Invoice.patient_id == Patient.id)
        .filter(
            func.date(Invoice.invoice_date) >= date_from,
            func.date(Invoice.invoice_date) <= date_to,
            Invoice.status != "RETURNED",
        )
        .group_by(Patient.id, Patient.name, Patient.mobile)
        .order_by(func.sum(net_invoice_amount_expr()).desc())
        .limit(10)
        .all()
    )

    top_patients = [
        TopPatientRow(
            patient_name=r.name,
            mobile=r.mobile,
            total_spent=_f(r.total_spent),
            visit_count=int(r.visit_count or 0),
        )
        for r in top_patient_rows
    ]

    # ------------------------------------------------------------------
    # New registrations per day in date range
    # ------------------------------------------------------------------
    reg_rows = (
        db.query(
            Patient.registration_date,
            func.count(Patient.id).label("new_patients"),
        )
        .filter(
            Patient.registration_date >= date_from,
            Patient.registration_date <= date_to,
        )
        .group_by(Patient.registration_date)
        .order_by(Patient.registration_date)
        .all()
    )

    registration_trend = [
        RegistrationTrendRow(date=str(r.registration_date), new_patients=int(r.new_patients or 0))
        for r in reg_rows
    ]

    return PatientReport(
        period=Period(from_date=str(date_from), to_date=str(date_to)),
        summary=PatientSummary(
            total_patients=total_patients,
            new_patients=new_patients,
            prescription_patients=prescription_patients,
            self_medication_patients=self_medication_patients,
            patients_with_purchases=patients_with_purchases,
        ),
        department_breakdown=department_breakdown,
        top_patients=top_patients,
        registration_trend=registration_trend,
    )
