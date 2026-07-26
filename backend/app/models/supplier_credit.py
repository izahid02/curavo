"""
ORM models for SUPPLIER credit — money the pharmacy OWES to its suppliers.

Do not confuse this with app/models/credit.py, which is the mirror image:
that module tracks money PATIENTS owe the pharmacy.  The two are deliberately
kept as separate tables because the direction of the debt is opposite and the
reports that read them are completely different.

  supplier_credit_accounts      — one row per supplier, their running balance
  supplier_credit_transactions  — each credit / payment / adjustment event
  supplier_payment_reminders    — "pay this supplier soon" nudges for due dates
  supplier_returns              — expired stock sent back to the supplier

DESIGN NOTES:
  - SupplierCreditAccount.outstanding is a denormalised cache kept in sync by
    the service layer on every transaction.  It means "how much do we owe
    everyone?" is a single SUM over a handful of rows instead of replaying the
    whole transaction ledger.
  - advance_balance is the opposite direction: when we overpay, or return
    expired stock while owing nothing, the SUPPLIER ends up owing US.  Holding
    that in its own column (rather than as a negative outstanding) keeps the
    dashboard wording honest — "we owe" and "they owe" are different sentences.
  - Statuses are plain strings, matching the existing convention in this
    codebase, so the values stay readable in SQLite without an enum migration.
"""
from datetime import date, datetime

from sqlalchemy import (
    Boolean, Column, Date, DateTime, ForeignKey, Integer, Numeric, String, Text,
)
from sqlalchemy.orm import relationship

from app.database import Base


class SupplierCreditAccount(Base):
    """
    One row per supplier — the running balance of what we owe them.

    total_credit and total_paid are ever-increasing counters.  outstanding is
    maintained as (total_credit - total_paid) minus any return adjustments, and
    is never allowed to go below zero — anything past zero spills into
    advance_balance instead.
    """
    __tablename__ = "supplier_credit_accounts"

    id              = Column(Integer, primary_key=True)
    supplier_id     = Column(Integer, ForeignKey("suppliers.id"),
                             unique=True, nullable=False, index=True)
    total_credit    = Column(Numeric(10, 2), default=0)   # total ever owed
    total_paid      = Column(Numeric(10, 2), default=0)   # total ever paid back
    outstanding     = Column(Numeric(10, 2), default=0)   # what we still owe
    advance_balance = Column(Numeric(10, 2), default=0)   # what THEY owe us
    last_activity   = Column(DateTime, nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow)

    supplier = relationship("Supplier", foreign_keys=[supplier_id], lazy="joined")


class SupplierCreditTransaction(Base):
    """
    Each credit event with a supplier.

    type values:
      CREDIT            — we took stock without paying in full; we owe them
      PAYMENT           — we paid them money
      RETURN_ADJUSTMENT — expired stock returned; our debt is reduced
      ADVANCE           — we overpaid / returned with no debt; they owe us
      ADVANCE_USED      — we spent some of our advance on a new purchase

    For CREDIT rows: amount is what we owe, paid_amount grows as we pay,
    balance = amount - paid_amount.
    For PAYMENT / ADVANCE rows: amount is the money involved; balance is 0
    because those rows are not something that can be "paid off".

    status lifecycle for CREDIT rows:
      PENDING → nothing paid yet          (balance == amount)
      PARTIAL → some paid                 (0 < balance < amount)
      CLEARED → fully settled             (balance == 0)
      OVERDUE → past due_date, still open
    """
    __tablename__ = "supplier_credit_transactions"

    id                = Column(Integer, primary_key=True)
    supplier_id       = Column(Integer, ForeignKey("suppliers.id"),
                               nullable=False, index=True)
    # Links the debt back to the exact delivery that created it, so the
    # supplier's ledger can show "this ₹5,200 came from invoice INV-2025-001".
    stock_purchase_id = Column(Integer, ForeignKey("stock_purchases.id"), nullable=True)
    type              = Column(String(20), nullable=False)
    amount            = Column(Numeric(10, 2), nullable=False)
    payment_mode      = Column(String(10), nullable=True)   # CASH / UPI — PAYMENT rows only
    due_date          = Column(Date, nullable=True)         # CREDIT rows only
    paid_amount       = Column(Numeric(10, 2), default=0)
    balance           = Column(Numeric(10, 2), nullable=False)
    status            = Column(String(10), default="PENDING")
    notes             = Column(Text, nullable=True)
    created_at        = Column(DateTime, default=datetime.utcnow)
    created_by        = Column(Integer, ForeignKey("users.id"), nullable=True)

    supplier       = relationship("Supplier", foreign_keys=[supplier_id], lazy="joined")
    stock_purchase = relationship("StockPurchase", foreign_keys=[stock_purchase_id],
                                  lazy="select")
    reminders      = relationship("SupplierPaymentReminder", back_populates="credit_tx",
                                  lazy="select")


