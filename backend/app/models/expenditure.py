"""
SQLAlchemy ORM models for the Expenditure & Payroll module.

Four tables — all created automatically by init_db() on first startup:

  employees        — staff on the pharmacy payroll (salary components live here)
  expenses         — every rupee that goes OUT of the business (any category)
  salary_records   — a settled month's salary for one employee (payslip source)
  cash_register    — one row per day: opening/closing cash & bank balances

DESIGN NOTES (read before touching):
  - Money is always Numeric(10,2) — never float.  The service layer converts to
    Decimal.  (Matches the Decimal-everywhere rule in CLAUDE.md section 6.)
  - An Expense with category "SALARY" or "ADVANCE" carries an employee_id so we
    can total how much each employee has drawn.  All other categories leave it
    NULL.
  - A SalaryRecord is the permanent payslip: it snapshots the salary components
    at the moment of settlement, so a later pay-rise never rewrites history
    (same "lock the numbers at the event" idea used for invoice profit).
  - cash_register.date is UNIQUE — there is at most one register row per day.
"""
from datetime import date, datetime

from sqlalchemy import (
    Boolean, Column, Date, DateTime, ForeignKey, Integer, Numeric, String, Text,
)
from sqlalchemy.orm import relationship

from app.database import Base


class Employee(Base):
    """
    One row per staff member on the payroll.

    total_salary (basic + hra + travel + other) is NOT stored — it is computed
    on the fly by the service layer and the schema, so it can never drift out of
    sync with the individual components.
    """
    __tablename__ = "employees"

    id               = Column(Integer, primary_key=True)
    name             = Column(String, nullable=False)
    phone            = Column(String, nullable=True)
    # Free-text job title, e.g. "Pharmacist", "Assistant", "Accountant"
    role             = Column(String, nullable=False)
    basic_salary     = Column(Numeric(10, 2), nullable=False)
    hra              = Column(Numeric(10, 2), default=0)   # House Rent Allowance
    travel_allowance = Column(Numeric(10, 2), default=0)
    other_allowance  = Column(Numeric(10, 2), default=0)
    joining_date     = Column(Date, nullable=True)
    # Soft-delete flag: deactivated employees stay in the DB (for history) but
    # are hidden from the active payroll lists.
    is_active        = Column(Boolean, default=True)
    created_at       = Column(DateTime, default=datetime.utcnow)
    created_by       = Column(Integer, ForeignKey("users.id"), nullable=True)

    # All expenses (advances / salaries) tied to this employee.
    expenses         = relationship("Expense", back_populates="employee", lazy="select")
    salary_records   = relationship("SalaryRecord", back_populates="employee", lazy="select")


class Expense(Base):
    """
    Every outgoing payment the pharmacy makes.

    category values:
      SALARY / ADVANCE / SHOP / PERSONAL / UTILITY / MAINTENANCE / OTHER
    payment_mode values:
      CASH / UPI   (matches the invoice.payment_method spellings so the cash
      register can net sales-in against expenses-out)
    """
    __tablename__ = "expenses"

    id           = Column(Integer, primary_key=True)
    date         = Column(Date, nullable=False, default=date.today)
    category     = Column(String, nullable=False)
    description  = Column(Text, nullable=False)
    amount       = Column(Numeric(10, 2), nullable=False)
    payment_mode = Column(String, nullable=False)          # "CASH" or "UPI"
    paid_to      = Column(String, nullable=True)           # person / vendor paid
    # Set only when category is SALARY or ADVANCE — links the payment to a staff
    # member so we can total their advances for the month.
    employee_id  = Column(Integer, ForeignKey("employees.id"), nullable=True)
    reference    = Column(String, nullable=True)           # UPI txn id / receipt no.
    notes        = Column(Text, nullable=True)
    created_by   = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at   = Column(DateTime, default=datetime.utcnow)

    employee     = relationship("Employee", back_populates="expenses", lazy="joined")
    creator      = relationship("User", foreign_keys=[created_by], lazy="joined")


class SalaryRecord(Base):
    """
    A settled month's salary for one employee — the source of the payslip.

    gross_salary  = basic + hra + travel + other   (snapshot at settlement time)
    total_advances= sum of that month's ADVANCE expenses for this employee
    net_payable   = gross_salary - total_advances
    amount_paid   = what the owner actually handed over (may be less → PARTIAL)
    """
    __tablename__ = "salary_records"

    id               = Column(Integer, primary_key=True)
    employee_id      = Column(Integer, ForeignKey("employees.id"), nullable=False)
    month            = Column(Integer, nullable=False)     # 1-12
    year             = Column(Integer, nullable=False)
    basic_salary     = Column(Numeric(10, 2), nullable=False)
    hra              = Column(Numeric(10, 2), default=0)
    travel_allowance = Column(Numeric(10, 2), default=0)
    other_allowance  = Column(Numeric(10, 2), default=0)
    gross_salary     = Column(Numeric(10, 2), nullable=False)
    total_advances   = Column(Numeric(10, 2), default=0)
    net_payable      = Column(Numeric(10, 2), nullable=False)
    amount_paid      = Column(Numeric(10, 2), default=0)
    payment_mode     = Column(String, nullable=True)       # "CASH" or "UPI"
    status           = Column(String, default="PENDING")   # PENDING / PAID / PARTIAL
    paid_at          = Column(DateTime, nullable=True)
    notes            = Column(Text, nullable=True)
    created_by       = Column(Integer, ForeignKey("users.id"), nullable=True)

    employee         = relationship("Employee", back_populates="salary_records", lazy="joined")


class CashRegister(Base):
    """
    One row per day — the daily cash & bank drawer picture.

    Only opening/closing balances and notes are stored here.  The "in" and "out"
    movements (sales and expenses) are calculated live from the invoices and
    expenses tables by the service layer, so they are always accurate and never
    need re-summing into this row.

    date is UNIQUE so there can only ever be one register per calendar day.
    """
    __tablename__ = "cash_register"

    id           = Column(Integer, primary_key=True)
    date         = Column(Date, nullable=False, unique=True)
    opening_cash = Column(Numeric(10, 2), default=0)
    opening_bank = Column(Numeric(10, 2), default=0)   # UPI/bank balance at start of day
    # The owner's actual counted balances at day's end (NULL until they count).
    closing_cash = Column(Numeric(10, 2), nullable=True)
    closing_bank = Column(Numeric(10, 2), nullable=True)
    notes        = Column(Text, nullable=True)
    created_by   = Column(Integer, ForeignKey("users.id"), nullable=True)
    updated_at   = Column(DateTime, default=datetime.utcnow)
