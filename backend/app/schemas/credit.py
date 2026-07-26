"""
Pydantic schemas for the Credit Management module.

All money fields use Decimal (never float) for exact arithmetic.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Incoming request schemas
# ---------------------------------------------------------------------------

class CreditTransactionCreate(BaseModel):
    """Create a new CREDIT entry when a patient buys on credit."""
    patient_id: int
    invoice_id: Optional[int] = None
    amount:     Decimal = Field(..., gt=0, description="Amount given on credit")
    due_date:   date
    notes:      Optional[str] = None


class PaymentCreate(BaseModel):
    """Record a payment received from a credit patient."""
    patient_id:    int
    amount:        Decimal = Field(..., gt=0, description="Amount received")
    notes:         Optional[str] = None
    credit_tx_id:  Optional[int] = None   # if paying a specific transaction
    # How the money arrived.  Defaults to CASH so older clients that do not
    # send the field keep working exactly as before.
    payment_mode:  str = Field(default="CASH", pattern="^(CASH|UPI)$")


class DueDateUpdate(BaseModel):
    """Update the due date on a PENDING/PARTIAL credit transaction."""
    due_date: date


# ---------------------------------------------------------------------------
# Outgoing response schemas
# ---------------------------------------------------------------------------

class CreditTransactionOut(BaseModel):
    id:          int
    patient_id:  int
    invoice_id:  Optional[int]
    type:        str
    amount:      Decimal
    due_date:    Optional[date]
    paid_amount: Decimal
    balance:     Decimal
    status:      str
    # True once this transaction has ever gone past its due date. Unlike
    # status, it is never cleared — a CLEARED row can still be was_overdue.
    # Optional because a row written outside the ORM could leave it NULL, and
    # a hard bool would make the whole endpoint 500 on that one row.
    was_overdue: Optional[bool] = False
    payment_mode: Optional[str] = None
    notes:       Optional[str]
    created_at:  datetime

    model_config = {"from_attributes": True}


class CreditAccountOut(BaseModel):
    id:            int
    patient_id:    int
    total_credit:  Decimal
    total_paid:    Decimal
    outstanding:   Decimal
    last_activity: Optional[datetime]
    created_at:    datetime

    model_config = {"from_attributes": True}


class PatientCreditSummary(BaseModel):
    """
    Full credit view for one patient — their account + recent transactions.

    The four flag fields exist so a caller (the billing screen) can decide
    which warning banners to show from ONE request, instead of fetching the
    account and then scanning the transaction list itself.
    """
    account:      CreditAccountOut
    transactions: list[CreditTransactionOut]
    # True when the patient has at least one transaction sitting in OVERDUE
    is_defaulter:        bool = False
    # True when outstanding > 0 (overdue or not) — drives the amber banner
    has_outstanding:     bool = False
    outstanding_amount:  Decimal = Decimal("0")
    # Due date of the OLDEST overdue transaction, or None if nothing is overdue
    oldest_overdue_date: Optional[date] = None


class CreditPatientRow(BaseModel):
    """One row in the credit dashboard list — minimal patient info + balance."""
    patient_id:      int
    name:            str
    phone:           Optional[str]
    outstanding:     Decimal
    oldest_due_date: Optional[date]
    is_overdue:      bool
    last_activity:   Optional[datetime]
    status:          str    # worst status across open transactions


class AllCreditSummary(BaseModel):
    """Aggregate stats shown in summary cards at the top of the Credit page."""
    total_outstanding:          Decimal
    total_patients_with_credit: int
    overdue_count:              int
    overdue_amount:             Decimal
    patients:                   list[CreditPatientRow]


# ---------------------------------------------------------------------------
# Credit History tab
# ---------------------------------------------------------------------------

class CreditHistoryRow(BaseModel):
    """
    One line in the Credit History tab — a single CREDIT or PAYMENT event,
    already joined to the patient name and invoice number so the frontend
    does not have to make follow-up requests per row.
    """
    id:             int
    created_at:     datetime
    patient_id:     int
    patient_name:   str
    type:           str              # 'CREDIT' or 'PAYMENT'
    amount:         Decimal
    payment_mode:   Optional[str]    # only set on PAYMENT rows
    invoice_number: Optional[str]
    notes:          Optional[str]
    # Account outstanding AFTER this transaction was applied, replayed from
    # the running balance (see get_credit_history for how this is computed).
    balance_after:  Decimal


class CreditHistoryPage(BaseModel):
    """A page of credit history plus the total row count for pagination."""
    total: int
    items: list[CreditHistoryRow]


# ---------------------------------------------------------------------------
# Defaulters tab
# ---------------------------------------------------------------------------

class DefaulterRow(BaseModel):
    """
    A patient who has EVER had a credit transaction go past its due date —
    including one they have since paid off.

    risk_level is computed on the backend so the Credit page and any future
    report agree on the same thresholds.
    """
    patient_id:          int
    name:                str
    phone:               Optional[str]
    outstanding:         Decimal
    # LIFETIME count of transactions that ever went late (was_overdue=True),
    # not the number that are late right now.
    times_overdue:       int
    # Oldest transaction late RIGHT NOW — None once everything late is paid
    oldest_overdue_date: Optional[date]
    days_overdue:        int             # 0 when nothing is currently late
    last_payment_date:   Optional[datetime]
    risk_level:          str             # 'HIGH' / 'MEDIUM' / 'LOW'
    # False = was late in the past but owes nothing late today
    currently_overdue:   bool = False
