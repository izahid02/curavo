"""
Opening stock from Excel - the medicines and stock a shop already has on its
shelves when it moves to Curavo (from Marg, another program, or a notebook).

Decided Nov 2026: template-based.  The owner downloads OUR template
(Medicines -> Import from Excel), fills one row per BATCH, and uploads it.
Curavo checks every row first and shows OK / warning / problem in plain words;
nothing is saved until the owner presses Import, and rows with a problem are
skipped, never guessed.  A backup is taken right before the import.

THE SAME RULES AS ADD STOCK (CLAUDE.md section 4):
  * Stock is stored in UNITS.  For a strip medicine the sheet says strips
    (+ loose tablets) and per-STRIP prices; we multiply/divide here.
  * Per-unit prices keep 4 decimals (a Rs 100 strip of 15 = Rs 6.6667 a tablet).
  * MRP includes GST; selling price = MRP.  Cost is the price BEFORE GST.
  * Every batch gets a StockMovement 'IN' (reference OPENING-IMPORT).
  * Expired stock is refused; stock inside BILLING_MIN_EXPIRY_DAYS is imported
    with a warning (it exists, but cannot be billed).

What opening stock does NOT do: it creates no StockPurchase row and no
supplier credit.  It is not a new delivery and nobody is owed money for it.

Existing medicines (same name, any case) get the new batch added; their
identity (type, tablets per strip, GST...) is never changed by an import.
A batch number already in stock for that medicine is refused, so uploading
the same file twice cannot double the stock.  A blank batch number becomes
OPEN-<YYMM of expiry>, which keeps that rule working too.

Schedule H1 is NOT set from a spreadsheet (a register built from guesses is
worse than none): the result says how many imported medicines may be H1, for
the owner to confirm in Medicines -> Register check.
"""
import calendar
import io
import re
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.inventory import Batch, Product, StockMovement
from app.services.inventory_service import BILLING_MIN_EXPIRY_DAYS

MAX_ROWS = 5000
SHEET_NAME = "Medicines"
GST_RATES = {Decimal(x) for x in ("0", "5", "12", "18", "28", "40")}
TYPES = ["Tablet", "Capsule", "Syrup", "Injection", "Drops", "Cream", "Ointment",
         "Powder", "Inhaler", "Suppository", "Other"]
STRIP_TYPES = {"TABLET", "CAPSULE"}
_UNIT = Decimal("0.0001")
_PAISE = Decimal("0.01")

# The template's columns, in order.  key -> (heading, help text, other headings we accept)
COLUMNS = [
    ("name",     "Medicine name *",   "As printed on the pack, e.g. DOLO 650 TAB", ["item name", "product", "product name", "medicine", "item"]),
    ("type",     "Type *",            "Tablet, Capsule, Syrup, Injection, Drops, Cream, Ointment, Powder, Inhaler, Suppository or Other", ["form", "medicine type"]),
    ("per_strip", "Tablets per strip", "Only for tablets/capsules sold in strips, e.g. 15. Leave empty if sold one by one", ["units per strip", "per strip", "strip size", "pack size", "pack"]),
    ("qty",      "Quantity *",        "Strips for a strip medicine, otherwise pieces (bottles, tubes...)", ["qty", "stock", "closing stock", "strips"]),
    ("loose",    "Loose tablets",     "Extra tablets from an opened strip (strip medicines only)", ["loose", "loose qty"]),
    ("mrp",      "MRP *",             "Per strip for a strip medicine, otherwise per piece. Includes GST", ["mrp per strip", "m.r.p", "m.r.p."]),
    ("cost",     "Cost price",        "What you paid per strip / piece, BEFORE GST (after the trade discount)", ["purchase rate", "purchase price", "rate", "cost", "p.rate"]),
    ("gst",      "GST % *",           "0, 5, 12, 18, 28 or 40", ["gst", "gst%", "tax", "tax %", "gst rate"]),
    ("batch",    "Batch no.",         "As printed on the pack. Leave empty if you don't know it", ["batch", "batch no", "batch number"]),
    ("expiry",   "Expiry (MM/YYYY) *", "e.g. 12/2027", ["expiry", "exp", "exp date", "expiry date"]),
    ("generic",  "Generic name",      "The salt, e.g. Paracetamol 650mg. Helps search and the Schedule H1 check", ["salt", "composition", "generic"]),
    ("maker",    "Manufacturer",      "e.g. Micro Labs", ["company", "mfr", "manufacturer name", "mfg"]),
    ("hsn",      "HSN code",          "e.g. 30049099", ["hsn", "hsn/sac"]),
    ("rack",     "Rack",              "Where it sits in the shop, e.g. A3", ["rack location", "location", "shelf"]),
    ("barcode",  "Barcode",           "If the pack has one", ["ean", "bar code"]),
]


