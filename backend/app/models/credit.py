"""
ORM models for the Credit Management module.

Three tables:
  credit_accounts      — one row per patient, tracks running balance
  credit_transactions  — each credit-given or payment-received event
  credit_reminders     — scheduled WhatsApp/SMS reminders for due dates

DESIGN NOTES:
  - CreditAccount.outstanding is kept in sync by the service layer every time
    a transaction is created.  It is a denormalised cache — queries like
    "show all patients with outstanding > 0" are then O(1) instead of O(n).
  - CreditReminder stores pre-rendered message text so the sending service
    never needs to touch the database to reconstruct the message.
  - Statuses use plain strings so they remain readable in SQLite without an
    enum migration.
"""
from datetime import datetime

from sqlalchemy import Boolean, Column, Date, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import relationship

from app.database import Base


class CreditAccount(Base):
    """
    One row per patient — their running credit balance.

    total_credit and total_paid are ever-increasing counters; outstanding is
    kept as   outstanding = total_credit - total_paid   so dashboards can
    query it directly without summing all transaction rows.
    """
    __tablename__ = "credit_accounts"

    id            = Column(Integer, primary_key=True)
    patient_id    = Column(Integer, ForeignKey("patients.id"), unique=True, nullable=False, index=True)
    total_credit  = Column(Numeric(10, 2), default=0)   # total ever given on credit
    total_paid    = Column(Numeric(10, 2), default=0)   # total ever repaid
    outstanding   = Column(Numeric(10, 2), default=0)   # total_credit - total_paid (kept in sync)
    last_activity = Column(DateTime, nullable=True)
    created_at    = Column(DateTime, default=datetime.utcnow)

    patient      = relationship("Patient", foreign_keys=[patient_id], lazy="joined",
                               overlaps="account,transactions")
    transactions = relationship("CreditTransaction", back_populates="account",
                                primaryjoin="CreditAccount.patient_id == CreditTransaction.patient_id",
                                foreign_keys="CreditTransaction.patient_id",
                                lazy="select", overlaps="patient")


class CreditTransaction(Base):
    """
    Each credit event — either new credit given (type='CREDIT') or a
    payment received (type='PAYMENT').

    For CREDIT rows: amount is how much is owed, paid_amount grows as
    payments arrive, balance = amount - paid_amount.
    For PAYMENT rows: amount is the cash received; paid_amount/balance
    are not meaningful (kept at 0).

    status lifecycle for CREDIT rows:
      PENDING  → no payments yet (balance == amount)
      PARTIAL  → some payments received (0 < balance < amount)
      CLEARED  → fully paid (balance == 0)
      OVERDUE  → past due_date and still PENDING or PARTIAL
    """
    __tablename__ = "credit_transactions"

    id         = Column(Integer, primary_key=True)
    patient_id = Column(Integer, ForeignKey("patients.id"), nullable=False, index=True)
    invoice_id = Column(Integer, ForeignKey("invoices.id"), nullable=True)
    type       = Column(String(10), nullable=False)          # 'CREDIT' or 'PAYMENT'
    amount     = Column(Numeric(10, 2), nullable=False)
    due_date   = Column(Date, nullable=True)                 # only for CREDIT rows
    paid_amount = Column(Numeric(10, 2), default=0)          # how much of THIS transaction is repaid
    balance    = Column(Numeric(10, 2), nullable=False)      # amount - paid_amount
    status     = Column(String(10), default="PENDING")       # PENDING/PARTIAL/CLEARED/OVERDUE
    # Permanent "this was late at some point" marker.
    #
    # status tells you where the transaction stands RIGHT NOW and gets
    # overwritten (OVERDUE -> CLEARED) as soon as the patient pays, which
    # destroys the evidence that they were ever late.  was_overdue is set to
    # True the moment a transaction goes past its due date and is NEVER reset,
    # so "has this patient been late before?" stays answerable forever.
    was_overdue = Column(Boolean, default=False)
    # How the money came in — only meaningful on PAYMENT rows.
    # CREDIT rows leave this NULL because no money changed hands.
    payment_mode = Column(String(10), nullable=True)         # 'CASH' or 'UPI'
    notes      = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)

    patient   = relationship("Patient", foreign_keys=[patient_id], lazy="joined",
                             overlaps="account,transactions")
    invoice   = relationship("Invoice", foreign_keys=[invoice_id], lazy="select")
    reminders = relationship("CreditReminder", back_populates="credit_tx", lazy="select")
    account   = relationship(
        "CreditAccount",
        primaryjoin="CreditTransaction.patient_id == CreditAccount.patient_id",
        foreign_keys=[patient_id],
        back_populates="transactions",
        lazy="select",
        overlaps="patient,transactions",
    )


class CreditReminder(Base):
    """
    A scheduled reminder message for a credit due date.

    Three reminders are created per CreditTransaction:
      3_DAYS_BEFORE  — 3 days before due_date
      DUE_DATE       — on the due_date
      2_DAYS_AFTER   — 2 days after due_date (overdue notice)

    status lifecycle:
      PENDING → not yet sent
      SENT    → queued into message_queue
      SKIPPED → debt was cleared before this reminder was due
    """
    __tablename__ = "credit_reminders"

    id             = Column(Integer, primary_key=True)
    credit_tx_id   = Column(Integer, ForeignKey("credit_transactions.id"), nullable=False, index=True)
    patient_id     = Column(Integer, ForeignKey("patients.id"), nullable=False)
    remind_date    = Column(Date, nullable=False, index=True)
    remind_type    = Column(String(20), nullable=False)   # '3_DAYS_BEFORE'/'DUE_DATE'/'2_DAYS_AFTER'
    status         = Column(String(10), default="PENDING")
    message_en     = Column(Text, nullable=True)
    message_as     = Column(Text, nullable=True)
    sent_at        = Column(DateTime, nullable=True)

    credit_tx = relationship("CreditTransaction", back_populates="reminders")
    patient   = relationship("Patient", foreign_keys=[patient_id], lazy="joined")
