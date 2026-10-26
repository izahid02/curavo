"""
SQLAlchemy ORM models for the Billing module.

Maps to tables that ALREADY EXIST in the database (created by schema.sql):
  invoices      — one row per sale transaction
  invoice_items — one row per batch deduction inside that sale
  audit_log     — immutable record of important events (returns, price changes…)

KEY DESIGN NOTE:
  A single bill line that spans two batches (FEFO overflow) becomes TWO
  invoice_items rows — one per batch.  The receipt collapses them visually,
  but the DB stores the split so stock and profit are exact.

  unit_price, purchase_price, and gst_rate are SNAPSHOTTED at sale time.
  Future changes to a product's price or GST rate must NOT affect old invoices.
"""
from sqlalchemy import Boolean, Column, Date, ForeignKey, Integer, Numeric, String, Text, TIMESTAMP  # noqa: F401
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Invoice(Base):
    """One complete sale transaction."""
    __tablename__ = "invoices"

    id              = Column(Integer, primary_key=True, index=True)
    # Human-readable format: HCC-2026-000123 — sequential, gapless, per year
    invoice_number  = Column(String(30), unique=True, nullable=False, index=True)
    # patient_id is nullable: walk-in customers have no patient record
    patient_id      = Column(Integer, ForeignKey("patients.id"), nullable=True)
    user_id         = Column(Integer, ForeignKey("users.id"))
    invoice_date    = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
    subtotal        = Column(Numeric(12, 2), nullable=False, default=0)  # pre-tax, pre-discount
    discount_amount = Column(Numeric(12, 2), nullable=False, default=0)
    gst_amount      = Column(Numeric(12, 2), nullable=False, default=0)
    total_amount    = Column(Numeric(12, 2), nullable=False, default=0)  # what the customer pays
    payment_method  = Column(String(20))   # 'CASH', 'UPI', 'CARD', 'CREDIT'
    amount_paid     = Column(Numeric(12, 2), nullable=True, default=0)    # paid upfront (for CREDIT mode)
    credit_amount   = Column(Numeric(12, 2), nullable=True, default=0)    # amount owed on credit
    credit_due_date = Column(Date, nullable=True)                          # when credit is due
    # 'COMPLETED' · 'PARTIAL_RETURN' (some units came back) · 'RETURNED' (all did)
    status          = Column(String(20), nullable=False, default="COMPLETED")
    # Running total of every rupee refunded against this invoice.
    #
    # WHY IT IS STORED RATHER THAN DERIVED: every revenue query in the app sums
    # Invoice.total_amount, and after a partial return that figure is no longer
    # what the customer is left having paid.  Deriving the refund on the fly
    # needs each line's share of the bill-level discount — a correlated subquery
    # in every dashboard card, to recompute something process_return already
    # worked out.  Written by billing_service.process_return; read through
    # services/revenue.net_invoice_amount_expr().
    refunded_amount = Column(Numeric(12, 2), nullable=True, default=0)
    referred_by     = Column(String(120), nullable=True)   # doctor/referrer name (optional)
    # --- Home visit / drip administration charge (Feature 4) ----------------
    # A flat service fee added to the bill when the pharmacist administers a
    # drip or injection at the patient's home.  It is stored on the INVOICE
    # rather than as an invoice_item because it has no batch and no stock
    # movement — and, being a service, it carries NO GST.
    home_visit_charge = Column(Numeric(12, 2), nullable=True, default=0)
    home_visit_notes  = Column(String(255), nullable=True)
    created_at      = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    # Accessing invoice.items gives all line items; cascade means items are
    # automatically deleted if the invoice is deleted (matches ON DELETE CASCADE in DB)
    items   = relationship(
        "InvoiceItem",
        back_populates="invoice",
        cascade="all, delete-orphan",
        lazy="selectin",   # load items in a single extra query (avoids N+1 in lists)
    )
    # lazy="select" (the default) — loads patient on demand without a JOIN.
    # Using lazy="joined" would add a LEFT OUTER JOIN to every Invoice query,
    # which PostgreSQL refuses to combine with FOR UPDATE (used in billing).
    patient = relationship("Patient", foreign_keys=[patient_id], lazy="select")


