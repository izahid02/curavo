"""
SQLAlchemy ORM models for the Purchasing module (Phase 2).

Maps to 4 new tables:
  purchase_orders      — a request sent to a supplier (does NOT touch stock)
  purchase_order_items — line items inside a PO
  goods_receipt_notes  — actual stock arriving (DOES create batches + movements)
  grn_items            — line items inside a GRN, each linked to a new batch

KEY RULE: A PO is just a document.  Stock only enters the system when a GRN
is created.  Each GRN item creates one Batch row + one StockMovement row.
"""
from sqlalchemy import Column, Date, ForeignKey, Integer, Numeric, String, Text, TIMESTAMP
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class PurchaseOrder(Base):
    """
    Maps to 'purchase_orders'.

    A PO is a formal request to a supplier: "please send us X units of Y."
    It does NOT change any stock numbers — that only happens when the goods
    physically arrive and a GRN is created.

    Status values and their meaning:
      DRAFT            — just written, not yet sent to supplier
      SENT             — sent (email / phone / WhatsApp)
      PARTIALLY_RECEIVED — some items received via GRN, not all
      RECEIVED         — fully received (all items on GRN)
      CANCELLED        — abandoned
    """
    __tablename__ = "purchase_orders"

    id            = Column(Integer, primary_key=True, index=True)
    po_number     = Column(String(30), unique=True, nullable=False, index=True)
    supplier_id   = Column(Integer, ForeignKey("suppliers.id"), nullable=False)
    user_id       = Column(Integer, ForeignKey("users.id"))
    status        = Column(String(20), nullable=False, default="DRAFT")
    order_date    = Column(Date, nullable=False, server_default=func.current_date())
    expected_date = Column(Date)
    notes         = Column(Text)
    total_amount  = Column(Numeric(12, 2), nullable=False, default=0)
    created_at    = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    # ORM relationships — accessing po.items gives the list; po.supplier gives the Supplier row
    supplier = relationship("Supplier", foreign_keys=[supplier_id])
    items    = relationship(
        "PurchaseOrderItem",
        back_populates="po",
        cascade="all, delete-orphan",
        lazy="selectin",   # load items in a single extra query, avoids N+1 on detail views
    )
    grns     = relationship("GoodsReceiptNote", back_populates="po")


class PurchaseOrderItem(Base):
    """Maps to 'purchase_order_items'. One row per product line in a PO."""
    __tablename__ = "purchase_order_items"

    id               = Column(Integer, primary_key=True, index=True)
    po_id            = Column(Integer, ForeignKey("purchase_orders.id", ondelete="CASCADE"), nullable=False)
    product_id       = Column(Integer, ForeignKey("products.id"), nullable=False)
    quantity_ordered = Column(Integer, nullable=False)
    unit_price       = Column(Numeric(10, 2), nullable=False)
    line_total       = Column(Numeric(12, 2), nullable=False)

    po      = relationship("PurchaseOrder", back_populates="items")
    product = relationship("Product", foreign_keys=[product_id], lazy="joined")


class GoodsReceiptNote(Base):
    """
    Maps to 'goods_receipt_notes'.

    A GRN is the paper trail for physical goods arriving at the store.
    Creating a GRN is what actually adds stock — each GRN item creates:
      1. A new Batch row  (batch_number, mrp, prices, expiry, qty)
      2. A StockMovement row  (type='IN', reference=grn_number)

    po_id is optional — direct/walk-in purchases have no preceding PO.
    If po_id is set, the service updates the PO's status after creating the GRN.
    """
    __tablename__ = "goods_receipt_notes"

    id             = Column(Integer, primary_key=True, index=True)
    grn_number     = Column(String(30), unique=True, nullable=False, index=True)
    po_id          = Column(Integer, ForeignKey("purchase_orders.id"), nullable=True)
    supplier_id    = Column(Integer, ForeignKey("suppliers.id"), nullable=False)
    user_id        = Column(Integer, ForeignKey("users.id"))
    receipt_date   = Column(Date, nullable=False, server_default=func.current_date())
    invoice_number = Column(String(60))   # the supplier's own invoice reference
    notes          = Column(Text)
    total_amount   = Column(Numeric(12, 2), nullable=False, default=0)
    created_at     = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    supplier = relationship("Supplier", foreign_keys=[supplier_id])
    po       = relationship("PurchaseOrder", back_populates="grns")
    items    = relationship(
        "GRNItem",
        back_populates="grn",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class GRNItem(Base):
    """
    Maps to 'grn_items'.

    Each row represents one product/batch received in a GRN.
    batch_id is set during GRN creation after the new Batch row is inserted.
    """
    __tablename__ = "grn_items"

    id                = Column(Integer, primary_key=True, index=True)
    grn_id            = Column(Integer, ForeignKey("goods_receipt_notes.id", ondelete="CASCADE"), nullable=False)
    product_id        = Column(Integer, ForeignKey("products.id"), nullable=False)
    # batch_id is populated during GRN creation — points to the new Batch row
    batch_id          = Column(Integer, ForeignKey("batches.id"), nullable=True)
    batch_number      = Column(String(60))
    quantity_received = Column(Integer, nullable=False)
    purchase_price    = Column(Numeric(10, 2), nullable=False)
    selling_price     = Column(Numeric(10, 2), nullable=False)
    mrp               = Column(Numeric(10, 2), nullable=False)
    expiry_date       = Column(Date, nullable=False)
    mfg_date          = Column(Date)
    line_total        = Column(Numeric(12, 2), nullable=False)

    grn     = relationship("GoodsReceiptNote", back_populates="items")
    product = relationship("Product", foreign_keys=[product_id], lazy="joined")
    batch   = relationship("Batch", foreign_keys=[batch_id], lazy="joined")
