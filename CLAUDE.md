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
  - Windows : %LOCALAPPDATA%\HCC\pharmacy.db
Prescription/avatar images live in sibling folders (kept out of the DB file
so it stays small). PostgreSQL remains the Phase 5 cloud-migration target,
but no local dev work touches Postgres today.

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
│   ├── .env / .env.example
│   └── app/
│       ├── main.py             ← FastAPI app, router includes, startup seed
│       ├── config.py           ← settings from .env
│       ├── database.py         ← engine, SessionLocal, get_db
│       ├── models/
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
│       │   │                      (Invoice carries home_visit_charge/notes)
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
│       │   ├── auth.py         ← POST /api/auth/login, GET /api/auth/me
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
        │   └── auth.js         ← saveToken, getToken, getUser,
        │                          clearAuth, isLoggedIn (sessionStorage)
        ├── components/
        │   ├── Layout.jsx      ← sidebar + topbar + outlet
        │   │                      (expiry alert count badge live)
        │   └── ProtectedRoute.jsx ← redirects to /login if not logged in
        ├── pages/
        │   ├── Login.jsx       ← glass card, pulse logo, inline errors
        │   ├── Dashboard.jsx   ← live data, Indian INR format, greeting,
        │   │                      recent invoices + top products panels
        │   ├── Inventory.jsx   ← Products tab + Receive Stock tab
        │   ├── ExpiryAlerts.jsx ← 5 colour-coded collapsible sections
        │   ├── Billing.jsx     ← two-panel POS, F2/Enter/F10 shortcuts,
        │   │                      receipt modal
        │   ├── InvoiceHistory.jsx ← paginated list, date filters,
        │   │                        detail modal, return flow
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
  The Add Stock panel relabels the field and warns when the typed figure looks
  like a strip price.

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
POST   /api/auth/login              → LoginResponse
GET    /api/auth/me                 → UserInfo

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
GET    /api/inventory/alerts/expiry → {expired,warn_7,warn_30,warn_60,warn_90}
GET    /api/inventory/alerts/low-stock → list
GET    /api/inventory/movements/{product_id} → stock history

### Billing
POST   /api/billing/invoices        → create (FEFO, GST, single txn)
GET    /api/billing/invoices        → list (date/patient filter, paginated)
GET    /api/billing/invoices/{num}  → single invoice
POST   /api/billing/invoices/{num}/return → process return
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
                                        amount_paid, payment_mode
                                        (CASH/UPI/CREDIT),
                                        supplier_invoice_total (optional —
                                        defaults to quantity × cost_price),
                                        due_date (REQUIRED if any credit)
                                        Response adds: invoice_total,
                                        amount_paid, credit_amount,
                                        credit_tx_id, supplier_outstanding

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
  %LOCALAPPDATA%\HCC\pharmacy.db (Windows). database/schema.sql is the
  canonical schema reference (Postgres-flavoured, for the Phase 5 cloud
  migration); it is NOT run against the live SQLite DB.
