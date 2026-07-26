"""
Credit Management API endpoints.

All routes are prefixed /api/credit and require a valid JWT login.
Business logic lives in app/services/credit_service.py.

Endpoints:
  POST /transactions          — create a CREDIT transaction (money owed)
  POST /payment               — record a repayment
  GET  /patient/{patient_id}  — patient's account + last 20 transactions
  GET  /summary               — all patients with outstanding balance + totals
  GET  /overdue               — only overdue patients, sorted by oldest due date
  PUT  /transactions/{tx_id}/due-date — update due date + reschedule reminders
"""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.credit import CreditTransaction
from app.models.user import User
from app.schemas.credit import (
    AllCreditSummary,
    CreditHistoryPage,
    CreditPatientRow,
    CreditTransactionCreate,
    CreditTransactionOut,
    DefaulterRow,
    DueDateUpdate,
    PatientCreditSummary,
    PaymentCreate,
    CreditAccountOut,
)
from app.services.auth_service import get_current_user
from app.services.credit_service import (
    create_credit_transaction,
    get_all_credit_summary,
    get_credit_history,
    get_defaulters,
    get_patient_credit_summary,
    record_payment,
    reschedule_reminders,
)

router = APIRouter(prefix="/credit", tags=["Credit"])


# ---------------------------------------------------------------------------
# Create a credit transaction (patient owes money)
# ---------------------------------------------------------------------------

