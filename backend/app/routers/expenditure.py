"""
Expenditure & Payroll API endpoints.

All routes are prefixed /api/expenditure and require a valid JWT login.
Business logic lives in app/services/expenditure_service.py — these route
functions stay thin (validate → call service → shape response).

Endpoints
  Expenses
    POST   /expenses                 create an expense
    GET    /expenses                 monthly summary + list (filters)
    GET    /expenses/{id}            single expense
    DELETE /expenses/{id}            delete (Owner/Admin only)
  Employees
    GET    /employees                all active employees
    POST   /employees                create employee
    PUT    /employees/{id}           update employee / salary
    DELETE /employees/{id}           soft delete (is_active=False)
  Payroll
    GET    /salary/{month}/{year}    salary summary for all employees
    POST   /salary/settle            pay an employee for a month
  Cash Register
    GET    /cash-register/{date}     daily cash + bank picture (YYYY-MM-DD or 'today')
    POST   /cash-register/opening    set opening balances
    POST   /cash-register/closing    record actual counted balances
"""
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.expenditure import Employee, Expense
from app.models.user import User
from app.utils.dates import get_today_ist
from app.schemas.expenditure import (
    CashClosingRequest,
    CashOpeningRequest,
    CashRegisterOut,
    EmployeeCreate,
    EmployeeOut,
    EmployeeUpdate,
    ExpenseCreate,
    ExpenseOut,
    ExpenseSummaryOut,
    SalaryRecordOut,
    SalarySettleRequest,
    SalarySummaryRow,
)
from app.services.auth_service import get_current_user
from app.services.expenditure_service import (
    employee_to_dict,
    get_cash_register,
    get_employee_salary_summary,
    get_expense_summary,
    record_closing,
    set_opening,
    settle_salary,
)

router = APIRouter(prefix="/expenditure", tags=["Expenditure"])


def _require_owner_admin(user: User) -> None:
    """Raise 403 unless the user's role is Owner or Admin."""
    if user.role and user.role.name not in ("Owner", "Admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Owner or Admin can perform this action",
        )


