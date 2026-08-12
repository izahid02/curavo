"""
Business logic for returning expired stock to the supplier (Feature 2).

WHAT ACTUALLY HAPPENS COMMERCIALLY:
  The pharmacy sends expired (or soon-to-expire) medicine back to the supplier.
  The supplier does NOT refund cash — they send replacement medicines of
  equivalent value.  The GST originally paid on that stock cannot be reclaimed,
  so the pharmacy absorbs it as a loss.

  gross_value      = return_quantity x purchase_price
  gst_deduction    = gross_value x (gst_rate / 100)
  net_return_value = gross_value - gst_deduction

  net_return_value is then knocked off whatever we owe that supplier.  If we
  owe them nothing, it is held as an advance instead.

WHY GST IS SUBTRACTED, NOT EXTRACTED:
  Elsewhere in this app GST is INCLUSIVE (it is extracted out of the MRP —
  see CLAUDE.md).  Here it is different on purpose: purchase_price is the
  pre-tax cost we paid the supplier, and the GST on top of it is the part we
  cannot recover.  So we subtract gst_rate% OF the gross value, matching the
  worked example in the spec (₹1,400 gross, 12% → ₹168 deduction, ₹1,232 net).
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session

from app.models.inventory import Batch, Product, StockMovement, StockPurchase, Supplier
from app.models.supplier_credit import SupplierReturn
from app.services import supplier_credit_service as credit_svc

_CENTS = Decimal("0.01")


def _money(value) -> Decimal:
    """Coerce anything numeric to a 2-decimal Decimal."""
    if value is None:
        return Decimal("0.00")
    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    return value.quantize(_CENTS)


def split_scheme_units(
    return_quantity: int,
    bonus_quantity: int,
    total_quantity: int,
) -> tuple[int, int]:
    """
    Split a return quantity into PAID and BONUS units (Feature B).

    A batch bought on a scheme (e.g. "5+1") mixes paid and free units.  Only the
    paid units carry a return value — the free bonus units cost us nothing, so
    the supplier owes us nothing for them.  We return proportionally:

        bonus_ratio          = bonus_quantity / total_quantity
        bonus_being_returned = round(return_quantity x bonus_ratio)
        paid_being_returned  = return_quantity - bonus_being_returned

    Returns (paid_being_returned, bonus_being_returned).  With no scheme (bonus
    or total is zero), everything is treated as paid.
    """
    if not bonus_quantity or not total_quantity or bonus_quantity <= 0:
        return return_quantity, 0

    bonus_ratio          = Decimal(bonus_quantity) / Decimal(total_quantity)
    bonus_being_returned = int((Decimal(return_quantity) * bonus_ratio)
                               .to_integral_value(rounding="ROUND_HALF_UP"))
    # Never claim to return more bonus than we are returning in total.
    bonus_being_returned = min(bonus_being_returned, return_quantity)
    paid_being_returned  = return_quantity - bonus_being_returned
    return paid_being_returned, bonus_being_returned


def calculate_return_value(
    quantity: int,
    purchase_price: Decimal,
    gst_rate: Decimal,
) -> dict:
    """
    Pure arithmetic — no database access.

    Kept separate so the frontend preview endpoint, the write path, and the
    tests all agree on the numbers by construction rather than by luck.
    """
    gross         = _money(Decimal(str(quantity)) * _money(purchase_price))
    gst_deduction = _money(gross * _money(gst_rate) / Decimal("100"))
    net           = _money(gross - gst_deduction)
    return {
        "gross_value":      gross,
        "gst_deduction":    gst_deduction,
        "net_return_value": net,
    }


def resolve_return_context(db: Session, batch_id: int) -> Optional[dict]:
    """
    Gather everything the return modal needs for one batch.

    Resolves the supplier through the batch first, falling back to the
    StockPurchase record — older batches created via the PO/GRN flow may not
    have a stock purchase row, and batches created before suppliers were
    mandatory may not have supplier_id set.  Returning None means we could not
    establish who to send the stock back to.
    """
    batch = db.get(Batch, batch_id)
    if batch is None:
        return None

    product = db.get(Product, batch.product_id)
    if product is None:
        return None

    # The purchase record carries the authoritative cost price the pharmacist
    # actually typed; batch.purchase_price is the same value but defaults to 0
    # when the cost was never recorded.
    purchase = (
        db.query(StockPurchase)
        .filter(StockPurchase.batch_id == batch.id)
        .order_by(StockPurchase.id.desc())
        .first()
    )

    supplier_id = batch.supplier_id or (purchase.supplier_id if purchase else None)
    if supplier_id is None:
        return None

    supplier = db.get(Supplier, supplier_id)

    # What one unit really cost us, in preference order:
    #   1. effective_cost — the rate AFTER any supplier discount.  A "5% trade
    #      discount" means we paid ₹57, not ₹60, so the supplier owes us the
    #      ₹57 and the GST lost is 12% of ₹57.  Valuing the return at the
    #      rate card would claim back money we never handed over.
    #   2. cost_price    — the rate card; correct for a purchase with no discount
    #      and for every row recorded before discounts existed.
    #   3. batch.purchase_price — last resort for stock that came in through the
    #      older GRN flow with no stock_purchase row at all.
    purchase_price = None
    if purchase is not None and purchase.effective_cost is not None:
        purchase_price = _money(purchase.effective_cost)
    if (purchase_price is None or purchase_price <= 0) and purchase is not None \
            and purchase.cost_price is not None:
        purchase_price = _money(purchase.cost_price)
    if purchase_price is None or purchase_price <= 0:
        purchase_price = _money(batch.purchase_price)

    account = credit_svc.get_or_create_account(db, supplier_id)

    return {
        "batch":            batch,
        "product":          product,
        "supplier":         supplier,
        "supplier_id":      supplier_id,
        "purchase_price":   purchase_price,
        "gst_rate":         _money(product.gst_rate),
        "outstanding":      _money(account.outstanding),
        "quantity_available": batch.quantity_available,
        # Scheme snapshot for the return modal (Feature B).
        "scheme_label":     batch.scheme_label,
        "bonus_quantity":   batch.bonus_quantity or 0,
        "total_received":   batch.quantity_received,
    }


def process_return(
    db: Session,
    *,
    batch_id: int,
    return_quantity: int,
    supplier_id: Optional[int],
    return_type: str,
    replacement_notes: Optional[str] = None,
    notes: Optional[str] = None,
    created_by: Optional[int] = None,
) -> dict:
    """
    Send expired stock back to the supplier and settle its value.

    Everything below happens in ONE transaction (the caller commits):
      1. Work out the return value (gross, GST loss, net).
      2. Write a SupplierReturn record — the permanent evidence.
      3. Reduce batch.quantity_available.
      4. Write a StockMovement(type="RETURN") with a NEGATIVE quantity, so the
         audit trail matches the "never mutate stock silently" rule.
      5. Apply the net value to the supplier's credit (or hold as advance).

    Raises ValueError with a readable message on any validation failure; the
    router turns those into 400s.
    """
    context = resolve_return_context(db, batch_id)
    if context is None:
        raise ValueError(
            "Cannot process return: batch not found, or no supplier is linked "
            "to this batch."
        )

    batch   = context["batch"]
    product = context["product"]

    # The caller may pass supplier_id explicitly; it must agree with the batch.
    resolved_supplier_id = context["supplier_id"]
    if supplier_id is not None and supplier_id != resolved_supplier_id:
        raise ValueError(
            "Supplier does not match the supplier this batch was purchased from."
        )

    # --- Validate the quantity ---------------------------------------------
    if return_quantity <= 0:
        raise ValueError("Return quantity must be greater than zero.")
    if return_quantity > batch.quantity_available:
        raise ValueError(
            f"Cannot return {return_quantity} units — only "
            f"{batch.quantity_available} available in this batch."
        )

    purchase_price = context["purchase_price"]
    gst_rate       = context["gst_rate"]

    if purchase_price <= 0:
        raise ValueError(
            "This batch has no recorded purchase price, so its return value "
            "cannot be calculated. Edit the batch cost price first."
        )

    # --- Scheme split (Feature B) ------------------------------------------
    # Only the PAID units carry value — bonus units were free.  For a plain
    # (non-scheme) batch this returns (return_quantity, 0), so the maths below
    # is identical to before.
    paid_being_returned, bonus_being_returned = split_scheme_units(
        return_quantity,
        context["bonus_quantity"],
        context["total_received"],
    )

    # --- Step 1: the money (paid units only) -------------------------------
    values = calculate_return_value(paid_being_returned, purchase_price, gst_rate)

    # --- Step 2: the return record -----------------------------------------
    supplier_return = SupplierReturn(
        supplier_id=resolved_supplier_id,
        batch_id=batch.id,
        product_id=product.id,
        return_quantity=return_quantity,
        purchase_price=purchase_price,
        gst_rate=gst_rate,
        gross_value=values["gross_value"],
        gst_deduction=values["gst_deduction"],
        net_return_value=values["net_return_value"],
        return_type=return_type,
        replacement_notes=replacement_notes,
        scheme_label=context["scheme_label"],
        bonus_returned=bonus_being_returned,
        paid_returned=paid_being_returned,
        # PENDING means the replacement has not been agreed yet, so the return
        # is not finished from the pharmacy's point of view.
        status="PENDING_REPLACEMENT" if return_type == "PENDING" else "COMPLETED",
        return_date=date.today(),
        notes=notes,
        created_by=created_by,
        created_at=datetime.utcnow(),
    )
    db.add(supplier_return)
    db.flush()   # assigns supplier_return.id

    # --- Step 3: reduce the physical stock ---------------------------------
    batch.quantity_available = batch.quantity_available - return_quantity

    # --- Step 4: the audit trail -------------------------------------------
    # Negative quantity = stock leaving the building, matching the convention
    # used by SALE rows elsewhere in this codebase.
    db.add(StockMovement(
        batch_id=batch.id,
        movement_type="RETURN",
        quantity=-return_quantity,
        reference=f"SUPPLIER-RETURN-{supplier_return.id}",
        user_id=created_by,
    ))

    # --- Step 5: settle the value against supplier credit ------------------
    credit_result = credit_svc.apply_return_value(
        db,
        supplier_id=resolved_supplier_id,
        net_value=values["net_return_value"],
        notes=(
            f"Return of {return_quantity} x {product.name} "
            f"(batch {batch.batch_number or batch.id})"
        ),
        created_by=created_by,
    )

    supplier_return.credit_adjusted = credit_result["credit_adjusted"]
    supplier_return.credit_tx_id    = credit_result["credit_tx_id"]

    # --- Build the response -------------------------------------------------
    if credit_result["credit_adjusted"]:
        message = (
            f"Return processed. Supplier credit reduced by "
            f"Rs.{credit_result['applied']}."
        )
        if credit_result["advance_created"] > 0:
            message += (
                f" Rs.{credit_result['advance_created']} held as advance."
            )
    else:
        message = (
            f"Return processed. No outstanding credit — "
            f"Rs.{values['net_return_value']} held as advance with supplier."
        )

    return {
        "return_id":                 supplier_return.id,
        "gross_value":               values["gross_value"],
        "gst_deduction":             values["gst_deduction"],
        "net_return_value":          values["net_return_value"],
        "credit_adjusted":           credit_result["credit_adjusted"],
        "supplier_outstanding_after": credit_result["outstanding"],
        "advance_balance_after":     credit_result["advance_balance"],
        "batch_quantity_after":      batch.quantity_available,
        "message":                   message,
        # Scheme split (Feature B) — echoed so the modal can confirm it.
        "scheme_label":              context["scheme_label"],
        "bonus_returned":            bonus_being_returned,
        "paid_returned":             paid_being_returned,
    }


def list_returns(
    db: Session,
    *,
    limit: int = 100,
    offset: int = 0,
    supplier_id: Optional[int] = None,
) -> dict:
    """
    Paginated list of every supplier return, newest first, with the product and
    supplier names resolved for display.
    """
    query = db.query(SupplierReturn)
    if supplier_id is not None:
        query = query.filter(SupplierReturn.supplier_id == supplier_id)

    total = query.count()
    rows  = (
        query.order_by(SupplierReturn.created_at.desc(), SupplierReturn.id.desc())
        .limit(limit)
        .offset(offset)
        .all()
    )

    items = []
    for r in rows:
        product  = db.get(Product, r.product_id)
        supplier = db.get(Supplier, r.supplier_id)
        batch    = db.get(Batch, r.batch_id)
        items.append({
            "id":                r.id,
            "supplier_id":       r.supplier_id,
            "supplier_name":     supplier.name if supplier else "Unknown supplier",
            "product_id":        r.product_id,
            "product_name":      product.name if product else "Unknown product",
            "batch_id":          r.batch_id,
            "batch_number":      batch.batch_number if batch else None,
            "return_quantity":   r.return_quantity,
            "purchase_price":    _money(r.purchase_price),
            "gst_rate":          _money(r.gst_rate),
            "gross_value":       _money(r.gross_value),
            "gst_deduction":     _money(r.gst_deduction),
            "net_return_value":  _money(r.net_return_value),
            "return_type":       r.return_type,
            "replacement_notes": r.replacement_notes,
            "credit_adjusted":   bool(r.credit_adjusted),
            "status":            r.status,
            "return_date":       r.return_date,
            "notes":             r.notes,
            "created_at":        r.created_at,
            "scheme_label":      r.scheme_label,
            "bonus_returned":    r.bonus_returned or 0,
            "paid_returned":     r.paid_returned,
        })

    return {"items": items, "total": total, "limit": limit, "offset": offset}
