"""
Pydantic schemas for the Expenditure & Payroll module.

These define the exact shape of data going IN (request bodies) and OUT
(responses).  As per CLAUDE.md we never return raw SQLAlchemy objects — the
router always converts to one of these first.

Money fields use Decimal so no float rounding creeps in.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import List, Optional

from pydantic import BaseModel


# ═══════════════════════════════════════════════════════════════════════════
#  EMPLOYEES
# ═══════════════════════════════════════════════════════════════════════════

class EmployeeCreate(BaseModel):
    """Fields accepted when adding a new employee."""
    name: str
    role: str
    phone: Optional[str] = None
    basic_salary: Decimal
    hra: Decimal = Decimal("0")
    travel_allowance: Decimal = Decimal("0")
    other_allowance: Decimal = Decimal("0")
    joining_date: Optional[date] = None


class EmployeeUpdate(BaseModel):
    """All fields optional — only send what changed."""
    name: Optional[str] = None
    role: Optional[str] = None
    phone: Optional[str] = None
    basic_salary: Optional[Decimal] = None
    hra: Optional[Decimal] = None
    travel_allowance: Optional[Decimal] = None
    other_allowance: Optional[Decimal] = None
    joining_date: Optional[date] = None
    is_active: Optional[bool] = None


class EmployeeOut(BaseModel):
    """Full employee record returned to the frontend, incl. computed total."""
    id: int
    name: str
    role: str
    phone: Optional[str] = None
    basic_salary: Decimal
    hra: Decimal
    travel_allowance: Decimal
    other_allowance: Decimal
    total_salary: Decimal          # computed: basic + hra + travel + other
    joining_date: Optional[date] = None
    is_active: bool
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ═══════════════════════════════════════════════════════════════════════════
#  EXPENSES
# ═══════════════════════════════════════════════════════════════════════════

class ExpenseCreate(BaseModel):
    """Body for POST /expenditure/expenses."""
    date: Optional[date] = None    # defaults to today when omitted
    category: str
    description: str
    amount: Decimal
    payment_mode: str              # "CASH" or "UPI"
    paid_to: Optional[str] = None
    employee_id: Optional[int] = None
    reference: Optional[str] = None
    notes: Optional[str] = None


class ExpenseOut(BaseModel):
    """One expense row returned to the frontend."""
    id: int
    date: date
    category: str
    description: str
    amount: Decimal
    payment_mode: str
    paid_to: Optional[str] = None
    employee_id: Optional[int] = None
    employee_name: Optional[str] = None   # convenience for the table display
    reference: Optional[str] = None
    notes: Optional[str] = None
    created_by: Optional[int] = None
    added_by_name: Optional[str] = None   # username/full name of the staff who logged it
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class ExpenseSummaryOut(BaseModel):
    """Response for GET /expenditure/expenses — totals + the list."""
    total_expenses: Decimal
    cash_out: Decimal
    upi_out: Decimal
    by_category: dict              # {"SALARY": 10000, "SHOP": 1500, ...}
    expenses: List[ExpenseOut]


# ═══════════════════════════════════════════════════════════════════════════
#  PAYROLL / SALARY
# ═══════════════════════════════════════════════════════════════════════════

class AdvanceLine(BaseModel):
    """A single ADVANCE expense shown under an employee's payroll card."""
    date: date
    amount: Decimal
    description: str


class SalarySummaryRow(BaseModel):
    """One employee's payroll picture for a given month."""
    employee: EmployeeOut
    gross_salary: Decimal
    advances_taken: Decimal
    net_payable: Decimal
    advances: List[AdvanceLine]
    status: str                   # PENDING / PAID / PARTIAL
    salary_record_id: Optional[int] = None
    amount_paid: Optional[Decimal] = None


class SalarySettleRequest(BaseModel):
    """Body for POST /expenditure/salary/settle."""
    employee_id: int
    month: int
    year: int
    amount_paid: Decimal
    payment_mode: str             # "CASH" or "UPI"
    notes: Optional[str] = None


class SalaryRecordOut(BaseModel):
    """A settled salary record — also drives the printable payslip."""
    id: int
    employee_id: int
    month: int
    year: int
    basic_salary: Decimal
    hra: Decimal
    travel_allowance: Decimal
    other_allowance: Decimal
    gross_salary: Decimal
    total_advances: Decimal
    net_payable: Decimal
    amount_paid: Decimal
    payment_mode: Optional[str] = None
    status: str
    paid_at: Optional[datetime] = None
    notes: Optional[str] = None

    model_config = {"from_attributes": True}


# ═══════════════════════════════════════════════════════════════════════════
#  CASH REGISTER
# ═══════════════════════════════════════════════════════════════════════════

class CashRegisterOut(BaseModel):
    """The full daily cash + bank picture for one date."""
    date: date
    opening_cash: Decimal
    opening_bank: Decimal
    cash_in: Decimal              # CASH sales for the day (from invoices)
    upi_in: Decimal               # UPI sales for the day
    cash_out: Decimal             # CASH expenses for the day
    upi_out: Decimal              # UPI expenses for the day
    closing_cash: Decimal         # opening_cash + cash_in - cash_out (expected)
    closing_bank: Decimal         # opening_bank + upi_in - upi_out (expected)
    actual_closing_cash: Optional[Decimal] = None   # owner's counted drawer
    actual_closing_bank: Optional[Decimal] = None
    difference_cash: Optional[Decimal] = None        # actual - expected
    difference_bank: Optional[Decimal] = None
    notes: Optional[str] = None


class CashOpeningRequest(BaseModel):
    """Body for POST /expenditure/cash-register/opening."""
    date: date
    opening_cash: Decimal = Decimal("0")
    opening_bank: Decimal = Decimal("0")


class CashClosingRequest(BaseModel):
    """Body for POST /expenditure/cash-register/closing."""
    date: date
    actual_closing_cash: Decimal
    actual_closing_bank: Decimal
    notes: Optional[str] = None