@router.post("/transactions", response_model=CreditTransactionOut, status_code=status.HTTP_201_CREATED)
def create_credit(
    body:         CreditTransactionCreate,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Record that a patient is buying on credit.
    Called automatically by the billing endpoint when payment_mode='CREDIT',
    but can also be called manually to add a credit entry.
    """
    tx = create_credit_transaction(
        db,
        patient_id=body.patient_id,
        invoice_id=body.invoice_id,
        credit_amount=body.amount,
        due_date=body.due_date,
        created_by=current_user.id,
        notes=body.notes,
    )
    db.commit()
    db.refresh(tx)
    return CreditTransactionOut.model_validate(tx)


# ---------------------------------------------------------------------------
# Record a repayment
# ---------------------------------------------------------------------------

@router.post("/payment", response_model=CreditAccountOut)
def receive_payment(
    body:         PaymentCreate,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Record a payment from the patient (cash at the counter or UPI).
    Applies FIFO to oldest unpaid credit transactions.
    """
    account = record_payment(
        db,
        patient_id=body.patient_id,
        amount=body.amount,
        notes=body.notes,
        created_by=current_user.id,
        credit_tx_id=body.credit_tx_id,
        payment_mode=body.payment_mode,
    )
    db.commit()
    db.refresh(account)
    return CreditAccountOut.model_validate(account)


# ---------------------------------------------------------------------------
# Patient credit detail
# ---------------------------------------------------------------------------

@router.get("/patient/{patient_id}", response_model=PatientCreditSummary)
def patient_credit(
    patient_id: int,
    db:         Session = Depends(get_db),
    _:          User    = Depends(get_current_user),
):
    """
    Return the credit account + last 20 transactions for one patient, plus the
    defaulter / outstanding flags the billing screen needs.

    The billing screen calls this ONE endpoint when a patient is selected and
    decides from the flags whether to show the red defaulter banner, the amber
    outstanding-credit banner, both, or neither.

    Overdue statuses are updated lazily here.
    """
    summary = get_patient_credit_summary(db, patient_id)
    db.commit()  # persist any overdue status updates

    # Convert ORM objects to Pydantic for the response
    account = summary["account"]
    txs     = summary["transactions"]

    # The flag fields are the same either way — only the account/transactions
    # shape differs between "has an account" and "no account yet".
    flags = {
        "is_defaulter":        summary["is_defaulter"],
        "has_outstanding":     summary["has_outstanding"],
        "outstanding_amount":  summary["outstanding_amount"],
        "oldest_overdue_date": summary["oldest_overdue_date"],
    }

    # If account is a plain dict (empty account), return it directly
    if isinstance(account, dict):
        return {"account": account, "transactions": [], **flags}

    return {
        "account":      CreditAccountOut.model_validate(account),
        "transactions": [CreditTransactionOut.model_validate(t) for t in txs],
        **flags,
    }


# ---------------------------------------------------------------------------
# Credit summary (all patients)
# ---------------------------------------------------------------------------

@router.get("/summary", response_model=AllCreditSummary)
def credit_summary(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    Aggregate totals + per-patient list for the Credit dashboard page.
    Updates overdue statuses across all patients as a side effect.
    """
    data = get_all_credit_summary(db)
    db.commit()  # persist overdue status updates
    return data


# ---------------------------------------------------------------------------
# Overdue-only list
# ---------------------------------------------------------------------------

@router.get("/overdue", response_model=list[CreditPatientRow])
def overdue_patients(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    Return only patients with at least one overdue credit transaction,
    ordered by oldest_due_date ascending (most overdue first).
    """
    data = get_all_credit_summary(db)
    db.commit()
    overdue = [p for p in data["patients"] if p["is_overdue"]]
    overdue.sort(key=lambda p: p["oldest_due_date"] or date.max)
    return overdue


# ---------------------------------------------------------------------------
# Credit history — every CREDIT and PAYMENT event, newest first
# ---------------------------------------------------------------------------

@router.get("/history", response_model=CreditHistoryPage)
def credit_history(
    limit:      int           = Query(50, ge=1, le=200),
    offset:     int           = Query(0, ge=0),
    patient_id: Optional[int] = None,
    type:       Optional[str] = Query(None, pattern="^(CREDIT|PAYMENT)$"),
    date_from:  Optional[date] = None,
    date_to:    Optional[date] = None,
    db:         Session       = Depends(get_db),
    _:          User          = Depends(get_current_user),
):
    """
    Paginated ledger of all credit activity across all patients.

    Every filter is optional — with no filters you get the 50 most recent
    transactions.  `type` narrows to only money given (CREDIT) or only money
    received (PAYMENT).
    """
    return get_credit_history(
        db,
        limit=limit,
        offset=offset,
        patient_id=patient_id,
        tx_type=type,
        date_from=date_from,
        date_to=date_to,
    )


# ---------------------------------------------------------------------------
# Defaulters — patients with unpaid transactions past their due date
# ---------------------------------------------------------------------------

@router.get("/defaulters", response_model=list[DefaulterRow])
def defaulters(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """
    Patients who currently have at least one overdue credit transaction,
    sorted worst-risk first.  Risk thresholds live in credit_service.
    """
    rows = get_defaulters(db)
    db.commit()  # persist any overdue status updates made while scanning
    return rows


# ---------------------------------------------------------------------------
# Update due date on a transaction
# ---------------------------------------------------------------------------

@router.put("/transactions/{tx_id}/due-date", response_model=CreditTransactionOut)
def update_due_date(
    tx_id:        int,
    body:         DueDateUpdate,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Update the due date on a PENDING or PARTIAL transaction and reschedule
    the three reminder rows.  Requires Owner or Admin role.
    """
    # Check role (Owner = role_id 1 by convention, or role name check)
    if current_user.role and current_user.role.name not in ("Owner", "Admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Owner or Admin can change due dates",
        )

    tx = db.get(CreditTransaction, tx_id)
    if tx is None:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if tx.status not in ("PENDING", "PARTIAL", "OVERDUE"):
        raise HTTPException(
            status_code=400,
            detail="Can only update due date on PENDING, PARTIAL, or OVERDUE transactions",
        )
    if body.due_date < date.today():
        raise HTTPException(status_code=400, detail="New due date must be today or in the future")

    tx.due_date = body.due_date
    # Reset OVERDUE → PENDING now that date is extended
    if tx.status == "OVERDUE":
        tx.status = "PARTIAL" if tx.paid_amount > 0 else "PENDING"

    reschedule_reminders(db, tx)
    db.commit()
    db.refresh(tx)
    return CreditTransactionOut.model_validate(tx)