class InvoiceItem(Base):
    """
    One batch deduction within an invoice.

    If a product was split across two batches (FEFO), there are two rows
    here — one per batch — each pointing at its own batch_id.
    The receipt in the UI merges them visually, but we store them split
    so profit calculation and stock audit remain exact.
    """
    __tablename__ = "invoice_items"

    id             = Column(Integer, primary_key=True, index=True)
    invoice_id     = Column(Integer, ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False)
    batch_id       = Column(Integer, ForeignKey("batches.id"), nullable=False)
    # product_id is denormalised here (it's also on the batch) to speed up reports
    # that group by product without having to join through batches every time
    product_id     = Column(Integer, ForeignKey("products.id"), nullable=False)
    quantity       = Column(Integer, nullable=False)
    # FOUR decimals, matching Batch.selling_price, which this is a snapshot of.
    # revenue.py nets a partial return as unit_price x (quantity - returned_qty)
    # IN SQL, where SQLite reads the raw stored number -- so at 2dp the Python
    # read and the SQL sum disagreed, and a fully returned strip refunded
    # Rs.100.05 against a Rs.100.00 sale.  Old rows physically hold 2dp values
    # and read back unchanged, so past invoices are untouched.
    unit_price     = Column(Numeric(12, 4), nullable=False)   # selling_price at time of sale
    # FOUR decimals, like unit_price beside it.  This is half of every margin
    # the app reports, and a Rs.23.62 strip of 15 under a 5+1 scheme costs
    # Rs.1.3120 a tablet -- read back as Rs.1.31 it disagreed with the batch
    # panel and the Add Stock preview, which is the bug that started this.
    # Rows written while this said 2dp hold a true 2-decimal number and read
    # back unchanged, so past invoices keep the profit they always reported.
    purchase_price = Column(Numeric(12, 4), nullable=False)   # snapshot — for profit calc
    gst_rate       = Column(Numeric(5, 2), nullable=False)    # snapshot — do NOT use product's current rate
    line_total     = Column(Numeric(12, 2), nullable=False)   # qty * unit_price * (1 + gst_rate/100)
    # Phase 3.3: estimated date when this purchased supply will run out (for refill reminders)
    estimated_finish_date = Column(Date, nullable=True)

    # --- Partial returns ----------------------------------------------------
    # A customer routinely brings back ONE medicine off a five-line bill, so a
    # return is per LINE, not per invoice.  returned_qty is how many of this
    # line's units have come back so far (a line can be returned in more than
    # one visit); is_returned is the convenience flag for "this line is fully
    # back", i.e. returned_qty == quantity.
    #
    # The pair is deliberately NOT a single "returned" boolean: the still-sellable
    # remainder of a partly returned line has to stay on the invoice, priced and
    # taxed exactly as it was sold, or the invoice stops reconciling.
    returned_qty   = Column(Integer, nullable=False, default=0, server_default="0")
    is_returned    = Column(Boolean, nullable=False, default=False, server_default="0")

    invoice = relationship("Invoice", back_populates="items")
    batch   = relationship("Batch",   foreign_keys=[batch_id],   lazy="joined")
    product = relationship("Product", foreign_keys=[product_id], lazy="joined")


class AuditLog(Base):
    """
    Permanent record of sensitive actions: invoice returns, price changes, etc.
    We NEVER delete from this table — it is the evidence trail.
    Module 23 will add a UI to view it; for now we only write to it.
    """
    __tablename__ = "audit_log"

    id         = Column(Integer, primary_key=True, index=True)
    user_id    = Column(Integer, ForeignKey("users.id"))
    action     = Column(String(120), nullable=False)   # e.g. 'INVOICE_RETURN'
    entity     = Column(String(60))                    # which table/record
    details    = Column(Text)                          # free-form JSON or text
    created_at = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())


class DocCounter(Base):
    """
    Atomic sequence counter for document numbers.

    One row per (doc_type, year) combination.  The counter is incremented
    via a BEGIN IMMEDIATE transaction in database.get_next_doc_number()
    so no two concurrent requests can generate the same sequence number.

    doc_type values: 'INVOICE', 'PO', 'GRN'
    """
    __tablename__ = "doc_counters"

    doc_type    = Column(String(20), nullable=False, primary_key=True)
    year        = Column(Integer,    nullable=False, primary_key=True)
    last_number = Column(Integer,    nullable=False, default=0)
