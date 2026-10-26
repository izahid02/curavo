"""
WHAT ONE UNIT COST US.  One definition, used by every screen that shows a
margin, a profit or a stock valuation.

THE BUG THIS EXISTS TO PREVENT
------------------------------
The same delivery used to produce three different margins, because three
screens each picked a different cost field:

    DOLO 650, 10 strips at Rs.24.86 ex-GST, 5% trade discount, 5+1 scheme,
    strip MRP Rs.32.12 incl 5% GST (= Rs.30.59 ex-GST):

      Batch panel  18.7%  <- stock_purchases.cost_price,  Rs.24.86  (rate card)
      Reports      23.0%  <- batch.purchase_price,        Rs.23.62  (less discount)
      Add Stock    35.7%  <- the real figure,             Rs.19.68  (less discount,
                                                                     over 12 strips)

Only the last one is true.  The pharmacy paid Rs.236.16 and received 12 strips,
so a strip cost Rs.19.68 and a tablet Rs.1.3122.  The other two overstate the
cost, which UNDERSTATES profit -- the pharmacist is told they earn less than
they do, and prices a shelf accordingly.

THE ORDER, AND WHY
------------------
Most-adjusted first.  Each fallback is a step backwards in accuracy and exists
only for rows that predate the field above it:

  1. batch.effective_cost_per_unit  discount AND free goods  (Add Stock, Feature B)
  2. batch.purchase_price           discount only            (Add Stock, earlier)
  3. stock_purchases.cost_price     neither -- the rate card (older GRN flow)

A bonus unit is not free stock sitting alongside paid stock: it lowers what
every unit in the batch cost, because the money was paid for the lot.  That is
also why valuing stock at the rate card overstates inventory -- 180 units at
the undiscounted rate claims an asset the pharmacy never bought.

SQL CALLERS use the same order through coalesce(); see dashboard.py and
reports.py.  If you add a fourth source, change it in both places or the
screens drift apart again, which is exactly how this started.
"""
from decimal import Decimal
from typing import Optional


def unit_cost(batch, purchase=None) -> Optional[Decimal]:
    """
    What ONE INDIVIDUAL UNIT of this batch cost, ex-GST, after every discount
    and after spreading the free units across the lot.

    Returns None when nothing was ever recorded, so a screen can show "—"
    rather than a margin of 100% computed against a cost of zero.
    """
    if batch is not None:
        value = getattr(batch, "effective_cost_per_unit", None)
        if value:
            return Decimal(str(value))
        value = getattr(batch, "purchase_price", None)
        if value:
            return Decimal(str(value))
    if purchase is not None:
        value = getattr(purchase, "cost_price", None)
        if value:
            return Decimal(str(value))
    return None


def margin_percent(selling_price_ex_gst: Optional[Decimal],
                   cost: Optional[Decimal]) -> Optional[Decimal]:
    """
    Margin as a percentage of the EX-GST selling price.

    Both sides must be ex-GST or the figure is meaningless: GST is collected
    for the government, never earned, so counting it as revenue inflates every
    margin in the shop by the GST rate.
    """
    if not selling_price_ex_gst or selling_price_ex_gst <= 0 or cost is None:
        return None
    return ((selling_price_ex_gst - cost) / selling_price_ex_gst * 100)


def unit_cost_column():
    """
    The same priority as unit_cost(), as a SQL expression.

    Stock valuations and expiry-loss totals are summed in the database rather
    than row by row, so they cannot call the Python version.  They must still
    agree with it: a shelf valued one way on the dashboard and another in a
    report is the same bug this module was written to end.

    Only the first two sources exist here.  stock_purchases.cost_price would
    need a join, and it is the rate card anyway — the least accurate of the
    three, and absent on anything booked in through Add Stock.
    """
    from sqlalchemy import func

    from app.models.inventory import Batch

    return func.coalesce(Batch.effective_cost_per_unit, Batch.purchase_price)