def _norm(h) -> str:
    return re.sub(r"[^a-z0-9%.]+", " ", str(h or "").lower().replace("*", "")).strip()


_HEADINGS = {}
for _key, _head, _help, _alts in COLUMNS:
    for _h in [_head, _head.split("(")[0]] + _alts:
        _HEADINGS[_norm(_h)] = _key


# ---------------------------------------------------------------------------
# The template
# ---------------------------------------------------------------------------

def template_bytes() -> bytes:
    """The .xlsx the owner fills in: a blank Medicines sheet, a How to fill sheet and an Example."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.worksheet.datavalidation import DataValidation

    wb = Workbook()
    ws = wb.active
    ws.title = SHEET_NAME
    head_fill = PatternFill("solid", fgColor="E0E7FF")
    for i, (_k, head, _help, _a) in enumerate(COLUMNS, start=1):
        c = ws.cell(row=1, column=i, value=head)
        c.font = Font(bold=True)
        c.fill = head_fill
        c.alignment = Alignment(wrap_text=True, vertical="center")
        ws.column_dimensions[c.column_letter].width = max(14, min(32, len(head) + 6))
    ws.row_dimensions[1].height = 30
    ws.freeze_panes = "A2"
    dv = DataValidation(type="list", formula1='"' + ",".join(TYPES) + '"', allow_blank=True)
    dv.error, dv.errorTitle = "Choose a type from the list.", "Type"
    ws.add_data_validation(dv)
    dv.add(f"B2:B{MAX_ROWS + 1}")
    # Expiry as text, so Excel does not turn 12/2027 into a date in another format.
    for r in range(2, 502):
        ws.cell(row=r, column=10).number_format = "@"

    how = wb.create_sheet("How to fill")
    how.column_dimensions["A"].width = 24
    how.column_dimensions["B"].width = 90
    lines = [
        ("Curavo opening stock", ""),
        ("", "Fill the Medicines sheet: ONE ROW PER BATCH. The same medicine with two batches = two rows."),
        ("", "Columns marked * are needed. Do not rename or move the column headings."),
        ("", "Strip medicines: Quantity = full strips, MRP and Cost = per STRIP. Curavo works out the per-tablet figures."),
        ("", "Everything else (syrups, tubes, injections...): Quantity = pieces, MRP and Cost = per piece."),
        ("", "Nothing is saved until you press Import. Curavo first shows every row as OK, warning or problem."),
        ("", "Expired stock is not imported. A medicine already in Curavo gets the new batch added."),
        ("", ""),
        ("Column", "What to type"),
    ] + [(head, help_) for _k, head, help_, _a in COLUMNS]
    for r, (a, b) in enumerate(lines, start=1):
        how.cell(row=r, column=1, value=a)
        how.cell(row=r, column=2, value=b).alignment = Alignment(wrap_text=True)
    how["A1"].font = Font(bold=True, size=14)
    how.cell(row=9, column=1).font = Font(bold=True)
    how.cell(row=9, column=2).font = Font(bold=True)

    ex = wb.create_sheet("Example")
    rows = [
        [h for _k, h, _x, _a in COLUMNS],
        ["DOLO 650 TAB", "Tablet", 15, 12, 7, 32.12, 24.86, 5, "DL2611", "08/2027", "Paracetamol 650mg", "Micro Labs", "30049099", "A3", ""],
        ["COLIZA LIQUID", "Drops", "", 6, "", 99.00, 81.80, 5, "CZ9012", "03/2027", "Simethicone + Dill oil", "", "30049099", "C1", ""],
    ]
    for r, vals in enumerate(rows, start=1):
        for cidx, v in enumerate(vals, start=1):
            ex.cell(row=r, column=cidx, value=v)
    for cidx in range(1, len(COLUMNS) + 1):
        ex.cell(row=1, column=cidx).font = Font(bold=True)
        ex.column_dimensions[ex.cell(row=1, column=cidx).column_letter].width = 16
    ex.cell(row=5, column=1, value="This sheet is only an example and is never imported.").font = Font(italic=True)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Reading and checking
# ---------------------------------------------------------------------------

class ImportFileError(ValueError):
    """The file as a whole cannot be read (not Excel, no headings...)."""


def _read_rows(content: bytes) -> list:
    from openpyxl import load_workbook
    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except Exception:
        raise ImportFileError("This is not an Excel file Curavo can read. Save it as .xlsx and try again.")
    ws = wb[SHEET_NAME] if SHEET_NAME in wb.sheetnames else wb.worksheets[0]
    if ws.title in ("How to fill", "Example"):
        raise ImportFileError("Put your medicines on the 'Medicines' sheet of the template.")
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        raise ImportFileError("The sheet is empty.")
    header_at, cols = None, {}
    for i, r in enumerate(rows[:10]):           # the heading row may not be the very first
        found = {}
        for j, v in enumerate(r or ()):
            key = _HEADINGS.get(_norm(v))
            if key and key not in found:
                found[key] = j
        if "name" in found and "qty" in found:
            header_at, cols = i, found
            break
    if header_at is None:
        raise ImportFileError("Could not find the column headings. Use the Curavo template and keep its first row.")
    missing = [head for k, head, _h, _a in COLUMNS if head.endswith("*") and k not in cols]
    if missing:
        raise ImportFileError("These columns are missing: " + ", ".join(m.rstrip(" *") for m in missing) + ".")
    out = []
    for n, r in enumerate(rows[header_at + 1:], start=header_at + 2):
        vals = {k: (r[j] if r is not None and j < len(r) else None) for k, j in cols.items()}
        if all(v is None or str(v).strip() == "" for v in vals.values()):
            continue
        out.append((n, vals))
        if len(out) > MAX_ROWS:
            raise ImportFileError(f"At most {MAX_ROWS} rows at a time. Split the file and import it in parts.")
    if not out:
        raise ImportFileError("No medicines found under the headings.")
    return out


def _text(v, limit) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()[:limit]


def _dec(v):
    if v is None or str(v).strip() == "":
        return None
    try:
        d = Decimal(str(v).replace(",", "").replace("₹", "").replace("Rs", "").strip())
    except InvalidOperation:
        raise ValueError
    if d.is_nan() or d.is_infinite():
        raise ValueError
    return d


_MONTHS = {m.lower(): i for i, m in enumerate(calendar.month_abbr) if m}


def parse_expiry(v) -> date:
    """12/2027, 12-27, Dec-2027, 2027-12 or an Excel date -> the LAST day of that month."""
    if isinstance(v, (datetime, date)):
        y, m = v.year, v.month
    else:
        t = str(v or "").strip().lower()
        mm = re.fullmatch(r"(\d{1,2})\s*[/\-. ]\s*(\d{2}|\d{4})", t)
        mm2 = re.fullmatch(r"(\d{4})\s*[/\-. ]\s*(\d{1,2})(?:[/\-. ]\d{1,2})?", t)
        mm3 = re.fullmatch(r"([a-z]{3})[a-z]*\s*[/\-. ]?\s*(\d{2}|\d{4})", t)
        if mm:
            m, y = int(mm.group(1)), int(mm.group(2))
        elif mm2:
            y, m = int(mm2.group(1)), int(mm2.group(2))
        elif mm3 and mm3.group(1) in _MONTHS:
            m, y = _MONTHS[mm3.group(1)], int(mm3.group(2))
        else:
            raise ValueError
        if y < 100:
            y += 2000
    if not (1 <= m <= 12) or not (2000 <= y <= 2100):
        raise ValueError
    return date(y, m, calendar.monthrange(y, m)[1])


def check_rows(db: Session, content: bytes) -> list:
    """
    Every row, checked.  Each: {row, name, status: ok|warning|error, messages[],
    and - when not error - the values to import ("plan")}.
    """
    rows = _read_rows(content)
    today = date.today()
    existing = {p.name.strip().lower(): p for p in db.query(Product).filter(Product.is_active.is_(True)).all()}
    new_in_file = {}        # lower name -> (type, per_strip, gst) of the first row that creates it
    seen_batches = set()    # (lower name, batch) within this file
    out = []
    for n, v in rows:
        msgs, warns = [], []
        name = _text(v.get("name"), 150)
        if not name:
            msgs.append("The medicine name is empty.")
        typ = _text(v.get("type"), 20).upper() or None
        if typ is None:
            msgs.append("Type is empty (Tablet, Capsule, Syrup...).")
        elif typ not in {t.upper() for t in TYPES}:
            msgs.append(f"Unknown type \"{_text(v.get('type'), 20)}\". Use one from the list.")
        # Numbers
        def num(key, label, required=False):
            try:
                d = _dec(v.get(key))
            except ValueError:
                msgs.append(f"{label} is not a number.")
                return None
            if d is None and required:
                msgs.append(f"{label} is empty.")
            return d
        per_strip = num("per_strip", "Tablets per strip")
        qty = num("qty", "Quantity", required=True)
        loose = num("loose", "Loose tablets")
        mrp = num("mrp", "MRP", required=True)
        cost = num("cost", "Cost price")
        gst = num("gst", "GST %", required=True)
        if gst is not None and gst < 1 and gst > 0:
            gst = gst * 100                          # 0.05 typed as a fraction -> 5
        is_strip = per_strip is not None and per_strip > 0
        if per_strip is not None and (per_strip != per_strip.to_integral_value() or per_strip <= 0):
            msgs.append("Tablets per strip must be a whole number, e.g. 10 or 15.")
            is_strip = False
        if is_strip and typ and typ not in STRIP_TYPES:
            msgs.append("Only tablets and capsules come in strips. Leave 'Tablets per strip' empty for this type.")
        if qty is not None and (qty < 0 or qty != qty.to_integral_value()):
            msgs.append("Quantity must be a whole number (strips or pieces).")
        if loose is not None and (loose < 0 or loose != loose.to_integral_value()):
            msgs.append("Loose tablets must be a whole number.")
        if loose and not is_strip:
            msgs.append("Loose tablets only make sense for a strip medicine.")
        if mrp is not None and mrp <= 0:
            msgs.append("MRP must be more than 0.")
        if cost is not None and cost < 0:
            msgs.append("Cost price cannot be negative.")
        if gst is not None and gst not in GST_RATES:
            msgs.append("GST % must be 0, 5, 12, 18, 28 or 40.")
        units = None
        if qty is not None and not msgs:
            units = int(qty) * (int(per_strip) if is_strip else 1) + (int(loose or 0) if is_strip else 0)
            if units <= 0:
                msgs.append("The quantity is 0: nothing to import.")
        # Expiry
        expiry = None
        if v.get("expiry") is None or str(v.get("expiry")).strip() == "":
            msgs.append("Expiry is empty (MM/YYYY).")
        else:
            try:
                expiry = parse_expiry(v.get("expiry"))
            except ValueError:
                msgs.append(f"Expiry \"{_text(v.get('expiry'), 20)}\" is not a month and year, e.g. 12/2027.")
        if expiry is not None:
            if expiry < today:
                msgs.append("Already expired: not imported. Return it to the supplier instead.")
            elif expiry < today + timedelta(days=BILLING_MIN_EXPIRY_DAYS):
                warns.append(f"Expires within {BILLING_MIN_EXPIRY_DAYS} days: it is imported but cannot be billed.")
        # Same medicine already in Curavo / earlier in this file
        key = name.lower()
        prod = existing.get(key)
        if prod is not None and not msgs:
            p_strip = bool(prod.is_strip and prod.units_per_strip)
            if p_strip != is_strip or (is_strip and int(prod.units_per_strip) != int(per_strip)):
                have = f"{prod.units_per_strip} per strip" if p_strip else "sold one by one"
                msgs.append(f"Already in Curavo as {have}. Make the row match, or rename the medicine.")
            elif gst is not None and Decimal(prod.gst_rate) != gst:
                warns.append(f"Already in Curavo with GST {Decimal(prod.gst_rate).normalize()}%; that stays.")
        elif prod is None and name and not msgs:
            first = new_in_file.get(key)
            if first is None:
                new_in_file[key] = (typ, int(per_strip) if is_strip else None, gst)
            elif first[1] != (int(per_strip) if is_strip else None):
                msgs.append("The same medicine appears above with a different 'Tablets per strip'.")
        # Batch
        batch = _text(v.get("batch"), 60).upper()
        if not batch and expiry is not None:
            batch = f"OPEN-{expiry:%y%m}"
            warns.append(f"No batch number: saved as {batch}.")
        if batch and name and not msgs:
            if (key, batch) in seen_batches:
                msgs.append(f"Batch {batch} of this medicine is already on another row. Put it on one row.")
            elif prod is not None and db.query(Batch.id).filter(Batch.product_id == prod.id,
                                                                Batch.batch_number == batch).first():
                msgs.append(f"Batch {batch} is already in stock (imported before?). Use Add Stock to add more.")
            seen_batches.add((key, batch))
        # Prices per unit (4 dp) - the same arithmetic Add Stock does
        plan = None
        if not msgs:
            per = Decimal(int(per_strip)) if is_strip else Decimal(1)
            unit_mrp = (mrp / per).quantize(_UNIT)
            unit_cost = (cost / per).quantize(_UNIT) if cost is not None else Decimal("0")
            if cost is None:
                warns.append("No cost price: profit on this stock will show as 100%.")
            else:
                mrp_ex = mrp * Decimal(100) / (Decimal(100) + gst)
                if cost > mrp_ex:
                    warns.append("Cost is higher than the price before GST: this stock sells at a loss.")
            plan = {
                "name": name, "type": typ, "is_strip": is_strip, "per_strip": int(per_strip) if is_strip else None,
                "units": units, "strip_mrp": mrp.quantize(_PAISE) if is_strip else None,
                "unit_mrp": unit_mrp, "unit_cost": unit_cost, "gst": gst, "batch": batch, "expiry": expiry,
                "generic": _text(v.get("generic"), 150) or None, "maker": _text(v.get("maker"), 120) or None,
                "hsn": re.sub(r"\D", "", _text(v.get("hsn"), 20))[:10] or None,
                "rack": _text(v.get("rack"), 50) or None, "barcode": _text(v.get("barcode"), 64) or None,
                "existing_id": prod.id if prod is not None else None,
            }
        out.append({"row": n, "name": name or "(no name)",
                    "status": "error" if msgs else ("warning" if warns else "ok"),
                    "messages": msgs + warns, "plan": plan,
                    "summary": None if plan is None else _describe(plan)})
    return out


def _describe(p) -> str:
    if p["is_strip"]:
        strips, loose = divmod(p["units"], p["per_strip"])
        q = f"{strips} strip{'s' if strips != 1 else ''}" + (f" + {loose} loose" if loose else "") + f" ({p['units']} tablets)"
        price = f"MRP Rs {p['strip_mrp']}/strip"
    else:
        q = f"{p['units']} piece{'s' if p['units'] != 1 else ''}"
        price = f"MRP Rs {p['unit_mrp'].quantize(_PAISE)}"
    return f"{q} · {price} · batch {p['batch']} · exp {p['expiry']:%m/%Y}"


# ---------------------------------------------------------------------------
# Importing
# ---------------------------------------------------------------------------

def import_rows(db: Session, checked: list, user_id: int) -> dict:
    """Save every row that passed (ok or warning) in ONE transaction. The caller has taken a backup."""
    from app.services.drug_schedules import match_schedule_h1
    made, batches, units, maybe_h1 = {}, 0, 0, set()
    try:
        for r in checked:
            p = r["plan"]
            if r["status"] == "error" or p is None:
                continue
            key = p["name"].lower()
            prod = db.get(Product, p["existing_id"]) if p["existing_id"] else made.get(key)
            if prod is None:
                prod = Product(
                    name=p["name"], generic_name=p["generic"], manufacturer=p["maker"], hsn_code=p["hsn"],
                    gst_rate=p["gst"], barcode=p["barcode"], rack_location=p["rack"],
                    medicine_type=p["type"], is_strip=p["is_strip"], units_per_strip=p["per_strip"],
                    strip_mrp=p["strip_mrp"], unit_mrp=p["unit_mrp"],
                    unit="tablet" if p["is_strip"] else "unit",
                )
                db.add(prod)
                db.flush()
                made[key] = prod
                if match_schedule_h1(p["generic"], p["name"]) is not None:
                    maybe_h1.add(prod.id)
            else:
                # Keep the product's own identity; only fill gaps the sheet can fill.
                for attr, val in (("generic_name", p["generic"]), ("manufacturer", p["maker"]), ("hsn_code", p["hsn"]),
                                  ("rack_location", p["rack"]), ("barcode", p["barcode"])):
                    if val and not getattr(prod, attr):
                        setattr(prod, attr, val)
                if prod.register_category is None and match_schedule_h1(prod.generic_name, prod.name) is not None:
                    maybe_h1.add(prod.id)
            # The newest delivery's price is what the product shows (Add Stock does the same).
            if p["is_strip"]:
                prod.strip_mrp = p["strip_mrp"]
            prod.unit_mrp = p["unit_mrp"]
            b = Batch(
                product_id=prod.id, supplier_id=None, batch_number=p["batch"],
                mrp=p["unit_mrp"], selling_price=p["unit_mrp"],       # GST is inside MRP
                purchase_price=p["unit_cost"], effective_cost_per_unit=p["unit_cost"],
                expiry_date=p["expiry"], quantity_received=p["units"], quantity_available=p["units"],
                paid_quantity=p["units"], bonus_quantity=0,
            )
            db.add(b)
            db.flush()
            db.add(StockMovement(batch_id=b.id, movement_type="IN", quantity=p["units"],
                                 reference="OPENING-IMPORT", user_id=user_id))
            batches += 1
            units += p["units"]
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"medicines_added": len(made), "batches_added": batches, "units_added": units,
            "skipped": sum(1 for r in checked if r["status"] == "error"), "maybe_schedule_h1": len(maybe_h1)}
