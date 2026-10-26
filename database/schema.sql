-- =============================================================
-- HEALTH CARE CENTRE ERP  —  DATABASE SCHEMA
-- Phase 1: Inventory + Billing + Patients
-- Database: PostgreSQL
-- =============================================================
--
-- HOW TO READ THIS FILE (for a beginner):
--   A "table" is like a spreadsheet. Each table stores one kind
--   of thing (products, patients, invoices...). Columns are the
--   fields; rows are the records.
--   A "foreign key" (REFERENCES) is a link from one table to
--   another — e.g. an invoice line points back to the batch it
--   came from. This is how the data stays connected and correct.
--
-- THE ONE BIG IDEA:
--   We split a medicine into TWO tables:
--     products  -> the medicine's identity (name, generic, GST%)
--     batches   -> actual physical stock that has an expiry date,
--                  a purchase price, and a quantity on hand.
--   The same product can have many batches. Billing pulls stock
--   from the batch expiring soonest (FEFO = First Expiry First Out).
-- =============================================================


-- ------------------------------------------------------------
-- USERS & ROLES  (Module 22)
-- ------------------------------------------------------------
CREATE TABLE roles (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(50) UNIQUE NOT NULL   -- Owner, Pharmacist, Billing Staff...
);

CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    username        VARCHAR(50) UNIQUE NOT NULL,
    full_name       VARCHAR(120) NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,     -- never store raw passwords
    role_id         INTEGER NOT NULL REFERENCES roles(id),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ------------------------------------------------------------
