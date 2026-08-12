# CLAUDE.md — Health Care Centre ERP
> Single source of truth for Claude Code. Read fully before touching 
> anything. Follow conventions exactly. Ask before guessing.

---

## 1. What this project is

An offline-first Pharmacy ERP & OPD Management System for "Health Care 
Centre." Runs on a single local Windows PC at the pharmacy (no internet 
needed for core features). Developed on macOS, deployed on Windows — 
never use OS-specific paths in application code.

The person relaying instructions is a beginner. Write clear, 
well-commented code and explain decisions in plain English.

### Goals
- Day-to-day: inventory, billing/POS, patients, dashboard
- Later: suppliers, purchasing, reports, OPD, follow-ups, marketing, AI
- Must stay scalable for future cloud + multi-branch deployment

---

## 2. Tech stack (do not change without asking)

| Layer     | Choice                                          |
|-----------|-------------------------------------------------|
| Frontend  | React 18 + Vite + React Router + Axios          |
| Backend   | Python 3.14 · FastAPI · SQLAlchemy 2.x          |
| Database  | SQLite (single-file, offline desktop build)     |
| Auth      | JWT (python-jose) + bcrypt (direct, no passlib) |
| Fonts     | Outfit (Google Fonts) — weights 300–700         |
| AI (Ph 4) | Ollama + local LLM (natural-language only)      |
| Deploy    | Local Windows PC; Docker optional later         |

No CSS framework. Custom design system via CSS variables in 
frontend/src/styles/global.css. Do NOT add Tailwind/Bootstrap/MUI.

### Database note (IMPORTANT — read before touching the DB)
The running app uses **SQLite**, NOT PostgreSQL. backend/app/database.py
hardcodes the SQLite path and overrides the (stale) postgres default in
config.py. The whole database is one file:
  - macOS   : ~/Library/Application Support/HCC/pharmacy.db
  - Windows : %APPDATA%\HCC\pharmacy.db
              (= C:\Users\<user>\AppData\Roaming\HCC\)
⚠ ROAMING, NOT LOCAL.  This file said %LOCALAPPDATA% until Aug 2026 and that
was simply wrong — both database.py:get_app_data_dir() and main_desktop.py
read os.environ["APPDATA"].  Getting this wrong matters most during a customer
restore, when someone is looking for a backup in a folder that does not exist.
Prescription/avatar images live in sibling folders (kept out of the DB file
so it stays small), as do backups/ (see §11). PostgreSQL remains the Phase 5
cloud-migration target, but no local dev work touches Postgres today.

### Dependency notes (learned in Phase 1)
- passlib[bcrypt] is INCOMPATIBLE with bcrypt 5.x — we call bcrypt 
  directly in auth_service.py. Never reintroduce passlib.
- psycopg2-binary is only for the future PostgreSQL/cloud target (Phase 5);
  the local SQLite build does not need it.
- pydantic 2.13.4 + pydantic-settings 2.9.1 required for Python 3.14.
- These are already pinned in requirements.txt — do not downgrade.

### Frontend packages added in Phase 2
- jspdf + jspdf-autotable — PDF export in Reports page
- xlsx (SheetJS) — Excel export in Reports page

---

