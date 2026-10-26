"""
SQLAlchemy ORM models for the Inventory module.

These Python classes map to tables that ALREADY EXIST in the database
(created by database/schema.sql). We are NOT creating tables here —
we are just giving Python a way to read/write those tables without
writing raw SQL every time.

The most important design rule:
  - Product  = medicine IDENTITY (name, GST rate, barcode…)
  - Batch    = one physical delivery with its own expiry & price
  - Stock quantity lives in Batch.quantity_available, NOT on Product.
"""
from sqlalchemy import (
    Boolean, Column, Date, ForeignKey, Integer, Numeric,
    String, TIMESTAMP, Text,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Category(Base):
    """Maps to the 'categories' table.  e.g. Tablet, Syrup, Injection."""
    __tablename__ = "categories"

    id   = Column(Integer, primary_key=True, index=True)
    name = Column(String(80), unique=True, nullable=False)

    # One category → many products
    products = relationship("Product", back_populates="category")


class Department(Base):
    """Maps to the 'departments' table.  e.g. Cardiology, Diabetes."""
    __tablename__ = "departments"

    id   = Column(Integer, primary_key=True, index=True)
    name = Column(String(80), unique=True, nullable=False)

    # One department → many products
    products = relationship("Product", back_populates="department")


class Supplier(Base):
    """Maps to the 'suppliers' table.  Tracks who we buy medicine from."""
    __tablename__ = "suppliers"

    id             = Column(Integer, primary_key=True, index=True)
    name           = Column(String(150), nullable=False)
    contact_person = Column(String(120))
    phone          = Column(String(20))
    address        = Column(Text)
    gst_number     = Column(String(20))
    # Drug Licence number.  Every pharmaceutical distributor in India must hold
    # one, and the pharmacy is legally required to record it against purchases,
    # so it sits next to the GSTIN on the supplier record.
    dl_number      = Column(String(50))
    created_at     = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    # One supplier → many batches
    batches = relationship("Batch", back_populates="supplier")


class Product(Base):
    """
    Maps to the 'products' table.

    A product is the medicine's IDENTITY — name, generic name, GST rate,
    barcode, etc.  Things that do NOT change per delivery live here.

    Stock quantity does NOT live here.  To find out how many units are
    on the shelf, SUM batch.quantity_available across all non-expired
    batches for this product.
    """
    __tablename__ = "products"

    id              = Column(Integer, primary_key=True, index=True)
    name            = Column(String(150), nullable=False, index=True)
    generic_name    = Column(String(150))
    brand           = Column(String(120))
    manufacturer    = Column(String(120))
    category_id     = Column(Integer, ForeignKey("categories.id"))
    department_id   = Column(Integer, ForeignKey("departments.id"))
    hsn_code        = Column(String(10))
    # Numeric(5,2) = up to 999.99, sufficient for any GST percentage
    gst_rate        = Column(Numeric(5, 2), nullable=False, default=12)
    barcode         = Column(String(64), index=True)
    rack_location   = Column(String(50))
    unit            = Column(String(30), default="unit")
    min_stock_level = Column(Integer, nullable=False, default=10)
    is_active       = Column(Boolean, nullable=False, default=True)
    # Which register this medicine's sale must be written into: 'H1' (Schedule
    # H1), 'MTP' (the MTP kit), or NULL for everything else — which is most of
    # the shelf.  Set only after a pharmacist CONFIRMS the match; see
    # services/drug_schedules.py, which proposes matches and never applies
    # them.  A register built from guesses is worse than no register.
    register_category = Column(String(8), nullable=True, index=True)
    # Phase 3.3: pharmacist override — how many days one unit lasts for this product
    days_per_unit   = Column(Integer, nullable=True)

    # --- Strip / unit management (Feature 3) --------------------------------
    # Tablets and capsules arrive in strips but customers often buy loose
    # tablets.  THE STOCK RULE: batch.quantity_available is ALWAYS counted in
    # individual units (tablets), never in strips.  units_per_strip is what
    # lets the UI display "15 strips (150 units)" and lets billing price the
    # same medicine either way.
    medicine_type   = Column(String(20), default="TABLET")
    # True only for products actually sold in strips — a syrup bottle is not.
    is_strip        = Column(Boolean, default=False)
    units_per_strip = Column(Integer, nullable=True)   # e.g. 10 tablets per strip
    strip_mrp       = Column(Numeric(10, 2), nullable=True)   # price of a full strip
    # Normally strip_mrp / units_per_strip, but the pharmacist can override it
    # (loose tablets often carry a small premium over the per-strip rate).
    #
    # FOUR decimals, not two: this is a DERIVED price.  A Rs.100 strip of 15 is
    # Rs.6.6667 a tablet; rounded to Rs.6.67 a whole strip bills at Rs.100.05 and
    # the customer is overcharged five paise for a price printed on the pack.
    # strip_mrp above stays at 2dp -- that one IS printed on the pack.
    unit_mrp        = Column(Numeric(12, 4), nullable=True)

    created_at      = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    # "product.category" → auto-fetches the Category row (no extra query needed)
    category   = relationship("Category", back_populates="products")
    department = relationship("Department", back_populates="products")
    batches    = relationship("Batch", back_populates="product")


class Batch(Base):
    """
    Maps to the 'batches' table.

    Each physical delivery of a product becomes one batch row with its
    own expiry date, purchase price, MRP, and quantity on hand.
    THIS is where stock quantity lives.  Multiple batches can exist for
    the same product (from different deliveries at different times).

    When we sell, billing code deducts from the batch expiring soonest
    first (FEFO = First Expiry First Out).
    """
    __tablename__ = "batches"

    id                 = Column(Integer, primary_key=True, index=True)
    product_id         = Column(Integer, ForeignKey("products.id"), nullable=False, index=True)
    supplier_id        = Column(Integer, ForeignKey("suppliers.id"))
    batch_number       = Column(String(60))
    # PER-UNIT SELLING PRICES KEEP FOUR DECIMALS.  A strip is a pricing
    # convenience, never a storage unit, so a Rs.100 strip of 15 tablets lands
    # here as Rs.6.6667 a tablet.  At 2dp it reads back Rs.6.67 and billing
    # charges 6.67 x 15 = Rs.100.05 for a strip whose pack says Rs.100 -- five
    # paise of overcharge on every strip sold, for every strip medicine.
    #
    # SQLite does not enforce a column's scale, so the full 4dp value was always
    # physically in the file; it was SQLAlchemy that rounded it on the way OUT,
    # to the scale declared here.  Widening this therefore needs NO migration
    # and fixes stock already on the shelf.  Line totals still quantize to paise
    # in billing_service -- that IS the money.  (max 99,999,999.9999)
    mrp                = Column(Numeric(12, 4), nullable=False)
    # Also 4dp, and for the same reason as the prices above.  Left at 2dp in
    # the first pass on the grounds that it only moved report figures -- which
    # turned out to be the wrong call: it is half of every margin on screen,
    # and at 2dp a 5+1 delivery's cost disagreed with what Add Stock had just
    # promised.  Past INVOICES are unaffected (they snapshot their own cost);
    # what this changes is current stock valuation, which becomes more
    # accurate, not different in kind.
    purchase_price     = Column(Numeric(12, 4), nullable=False)
    selling_price      = Column(Numeric(12, 4), nullable=False)
    mfg_date           = Column(Date)
    expiry_date        = Column(Date, nullable=False, index=True)
    quantity_received  = Column(Integer, nullable=False)
    # quantity_available starts = quantity_received, decreases with each sale/adjustment
    quantity_available = Column(Integer, nullable=False)
    # --- Bonus / scheme purchase (Feature B) --------------------------------
    # Distributors offer schemes like "5+1" (buy 5, get 1 free).  The free units
    # enter stock at zero cost; we record the scheme here for reference and so a
    # later return can value only the PAID units (bonus units were free).
    #
    # ⚠ A SCHEME IS COUNTED IN PACKS, NOT TABLETS.  "5+1" on a strip medicine
    # means 5 STRIPS earn 1 free strip.  scheme_buy/scheme_free store the human
    # numbers (5 and 1); inventory_service._compute_scheme scales them by
    # units_per_strip before working out bonus_quantity, which is in UNITS.
    #   scheme_buy / scheme_free — the two halves of "5+1", in packs
    #   scheme_label             — the human string, e.g. "5+1"
    #   bonus_quantity           — how many of quantity_received were free
    #   paid_quantity            — how many were actually paid for
    #   effective_cost_per_unit  — cost x paid / total.  NOT informational:
    #                              this is THE cost of one unit of this batch,
    #                              read by the batch panel, by billing when it
    #                              snapshots profit, and by every stock
    #                              valuation.  See services/costing.py.
    scheme_buy              = Column(Integer, nullable=True)
    scheme_free             = Column(Integer, nullable=True)
    scheme_label            = Column(String, nullable=True)
    bonus_quantity          = Column(Integer, default=0)
    paid_quantity           = Column(Integer, nullable=True)
    # FOUR decimals, for the reason in CLAUDE.md s4: a Rs.23.62 strip of 15
    # spread over a 5+1 scheme is Rs.1.3122 a tablet, and rounding that to
    # paise drifts a 180-unit delivery by about 40 paise of reported profit.
    effective_cost_per_unit = Column(Numeric(12, 4), nullable=True)
    created_at         = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    product   = relationship("Product", back_populates="batches")
    supplier  = relationship("Supplier", back_populates="batches")
    movements = relationship("StockMovement", back_populates="batch")


class StockPurchase(Base):
    """
    Maps to the 'stock_purchases' table.

    A simple, flat record of ONE stock-in event from the unified "Add Stock"
    flow on the Medicines page.  Each time the pharmacist receives a delivery
    of a medicine, we write one row here linking:
      - which product + batch was created,
      - which supplier it came from,
      - the supplier's invoice number + date,
      - the quantity, MRP, and (optional) cost price,
      - who recorded it and when.

    Why a dedicated table instead of the Purchase Order / GRN tables?
        The PO→GRN workflow is a multi-document process (draft order, send,
        goods-receipt-note, status transitions).  For a small pharmacy that
        just wants "I got 100 boxes from this supplier, here's the invoice",
        that is far too heavy.  This table captures exactly the fields the
        Add Stock panel collects — nothing more — so Purchase History can be
        rendered from a single simple query.

    The old PO/GRN tables still exist untouched; this table lives alongside
    them and powers the new simplified UI.
    """
    __tablename__ = "stock_purchases"

    id                      = Column(Integer, primary_key=True, index=True)
    product_id              = Column(Integer, ForeignKey("products.id"), nullable=False, index=True)
    batch_id                = Column(Integer, ForeignKey("batches.id"), nullable=False)
    supplier_id             = Column(Integer, ForeignKey("suppliers.id"), nullable=False)
    supplier_invoice_number = Column(String(80), nullable=False)
    supplier_invoice_date   = Column(Date, nullable=False)
    quantity                = Column(Integer, nullable=False)
    mrp                     = Column(Numeric(10, 2), nullable=False)
    # cost_price is the S.Rate: the PRE-TAX (ex-GST), PRE-discount price of ONE
    # unit, exactly as the distributor's rate card states it.  Optional only for
    # historical rows; the Add Stock form now requires it.
    #
    # ⚠ FOUR decimal places, not two.  A ₹86.10 strip of 15 tablets is ₹5.74/unit;
    # rounded to paise and multiplied back up over 150 units the invoice drifts
    # by nearly a rupee.  Line totals below stay at paise — that IS the money.
    cost_price              = Column(Numeric(12, 4), nullable=True)
    # --- What we actually PAY the supplier ----------------------------------
    # A distributor's invoice takes the trade discount off the rate FIRST, then
    # charges GST on what is left.  So the money that leaves the till is the
    # discounted goods value plus tax on that.  The figures are kept apart:
    #   effective_cost  → profit margin maths (ex-GST, post-discount, per unit)
    #   gst_on_purchase → the tax we paid ON THIS LINE; NOT recoverable if the
    #                     stock expires and goes back, so it drives expiry loss
    #   total_cost      → goods + GST for the line; what supplier credit uses
    # gst_on_purchase and total_cost are LINE totals (whole delivery of this
    # medicine), not per-unit prices.
    gst_on_purchase         = Column(Numeric(12, 2), default=0)
    total_cost              = Column(Numeric(12, 2), default=0)
    # --- Supplier discount --------------------------------------------------
    # Distributors often knock money off the rate card: "5% trade discount" or
    # a flat "₹30 off per strip".  Both forms end up as the SAME thing — a lower
    # real cost per unit — so we store the discount in both shapes plus the
    # resulting cost, and let every downstream calculation read effective_cost.
    #   discount_percent → e.g. 5.00 for 5%; 0 when the discount was flat ₹
    #   discount_amount  → the discount in ₹ PER UNIT (never per strip — the
    #                      frontend divides by units_per_strip before sending,
    #                      exactly as it already does for cost_price)
    #   effective_cost   → cost_price − discount_amount, per unit, EX-GST.  This
    #                      is the post-discount price the supplier then charges
    #                      GST on, and the figure that drives profit margin,
    #                      expiry loss and supplier-return value.
    # Historical rows have NULL effective_cost, which every reader treats as
    # "no discount" and falls back to cost_price.
    # 4dp for the same reason as cost_price: 5% off ₹86.10 is ₹4.305, and half a
    # paisa per unit is a real rupee once you multiply by a delivery.
    discount_percent        = Column(Numeric(5, 2), default=0)
    discount_amount         = Column(Numeric(12, 4), default=0)
    effective_cost          = Column(Numeric(12, 4), nullable=True)
    # --- Bonus / scheme purchase (Feature B) --------------------------------
    # Mirrors the batch's scheme so Purchase History can show "50 paid + 10
    # bonus = 60 total" without joining back to the batch.  quantity above is
    # the PAID quantity; bonus_quantity is the free units on top of it.
    scheme_label            = Column(String, nullable=True)
    bonus_quantity          = Column(Integer, default=0)
    created_by              = Column(Integer, ForeignKey("users.id"))
    created_at              = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    # Convenience relationships so a single query can resolve display names.
    product  = relationship("Product")
    batch    = relationship("Batch")
    supplier = relationship("Supplier")


class StockMovement(Base):
    """
    Maps to the 'stock_movements' table.

    Every time stock changes — purchase in, sale out, return, adjustment —
    we write one row here.  This is the immutable audit trail.  We NEVER
    change stock silently; there must always be a matching movement row.

    movement_type values: 'IN', 'SALE', 'RETURN', 'ADJUST', 'EXPIRED'
    quantity: positive = stock coming IN, negative = stock going OUT
    """
    __tablename__ = "stock_movements"

    id            = Column(Integer, primary_key=True, index=True)
    batch_id      = Column(Integer, ForeignKey("batches.id"), nullable=False)
    movement_type = Column(String(20), nullable=False)
    quantity      = Column(Integer, nullable=False)
    reference     = Column(String(80))   # e.g. an invoice number or "PURCHASE"
    user_id       = Column(Integer, ForeignKey("users.id"))
    created_at    = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    batch = relationship("Batch", back_populates="movements")
