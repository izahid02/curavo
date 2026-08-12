"""
The ONE definition of "how much did we actually sell".

WHY THIS MODULE EXISTS
Partial returns (invoice status 'PARTIAL_RETURN') broke an assumption that was
baked into every revenue query in the app: that an invoice is either entirely a
sale or entirely not.  Every report filtered `Invoice.status != "RETURNED"`,
which quietly ADMITS a partially-returned invoice — and then counts it at its
ORIGINAL, full value.  Nothing was being wrongly excluded; things were being
wrongly counted whole.

Concretely: a ₹1,000 bill where the customer brings back ₹400 of medicine
reported ₹1,000 of revenue, the full cost of goods that are back on the shelf,
and the full unit count in "top products".  The stock was restored, so the same
tablets were then also sitting in inventory value — counted twice.

There are exactly TWO shapes of revenue query in this codebase, and each needs
its own correction:

  1. HEADER-LEVEL — sums Invoice.total_amount (dashboards, cash splits, spend
     per patient).  Corrected with net_invoice_amount_expr(), which subtracts
     the denormalised invoices.refunded_amount.

  2. ITEM-LEVEL — sums over invoice_items (profit, cost of goods, units sold,
     top products/departments).  Corrected with sold_qty_expr() and
     retained_line_total_expr(), which net off invoice_items.returned_qty.

Both are SQL expressions, not Python — they are meant to be dropped straight
into a query so the database does the arithmetic:

    db.query(func.sum(net_invoice_amount_expr())).filter(...)

⚠ KEEP THE `Invoice.status != "RETURNED"` FILTER ALONGSIDE THESE.  A fully
returned invoice nets to zero through these expressions anyway, but the filter
also keeps it out of COUNT(*) — an invoice that was entirely handed back is not
a sale that happened, and counting it would drag the average bill value down.
"""
from sqlalchemy import case, func

from app.models.billing import Invoice, InvoiceItem


# ---------------------------------------------------------------------------
# Header-level: what the customer is left having paid
# ---------------------------------------------------------------------------

def net_invoice_amount_expr():
    """
    SQL expression: an invoice's total AFTER any refunds against it.

        total_amount − refunded_amount

    refunded_amount is a denormalised running total, written by
    billing_service.process_return using the same _refund_for() maths the
    return modal previews.  It is kept on the invoice rather than derived on
    the fly because deriving it needs the per-line discount share — a
    correlated subquery in every dashboard card, to answer a question the
    return already knew the answer to.

    Old invoices predate the column and hold NULL, which coalesce reads as
    "nothing was ever refunded" — exactly right for a sale that was never
    returned.
    """
    return Invoice.total_amount - func.coalesce(Invoice.refunded_amount, 0)


# ---------------------------------------------------------------------------
# Item-level: what stayed sold on each line
# ---------------------------------------------------------------------------

def sold_qty_expr():
    """
    SQL expression: units of this line that the customer actually KEPT.

        quantity − returned_qty

    Use this anywhere the old code said `InvoiceItem.quantity`.  Returned units
    went back onto the shelf, so counting them as sold both overstates the sale
    and double-counts the stock (it is simultaneously in inventory value).
    """
    return InvoiceItem.quantity - func.coalesce(InvoiceItem.returned_qty, 0)


def retained_line_total_expr():
    """
    SQL expression: the GST-inclusive, pre-discount value of the units KEPT.

    Written as a CASE rather than the obvious `line_total × kept / quantity` on
    purpose.  The overwhelmingly common row has returned_qty = 0, and this way
    that row yields the STORED line_total byte for byte — no float division, no
    chance of a stray paisa appearing in a report that used to reconcile.  Only
    a genuinely returned line takes the arithmetic branch, where the money is
    rebuilt from the snapshotted unit_price:

        unit_price × (quantity − returned_qty)

    which is the same basis line_total was created from in create_invoice
    (line_total = unit_price × quantity), so the two agree.
    """
    returned = func.coalesce(InvoiceItem.returned_qty, 0)
    return case(
        (returned == 0, InvoiceItem.line_total),
        else_=InvoiceItem.unit_price * (InvoiceItem.quantity - returned),
    )