## 3. Repository layout
hcc-erp/
├── CLAUDE.md
├── README.md
├── database/
│   └── schema.sql              ← canonical DB schema (run once)
├── backend/
│   ├── requirements.txt        ← pinned, Python 3.14 compatible
│   ├── scripts/                ← verification scripts. ALL of them set
│   │                             HCC_DATA_DIR at a sandbox first — they never
│   │                             touch the live DB (test_migrations.py,
│   │                             check_purchase_totals.py,
│   │                             check_expenditure_summary.py, …)
│   ├── .env / .env.example
│   └── app/
│       ├── main.py             ← FastAPI app, router includes, startup seed
│       ├── config.py           ← settings from .env
│       ├── database.py         ← engine, SessionLocal, get_db
│       ├── models/
│       │   ├── settings.py     ← PharmacySettings (ONE row: shop name,
│       │   │                      tagline, address, phone, email, GSTIN, DL)
│       │   ├── user.py         ← User, Role (server_default for created_at)
│       │   ├── inventory.py    ← Product, Batch, StockMovement, StockPurchase,
│       │   │                      Category, Department, Supplier
│       │   │                      (Product carries the strip fields:
│       │   │                       medicine_type, is_strip, units_per_strip,
│       │   │                       strip_mrp, unit_mrp)
│       │   ├── supplier_credit.py ← SupplierCreditAccount,
│       │   │                      SupplierCreditTransaction,
│       │   │                      SupplierPaymentReminder, SupplierReturn,
│       │   │                      HomeVisitCharge
│       │   ├── credit.py       ← CreditAccount, CreditTransaction,
│       │   │                      CreditReminder (PATIENT side — do not
│       │   │                      confuse with supplier_credit.py)
│       │   ├── billing.py      ← Invoice, InvoiceItem, AuditLog, DocCounter
│       │   │                      (Invoice carries home_visit_charge/notes;
│       │   │                       InvoiceItem carries returned_qty/is_returned
│       │   │                       for PARTIAL returns)
│       │   ├── patients.py     ← Patient, PatientDepartment, Tag, PatientTag
│       │   ├── purchasing.py   ← PurchaseOrder, PurchaseOrderItem,
│       │   │                      GoodsReceiptNote, GRNItem
│       │   ├── opd.py          ← Doctor, OPDVisit
│       │   ├── followup.py     ← MessageTemplate, FollowUpSchedule,
│       │   │                      MessageQueue, PatientResponse
│       │   └── marketing.py    ← Campaign, CampaignFilter,
│       │                          CampaignMessage, CampaignRecipient
│       ├── schemas/
│       │   ├── auth.py         ← LoginRequest, TokenResponse, UserInfo,
│       │   │                      LoginResponse
│       │   ├── inventory.py    ← CategoryOut, DepartmentOut,
│       │   │                      ProductCreate/Update/Out/ListItem,
│       │   │                      BatchReceive/Out, StockMovementOut
│       │   ├── billing.py      ← BillItem, CreateInvoiceRequest,
│       │   │                      InvoiceItemOut, InvoiceOut, ReturnRequest
│       │   ├── patients.py     ← TagOut, PatientCreate/Update/Out/ListItem
│       │   ├── suppliers.py    ← SupplierCreate, SupplierUpdate, SupplierOut
│       │   ├── purchasing.py   ← POCreate, POOut, POStatusUpdate,
│       │   │                      GRNCreate, GRNOut
│       │   ├── followup.py     ← FollowUpScheduleOut, MessageQueueOut,
│       │   │                      PatientResponseCreate/Out,
│       │   │                      FollowUpStatsOut, ResponseSummaryOut
│       │   └── marketing.py    ← CampaignFilterCreate,
│       │                          CampaignMessageCreate, CampaignCreate,
│       │                          CampaignOut, CampaignListItem,
│       │                          CampaignPreviewOut, CampaignRecipientOut
│       ├── routers/
│       │   ├── auth.py         ← POST /api/auth/login (username OR email),
│       │   │                      GET/PUT /api/auth/me, /me/profile
│       │   ├── settings.py     ← GET (public) / PUT /api/settings/pharmacy
│       │   ├── backup.py       ← /api/backup/* (4 endpoints, Owner/Admin only)
│       │   ├── inventory.py    ← /api/inventory/* (12 endpoints)
│       │   ├── billing.py      ← /api/billing/* (7 endpoints)
│       │   ├── patients.py     ← /api/patients/* (7 endpoints)
│       │   ├── dashboard.py    ← GET /api/dashboard/summary
│       │   ├── suppliers.py    ← /api/suppliers/* (5 endpoints)
│       │   ├── purchasing.py   ← /api/purchasing/orders/* (4 endpoints)
│       │   │                      /api/purchasing/grn/* (3 endpoints)
│       │   ├── reports.py      ← /api/reports/* (4 read-only endpoints)
│       │   ├── followup.py     ← /api/followup/* (13 endpoints)
│       │   └── marketing.py    ← /api/marketing/* (7 endpoints)
│       └── services/
│           ├── auth_service.py ← hash_password, verify_password,
│           │                      create_access_token, get_current_user
│           ├── inventory_service.py ← get_product_stock, get_expiry_status,
│           │                          receive_stock, get_low_stock_products,
│           │                          get_expiry_alerts
│           ├── billing_service.py   ← get_next_invoice_number (thread-safe),
│           │                          fefo_allocate, create_invoice,
│           │                          process_return
│           ├── patient_service.py  ← create_patient, update_patient,
│           │                          get_patient_with_stats,
│           │                          search_patients, get_purchase_history
│           ├── purchasing_service.py ← create_po, update_po_status,
│           │                           create_grn, build_po_out,
│           │                           build_grn_out, get_po_list,
│           │                           get_grn_list
│           ├── followup_service.py  ← schedule_follow_ups,
│           │                          queue_follow_up_messages,
│           │                          cancel_follow_ups,
│           │                          record_response
│           ├── revenue.py     ← net_invoice_amount_expr, sold_qty_expr,
│           │                      retained_line_total_expr — the ONE definition
│           │                      of "what actually stayed sold" after a
│           │                      partial return.  Every dashboard/report
│           │                      revenue figure goes through these.
│           ├── refill_service.py   ← schedule_refill_reminder,
│           │                          get_upcoming_refills
│           └── marketing_service.py ← get_filtered_patients,
│                                       preview_campaign,
│                                       create_campaign, queue_campaign,
│                                       list_campaigns, list_recipients
└── frontend/
    ├── index.html              ← Outfit font, favicon.svg link
    ├── package.json
    ├── vite.config.js          ← proxies /api → localhost:8000
    └── src/
        ├── main.jsx
        ├── App.jsx             ← all routes registered here
        ├── assets/
        │   └── logo.svg        ← green cross + ribbon SVG logo
        ├── lib/
        │   ├── api.js          ← axios instance, setAuthToken,
        │   │                      401 interceptor (excludes /auth/login)
        │   ├── pharmacy.jsx    ← PharmacyProvider / usePharmacy — the shop's
        │   │                      identity, fetched ONCE at app start and
        │   │                      shared by the sidebar, login card, receipt
        │   │                      and document.title.  Mounted OUTSIDE the
        │   │                      router in main.jsx (the login screen needs
        │   │                      it too).  Never null — falls back to
        │   │                      DEFAULT_PHARMACY so nothing renders blank.
        │   └── auth.js         ← saveToken, getToken, getUser,
        │                          clearAuth, isLoggedIn (sessionStorage)
        ├── components/
        │   ├── Layout.jsx      ← sidebar + topbar + outlet
        │   │                      (expiry alert count badge live).
        │   │                      Account menu: Edit Profile (incl. USERNAME),
        │   │                      Change Password, and Pharmacy Settings
        │   │                      (Owner/Administrator only).
        │   ├── inventory/MedicineBatchPanel.jsx
        │   │                    ← per-batch popover with margins, plus an
        │   │                      inline [✏ Edit] form per row (Owner/Admin).
        │   │                      Edits IN PLACE rather than opening a modal:
        │   │                      the panel is already a portal over a
        │   │                      backdrop-filter ancestor, and a third layer
        │   │                      is exactly the arrangement that paints
        │   │                      underneath (see §5 stacking-context note).
        │   └── ProtectedRoute.jsx ← redirects to /login if not logged in
        ├── pages/
        │   ├── Login.jsx       ← glass card, pulse logo, inline errors
        │   ├── Dashboard.jsx   ← live data, Indian INR format, greeting,
        │   │                      recent invoices + top products panels,
        │   │                      8 stat cards in a 2×4 grid (.stats-grid
        │   │                      in global.css — 4 cols, grid-auto-rows:1fr
        │   │                      so all 8 are the same height)
        │   ├── Inventory.jsx   ← Products / Add Stock / Purchase History tabs.
        │   │                      Purchase History is GROUPED BY DISTRIBUTOR:
        │   │                      one summary row per supplier, expanding to
        │   │                      their deliveries (lazily fetched — nothing
        │   │                      loads for suppliers nobody opened).
        │   │                      Add/Edit Medicine has the GST Rate dropdown
        │   │                      (0/5/12/18/28), defaulting to 5%.
        │   ├── ExpiryAlerts.jsx ← 3 collapsible sections (Expired / 30d / 60d),
│   │                      Return to Supplier on all three, discount column
        │   ├── Billing.jsx     ← two-panel POS, F2/Enter/F10 shortcuts,
        │   │                      receipt modal
        │   ├── InvoiceHistory.jsx ← paginated list; period tabs
        │   │                        [Today][Yesterday][This Week][This Month]
        │   │                        [All] (the SERVER resolves each window —
        │   │                        the page only sends the name); detail
        │   │                        modal with a per-item RETURN CHECKLIST
        │   │                        (tick lines, set qty, live refund preview)
        │   ├── Patients.jsx    ← list + register tabs, detail modal,
        │   │                      edit mode, purchase history
        │   ├── Suppliers.jsx   ← list + add form, edit modal,
        │   │                      delete guard (blocks if batches exist)
        │   ├── Purchasing.jsx  ← Purchase Orders tab + GRN tab,
        │   │                      PO status workflow, stock-in on GRN
        │   ├── Reports.jsx     ← 4 tabs (Sales/Inventory/Profit/Patient),
        │   │                      date range + presets, PDF + Excel export
        │   ├── FollowUps.jsx   ← 5 tabs: Due Today, Responses,
        │   │                      All Schedules, Message Queue,
        │   │                      Refill Reminders
        │   ├── Marketing.jsx   ← Campaigns + Create Campaign
        │   │                      (3-step form, filter builder,
        │   │                       bilingual editor)
        │   ├── Backup.jsx      ← every snapshot on this PC (automatic +
        │   │                      manual), Backup Now, download, delete.
        │   │                      Shows the backup FOLDER PATH in plain text
        │   │                      on purpose: if the app will not start, the
        │   │                      owner cannot reach this screen and needs to
        │   │                      find the files by hand (see §11)
        │   └── Placeholder.jsx ← used for unbuilt routes
        └── styles/
            └── global.css      ← full design system (see Section 5)

---

## 4. THE core domain model — read before writing any code

A medicine = TWO tables. Never collapse them.

**`products`** — identity: name, generic, brand, manufacturer, 
  category, department, HSN code, GST rate, barcode, rack, 
  min_stock_level. Nothing that changes per delivery.

**`batches`** — physical stock: one row per delivery, each with 
  batch_number, mrp, purchase_price, selling_price, mfg_date, 
  expiry_date, quantity_available. Stock quantity lives HERE.

Current stock of a product = SUM(quantity_available) across 
  non-expired batches for that product.

### Rules derived from this model

**FEFO (First Expiry First Out):** billing deducts from the batch 
  with the earliest expiry_date that has quantity_available > 0. 
  Split across batches if one cannot cover the full quantity.
  Implemented in billing_service.fefo_allocate().

**Expired stock cannot be sold.** fefo_allocate skips batches where 
  expiry_date < today. Enforce in service layer, not just UI.

**Profit is locked at sale time.** invoice_items.purchase_price 
  snapshots the batch's purchase_price. Later price changes do not 
  alter historical profit.

**Every stock change writes to stock_movements.**
  Types: IN / SALE / RETURN / ADJUST / EXPIRED
  Never mutate batch.quantity_available silently.

**Invoice numbers are sequential and gapless.**
  Format: HCC-YYYY-NNNNNN (e.g. HCC-2026-000001)
  Generated in billing_service.get_next_invoice_number() using 
  SELECT FOR UPDATE (thread-safe).

**Purchase Orders are documents only.** A PO does NOT change stock.
  Stock enters the system only when a GRN is created. Each GRN item
  creates one Batch + one StockMovement(type='IN').

**PO status lifecycle:**
  DRAFT → SENT → PARTIALLY_RECEIVED → RECEIVED
  Any status → CANCELLED (manual)
  PARTIALLY_RECEIVED and RECEIVED are set automatically by GRN creation.

**GST RULE: GST is inclusive in MRP.**
  gst_amount = line_total × rate / (100 + rate)
  taxable    = line_total − gst_amount
  total      = line_total  (= MRP × qty, unchanged)
  Never add GST on top of selling price.

**SUPPLIER RETURNS use the OPPOSITE GST formula — this is not a bug.**
  On a SALE, GST is extracted OUT of an inclusive MRP (formula above).
  On a supplier RETURN, purchase_price is the PRE-TAX cost we paid, and the
  GST charged on top of it cannot be reclaimed, so it is SUBTRACTED:
    gross_value      = return_quantity × purchase_price
    gst_deduction    = gross_value × (gst_rate / 100)
    net_return_value = gross_value − gst_deduction
  Worked example: 40 units × ₹35 = ₹1,400 gross, 12% → ₹168 lost, ₹1,232 net.
  Implemented in supplier_return_service.calculate_return_value().

**STRIP MEDICINES: stock is ALWAYS counted in individual UNITS.**
  A strip is a display/pricing convenience, never a storage unit.
    batch.quantity_available  → individual tablets
    products.units_per_strip  → how many tablets per strip (e.g. 10)
    products.strip_mrp        → price of a whole strip (e.g. ₹95)
    products.unit_mrp         → price of one tablet (₹9.50, auto = strip/units)
  The FRONTEND multiplies strips → units before any API call.  The backend
  never receives the word "strip".
  ⚠ CRITICAL: for a strip medicine, the batch MRP entered in Add Stock must be
  the PER-UNIT price (₹9.50), not the strip price (₹95).  Billing prices from
  batch.selling_price × units, so entering ₹95 there bills a strip at ₹950.
  Add Stock takes the STRIP price and derives the per-unit price itself — the
  per-unit field is read-only, so the two can never disagree.  Entry is always
  in strips; there is no "enter units" mode.

**PURCHASE SCHEMES ARE COUNTED IN PACKS, NOT TABLETS.**
  When a distributor says "5+1" on a strip medicine they mean *buy 5 STRIPS,
  get 1 strip free* — never "buy 5 tablets, get 1 tablet free".  Same for any
  other form: 5 bottles, 5 tubes.  The pack for a strip medicine is the strip;
  for everything else the pack IS the unit, so no scaling happens.
    buy_units      = scheme_buy  × units_per_strip   (× 1 for non-strip)
    free_units     = scheme_free × units_per_strip
    bonus_quantity = (paid_units // buy_units) × free_units
  Only WHOLE sets earn a bonus: 7 strips on "5+1" earns 1 free strip, not 1.4.
  4 strips on "5+1" earns nothing — the purchase does not qualify.
  scheme_buy / scheme_free are STORED as the human numbers (5 and 1) so the
  ledger reads like the invoice; the scaling happens at calculation time in
  inventory_service._compute_scheme().  The frontend's schemePreview() mirrors
  it exactly — if you change one, change both.

**A PURCHASE INVOICE: DISCOUNT FIRST, THEN GST ON WHAT IS LEFT.**
  This is how every Indian distributor's invoice is printed, and the app now
  reproduces it line for line:
    S.Rate                     ← the rate card price, per unit, PRE-tax
    − trade discount           ← knocked off FIRST
    = goods value              ← what the medicine itself costs us
    + GST on the GOODS VALUE   ← the tax, charged AFTER the discount
    = invoice total            ← what we owe the supplier
  Worked example (COLIZA LIQUID, from a real invoice) — S.Rate ₹86.10, disc 5%,
  GST 5%, qty 3:
    discount   = 86.10 × 5%      = ₹4.305/unit
    post-disc  = ₹81.795/unit    ← effective_cost
    GST        = 81.795 × 5%     = ₹4.0898/unit
    goods (×3) = ₹245.39 · GST ₹12.27 · INVOICE ₹257.66
  Note this is the OPPOSITE direction to a SALE: there, GST is already inside
  the MRP and gets extracted out.  On a purchase the rate is pre-tax and GST is
  added on top of the DISCOUNTED rate.
  ⚠ THIS REVERSES THE OLD RULE.  Until July 2026 the app charged GST on the
  un-discounted rate and treated a discount as margin-only, which over-stated
  every discounted supplier debt (₹271.67 instead of ₹257.66 above).  Supplier
  credit rows written before that fix carry the error.
  One helper computes all of it: inventory_service.compute_purchase_totals().
  Both the router's pre-validation and the service call it, so they agree to the
  paisa.  The frontend mirrors it in AddStockPanel and bulkRowCalc — if you
  change one, change all three.
  Stored on stock_purchases, each for a different job:
    cost_price      → the S.Rate, per unit, pre-discount (matches the invoice)
    discount_%/₹    → the trade discount.  The % is what was TYPED; the ₹ is
                      DERIVED from it, per unit (see below)
    effective_cost  → S.Rate − discount, per unit, ex-GST.  THE cost figure:
                      profit margin · batch.purchase_price (so profit locked at
                      sale time is right) · expiry loss · supplier-return value
    gst_on_purchase → the GST on this LINE (not per unit); not recoverable if
                      the stock expires, so it drives expiry loss
    total_cost      → goods + GST for the LINE = supplier credit / payment
  ⚠ gst_on_purchase and total_cost are LINE totals; cost_price, discount_amount
  and effective_cost are PER UNIT, at 4 decimals (a ₹86.10 strip of 15 is
  ₹5.74/unit — rounding that to paise drifts a 150-unit invoice by ~₹1).
  If a supplier does something the formula does not cover (freight, rounding, an
  unlisted line), type the real figure into "Supplier invoice total" — that
  override wins for the credit, and the breakdown lines stay as computed.
  THE DISCOUNT IS ENTERED AS A PERCENTAGE ONLY — there is no ₹ input anywhere.
  A rupee figure has to be stated in a basis (per tablet? per strip? per line?)
  and every basis needed its own conversion before the backend could use it,
  which is exactly the mismatch that quietly mis-states a supplier debt.  A
  percentage means the same thing in every basis, so it is the only shape the
  UI offers and the only one AddStockRequest accepts.  The stored ₹ figure is
  derived: S.Rate × percent / 100, per unit.
  Both Add Stock forms label it "Discount % … of total purchase price" and show
  the saving across the WHOLE line — "5% of ₹600 = ₹30 saved → Effective cost:
  ₹570" — because that is the line the paper invoice prints.  The ₹ saving is
  derived by SUBTRACTION (gross goods − goods value), not as percent × gross,
  so the breakdown on screen always reconciles to the paisa.
  Old rows have NULL effective_cost; every reader falls back to cost_price,
  which is exactly right for a purchase that had no discount.
  Verify with: `python backend/scripts/check_purchase_totals.py`

**PROFIT MARGIN COMPARES TWO EX-GST FIGURES.**
  MRP is GST-INCLUSIVE; the purchase cost is EX-GST.  Comparing them as they
  come flatters every margin, because only one side carries tax.  So the MRP has
  its tax extracted first:
    mrp_ex_gst = mrp × 100 / (100 + gst_rate)
    margin     = (mrp_ex_gst − effective_cost) / mrp_ex_gst × 100
  MRP ₹100 at 5% GST against an effective cost of ₹81.795 is a 14.1% margin,
  not the 18.2% a raw comparison would claim.
  Implemented in ProfitAnalysis and bulkRowCalc (Inventory.jsx).

**STOCK EXPIRING WITHIN 30 DAYS IS NOT SELLABLE (BILLING_MIN_EXPIRY_DAYS).**
  A customer buying a strip today may still be taking it a month from now, so a
  batch inside the 30-day window goes BACK TO THE SUPPLIER — it never goes on a
  bill.  The number lives in ONE place: inventory_service.BILLING_MIN_EXPIRY_DAYS.
  Both ends of the billing flow enforce it and must never disagree:
    routers/search.py            → hides those batches from the medicine search
    billing_service.fefo_allocate → refuses to deduct stock from them
  If the search offered a batch the allocator then rejected (or vice versa), the
  pharmacist would see stock they cannot actually bill.
  ⚠ This is a DIFFERENT number from EXPIRY_ALERT_HORIZON_DAYS (60), which is how
  far ahead the *alerts page* looks.  30 = "cannot sell"; 60 = "warn about it".
  A medicine whose batches are ALL inside the window is still returned by the
  search, with available_stock 0 and all_batches_near_expiry true, so the
  pharmacist sees it exists but cannot be sold instead of an empty dropdown.

**THE MEDICINE SEARCH RETURNS ONE ROW PER BATCH, NOT PER PRODUCT.**
  GET /api/search/medicines matches on the PRODUCT (name / generic_name /
  hsn_code / category — so searching a generic surfaces every brand carrying
  it), then expands each match into one dropdown row per SELLABLE batch, FEFO
  order (earliest expiry first).  Each row carries batch_id, batch_number and
  the product's rack_location, so the pharmacist picks the exact box in their
  hand.  That batch_id rides along on the bill item and is deducted first;
  fefo_allocate only spills into other batches to cover a shortfall, and still
  runs as the fallback when no batch_id is sent (barcode scans, older clients).
  Products with nothing sellable get ONE greyed-out row instead, carrying
  `alternatives`: up to 3 in-stock products sharing the same generic_name, each
  a complete search row so the frontend can bill one with no extra lookup.
  ⚠ A bill row is therefore identified by product_id + batch_id, never
  product_id alone — two batches of the same medicine are two separate lines
  with different expiry dates.  Billing.jsx keys every row on `line_key`.

**A RETURN IS PER LINE, NOT PER INVOICE.**
  A customer brings back ONE medicine off a five-line bill.  Reversing the whole
  invoice — what the app used to do — put four medicines they still have back on
  the shelf as sellable stock.  So invoice_items carries the return state:
    returned_qty  → units of THIS line handed back so far (a line can come back
                    across more than one visit)
    is_returned   → returned_qty == quantity
  Stock goes back to the line's ORIGINAL batch, never FEFO: the physical box the
  customer is holding came from that batch, with that expiry date.
  Invoice status: every line fully back → 'RETURNED'; some units back →
  'PARTIAL_RETURN'.  A third status means every reader (history filter, badge,
  reports) must handle it — PARTIAL_RETURN is amber, not red, because part of
  that sale is still good and still counts as revenue.
  THE REFUND IS THE RETURNED UNITS' SHARE OF WHAT WAS ACTUALLY PAID:
    gross = line_total × qty_returned / line_quantity     (GST rides along —
            line_total is already tax-inclusive)
    refund = gross − discount × gross / Σ(all line_totals)
  The bill-level discount is shared out by gross value, which is what makes a
  full return refund exactly (subtotal + GST − discount).  The HOME VISIT CHARGE
  IS NOT REFUNDED — the pharmacist already travelled and administered the drip;
  returning the medicine does not undo the service.
  Implemented in billing_service.process_return / _refund_for.  The modal's
  on-screen preview in InvoiceHistory.jsx mirrors the same formula — if you
  change one, change both, or the screen promises money the backend won't pay.
  On a CREDIT invoice the refund does NOT go through the till: it cancels the
  debt via credit_service.reduce_invoice_credit(), which walks total_credit and
  outstanding DOWN.  Booking it as a payment would show cash arriving at the
  counter that nobody ever received.

**EVERY REVENUE QUERY MUST NET OFF PARTIAL RETURNS — services/revenue.py.**
  ⚠ `Invoice.status != "RETURNED"` ADMITS a PARTIAL_RETURN invoice and then
  counts it WHOLE.  That is the trap: nothing is wrongly excluded, things are
  wrongly counted at full value.  A ₹1,000 bill with ₹400 handed back reported
  ₹1,000 of revenue, the full cost of goods that are back on the shelf, and the
  full unit count in "top products" — while those same tablets were ALSO being
  counted in inventory value.  Never sum `Invoice.total_amount`,
  `InvoiceItem.line_total` or `InvoiceItem.quantity` directly.  Use:
    net_invoice_amount_expr()   → total_amount − refunded_amount   (HEADER level:
                                  dashboards, spend per patient)
    sold_qty_expr()             → quantity − returned_qty          (ITEM level)
    retained_line_total_expr()  → the money for the units KEPT     (ITEM level)
  KEEP the `!= "RETURNED"` filter alongside them: a fully returned invoice nets
  to zero anyway, but the filter also keeps it out of COUNT(*), and an invoice
  handed back in full is not a sale that happened.
  invoices.refunded_amount is a denormalised running total written ONLY by
  billing_service.process_return.  It exists because deriving the refund needs
  each line's share of the bill discount — a correlated subquery in every
  dashboard card, to recompute what the return already knew.
  ⚠ ONE DELIBERATE EXCEPTION: expenditure_service._sales_split (the daily cash
  register) is NOT netted.  It buckets by invoice_date, so subtracting a refund
  would book it on the day of the ORIGINAL SALE — turning a day already counted,
  closed and signed off into a phantom shortage.  Doing it properly needs a
  refund DATE and TENDER, which the return flow does not record yet.
  Verify with the delta tests: a 4-of-10 return on a ₹1,000 / ₹600-cost bill
  must move revenue by exactly −₹400, cost by −₹240 and profit by −₹160.

**A DATE-WINDOW FILTER IS NAMED BY THE CLIENT AND RESOLVED BY THE SERVER.**
  Invoice History used to compute "this week" in JavaScript and send a
  date_from/date_to pair.  That put the definition of a week on the shop PC's
  clock and timezone, so a machine set to anything but IST asked for a window
  that did not contain the invoices just created — "This Week" came back empty.
  The browser now sends only the NAME (today / yesterday / week / month / all)
  and app/utils/dates.py turns it into the UTC window, because the server is the
  only thing that knows the timestamps are naive UTC:
    period_bounds_utc(period) → (start, end) or None for "all"
    ist_week_bounds_utc()     → Monday–Sunday of the current IST week
    ist_month_bounds_utc()    → 1st to last day of the current IST month
  Weeks start MONDAY.  The week window covers the WHOLE week, not "Monday →
  today", so an invoice dated later today still falls inside it.

**HOME VISIT CHARGE carries NO GST.**
  It is a service (administering a drip/injection at the patient's home), not
  a medicine — no batch, no stock movement, no tax.  It is stored on the
  INVOICE (invoices.home_visit_charge), never as an invoice_item, and is added
  AFTER the GST maths:
    total = subtotal + gst_amount + home_visit_charge − discount

**SUPPLIER CREDIT is the mirror of PATIENT credit — keep them separate.**
  models/credit.py            → money patients owe US
  models/supplier_credit.py   → money WE owe suppliers
  Same table shapes, opposite direction. Never merge them.
  account.outstanding and account.advance_balance are denormalised caches;
  they are ONLY ever moved by functions in supplier_credit_service.py.
  Overpaying a supplier is allowed — the excess becomes advance_balance and is
  consumed automatically by that supplier's next credit purchase.

**"MONEY OUT" HAS FOUR SOURCES AND TWO DOUBLE-COUNTING TRAPS.**
  The dashboard expenditure cards total every rupee that leaves the pharmacy.
  Assembled in dashboard._collect_expenditure(); read this before adding a
  source, because both traps below inflate a number the owner reads as fact.
  ⚠ TRAP 1 — stock_purchases has NO amount_paid and NO payment_mode column.
    Money handed over when a delivery arrives is written by inventory_service as
    a SupplierCreditTransaction(type='PAYMENT') carrying a stock_purchase_id.
    Supplier payments therefore live in exactly ONE table, and that
    stock_purchase_id is what separates the two kinds:
      stock_purchase_id IS NOT NULL → SUPPLIER_PAYMENT (paid at the door)
      stock_purchase_id IS NULL     → CREDIT_PAYMENT   (settled an older debt)
    Summing stock_purchases as a second source counts every delivery twice.
  ⚠ TRAP 2 — expenditure_service.settle_salary writes BOTH a SalaryRecord AND a
    mirrored Expense(category='SALARY').  Salary is taken from salary_records
    ONLY, and category='SALARY' is EXCLUDED from the expense query.
    salary_records wins because it is dated by paid_at — the day the cash
    actually left — whereas the mirror Expense is dated to the last day of the
    salary month, so an August settlement of July's salary would never appear
    on any day's card.
  Date handling: expenses.date is a plain DATE (business date) and is compared
  to IST dates directly; created_at / paid_at are naive UTC and need the
  ist_range_bounds_utc() window.
  Verify with: `python backend/scripts/check_expenditure_summary.py`

**EVERY MIGRATION IS RECORDED IN db_migrations — NEVER try/except ALONE.**
  The customer runs this app on their own PC and installs updates over a
  database full of real sales.  A migration therefore has to be safe to run on
  a fresh install, on a database that already has the column, and on one that
  does not — without ever crashing, and without hiding a genuine failure.
  main.py:_run_db_migrations() puts each statement through THREE gates:
    1. name already in db_migrations?      → skip (the everyday case)
    2. column already in the schema?       → adopt into the ledger, don't run
       (PRAGMA table_info — the SCHEMA is the ground truth, not the ledger)
    3. otherwise                           → run it, and record it ONLY if it
                                             SUCCEEDS
  ⚠ A FAILED MIGRATION IS DELIBERATELY NOT RECORDED, so it retries on the next
  start.  Recording a failure would mark a missing column as done and leave the
  app querying something that is not there.
  ⚠ GATE 2 IS WHAT MAKES AN UPGRADE SAFE.  A pharmacy already running the app
  has all 41 columns but an EMPTY ledger — the old system kept no record.  A
  name-only check would re-attempt 41 doomed ALTERs on their first upgrade
  boot; gate 2 adopts them silently instead.
  ⚠ try/except alone (what this used to be) cannot tell "column already there"
  from "this genuinely failed" — both raise, both got logged at INFO, so a real
  failure was invisible.  That is the bug the ledger exists to fix, and why a
  reader must not "simplify" it back to a bare try/except.
  Migration NAMES are DERIVED from the SQL (add_<column>_to_<table>), so adding
  a statement to the list is the only step — there is no second list to keep in
  sync, and a typo cannot point the ledger at the wrong statement.
  Verify with: `python backend/scripts/test_migrations.py` — it copies the live
  DB to a sandbox, strips the ledger to imitate a pre-update customer, and runs
  startup 4 times (upgrade → restart → new column → settle), asserting row
  counts never move.  THE REAL DATABASE IS NEVER TOUCHED.

**A BACKUP IS TAKEN BEFORE ANYTHING TOUCHES THE DATABASE — AND NOT WITH copy2.**
  main.py:_backup_on_startup() runs as step 0 of the lifespan, ahead of
  init_db() and the migrations, because a snapshot taken afterwards has already
  lost whatever a bad migration destroyed.  Keeps the newest 7 startup_*.db.
  ⚠ NEVER shutil.copy2 THIS DATABASE.  It runs in WAL mode, so a committed sale
  lives in pharmacy.db-wal until a checkpoint folds it in.  Measured on the dev
  machine in Aug 2026: pharmacy.db was 528 KB dated Jul 30 while the -wal file
  held 3.7 MB dated Aug 12 — a copy2 backup would have silently dropped two
  weeks of sales and looked like it worked.  Use sqlite3's online backup API
  (conn.backup(dest)): it reads through the WAL, writes ONE self-contained
  file, and is safe while the app holds the DB open.  Both writers do this —
  _backup_on_startup() and routers/backup.py.
  ⚠ RESTORING MEANS DELETING pharmacy.db-wal AND pharmacy.db-shm TOO.  Copy a
  backup over pharmacy.db and leave the old -wal beside it and SQLite replays
  that stale WAL over the restored file, undoing the restore.  This is the most
  common way a manual SQLite restore silently fails.  Full 6-step procedure in
  §11.
  Filenames carry a same-second collision suffix (_2, _3): the timestamp only
  resolves to the second, and `uvicorn --reload` restarts several times in a
  row while a file is being edited — which cost 4 of 5 backups the first time
  this was tested.

---

## 5. Design system (glassmorphism — do not change without asking)

Aesthetic: light glassmorphism. Soft pastel gradient background 
  with animated orbs. Frosted white glass panels. Indigo accent.

### CSS variables (all in global.css — always use these, never hardcode)
--accent:         #6366f1   (indigo — buttons, active nav, focus rings)
--accent-dark:    #4f46e5
--accent-light:   rgba(99,102,241,0.12)
--glass:          rgba(255,255,255,0.50)
--glass-strong:   rgba(255,255,255,0.70)
--glass-border:   rgba(255,255,255,0.75)
--text:           #1e1b4b
--text-secondary: #6b7280
--text-hint:      #9ca3af
--ok:             #059669   + --ok-bg:     rgba(16,185,129,0.12)
--warn:           #d97706   + --warn-bg:   rgba(245,158,11,0.12)
--danger:         #e11d48   + --danger-bg: rgba(244,63,94,0.12)
--info:           #0284c7   + --info-bg:   rgba(14,165,233,0.12)
--font-body:      'Outfit', system-ui, sans-serif
--radius:         10px
--radius-lg:      14px
--radius-xl:      18px

### Key patterns
- **Glass card:** background var(--glass), backdrop-filter blur(24px),
  border 1px solid var(--glass-border), border-radius var(--radius-lg)
- **Stat card:** glass card + 3px gradient top border + fadeUp animation
- **Buttons:** .btn-primary (indigo), .btn-secondary (glass), .btn-danger
- **Inputs:** rgba white bg + blur + indigo focus ring (3px)
- **Badges:** .badge-ok / .badge-warn / .badge-danger / .badge-info / 
  .badge-accent / .badge-neutral
- **Table headers:** 11px uppercase tracked, var(--text-hint)
- **Modals:** MUST use createPortal(…, document.body) to avoid 
  fixed-position clipping by overflow containers (learned in Phase 1)
- **Dropdowns / autocomplete lists inside a .card:** render them IN normal
  document flow (let the card grow and push siblings down). Do NOT float them
  with position:absolute. Every .card sets backdrop-filter, and a non-`none`
  backdrop-filter creates a NEW STACKING CONTEXT — so an absolutely-positioned
  child's z-index only competes inside its own card and can never outrank a
  later sibling card. The symptom is deceptive: the list renders correctly in
  the DOM and in the served bundle, but is painted underneath the next card, so
  only a sliver shows. Raising z-index on the list does nothing; raising it on
  the CARD works but still overlaps content. In-flow is the fix.
  (Learned in Phase 3 — Billing.jsx patient search.)
- **Animations:** fadeUp (0.4s ease) — stagger 0.05s per card

### Logo
- SVG file: frontend/src/assets/logo.svg
  Green medical cross + lime ribbon/wave. viewBox 0 0 120 120.
- Favicon: frontend/public/favicon.svg 
  Green cross on dark green square, 32×32.
- In sidebar: <img src={logoSvg} width=36 height=36>
- In login: <img src={logoSvg} width=52 height=52> with pulse animation

### Background (on body)
```css
background: linear-gradient(145deg,
  #e8f4fd 0%, #dbeeff 25%, #ede9fe 55%, 
  #fce7f3 80%, #e0f2fe 100%);
background-attachment: fixed;
```
body::before adds animated radial orbs (orbShift 12s animation).

---

## 6. Coding conventions

### Backend
- One router per module in app/routers/, included in main.py
- Pydantic schemas in app/schemas/ — never return raw SQLAlchemy objects
- Business logic in app/services/ — keep routers thin
- get_db dependency for all DB access — one session per request
- Money: Decimal everywhere, never float
- GST: compute taxable value, gst_rate, gst_amount explicitly per line
- Multi-step writes (invoice + items + movements): single transaction
- Audit log: write to audit_log for price changes, deletions, 
  patient record changes
- Auth: bcrypt direct (no passlib). get_current_user in auth_service.py.
- startup seed in main.py: admin user (if no users), default tags 
  (if no tags), roles/categories/departments from schema.sql

### Frontend
- ALL api calls through src/lib/api.js — never call axios elsewhere
- Auth state in sessionStorage via src/lib/auth.js (clears on tab close)
- 401 interceptor in api.js excludes /auth/login (prevents eating 
  the login error)
- Register routes in App.jsx, pages in src/pages/
- Indian currency: formatINR(amount) using toLocaleString('en-IN')
- Billing screen must remain keyboard-friendly: F2/Enter/F10
- Modals must use createPortal(…, document.body)
- New pages must follow glassmorphism patterns (glass card wrapper, 
  CSS variable colors, fadeUp animation on cards)
- PDF export: jspdf + jspdf-autotable (dynamic import — loaded on demand)
- Excel export: xlsx/SheetJS (dynamic import — loaded on demand)

### General
- Comment for a beginner audience — explain WHY, not just WHAT
- Build one module at a time, verify, then move on
- Don't add features beyond the current task
- Stop and report errors rather than silently fixing them
- Verifying a frontend build: run `npx vite build` and read ITS exit code.
  Piping into `tail`/`head` makes `$?` report the pipe's last command, so a
  FAILING build reports success. Redirect to a log file instead:
    npx vite build > /tmp/build.log 2>&1; echo $?
- A green build only proves the code compiles. It cannot see rendering bugs
  (paint order, z-index, overlap, clipping). When the user reports that
  something looks wrong and the source looks correct, ask for a SCREENSHOT
  early — grep and build checks are structurally blind to that whole class of
  bug, and re-checking them harder just wastes the user's time.

---

## 7. API reference (Phase 1 + Phase 2 — all working)

### Auth
POST   /api/auth/login              → LoginResponse.  The `username` field
                                      accepts a USERNAME **or** an EMAIL —
                                      matched case-insensitively with
                                      func.lower() on both sides.  The field
                                      keeps its name on the wire; only the
                                      login screen's label changed.
GET    /api/auth/me                 → UserInfo
GET    /api/auth/me/profile         → ProfileOut
PUT    /api/auth/me/profile         → update full_name/email/phone AND username.
                                      Username rules: ≥3 chars, [A-Za-z0-9_]
                                      only, unique case-insensitively (409 if
                                      taken).  ⚠ The JWT identifies its holder
                                      by username, so changing it KILLS the
                                      current token — the response carries a
                                      fresh `access_token`, and Layout.jsx swaps
                                      it into sessionStorage so the user is not
                                      thrown out mid-shift.

### Pharmacy settings (the shop's own identity)
GET    /api/settings/pharmacy       → name, tagline, address, phone, email,
                                      GSTIN, DL number.  **NO AUTH REQUIRED** —
                                      the login screen renders it before anyone
                                      has a token, and every field is already
                                      printed on the shop's own bills.
PUT    /api/settings/pharmacy       → update (Owner/Administrator only)
  ONE ROW, EVER (multi-branch is Phase 5).  Seeded on startup by
  _seed_pharmacy_settings(), and created lazily by get_or_create_settings() so
  an older database can never 404 the login screen.
  The frontend loads it ONCE into a context (frontend/src/lib/pharmacy.jsx,
  mounted outside the router in main.jsx) and shares it with the sidebar brand,
  the login card, ThermalReceipt and document.title — so a rename lands
  everywhere at once instead of in four independently-fetched places.

### Backup (database snapshots — ALL Owner/Administrator only)
POST   /api/backup/create           → snapshot now → manual_<ts>.db
GET    /api/backup/list             → every backup, newest first, + backup_dir
GET    /api/backup/download/{file}  → the .db file (how a copy gets OFF this PC)
DELETE /api/backup/{file}           → delete one
  TWO KINDS, ONE TABLE.  startup_*.db is taken automatically on every app open
  and PRUNED to the newest 7; manual_*.db is the owner pressing Backup Now and
  is NEVER pruned — only a person deletes one.  The pruner globs startup_*.db
  precisely so it can never eat a manual backup.
  The filename arrives in the URL and is therefore untrusted: it must match
  ^(startup|manual)_\d{8}_\d{6}(_\d+)?\.db$ AND resolve inside the backups
  folder.  Without that, '../pharmacy.db' would download — or DELETE — the live
  database.  Both guards are deliberate; either alone would do.
  The frontend downloads via axios into a blob, not a plain <a href>: the
  endpoint needs the JWT and a bare link cannot carry the header (401).
  Snapshots use sqlite3's online backup API, never copy2 — see the WAL rule
  in §4 for why that is not a style preference.

### Inventory
GET    /api/inventory/categories    → list
GET    /api/inventory/departments   → list
GET    /api/inventory/products      → paginated (search, page, limit)
POST   /api/inventory/products      → create
GET    /api/inventory/products/{id} → detail + current_stock
PUT    /api/inventory/products/{id} → update
DELETE /api/inventory/products/{id} → soft delete
POST   /api/inventory/batches/receive → receive stock (transactional)
GET    /api/inventory/batches/{product_id} → batch list
PUT    /api/inventory/batches/{batch_id}   → CORRECT a batch (Owner/Admin only)
                                      Body (all optional — send what changed):
                                      batch_number, quantity, expiry_date
                                      ("YYYY-MM"), selling_price (per UNIT),
                                      purchase_price (S.Rate per UNIT),
                                      discount_percent, scheme_label, strip_mrp
                                      ⚠ A CORRECTION IS NOT A DELIVERY.  A
                                      quantity change writes ONE StockMovement
                                      (type='ADJUST') carrying the SIGNED
                                      difference — never a new batch and never
                                      type='IN'.  The linked stock_purchases row
                                      is recomputed through the same
                                      compute_purchase_totals() Add Stock uses,
                                      so a corrected line and a fresh one agree
                                      to the paisa.
                                      ⚠ SUPPLIER CREDIT IS NOT TOUCHED — the
                                      ledger records what was agreed with the
                                      distributor, and silently moving a debt
                                      because someone fixed a typo would stop
                                      their statement reconciling with ours.
                                      The response message says so explicitly;
                                      a real invoice correction is settled from
                                      the Supplier Credit page, on purpose.
GET    /api/inventory/purchase-history?supplier_id=&date_from=&date_to=
                                      → flat list (still used for the detail
                                        rows inside one distributor)
GET    /api/inventory/purchase-history/by-supplier
                                      → ONE ROW PER DISTRIBUTOR: entry_count,
                                      product_count, last_purchase_date and
                                      total_value.  total_value sums total_cost
                                      (goods + GST — what they actually billed
                                      us); rows predating that column fall back
                                      to quantity × cost_price.  Sorted by most
                                      recent purchase.  Powers the accordion on
                                      the Purchase History tab.
GET    /api/inventory/alerts/expiry → {expired, expires_30, expires_60,
                                      alert_product_count}
                                      THREE buckets only — no 7-day or 90-day
                                      section (batches inside 7 days sit in
                                      expires_30; past 60 days is not
                                      actionable).  Every row carries the
                                      supplier discount, effective_cost, the
                                      GST loss computed on it, and a
                                      return-to-supplier preview, so all three
                                      sections offer a Return button.
                                      EXPIRY_ALERT_HORIZON_DAYS (60) must match
                                      the last bucket — sidebar + dashboard
                                      count off it.
GET    /api/inventory/alerts/low-stock → list
GET    /api/inventory/movements/{product_id} → stock history

### Search (medicine picker — powers MedicineSearchBox)
GET    /api/search/medicines?q=     → ONE ROW PER SELLABLE BATCH.
                                      Matches on product name / generic_name /
                                      hsn_code / category (multi-word AND), then
                                      expands each product into its batches,
                                      FEFO order.  Every row adds batch_id,
                                      batch_number, rack_location.
                                      Batches expiring within
                                      BILLING_MIN_EXPIRY_DAYS (30) are excluded.
                                      A product with nothing sellable returns
                                      ONE row: available_stock 0,
                                      all_batches_near_expiry (true = stock
                                      exists but must be returned; false = empty
                                      shelf) + alternatives[] (up to 3 in-stock
                                      products with the same generic_name, each
                                      a full search row).
                                      Caps: 15 products, 50 rows.
GET    /api/search/barcode/{code}   → same shape + barcode; returns the FEFO
                                      batch_id.  404 if unknown; out_of_stock
                                      true when nothing is sellable.

### Billing
POST   /api/billing/invoices        → create (FEFO, GST, single txn)
                                      items[] accept an optional batch_id — the
                                      batch chosen in the search dropdown. It is
                                      deducted FIRST; FEFO covers any shortfall
                                      and remains the fallback when omitted.
GET    /api/billing/invoices        → list (paginated).
                                      ?period=today|yesterday|week|month|all
                                      is the PREFERRED date filter and WINS over
                                      date_from/date_to.  The server owns the
                                      definition of each window because it owns
                                      the timezone — see the IST rule below.
                                      ?status= accepts COMPLETED, PARTIAL_RETURN
                                      or RETURNED.
GET    /api/billing/invoices/{num}  → single invoice.  Each item now carries
                                      `id` (the invoice_items row), plus
                                      returned_qty and is_returned.
POST   /api/billing/invoices/{num}/return → PARTIAL return.
                                      Body: {items:[{invoice_item_id,
                                      return_qty}], reason}.  Omitting `items`
                                      returns everything still outstanding (the
                                      old whole-invoice behaviour), so older
                                      clients keep working.
GET    /api/billing/invoices/today  → today's invoices + total
GET    /api/billing/patient/{id}/last-doctor
                                    → {doctor_name, visit_date, specialization}

### Patients
GET    /api/patients/tags           → list (16 default seeded)
POST   /api/patients/tags           → create tag
GET    /api/patients/               → search (query, page, limit)
POST   /api/patients/               → create
GET    /api/patients/{id}           → detail + stats
PUT    /api/patients/{id}           → update
GET    /api/patients/{id}/purchases → purchase history

### Dashboard
GET    /api/dashboard/summary       → all 8 metrics + recent_invoices
                                      + top_products
                                      + patients_today {total, new_patients,
                                      returning} — DISTINCT patients billed
                                      today (walk-ins excluded: no record means
                                      no way to tell new from returning).
                                      "new" = of TODAY'S buyers, how many
                                      registered today — deliberately NOT the
                                      separate new_patients_today field, which
                                      counts every registration today including
                                      people who bought nothing and so would let
                                      `returning` go negative.
                                      Powers the Total Patients card.
GET    /api/dashboard/expenditure-summary
                                    → ALL money OUT, for today and this month.
                                      {today, month, month_label}; each period
                                      carries total + the four component totals
                                      (supplier_payments, credit_payments,
                                      expenses, salary), a cash/upi split, and
                                      the full breakdown[] the slide-in panel
                                      lists.  Card and panel read the SAME
                                      array, so they cannot disagree.
                                      Powers the two expenditure cards that
                                      replaced the New Patients card.
                                      Verify with:
                                      `python backend/scripts/check_expenditure_summary.py`

### Suppliers (Phase 2)
GET    /api/suppliers/              → list (optional ?search=)
POST   /api/suppliers/              → create
GET    /api/suppliers/{id}          → detail + batch_count
PUT    /api/suppliers/{id}          → update (partial)
DELETE /api/suppliers/{id}          → delete (blocked if batches exist → 409)

### Purchasing (Phase 2)
GET    /api/purchasing/orders       → list POs (status filter, paginated)
POST   /api/purchasing/orders       → create PO (DRAFT, items required)
GET    /api/purchasing/orders/{id}  → PO detail + items
PATCH  /api/purchasing/orders/{id}/status → update status only
GET    /api/purchasing/grn          → list GRNs (paginated)
POST   /api/purchasing/grn          → create GRN → creates batches +
                                      StockMovement(IN) + updates PO status
GET    /api/purchasing/grn/{id}     → GRN detail + items + batch info

### Supplier Credit (money WE owe suppliers)
GET    /api/supplier-credit/summary   → totals + upcoming_dues + overdue lists
GET    /api/supplier-credit/suppliers → one row per supplier with credit
GET    /api/supplier-credit/supplier/{id} → full ledger (account + transactions)
POST   /api/supplier-credit/payment   → record payment (FIFO, oldest debt first;
                                        overpayment becomes an advance)
GET    /api/supplier-credit/due-soon  → ?days=7 window + all overdue
                                        (powers the Dashboard widget)

### Supplier Returns (expired stock back to supplier)
GET    /api/inventory/return-preview/{batch_id} → supplier, cost, GST loss,
                                        net value, current outstanding
POST   /api/inventory/return-to-supplier → process return (reduces batch qty,
                                        writes StockMovement RETURN with a
                                        NEGATIVE quantity, adjusts credit)
GET    /api/inventory/returns         → paginated return history

### Home Visit Charge
GET    /api/billing/home-visit-charge → default amount (billing screen pre-fill)
PUT    /api/billing/home-visit-charge → update default (Owner/Administrator only)

### Add Stock — now also creates supplier credit
POST   /api/inventory/add-stock       → extra body fields:
                                        discount_percent (a PERCENTAGE of the
                                        S.Rate — the only shape accepted; the
                                        backend derives the ₹ figure.  There is
                                        NO discount_amount on the request),
                                        amount_paid, payment_mode
                                        (CASH/UPI/CREDIT),
                                        supplier_invoice_total (optional —
                                        defaults to the computed line total:
                                        (qty × S.Rate − discount) + GST on it),
                                        due_date (REQUIRED if any credit)
                                        Response adds: invoice_total,
                                        amount_paid, credit_amount,
                                        credit_tx_id, supplier_outstanding,
                                        discount_percent, discount_amount
                                        (RESPONSE only — the derived ₹ figure,
                                        per unit), effective_cost

### Reports (Phase 2 — all read-only, require auth)
GET    /api/reports/sales           → revenue, cost, profit, daily breakdown,
                                      top 10 products, top 5 departments
                                      params: date_from, date_to
                                      (defaults: first of month → today)
GET    /api/reports/inventory       → stock snapshot, expiry buckets,
                                      low stock, top value products
                                      (no date filter — always current state)
GET    /api/reports/profit          → profit summary, 6-month trend
                                      (fixed, not affected by date filter),
                                      top 15 products by profit
                                      params: date_from, date_to
GET    /api/reports/patients        → patient stats, department breakdown,
                                      top 10 patients by spend,
                                      registration trend
                                      params: date_from, date_to

---

## 8. Current build status

### ✅ Phase 1 — COMPLETE
- Authentication (JWT, bcrypt, roles, protected routes)
- Inventory (products, batches, FEFO-ready, expiry alerts, low stock)
- Billing & POS (FEFO deduction, GST, invoice numbering, returns)
- Patients (registration, departments, tags, purchase history, edit)
- Dashboard (live data, Indian INR, time greeting, panels)
- UI (light glassmorphism, Outfit font, SVG logo, favicon)
- GST calculation fixed: inclusive pricing (extracted from MRP, not added on top)
- A4 GST Tax Invoice with jsPDF: navy header, shop details, GSTIN, DL number,
  CGST/SGST split, green TOTAL, amount in words, "Powered by ARZ Solutions" footer
- Referred by field on invoices (auto-fill from OPD visit or manual entry)
- Inline patient registration on billing screen (search + add new patient
  without leaving page)
- Prescription toggle on billing screen
- Billing discount accepts EITHER a rupee amount or a percentage (₹/% toggle).
  The percentage is a counter convenience only — it is resolved to rupees in
  the totals useMemo, so `discount_amount` posted to the backend and stored on
  the invoice is ALWAYS a rupee figure. Percent is capped at 100 and the rupee
  amount is capped at the bill value (previously an over-large rupee discount
  showed ₹0.00 total but still posted the full typed number).

### ✅ Phase 2 — COMPLETE
- Suppliers — full CRUD, contact info, GST number, delete guard
- Purchase Management — purchase orders (DRAFT→SENT→RECEIVED workflow),
  GRN stock-in (creates batches + StockMovement IN, auto-updates PO status)
- Reports — 4 analytics tabs (Sales, Inventory, Profit, Patient),
  date range + presets (Today/Week/Month/Year),
  PDF export (jspdf + jspdf-autotable), Excel export (xlsx/SheetJS)
- All reports read from real DB data — no mocked numbers

### 🔄 Phase 3 — IN PROGRESS
Phase 3 order:
  3.1 Smart Follow-Up System (message queue, Day 2/5/10/30, offline-safe)
  3.2 Patient Response Management
  3.3 Medicine Refill Reminders
  3.4 Marketing Automation
  3.5 OPD Management (deferred, build last)

### ✅ Supplier Credit / Returns / Strips / Home Visit — COMPLETE
Four cross-cutting features touching inventory, billing and suppliers:

**Supplier Credit** — money the pharmacy OWES suppliers (the mirror image of
  the patient-side credit module in models/credit.py).  Created automatically
  by the Add Stock flow whenever the supplier invoice is not paid in full.
  FIFO repayment, overpayment becomes an advance, 3 reminders per credit.

**Expired stock return to supplier** — sends expired/near-expiry batches back.
  Supplier replaces with stock, not cash; the GST paid is NOT recoverable and
  is absorbed as a loss.  Net value reduces outstanding credit (FIFO) or
  becomes an advance if nothing is owed.

**Strip/unit medicine management** — tablets/capsules bought in strips but
  sellable as loose tablets.  Stock is ALWAYS stored in individual units.

**Home visit charge** — flat service fee for administering a drip/injection at
  the patient's home.  Added to the invoice, NOT GST-taxed.

### ⬜ Phase 4
Local AI (Ollama) — natural-language queries only.
Note: expiry prediction, reorder suggestions, dead-stock detection 
are plain rules/math — build as ordinary logic, NOT LLM.

Expiry automation (deferred from Phase 2):
  Auto-lock expired batches on startup,
  ~~return-to-supplier workflow~~ (DONE — see above),
  estimated loss calculation.

### ⬜ Phase 5
Multi-branch + cloud migration

---

## 9. Messaging note
Follow-up/marketing message content and scheduling is built offline 
and queued. Actual sending (SMS/WhatsApp) needs internet + a paid 
provider (Indian SMS gateway or WhatsApp BSP). Design the message 
system provider-agnostic.

---

## 10. How to run (dev)

Backend:
  cd backend
  source venv/bin/activate        # mac
  venv\Scripts\activate           # windows
  uvicorn app.main:app --reload   → http://localhost:8000/docs

Frontend:
  cd frontend
  npm run dev                     → http://localhost:5173

Default login: admin / admin123

Database:
  SQLite — no setup needed. The file is created automatically on first
  run at ~/Library/Application Support/HCC/pharmacy.db (Mac) /
  %APPDATA%\HCC\pharmacy.db (Windows). database/schema.sql is the
  canonical schema reference (Postgres-flavoured, for the Phase 5 cloud
  migration); it is NOT run against the live SQLite DB.

⚠ ONE SERVER PER DATABASE — CHECK THIS BEFORE YOU START ANYTHING.
  The data folder is chosen by the OPERATING SYSTEM, not by the repo folder, so
  every checkout on the machine shares ONE pharmacy.db.  Two checkouts exist on
  this dev machine (~/Desktop/hcc_erp_app and ~/Documents/hcc-erp) and in Aug
  2026 a uvicorn was found running with the venv binary from one and the CWD —
  and therefore the CODE — from the other.  `uvicorn --reload` then re-ran the
  full startup sequence against the REAL database on every file save.  Nothing
  was lost, but it just as easily could have been: whichever copy has the CWD
  is the code that touches live pharmacy data.
  Before starting a server:
      lsof -a -p <uvicorn-pid> -d cwd     # which code is actually running?
      ps aux | grep uvicorn               # is one already running?
  Run ONE backend at a time, and know which checkout it is serving.  To work on
  a copy safely, point it somewhere else instead:
      HCC_DATA_DIR=/tmp/hcc_scratch uvicorn app.main:app --reload
  Every script under backend/scripts/ already does exactly this.

---

## 11. Disaster recovery (what to tell the customer)

Backups folder — ROAMING, not Local (see §2):
  Windows : %APPDATA%\HCC\backups\
            (C:\Users\<user>\AppData\Roaming\HCC\backups\)
  macOS   : ~/Library/Application Support/HCC/backups/
Paste `%APPDATA%\HCC\backups` into the Explorer address bar.

RESTORE — the app broke after an update:
  1. Close the app COMPLETELY (check Task Manager for stray HCC processes).
  2. Open %APPDATA%\HCC\
  3. Rename pharmacy.db → pharmacy.db.broken.  Do NOT delete it: a technician
     may still recover data from it.
  4. DELETE pharmacy.db-wal AND pharmacy.db-shm if present.  ⚠ DO NOT SKIP.
     SQLite replays a stale WAL over the restored file and undoes the restore.
     This is the most common way a manual SQLite restore silently fails.
  5. Copy the newest backups\ file from BEFORE the problem up one level into
     HCC\ and rename it to exactly  pharmacy.db
  6. Start the app.  Migrations re-run against the restored file; the ledger
     travels INSIDE the backup, so nothing is applied twice.

THERE IS NO RESTORE ENDPOINT, ON PURPOSE.  Overwriting the live database from
inside the running app that holds it open is how you get a half-written file.
Restore is a file operation, with the app closed.

TELL THE OWNER: backups sit on the same disk as the database, so if that disk
fails both go together.  Use Download on the Backup page monthly and keep a
copy on a pen drive.