# ═══════════════════════════════════════════════════════════════════════════
#  EXPENSES
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/expenses", response_model=ExpenseOut, status_code=status.HTTP_201_CREATED)
def create_expense(
    body:         ExpenseCreate,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Log a new outgoing payment."""
    if body.payment_mode not in ("CASH", "UPI"):
        raise HTTPException(status_code=400, detail="payment_mode must be CASH or UPI")
    if body.amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than zero")

    # ADVANCE / SALARY expenses must name the employee they belong to.
    if body.category in ("ADVANCE", "SALARY") and not body.employee_id:
        raise HTTPException(
            status_code=400,
            detail=f"An employee is required for {body.category} expenses",
        )
    if body.employee_id and db.get(Employee, body.employee_id) is None:
        raise HTTPException(status_code=404, detail="Employee not found")

    exp = Expense(
        date=body.date or get_today_ist(),
        category=body.category,
        description=body.description,
        amount=body.amount,
        payment_mode=body.payment_mode,
        paid_to=body.paid_to,
        employee_id=body.employee_id,
        reference=body.reference,
        notes=body.notes,
        created_by=current_user.id,
    )
    db.add(exp)
    db.commit()
    db.refresh(exp)

    # Reload so employee/creator relationships are populated for the response.
    from app.services.expenditure_service import _expense_to_dict
    return ExpenseOut(**_expense_to_dict(exp))


@router.get("/expenses", response_model=ExpenseSummaryOut)
def list_expenses(
    month:        int | None = Query(None, ge=1, le=12),
    year:         int | None = Query(None, ge=2000, le=2100),
    category:     str | None = Query(None),
    payment_mode: str | None = Query(None),
    db:           Session = Depends(get_db),
    _:            User    = Depends(get_current_user),
):
    """
    Monthly expense summary (totals + per-category split + list).
    Defaults to the current month when month/year are omitted.  Optional
    category / payment_mode filters narrow the returned list (totals still
    reflect the whole month so the summary cards stay meaningful).
    """
    today = get_today_ist()
    month = month or today.month
    year  = year or today.year

    data = get_expense_summary(db, month, year)

    # Apply optional filters to the list only.
    expenses = data["expenses"]
    if category:
        expenses = [e for e in expenses if e["category"] == category]
    if payment_mode:
        expenses = [e for e in expenses if e["payment_mode"] == payment_mode]

    return ExpenseSummaryOut(
        total_expenses=data["total_expenses"],
        cash_out=data["cash_out"],
        upi_out=data["upi_out"],
        by_category=data["by_category"],
        expenses=[ExpenseOut(**e) for e in expenses],
    )


@router.get("/expenses/{expense_id}", response_model=ExpenseOut)
def get_expense(
    expense_id: int,
    db:         Session = Depends(get_db),
    _:          User    = Depends(get_current_user),
):
    """Fetch a single expense by id."""
    exp = db.get(Expense, expense_id)
    if exp is None:
        raise HTTPException(status_code=404, detail="Expense not found")
    from app.services.expenditure_service import _expense_to_dict
    return ExpenseOut(**_expense_to_dict(exp))


@router.delete("/expenses/{expense_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_expense(
    expense_id:   int,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Delete an expense.  Owner/Admin only (protects the ledger)."""
    _require_owner_admin(current_user)
    exp = db.get(Expense, expense_id)
    if exp is None:
        raise HTTPException(status_code=404, detail="Expense not found")
    db.delete(exp)
    db.commit()
    return None


# ═══════════════════════════════════════════════════════════════════════════
#  EMPLOYEES
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/employees", response_model=list[EmployeeOut])
def list_employees(
    include_inactive: bool = Query(False),
    db:               Session = Depends(get_db),
    _:                User    = Depends(get_current_user),
):
    """Return all active employees (with computed total_salary)."""
    q = db.query(Employee)
    if not include_inactive:
        q = q.filter(Employee.is_active == True)  # noqa: E712
    employees = q.order_by(Employee.name.asc()).all()
    return [EmployeeOut(**employee_to_dict(e)) for e in employees]


@router.post("/employees", response_model=EmployeeOut, status_code=status.HTTP_201_CREATED)
def create_employee(
    body:         EmployeeCreate,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Add a new employee to the payroll."""
    emp = Employee(
        name=body.name,
        role=body.role,
        phone=body.phone,
        basic_salary=body.basic_salary,
        hra=body.hra,
        travel_allowance=body.travel_allowance,
        other_allowance=body.other_allowance,
        joining_date=body.joining_date,
        is_active=True,
        created_by=current_user.id,
    )
    db.add(emp)
    db.commit()
    db.refresh(emp)
    return EmployeeOut(**employee_to_dict(emp))


@router.put("/employees/{employee_id}", response_model=EmployeeOut)
def update_employee(
    employee_id:  int,
    body:         EmployeeUpdate,
    db:           Session = Depends(get_db),
    _:            User    = Depends(get_current_user),
):
    """Update an employee's details or salary components (partial update)."""
    emp = db.get(Employee, employee_id)
    if emp is None:
        raise HTTPException(status_code=404, detail="Employee not found")

    # Only overwrite fields the client actually sent.
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(emp, field, value)

    db.commit()
    db.refresh(emp)
    return EmployeeOut(**employee_to_dict(emp))


@router.delete("/employees/{employee_id}", response_model=EmployeeOut)
def deactivate_employee(
    employee_id:  int,
    db:           Session = Depends(get_db),
    _:            User    = Depends(get_current_user),
):
    """Soft-delete: set is_active=False so payroll history is preserved."""
    emp = db.get(Employee, employee_id)
    if emp is None:
        raise HTTPException(status_code=404, detail="Employee not found")
    emp.is_active = False
    db.commit()
    db.refresh(emp)
    return EmployeeOut(**employee_to_dict(emp))


# ═══════════════════════════════════════════════════════════════════════════
#  PAYROLL
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/salary/{month}/{year}", response_model=list[SalarySummaryRow])
def salary_summary(
    month: int,
    year:  int,
    db:    Session = Depends(get_db),
    _:     User    = Depends(get_current_user),
):
    """Payroll picture for all active employees for the given month/year."""
    if not (1 <= month <= 12):
        raise HTTPException(status_code=400, detail="month must be 1-12")
    rows = get_employee_salary_summary(db, month, year)
    return [SalarySummaryRow(**r) for r in rows]


@router.post("/salary/settle", response_model=SalaryRecordOut, status_code=status.HTTP_201_CREATED)
def settle(
    body:         SalarySettleRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Pay an employee for a month — writes a SalaryRecord + a SALARY Expense."""
    if body.payment_mode not in ("CASH", "UPI"):
        raise HTTPException(status_code=400, detail="payment_mode must be CASH or UPI")
    if not (1 <= body.month <= 12):
        raise HTTPException(status_code=400, detail="month must be 1-12")
    try:
        record = settle_salary(
            db,
            employee_id=body.employee_id,
            month=body.month,
            year=body.year,
            amount_paid=body.amount_paid,
            payment_mode=body.payment_mode,
            notes=body.notes,
            created_by=current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    db.commit()
    db.refresh(record)
    return SalaryRecordOut.model_validate(record)


# ═══════════════════════════════════════════════════════════════════════════
#  CASH REGISTER
# ═══════════════════════════════════════════════════════════════════════════

def _parse_day(raw: str) -> date:
    """Accept 'today' or an ISO 'YYYY-MM-DD' string, returning a date."""
    if raw == "today":
        return get_today_ist()
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD or 'today'")


@router.get("/cash-register/{day}", response_model=CashRegisterOut)
def cash_register(
    day: str,
    db:  Session = Depends(get_db),
    _:   User    = Depends(get_current_user),
):
    """Full daily cash + bank picture for the given date (YYYY-MM-DD or 'today')."""
    return CashRegisterOut(**get_cash_register(db, _parse_day(day)))


@router.post("/cash-register/opening", response_model=CashRegisterOut)
def cash_opening(
    body:         CashOpeningRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Set (or update) the opening cash + bank balances for a day."""
    set_opening(db, body.date, body.opening_cash, body.opening_bank, current_user.id)
    db.commit()
    return CashRegisterOut(**get_cash_register(db, body.date))


@router.post("/cash-register/closing", response_model=CashRegisterOut)
def cash_closing(
    body:         CashClosingRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Record the owner's actual counted cash + bank balances for a day."""
    record_closing(
        db,
        body.date,
        body.actual_closing_cash,
        body.actual_closing_bank,
        body.notes,
        current_user.id,
    )
    db.commit()
    return CashRegisterOut(**get_cash_register(db, body.date))
