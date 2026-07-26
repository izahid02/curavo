"""
Seed script — inserts 10 realistic Indian pharmacy medicines into the
SQLite database used by the desktop app.

Each medicine gets:
  • a Product row (identity: name, category, GST, HSN)
  • a Batch row   (physical stock: qty, MRP, expiry)
  • a StockMovement row (type IN, for audit trail)

Run with:
    cd backend
    source venv/bin/activate      # mac
    python seed_medicines.py

Safe to re-run — skips any product whose name already exists.
"""
import sys
from datetime import date, datetime
from decimal import Decimal

# Make sure 'app' is importable from the backend directory
sys.path.insert(0, ".")

from app.database import SessionLocal, init_db
from app.models.inventory import Batch, Category, Product, StockMovement


# ─── Medicine definitions ────────────────────────────────────────────────────
#
# Each entry is a dict with:
#   name          → full display name (must match the format used at the counter)
#   generic_name  → INN name used by the drug-interaction checker
#   category      → therapeutic class (created if not in DB)
#   hsn_code      → for GST invoicing
#   gst_rate      → percentage (12 for most medicines)
#   unit          → dispensing unit
#   min_stock     → trigger low-stock alert below this quantity
#   batch         → dict describing the opening stock delivery
#
MEDICINES = [
    {
        "name":         "Amoxicillin Capsule 500mg",
        "generic_name": "amoxicillin",
        "category":     "Antibiotic",
        "hsn_code":     "30041099",
        "gst_rate":     Decimal("12"),
        "unit":         "capsule",
        "min_stock":    20,
        "batch": {
            "batch_number":    "AMX-001",
            "qty":             100,
            "mrp":             Decimal("85.00"),
            "expiry":          date(2026, 12, 31),
        },
    },
    {
        "name":         "Paracetamol Tablet 500mg",
        "generic_name": "paracetamol",
        "category":     "Analgesic",
        "hsn_code":     "30049099",
        "gst_rate":     Decimal("12"),
        "unit":         "tablet",
        "min_stock":    30,
        "batch": {
            "batch_number":    "PCT-001",
            "qty":             200,
            "mrp":             Decimal("22.00"),
            "expiry":          date(2026, 10, 31),
        },
    },
    {
        "name":         "Metformin Tablet 500mg",
        "generic_name": "metformin",
        "category":     "Antidiabetic",
        "hsn_code":     "30049099",
        "gst_rate":     Decimal("12"),
        "unit":         "tablet",
        "min_stock":    20,
        "batch": {
            "batch_number":    "MET-001",
            "qty":             150,
            "mrp":             Decimal("45.00"),
            "expiry":          date(2026, 8, 31),
        },
    },
    {
        "name":         "Amlodipine Tablet 5mg",
        "generic_name": "amlodipine",
        "category":     "Antihypertensive",
        "hsn_code":     "30049099",
        "gst_rate":     Decimal("12"),
        "unit":         "tablet",
        "min_stock":    15,
        "batch": {
            "batch_number":    "AML-001",
            "qty":             80,
            "mrp":             Decimal("120.00"),
            "expiry":          date(2026, 11, 30),
        },
    },
    {
        "name":         "Atorvastatin Tablet 10mg",
        "generic_name": "atorvastatin",
        "category":     "Antilipidemic",
        "hsn_code":     "30049099",
        "gst_rate":     Decimal("12"),
        "unit":         "tablet",
        "min_stock":    10,
        "batch": {
            "batch_number":    "ATV-001",
            "qty":             60,
            "mrp":             Decimal("95.00"),
            "expiry":          date(2026, 9, 30),
        },
    },
    {
        "name":         "Omeprazole Capsule 20mg",
        "generic_name": "omeprazole",
        "category":     "Antacid",
        "hsn_code":     "30049099",
        "gst_rate":     Decimal("12"),
        "unit":         "capsule",
        "min_stock":    20,
        "batch": {
            "batch_number":    "OMP-001",
            "qty":             120,
            "mrp":             Decimal("55.00"),
            "expiry":          date(2026, 7, 31),
        },
    },
    {
        "name":         "Warfarin Tablet 5mg",
        "generic_name": "warfarin",
        "category":     "Anticoagulant",
        "hsn_code":     "30049099",
        "gst_rate":     Decimal("12"),
        "unit":         "tablet",
        "min_stock":    5,
        "batch": {
            "batch_number":    "WAR-001",
            "qty":             30,
            "mrp":             Decimal("180.00"),
            "expiry":          date(2026, 6, 30),
        },
    },
    {
        "name":         "Aspirin Tablet 75mg",
        "generic_name": "aspirin",
        "category":     "Antiplatelet",
        "hsn_code":     "30049099",
        "gst_rate":     Decimal("12"),
        "unit":         "tablet",
        "min_stock":    15,
        "batch": {
            "batch_number":    "ASP-001",
            "qty":             90,
            "mrp":             Decimal("35.00"),
            "expiry":          date(2026, 8, 31),
        },
    },
    {
        "name":         "Clopidogrel Tablet 75mg",
        "generic_name": "clopidogrel",
        "category":     "Antiplatelet",
        "hsn_code":     "30049099",
        "gst_rate":     Decimal("12"),
        "unit":         "tablet",
        "min_stock":    10,
        "batch": {
            "batch_number":    "CLO-001",
            "qty":             45,
            "mrp":             Decimal("210.00"),
            "expiry":          date(2026, 10, 31),
        },
    },
    {
        "name":         "Ciprofloxacin Tablet 500mg",
        "generic_name": "ciprofloxacin",
        "category":     "Antibiotic",
        "hsn_code":     "30041099",
        "gst_rate":     Decimal("12"),
        "unit":         "tablet",
        "min_stock":    15,
        "batch": {
            "batch_number":    "CIP-001",
            "qty":             75,
            "mrp":             Decimal("140.00"),
            "expiry":          date(2026, 9, 30),
        },
    },
]


