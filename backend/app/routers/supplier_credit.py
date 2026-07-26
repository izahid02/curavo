"""
Supplier Credit API endpoints — money the pharmacy OWES its suppliers.

All routes are prefixed /api/supplier-credit and require a valid JWT login.
Business logic lives in app/services/supplier_credit_service.py.

Endpoints:
  GET  /summary               — totals + upcoming/overdue lists (summary cards)
  GET  /suppliers             — one row per supplier with credit (main table)
  GET  /supplier/{id}         — full ledger for one supplier (history panel)
  POST /payment               — record a payment to a supplier (FIFO applied)
  GET  /due-soon              — next 7 days + overdue (dashboard widget)

Note the deliberate naming split from /api/credit, which is the PATIENT side.
Same shape, opposite direction of money.
"""
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.inventory import Supplier
from app.models.user import User
from app.schemas.supplier_credit import (
    DueSoonResponse,
    SupplierCreditRow,
    SupplierCreditSummary,
    SupplierLedgerOut,
    SupplierPaymentRequest,
    SupplierPaymentResponse,
)
from app.services.auth_service import get_current_user
from app.services import supplier_credit_service as svc

router = APIRouter(prefix="/supplier-credit", tags=["Supplier Credit"])


@router.get("/summary", response_model=SupplierCreditSummary)
def credit_summary(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    Headline numbers for the Credit Management tab: what we owe in total, how
    much of it is late, how much advance we are holding, plus the due lists.
    """
    return SupplierCreditSummary(**svc.get_summary(db))


@router.get("/suppliers", response_model=list[SupplierCreditRow])
def suppliers_with_credit(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    Every supplier that currently has outstanding credit or an advance balance,
    most urgent first.  Suppliers we are square with are omitted entirely.
    """
    return [SupplierCreditRow(**row) for row in svc.get_supplier_rows(db)]


@router.get("/supplier/{supplier_id}", response_model=SupplierLedgerOut)
def supplier_ledger(
    supplier_id: int,
    db:          Session = Depends(get_db),
    _:           User    = Depends(get_current_user),
):
    """Full chronological credit history for one supplier (newest first)."""
    ledger = svc.get_supplier_ledger(db, supplier_id)
    if ledger is None:
        raise HTTPException(status_code=404, detail="Supplier not found")
    db.commit()   # persist any OVERDUE status refresh done during the read
    return SupplierLedgerOut(**ledger)


@router.post("/payment", response_model=SupplierPaymentResponse,
             status_code=status.HTTP_201_CREATED)
def pay_supplier(
    body:         SupplierPaymentRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Record money paid to a supplier.

    The payment is applied to the OLDEST open credit first (FIFO).  Paying more
    than is owed is allowed — the excess is stored as an advance and will be
    consumed automatically by the supplier's next credit purchase.
    """
    supplier = db.get(Supplier, body.supplier_id)
    if supplier is None:
        raise HTTPException(status_code=404, detail="Supplier not found")

    result = svc.record_payment(
        db,
        supplier_id=body.supplier_id,
        amount=body.amount,
        payment_mode=body.payment_mode,
        notes=body.notes,
        credit_tx_id=body.credit_tx_id,
        created_by=current_user.id,
    )
    db.commit()

    # Build a sentence the pharmacist can read at a glance.
    if result["advance_created"] > 0:
        message = (
            f"Paid Rs.{result['amount']} to {supplier.name}. "
            f"All dues cleared; Rs.{result['advance_created']} held as advance."
        )
    else:
        message = (
            f"Paid Rs.{result['amount']} to {supplier.name}. "
            f"Outstanding now Rs.{result['outstanding']}."
        )

    return SupplierPaymentResponse(**result, message=message)


@router.get("/due-soon", response_model=DueSoonResponse)
def due_soon(
    days: int     = Query(7, ge=1, le=90, description="Look-ahead window in days"),
    db:   Session = Depends(get_db),
    _:    User    = Depends(get_current_user),
):
    """
    Supplier payments falling due in the next `days` days, plus everything
    already overdue.  This is what the Dashboard credit widget reads.
    """
    due     = svc.get_due_rows(db, within_days=days)
    summary = svc.get_summary(db)
    db.commit()   # persist OVERDUE refresh
    return DueSoonResponse(
        total_outstanding=summary["total_outstanding"],
        upcoming=due["upcoming"],
        overdue=due["overdue"],
    )