-- SUPPLIERS  (Module 17) — needed early so batches can link to them
-- ------------------------------------------------------------
CREATE TABLE suppliers (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(150) NOT NULL,
    contact_person  VARCHAR(120),
    phone           VARCHAR(20),
    address         TEXT,
    gst_number      VARCHAR(20),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ------------------------------------------------------------
-- PRODUCT CLASSIFICATION
-- ------------------------------------------------------------
CREATE TABLE categories (
    id      SERIAL PRIMARY KEY,
    name    VARCHAR(80) UNIQUE NOT NULL        -- Tablet, Syrup, Injection...
);

CREATE TABLE departments (
    id      SERIAL PRIMARY KEY,
    name    VARCHAR(80) UNIQUE NOT NULL        -- Cardiology, Diabetes... (Module 6)
);


-- ------------------------------------------------------------
-- PRODUCTS = the medicine's IDENTITY  (Module 2)
-- Things that DON'T change per delivery live here.
-- ------------------------------------------------------------
CREATE TABLE products (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(150) NOT NULL,
    generic_name        VARCHAR(150),
    brand               VARCHAR(120),
    manufacturer        VARCHAR(120),
    category_id         INTEGER REFERENCES categories(id),
    department_id       INTEGER REFERENCES departments(id),
    hsn_code            VARCHAR(10),           -- for GST compliance
    gst_rate            NUMERIC(5,2) NOT NULL DEFAULT 12,  -- % e.g. 5, 12, 18
    barcode             VARCHAR(64),
    rack_location       VARCHAR(50),
    unit                VARCHAR(30) DEFAULT 'unit',  -- strip, bottle, piece...
    min_stock_level     INTEGER NOT NULL DEFAULT 10, -- triggers low-stock alert
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    -- Phase 3.3: pharmacist can override the estimated days-per-unit for refill calc
    days_per_unit       INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup when scanning a barcode at the counter
CREATE INDEX idx_products_barcode ON products(barcode);
CREATE INDEX idx_products_name    ON products(name);


-- ------------------------------------------------------------
-- BATCHES = actual PHYSICAL STOCK  (Modules 2, 3)
-- Each delivery of a product becomes a batch with its own
-- expiry date, prices, and quantity. THIS is where stock lives.
-- ------------------------------------------------------------
CREATE TABLE batches (
    id                  SERIAL PRIMARY KEY,
    product_id          INTEGER NOT NULL REFERENCES products(id),
    supplier_id         INTEGER REFERENCES suppliers(id),
    batch_number        VARCHAR(60),
    -- 4dp, not 2: these are PER-UNIT prices.  A Rs.100 strip of 15 tablets is
    -- Rs.6.6667 each; at 2dp a whole strip bills at Rs.100.05.  SQLite ignores
    -- the scale, so this only bites on a database that enforces it.
    mrp                 NUMERIC(12,4) NOT NULL,    -- printed max retail price
    purchase_price      NUMERIC(10,2) NOT NULL,    -- what we paid (for profit calc)
    selling_price       NUMERIC(12,4) NOT NULL,    -- what we charge
    mfg_date            DATE,
    expiry_date         DATE NOT NULL,
    quantity_received   INTEGER NOT NULL,
    quantity_available  INTEGER NOT NULL,          -- decreases as we sell
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- These indexes make expiry alerts and FEFO billing fast
CREATE INDEX idx_batches_product ON batches(product_id);
CREATE INDEX idx_batches_expiry  ON batches(expiry_date);


-- ------------------------------------------------------------
-- STOCK MOVEMENTS — an audit trail of every stock change
-- (purchase in, sale out, return, adjustment). Module 2 + 23.
-- ------------------------------------------------------------
CREATE TABLE stock_movements (
    id              SERIAL PRIMARY KEY,
    batch_id        INTEGER NOT NULL REFERENCES batches(id),
    movement_type   VARCHAR(20) NOT NULL,   -- 'IN','SALE','RETURN','ADJUST','EXPIRED'
    quantity        INTEGER NOT NULL,       -- positive in, negative out
    reference       VARCHAR(80),            -- e.g. invoice number
    user_id         INTEGER REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ------------------------------------------------------------
-- PATIENTS / CUSTOMERS  (Modules 5, 6, 7, 11)
-- ------------------------------------------------------------
CREATE TABLE patients (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(120) NOT NULL,
    age                 INTEGER,
    gender              VARCHAR(10),
    mobile              VARCHAR(20),
    email               VARCHAR(120),
    address             TEXT,
    patient_type        VARCHAR(30) NOT NULL,  -- 'PRESCRIPTION' or 'SELF_MEDICATION'
    preferred_language  VARCHAR(10) DEFAULT 'BOTH', -- 'AS','EN','BOTH'
    registration_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_patients_mobile ON patients(mobile);

-- A patient can belong to many departments (Module 6) — many-to-many
CREATE TABLE patient_departments (
    patient_id      INTEGER NOT NULL REFERENCES patients(id),
    department_id   INTEGER NOT NULL REFERENCES departments(id),
    PRIMARY KEY (patient_id, department_id)
);

-- Tags (Module 7) — flexible labels, many per patient
CREATE TABLE tags (
    id      SERIAL PRIMARY KEY,
    name    VARCHAR(60) UNIQUE NOT NULL
);

CREATE TABLE patient_tags (
    patient_id  INTEGER NOT NULL REFERENCES patients(id),
    tag_id      INTEGER NOT NULL REFERENCES tags(id),
    PRIMARY KEY (patient_id, tag_id)
);


-- ------------------------------------------------------------
-- BILLING / POS  (Module 4)
-- An invoice has a header (totals, customer) and many lines.
-- ------------------------------------------------------------
CREATE TABLE invoices (
    id                  SERIAL PRIMARY KEY,
    invoice_number      VARCHAR(30) UNIQUE NOT NULL,   -- e.g. HCC-2026-000123
    patient_id          INTEGER REFERENCES patients(id), -- nullable: walk-in
    user_id             INTEGER REFERENCES users(id),    -- who billed it
    invoice_date        TIMESTAMPTZ NOT NULL DEFAULT now(),
    subtotal            NUMERIC(12,2) NOT NULL DEFAULT 0, -- before tax & discount
    discount_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
    gst_amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_method      VARCHAR(20),    -- 'CASH','UPI','CARD'
    status              VARCHAR(20) NOT NULL DEFAULT 'COMPLETED', -- or 'RETURNED'
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoices_date    ON invoices(invoice_date);
CREATE INDEX idx_invoices_patient ON invoices(patient_id);

-- Each line ties to the exact BATCH sold (so profit & stock are exact)
CREATE TABLE invoice_items (
    id              SERIAL PRIMARY KEY,
    invoice_id      INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    batch_id        INTEGER NOT NULL REFERENCES batches(id),
    product_id      INTEGER NOT NULL REFERENCES products(id), -- denormalised for reports
    quantity        INTEGER NOT NULL,
    unit_price      NUMERIC(12,4) NOT NULL,   -- selling price at time of sale (4dp: see batches.mrp)
    purchase_price  NUMERIC(10,2) NOT NULL,   -- snapshot, so profit is locked in
    gst_rate        NUMERIC(5,2) NOT NULL,
    line_total      NUMERIC(12,2) NOT NULL,   -- qty * unit_price (incl. its share)
    -- Phase 3.3: estimated date when this line's supply will run out
    estimated_finish_date DATE
);


-- ------------------------------------------------------------
-- AUDIT LOG  (Module 23)
-- ------------------------------------------------------------
CREATE TABLE audit_log (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id),
    action      VARCHAR(120) NOT NULL,   -- 'PRICE_CHANGE','INVOICE_DELETE'...
    entity      VARCHAR(60),             -- which table/record
    details     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- =============================================================
-- PHASE 2 — PURCHASING MODULE
-- Purchase Orders, GRN, and related items
-- =============================================================

-- A Purchase Order is a REQUEST to a supplier.  It does NOT touch stock.
-- Status lifecycle: DRAFT → SENT → PARTIALLY_RECEIVED → RECEIVED → CANCELLED
CREATE TABLE purchase_orders (
    id            SERIAL PRIMARY KEY,
    po_number     VARCHAR(30) UNIQUE NOT NULL,   -- HCC-PO-YYYY-NNNNNN
    supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
    user_id       INTEGER REFERENCES users(id),
    status        VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    order_date    DATE NOT NULL DEFAULT CURRENT_DATE,
    expected_date DATE,
    notes         TEXT,
    total_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One line per product inside a PO
CREATE TABLE purchase_order_items (
    id               SERIAL PRIMARY KEY,
    po_id            INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    product_id       INTEGER NOT NULL REFERENCES products(id),
    quantity_ordered INTEGER NOT NULL,
    unit_price       NUMERIC(10,2) NOT NULL,
    line_total       NUMERIC(12,2) NOT NULL
);

-- A Goods Receipt Note (GRN) records ACTUAL stock arriving.
-- Each GRN creates batches and stock_movements rows (type='IN').
-- po_id is optional — allows walk-in / direct purchases with no prior PO.
CREATE TABLE goods_receipt_notes (
    id             SERIAL PRIMARY KEY,
    grn_number     VARCHAR(30) UNIQUE NOT NULL,  -- HCC-GRN-YYYY-NNNNNN
    po_id          INTEGER REFERENCES purchase_orders(id),
    supplier_id    INTEGER NOT NULL REFERENCES suppliers(id),
    user_id        INTEGER REFERENCES users(id),
    receipt_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    invoice_number VARCHAR(60),   -- supplier's own invoice number
    notes          TEXT,
    total_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One line per batch received inside a GRN.
-- batch_id is set after the batch is created, so it can be NULL initially
-- but should always be populated before the transaction commits.
CREATE TABLE grn_items (
    id                SERIAL PRIMARY KEY,
    grn_id            INTEGER NOT NULL REFERENCES goods_receipt_notes(id) ON DELETE CASCADE,
    product_id        INTEGER NOT NULL REFERENCES products(id),
    batch_id          INTEGER REFERENCES batches(id),
    batch_number      VARCHAR(60),
    quantity_received INTEGER NOT NULL,
    purchase_price    NUMERIC(10,2) NOT NULL,
    selling_price     NUMERIC(10,2) NOT NULL,
    mrp               NUMERIC(10,2) NOT NULL,
    expiry_date       DATE NOT NULL,
    mfg_date          DATE,
    line_total        NUMERIC(12,2) NOT NULL
);

CREATE INDEX idx_po_supplier  ON purchase_orders(supplier_id);
CREATE INDEX idx_po_status    ON purchase_orders(status);
CREATE INDEX idx_grn_supplier ON goods_receipt_notes(supplier_id);
CREATE INDEX idx_grn_po       ON goods_receipt_notes(po_id);


-- ------------------------------------------------------------
-- PHASE 3 — SMART FOLLOW-UP SYSTEM
-- ------------------------------------------------------------

CREATE TABLE message_templates (
    id              SERIAL PRIMARY KEY,
    code            VARCHAR(60) UNIQUE NOT NULL,
    name            VARCHAR(120) NOT NULL,
    language        VARCHAR(5) NOT NULL,
    channel         VARCHAR(20) NOT NULL DEFAULT 'SMS',
    body_en         TEXT,
    body_as         TEXT,
    variables       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per patient+invoice+day follow-up checkpoint
CREATE TABLE follow_up_schedules (
    id              SERIAL PRIMARY KEY,
    patient_id      INTEGER NOT NULL REFERENCES patients(id),
    invoice_id      INTEGER NOT NULL REFERENCES invoices(id),
    day_number      INTEGER NOT NULL,
    scheduled_date  DATE NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'PENDING',   -- PENDING, COMPLETED, CANCELLED
    template_code   VARCHAR(60),
    cancelled_at    TIMESTAMPTZ,
    cancelled_reason VARCHAR(120),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outbound message ready to be dispatched by an SMS/WhatsApp provider
-- status = QUEUED → SENT or FAILED; or CANCELLED if the schedule was cancelled
CREATE TABLE message_queue (
    id              SERIAL PRIMARY KEY,
    patient_id      INTEGER NOT NULL REFERENCES patients(id),
    follow_up_id    INTEGER REFERENCES follow_up_schedules(id),
    channel         VARCHAR(20) NOT NULL DEFAULT 'SMS',
    recipient_mobile VARCHAR(20) NOT NULL,
    language        VARCHAR(5) NOT NULL DEFAULT 'EN',
    message_body    TEXT NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    scheduled_at    TIMESTAMPTZ NOT NULL,
    sent_at         TIMESTAMPTZ,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recorded patient responses (entered manually by pharmacy staff)
CREATE TABLE patient_responses (
    id              SERIAL PRIMARY KEY,
    patient_id      INTEGER NOT NULL REFERENCES patients(id),
    follow_up_id    INTEGER REFERENCES follow_up_schedules(id),
    response_type   VARCHAR(30) NOT NULL,   -- BETTER, SAME, WORSE, NEED_DOCTOR, CALL_ME
    notes           TEXT,
    recorded_by     INTEGER REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    actioned_at     TIMESTAMPTZ,            -- when staff took action on NEED_DOCTOR / CALL_ME
    action_note     TEXT                    -- note describing action taken
);


-- =============================================================
-- SEED DATA — the minimum needed to log in and start testing
-- =============================================================
INSERT INTO roles (name) VALUES
    ('Owner'), ('Administrator'), ('Pharmacist'),
    ('Billing Staff'), ('Inventory Manager'),
    ('Marketing Staff'), ('OPD Staff');

INSERT INTO categories (name) VALUES
    ('Tablet'), ('Capsule'), ('Syrup'), ('Injection'),
    ('Ointment'), ('Drops'), ('Other');

INSERT INTO departments (name) VALUES
    ('General Medicine'), ('Cardiology'), ('Diabetes'),
    ('Hypertension'), ('Orthopedics'), ('Neurology'),
    ('Dermatology'), ('Gastroenterology'), ('Pediatrics'),
    ('Gynecology'), ('Respiratory'), ('ENT'),
    ('Eye Care'), ('Oncology'), ('Nutrition');


-- ------------------------------------------------------------
-- PHASE 3.4 — MARKETING AUTOMATION
-- ------------------------------------------------------------

-- A campaign is a targeted bulk message sent to a filtered set of patients.
-- status lifecycle: DRAFT → QUEUED → SENT  (or CANCELLED at any stage)
CREATE TABLE campaigns (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(120) NOT NULL,
    description     TEXT,
    campaign_type   VARCHAR(30) NOT NULL,   -- HEALTH_TIP, FESTIVAL, AWARENESS, PROMOTIONAL, RECALL
    channel         VARCHAR(20) NOT NULL DEFAULT 'SMS',
    status          VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    scheduled_at    TIMESTAMPTZ,            -- optional: when to send; NULL = immediately on queue
    sent_at         TIMESTAMPTZ,            -- set when campaign is queued (queue time stamp)
    created_by      INTEGER REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each campaign has 1..N filters that narrow the target patient list.
-- Multiple filters = AND logic (patient must satisfy ALL filters).
CREATE TABLE campaign_filters (
    id              SERIAL PRIMARY KEY,
    campaign_id     INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    filter_type     VARCHAR(30) NOT NULL,   -- TAG, DEPARTMENT, PATIENT_TYPE, GENDER, etc.
    filter_value    TEXT NOT NULL
);

-- One message per language per campaign (EN and/or AS).
-- The body may contain {patient_name} and {shop_name} variables.
CREATE TABLE campaign_messages (
    id              SERIAL PRIMARY KEY,
    campaign_id     INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    language        VARCHAR(5) NOT NULL,    -- EN or AS
    message_body    TEXT NOT NULL
);

-- One row per patient per campaign after the campaign is queued.
-- Mirrors the message_queue table but tracks delivery per recipient.
CREATE TABLE campaign_recipients (
    id              SERIAL PRIMARY KEY,
    campaign_id     INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    patient_id      INTEGER NOT NULL REFERENCES patients(id),
    mobile          VARCHAR(20) NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'QUEUED',  -- QUEUED, SENT, FAILED
    queued_at       TIMESTAMPTZ,
    sent_at         TIMESTAMPTZ,
    error_message   TEXT
);