# ─── Helpers ─────────────────────────────────────────────────────────────────

def get_or_create_category(db, name: str) -> Category:
    """Return existing category by name, or create it if it doesn't exist."""
    cat = db.query(Category).filter(Category.name == name).first()
    if cat:
        return cat
    cat = Category(name=name)
    db.add(cat)
    db.flush()   # assigns cat.id before we use it on Product
    print(f"  + Created category: {name}")
    return cat


def selling_price_from_mrp(mrp: Decimal) -> Decimal:
    """
    Selling price = MRP for most OTC medicines (standard Indian retail practice).
    Returns the same value, stored as the per-unit selling price.
    """
    return mrp


def purchase_price_from_mrp(mrp: Decimal) -> Decimal:
    """
    Approximate purchase price = 72% of MRP.
    This is a rough trade-margin estimate — real prices come from GRN.
    Rounded to 2 decimal places.
    """
    return (mrp * Decimal("0.72")).quantize(Decimal("0.01"))


# ─── Main seed function ──────────────────────────────────────────────────────

def seed():
    # Create tables if they don't exist yet (no-op on an existing DB)
    init_db()

    db = SessionLocal()
    products_created = 0
    batches_created  = 0

    try:
        for med in MEDICINES:
            # Skip if a product with this exact name already exists
            existing = db.query(Product).filter(Product.name == med["name"]).first()
            if existing:
                print(f"  ⏭  Skipping (already exists): {med['name']}")
                continue

            # Get or create the therapeutic category
            category = get_or_create_category(db, med["category"])

            # ── 1. Create Product ──────────────────────────────────────────
            product = Product(
                name=med["name"],
                generic_name=med["generic_name"],
                category_id=category.id,
                hsn_code=med["hsn_code"],
                gst_rate=med["gst_rate"],
                unit=med["unit"],
                min_stock_level=med["min_stock"],
                is_active=True,
            )
            db.add(product)
            db.flush()   # get product.id before linking batch
            products_created += 1

            # ── 2. Create Batch (opening stock) ───────────────────────────
            b = med["batch"]
            mrp            = b["mrp"]
            selling_price  = selling_price_from_mrp(mrp)
            purchase_price = purchase_price_from_mrp(mrp)

            batch = Batch(
                product_id=product.id,
                batch_number=b["batch_number"],
                mrp=mrp,
                purchase_price=purchase_price,
                selling_price=selling_price,
                expiry_date=b["expiry"],
                # mfg_date is optional — leave None for seed data
                quantity_received=b["qty"],
                quantity_available=b["qty"],
            )
            db.add(batch)
            db.flush()   # get batch.id before writing movement
            batches_created += 1

            # ── 3. Stock movement (audit trail for the opening stock) ─────
            movement = StockMovement(
                batch_id=batch.id,
                movement_type="IN",
                quantity=b["qty"],
                reference="SEED",          # marks it as initial seed data
            )
            db.add(movement)

            print(
                f"  ✅ {med['name']:<38}  "
                f"qty={b['qty']:>3}  MRP=₹{mrp:<7}  exp={b['expiry']}"
            )

        # Commit all inserts in one transaction
        db.commit()

    except Exception as exc:
        db.rollback()
        print(f"\n❌ ERROR — transaction rolled back: {exc}")
        raise
    finally:
        db.close()

    print(f"\n{'─'*60}")
    print(f"  Products created : {products_created}")
    print(f"  Batches created  : {batches_created}")
    print(f"{'─'*60}")


if __name__ == "__main__":
    print("\n🌱  Seeding medicines into the HCC pharmacy database...\n")
    seed()
    print("\n✅  Done.\n")