class SupplierPaymentReminder(Base):
    """
    A scheduled nudge telling the pharmacist to pay a supplier.

    Three reminders are created per CREDIT transaction that has a due date:
      5_DAYS_BEFORE — five days ahead of the due date
      DUE_DATE      — on the day itself
      2_DAYS_AFTER  — two days late (the "you are overdue" nudge)

    status lifecycle:
      PENDING   → not yet surfaced in the UI
      SHOWN     → surfaced to the pharmacist (or made moot by full payment)
      DISMISSED → pharmacist explicitly dismissed it
    """
    __tablename__ = "supplier_payment_reminders"

    id           = Column(Integer, primary_key=True)
    credit_tx_id = Column(Integer, ForeignKey("supplier_credit_transactions.id"),
                          nullable=False, index=True)
    supplier_id  = Column(Integer, ForeignKey("suppliers.id"), nullable=False)
    remind_date  = Column(Date, nullable=False, index=True)
    remind_type  = Column(String(20), nullable=False)
    status       = Column(String(10), default="PENDING")
    created_at   = Column(DateTime, default=datetime.utcnow)

    credit_tx = relationship("SupplierCreditTransaction", back_populates="reminders")


class SupplierReturn(Base):
    """
    Expired (or nearly expired) stock sent back to the supplier.

    THE MONEY RULE — read this before touching the numbers:
      The supplier does not hand back cash.  They give replacement medicines
      of equivalent value.  The GST originally paid on the purchase is NOT
      recoverable, so the pharmacy absorbs it as a loss:

          gross_value      = return_quantity x purchase_price
          gst_deduction    = gross_value x (gst_rate / 100)
          net_return_value = gross_value - gst_deduction

      net_return_value is then applied against what we owe that supplier
      (a RETURN_ADJUSTMENT credit transaction).  If we owe them nothing, it
      becomes an ADVANCE instead — they now owe us that value in stock.

    return_type records what we expect back:
      SAME_MEDICINE      — same drug, fresh batch
      DIFFERENT_MEDICINE — swapped for other stock of equal value
      PENDING            — returned, replacement not yet agreed/received
    """
    __tablename__ = "supplier_returns"

    id                = Column(Integer, primary_key=True)
    supplier_id       = Column(Integer, ForeignKey("suppliers.id"),
                               nullable=False, index=True)
    batch_id          = Column(Integer, ForeignKey("batches.id"), nullable=False)
    product_id        = Column(Integer, ForeignKey("products.id"), nullable=False)
    return_quantity   = Column(Integer, nullable=False)
    # Snapshots — taken at return time so later price/GST edits never rewrite
    # the value of a return that already happened.
    purchase_price    = Column(Numeric(10, 2), nullable=False)
    gst_rate          = Column(Numeric(5, 2), nullable=False)
    gross_value       = Column(Numeric(10, 2), nullable=False)
    gst_deduction     = Column(Numeric(10, 2), nullable=False)
    net_return_value  = Column(Numeric(10, 2), nullable=False)
    return_type       = Column(String(20), nullable=False)
    replacement_notes = Column(Text, nullable=True)
    # --- Bonus / scheme purchase (Feature B) --------------------------------
    # When the returned batch was bought on a scheme (e.g. "5+1"), the value is
    # based on the PAID units only — the free bonus units cost us nothing, so we
    # cannot reclaim anything for them.  These snapshot the split at return time.
    scheme_label      = Column(String, nullable=True)
    bonus_returned    = Column(Integer, default=0)
    paid_returned     = Column(Integer, nullable=True)
    credit_adjusted   = Column(Boolean, default=False)
    credit_tx_id      = Column(Integer,
                               ForeignKey("supplier_credit_transactions.id"),
                               nullable=True)
    status            = Column(String(20), default="COMPLETED")  # or PENDING_REPLACEMENT
    return_date       = Column(Date, default=date.today)
    notes             = Column(Text, nullable=True)
    created_by        = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at        = Column(DateTime, default=datetime.utcnow)

    supplier  = relationship("Supplier", foreign_keys=[supplier_id], lazy="joined")
    product   = relationship("Product", foreign_keys=[product_id], lazy="joined")
    batch     = relationship("Batch", foreign_keys=[batch_id], lazy="select")
    credit_tx = relationship("SupplierCreditTransaction", foreign_keys=[credit_tx_id],
                             lazy="select")


class HomeVisitCharge(Base):
    """
    The configurable default fee for administering a drip/injection at the
    patient's home (Feature 4).

    Only ONE active row is expected — it is a settings row, not a log.  The
    pharmacist can override the amount per-bill at the billing screen; this
    table just remembers the number that gets pre-filled.

    It lives in this module rather than billing.py purely to keep all four
    new features' tables discoverable in one place.
    """
    __tablename__ = "home_visit_charges"

    id             = Column(Integer, primary_key=True)
    name           = Column(String(120), default="Home Visit Charge")
    default_amount = Column(Numeric(10, 2), default=100.00)
    is_active      = Column(Boolean, default=True)
    created_at     = Column(DateTime, default=datetime.utcnow)
