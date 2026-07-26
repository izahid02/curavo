/**
 * Medicines Management Page (unified inventory).
 *
 * ONE page that replaces the old separate "Medicines" + "Purchasing" pages.
 * Three tabs:
 *   1. Products        — searchable table of all medicines.  Each row has
 *                        [+ Add Stock] and [✏ Edit] buttons, and a clickable
 *                        stock number that shows a batch-breakdown popover.
 *   2. Add Stock       — bulk entry: receive several medicines from one
 *                        supplier invoice in a single go.
 *   3. Purchase History — every past stock-in event, newest first.
 *
 * The [+ Add Stock] button on a product row opens a slide-in panel (from the
 * right) pre-filled with that medicine, for a single quick stock-in.
 *
 * All API calls go through src/lib/api.js (never call axios directly here).
 * All colours come from CSS variables in global.css (no hardcoded hex values).
 */
import { useState, useEffect, useCallback, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import CameraScanner from '../components/billing/CameraScanner';
import MedicineSearchBox from '../components/shared/MedicineSearchBox';
import { formatDateOnly, getTodayIST } from '../lib/datetime';

// ─── Small reusable helpers ────────────────────────────────────────────────

/** Format a number as Indian Rupees: ₹12.50 */
function inr(amount) {
  if (amount === null || amount === undefined || amount === '') return '—';
  return '₹' + Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Format an ISO date string ("2026-12-31") as "Dec 2026" (month + year), IST. */
function formatMonthYear(isoDate) {
  if (!isoDate) return '—';
  return new Date(isoDate).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', month: 'short', year: 'numeric',
  });
}

/** Format an ISO date string as a full Indian date "15 Jan 2025" in IST. */
const formatDate = formatDateOnly;

/** Today's date as "YYYY-MM-DD" (IST) for date-input defaults. */
const todayISO = getTodayIST;

/** A labelled input field. */
function Field({ label, required, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text)' }}>
        {label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}
      </label>
      {children}
    </div>
  );
}

/** Modal overlay wrapper (portal to body so it is never clipped). */
function Modal({ title, onClose, children, wide }) {
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(30,27,75,0.35)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}   // don't close when clicking modal content
        style={{
          background: 'rgba(255,255,255,0.75)',
          backdropFilter: 'blur(28px)',
          WebkitBackdropFilter: 'blur(28px)',
          border: '1px solid rgba(255,255,255,0.80)',
          borderRadius: 16,
          boxShadow: '0 20px 60px rgba(99,102,241,0.16)',
          padding: '28px 32px',
          width: wide ? 700 : 480,
          maxWidth: '95vw',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ fontSize: 20, margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, color: 'var(--text-muted)', padding: '0 4px', cursor: 'pointer' }}>×</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Badge showing a batch's expiry status. */
function ExpiryBadge({ status }) {
  const MAP = {
    OK:       { label: 'OK',        color: 'var(--ok)'     },
    WARN_90:  { label: '90d',       color: 'var(--ok)'     },
    WARN_60:  { label: '60d',       color: 'var(--warn)'   },
    WARN_30:  { label: '30d',       color: 'var(--warn)'   },
    WARN_7:   { label: '7d',        color: 'var(--danger)' },
    EXPIRED:  { label: 'EXPIRED',   color: 'var(--danger)' },
  };
  const { label, color } = MAP[status] ?? { label: status, color: 'var(--text-muted)' };
  return (
    <span style={{
      background: color, color: '#fff', borderRadius: 4,
      padding: '2px 7px', fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
    }}>
      {label}
    </span>
  );
}

// ─── Add / Edit Product Modal ──────────────────────────────────────────────

const BLANK_PRODUCT = {
  name: '', generic_name: '', brand: '', manufacturer: '',
  category_id: '', hsn_code: '',
  gst_rate: '12', barcode: '', rack_location: '',
  unit: 'unit', min_stock_level: '10',
  // Strip / unit management (Feature 3)
  medicine_type: 'TABLET', is_strip: false,
  units_per_strip: '', strip_mrp: '', unit_mrp: '',
};

// The dosage forms offered as pill-style toggle buttons.
const MEDICINE_TYPES = [
  ['TABLET', 'Tablet'],   ['CAPSULE', 'Capsule'],   ['SYRUP', 'Syrup'],
  ['INJECTION', 'Injection'], ['DROPS', 'Drops'],   ['CREAM', 'Cream'],
  ['OINTMENT', 'Ointment'],   ['POWDER', 'Powder'], ['INHALER', 'Inhaler'],
  ['SUPPOSITORY', 'Suppository'], ['OTHER', 'Other'],
];

// Only tablets and capsules come in strips — a syrup bottle does not.
// Must match STRIP_CAPABLE_TYPES in backend/app/schemas/inventory.py.
const STRIP_CAPABLE = ['TABLET', 'CAPSULE'];

/**
 * One modal used for BOTH "Add New Medicine" and "Edit".
 * Pass `existing` (a full product object) to switch into edit mode — then it
 * pre-fills the form and calls PUT instead of POST.
 */
function ProductFormModal({ existing, categories, onClose, onSaved }) {
  const isEdit = Boolean(existing);
  const [form, setForm] = useState(() =>
    existing
      ? {
          name: existing.name ?? '',
          generic_name: existing.generic_name ?? '',
          brand: existing.brand ?? '',
          manufacturer: existing.manufacturer ?? '',
          category_id: existing.category_id ?? '',
          hsn_code: existing.hsn_code ?? '',
          gst_rate: String(existing.gst_rate ?? '12'),
          barcode: existing.barcode ?? '',
          rack_location: existing.rack_location ?? '',
          unit: existing.unit ?? 'unit',
          min_stock_level: String(existing.min_stock_level ?? '10'),
          medicine_type:   existing.medicine_type ?? 'TABLET',
          is_strip:        Boolean(existing.is_strip),
          units_per_strip: existing.units_per_strip != null ? String(existing.units_per_strip) : '',
          strip_mrp:       existing.strip_mrp != null ? String(existing.strip_mrp) : '',
          unit_mrp:        existing.unit_mrp != null ? String(existing.unit_mrp) : '',
        }
      : BLANK_PRODUCT
  );
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);
  const [scanningBarcode, setScanningBarcode] = useState(false);

  function set(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!form.name.trim())  return setError('Medicine Name is required.');
    if (!form.gst_rate)     return setError('GST Rate is required.');

    setLoading(true);
    try {
      // Strip options only apply to tablets/capsules that are actually sold in
      // strips.  For anything else we send explicit nulls so switching a
      // product away from strips clears its old strip pricing.
      const stripMedicine = form.is_strip && STRIP_CAPABLE.includes(form.medicine_type);

      const payload = {
        ...form,
        category_id:     form.category_id   ? Number(form.category_id)   : null,
        department_id:   null,   // Department removed from the medicine form; always send null
        gst_rate:        Number(form.gst_rate),
        min_stock_level: Number(form.min_stock_level) || 10,
        is_strip:        stripMedicine,
        units_per_strip: stripMedicine && form.units_per_strip ? Number(form.units_per_strip) : null,
        strip_mrp:       stripMedicine && form.strip_mrp       ? Number(form.strip_mrp)       : null,
        unit_mrp:        stripMedicine && form.unit_mrp        ? Number(form.unit_mrp)        : null,
      };
      const { data } = isEdit
        ? await api.put(`/inventory/products/${existing.id}`, payload)
        : await api.post('/inventory/products', payload);
      onSaved(data, isEdit);
      onClose();
    } catch (err) {
      setError(err.response?.data?.detail || `Could not ${isEdit ? 'update' : 'create'} product.`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal title={isEdit ? `Edit — ${existing.name}` : 'Add New Medicine'} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          <div style={{ gridColumn: '1/-1' }}>
            <Field label="Medicine Name" required>
              <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Metformin 500mg" />
            </Field>
          </div>
          <Field label="Generic Name">
            <input value={form.generic_name} onChange={(e) => set('generic_name', e.target.value)} placeholder="e.g. Metformin" />
          </Field>
          <Field label="Brand">
            <input value={form.brand} onChange={(e) => set('brand', e.target.value)} placeholder="e.g. Glucophage" />
          </Field>
          <Field label="Manufacturer">
            <input value={form.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} />
          </Field>
          <Field label="Category">
            <select value={form.category_id} onChange={(e) => set('category_id', e.target.value)}>
              <option value="">— select —</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <div style={{ gridColumn: '1/-1' }}>
            <Field label="HSN Code">
              <input value={form.hsn_code} onChange={(e) => set('hsn_code', e.target.value)} placeholder="e.g. 30049099" />
            </Field>
          </div>
          <Field label="GST Rate (%)" required>
            <select value={form.gst_rate} onChange={(e) => set('gst_rate', e.target.value)}>
              <option value="0">0%</option>
              <option value="5">5%</option>
              <option value="12">12%</option>
              <option value="18">18%</option>
            </select>
          </Field>
          <Field label="Barcode">
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={form.barcode}
                onChange={(e) => set('barcode', e.target.value)}
                placeholder="Scan or type barcode"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                onClick={() => setScanningBarcode(true)}
                title="Scan barcode from camera"
                style={{
                  flexShrink: 0, padding: '0 10px', fontSize: 16,
                  background: 'var(--accent-light)', border: '1px solid rgba(99,102,241,0.25)',
                  borderRadius: 'var(--radius)', cursor: 'pointer', color: 'var(--accent)',
                }}
              >
                📷
              </button>
            </div>
            <CameraScanner
              isOpen={scanningBarcode}
              onClose={() => setScanningBarcode(false)}
              onScan={(code) => { set('barcode', code); setScanningBarcode(false); }}
            />
          </Field>
          <Field label="Rack Location">
            <input value={form.rack_location} onChange={(e) => set('rack_location', e.target.value)} placeholder="e.g. A-3" />
          </Field>
          <Field label="Unit">
            <input value={form.unit} onChange={(e) => set('unit', e.target.value)} placeholder="e.g. strip, bottle, piece" />
          </Field>
          <Field label="Min Stock Level" required>
            <input type="number" min="0" value={form.min_stock_level} onChange={(e) => set('min_stock_level', e.target.value)} />
          </Field>
        </div>

        {/* ── Medicine type + strip options (Feature 3) ─────────────── */}
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
          color: 'var(--text-hint)', margin: '14px 0 10px',
        }}>
          Medicine Type
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 14 }}>
          {MEDICINE_TYPES.map(([value, label]) => {
            const active = form.medicine_type === value;
            return (
              <button
                key={value} type="button"
                onClick={() => {
                  set('medicine_type', value);
                  // Switching to a non-strip form (syrup, cream…) must clear
                  // the strip flag, otherwise the hidden fields would still be
                  // submitted and the backend would reject or ignore them.
                  if (!STRIP_CAPABLE.includes(value)) set('is_strip', false);
                }}
                style={{
                  padding: '6px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 600,
                  cursor: 'pointer',
                  border: active ? '1px solid var(--accent)' : '1px solid var(--glass-border)',
                  background: active ? 'var(--accent-light)' : 'rgba(255,255,255,0.6)',
                  color: active ? 'var(--accent-dark)' : 'var(--text-secondary)',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Strip options — only meaningful for tablets and capsules.
            NOTE: MRP is NOT collected here.  A medicine's price can change with
            every delivery, so the pharmacist enters Strip/Unit MRP in the Add
            Stock panel instead — this form only records that the medicine comes
            in strips and how many tablets each strip holds. */}
        {STRIP_CAPABLE.includes(form.medicine_type) && (
          <div style={{
            background: 'rgba(255,255,255,0.55)', border: '1px solid var(--glass-border)',
            borderRadius: 'var(--radius)', padding: '14px 16px', marginBottom: 14,
          }}>
            {/* Styled toggle switch (replaces the default browser checkbox).
                Clicking anywhere on the row flips form.is_strip. */}
            <div
              onClick={() => set('is_strip', !form.is_strip)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                cursor: 'pointer',
                userSelect: 'none',
                padding: '12px 16px',
                background: form.is_strip
                  ? 'rgba(99,102,241,0.08)'
                  : 'rgba(0,0,0,0.03)',
                borderRadius: '10px',
                border: form.is_strip
                  ? '1px solid rgba(99,102,241,0.3)'
                  : '1px solid rgba(0,0,0,0.08)',
                transition: 'all 0.2s',
              }}
            >
              {/* Toggle switch — the knob slides left/right on toggle */}
              <div style={{
                width: '44px',
                height: '24px',
                borderRadius: '12px',
                background: form.is_strip ? '#6366f1' : '#cbd5e1',
                position: 'relative',
                transition: 'background 0.2s',
                flexShrink: 0,
              }}>
                <div style={{
                  position: 'absolute',
                  top: '3px',
                  left: form.is_strip ? '23px' : '3px',
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  background: 'white',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  transition: 'left 0.2s',
                }} />
              </div>

              {/* Label + helper text */}
              <div>
                <div style={{
                  fontSize: '14px',
                  fontWeight: 600,
                  color: form.is_strip ? '#6366f1' : '#1e1b4b',
                }}>
                  Comes in strips
                </div>
                <div style={{
                  fontSize: '11px',
                  color: '#94a3b8',
                  marginTop: '1px',
                }}>
                  {form.is_strip
                    ? 'Stock counted in individual units'
                    : 'Toggle on for tablet/capsule strips'}
                </div>
              </div>
            </div>

            {form.is_strip && (
              <div style={{ marginTop: '12px' }}>
                <Field label="Units per strip *">
                  <input
                    type="number" min="1" placeholder="e.g. 10"
                    value={form.units_per_strip}
                    onChange={(e) => set('units_per_strip', e.target.value)}
                  />
                </Field>
                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                  MRP is entered when you add stock
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>{error}</p>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Saving…' : (isEdit ? 'Save Changes' : 'Save Product')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Expiry month/year picker ──────────────────────────────────────────────

// Month values are zero-padded ("01".."12") so they slot straight into a
// "YYYY-MM" string without extra formatting.
const MONTHS = [
  ['01', 'January'], ['02', 'February'], ['03', 'March'],     ['04', 'April'],
  ['05', 'May'],     ['06', 'June'],     ['07', 'July'],      ['08', 'August'],
  ['09', 'September'],['10', 'October'],  ['11', 'November'],  ['12', 'December'],
];
// 15 years starting from this year — plenty of runway for medicine expiries.
const EXPIRY_YEARS = Array.from({ length: 15 }, (_, i) => 2025 + i);

/**
 * Two side-by-side dropdowns for choosing an expiry Month + Year.
 *
 * WHY not <input type="month">?  On some machines the browser's native month
 * picker let the user scroll to nonsense years (e.g. 1135), which then got
 * saved as the expiry date.  Plain dropdowns can only offer valid choices.
 */
function MonthYearSelect({ month, year, onMonth, onYear }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <select value={month} onChange={(e) => onMonth(e.target.value)} required style={{ flex: 1 }}>
        <option value="">Month</option>
        {MONTHS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <select value={year} onChange={(e) => onYear(e.target.value)} required style={{ flex: 1 }}>
        <option value="">Year</option>
        {EXPIRY_YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
    </div>
  );
}

// ─── Add Stock slide-in panel ──────────────────────────────────────────────

const BLANK_STOCK = {
  supplier_id: '', supplier_invoice_number: '', supplier_invoice_date: todayISO(),
  batch_number: '', quantity: '', expiry_month: '', expiry_year: '', mrp: '', cost_price: '',
  // Strip pricing (Feature 3): for a strip medicine the pharmacist types the
  // whole-strip price here and `mrp` (the per-UNIT price billed) is auto-derived
  // as strip_mrp ÷ units_per_strip.  Empty/unused for non-strip medicines.
  strip_mrp: '',
  // Payment / supplier credit (Feature 1)
  amount_paid: '', payment_mode: 'CASH', due_date: '',
  // Advance balance adjustment (Feature A) — how much advance to spend
  advance_used: '',
  // Strip entry mode (Feature 3) — 'strips' or 'units'
  qty_mode: 'strips',
  // Purchase scheme (Feature B) — '' means None; 'CUSTOM' shows buy/free inputs
  scheme: '', scheme_buy: '', scheme_free: '',
};

// Quick-select purchase schemes for the Add Stock forms (Feature B).
// Each maps a label to its [buy, free] pair; 'CUSTOM' lets the pharmacist type
// any combination.
const SCHEME_PRESETS = [
  ['',       'None'],
  ['1+1',    '1+1'],
  ['5+1',    '5+1'],
  ['10+1',   '10+1'],
  ['10+2',   '10+2'],
  ['CUSTOM', 'Custom'],
];

/**
 * Resolve a scheme selection into { buy, free, label } (Feature B).
 * Returns null when no usable scheme is set, so callers can skip the fields.
 */
function resolveScheme(scheme, customBuy, customFree) {
  if (!scheme) return null;
  if (scheme === 'CUSTOM') {
    const buy = parseInt(customBuy, 10);
    const free = parseInt(customFree, 10);
    if (!buy || !free || buy <= 0 || free <= 0) return null;
    return { buy, free, label: `${buy}+${free}` };
  }
  const [buy, free] = scheme.split('+').map((n) => parseInt(n, 10));
  if (!buy || !free) return null;
  return { buy, free, label: scheme };
}

/**
 * Bonus / total preview for a scheme (Feature B).
 * bonus = floor(paidQty / buy) x free, exactly like the backend.
 */
function schemePreview(paidQty, scheme) {
  if (!scheme || !paidQty || paidQty <= 0) {
    return { bonus: 0, total: paidQty || 0 };
  }
  const bonus = Math.floor(paidQty / scheme.buy) * scheme.free;
  return { bonus, total: paidQty + bonus };
}

/**
 * Slide-in panel (from the right) to add ONE batch of stock to ONE medicine.
 * Opened by the [+ Add Stock] button on a product row — pre-filled with the
 * medicine name in the header.
 */
function AddStockPanel({ product, suppliers, onClose, onAdded }) {
  const [form, setForm]       = useState({ ...BLANK_STOCK });
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);
  const [shown, setShown]     = useState(false);   // drives the slide-in transition
  // Advance balance for the chosen supplier (Feature A) — null until fetched.
  const [advanceBalance, setAdvanceBalance] = useState(0);
  // Has the pharmacist typed into "Amount Paid Now" yet?  Until they do, the
  // field auto-follows the remaining-after-advance figure, so the default is
  // "pay this delivery in full" (credit only happens if they lower it).
  const [paidTouched, setPaidTouched] = useState(false);
  // Same idea for the "Use advance" box.  Until the pharmacist edits it, the
  // field auto-follows min(advance balance, invoice total) and updates live as
  // quantity/price change.  Once they type in it, we respect their figure.
  const [advanceTouched, setAdvanceTouched] = useState(false);

  // Trigger the slide-in on mount.
  useEffect(() => { setShown(true); }, []);

  function set(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  // ── Advance balance (Feature A) ─────────────────────────────────────────
  // When the supplier changes, fetch how much advance we are holding with
  // them.  A positive balance can be used to offset this delivery instead of
  // paying fresh cash.
  useEffect(() => {
    // A new supplier means a fresh advance figure, so drop any manual edit and
    // let the auto-fill effect below decide the box value again.
    setAdvanceTouched(false);
    if (!form.supplier_id) { setAdvanceBalance(0); set('advance_used', ''); return; }
    let cancelled = false;
    api.get(`/supplier-credit/supplier/${form.supplier_id}`)
      .then(({ data }) => {
        if (cancelled) return;
        const adv = Number(data?.account?.advance_balance) || 0;
        setAdvanceBalance(adv);
        // Do NOT pre-fill advance_used here — that ran before the invoice total
        // was recalculated and left the box showing a stale/partial figure.
        // The derived auto-fill effect below sets it from the CALCULATED
        // invoice total instead, and re-runs live as qty/price change.
      })
      .catch(() => { if (!cancelled) { setAdvanceBalance(0); set('advance_used', ''); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.supplier_id]);

  // ── Strip handling (Feature 3) ──────────────────────────────────────────
  // Stock is ALWAYS stored in individual units.  When the pharmacist enters
  // strips we multiply here, before the value ever leaves the browser.
  const isStrip     = Boolean(product.is_strip && product.units_per_strip);
  const perStrip    = Number(product.units_per_strip) || 1;
  const enterStrips = isStrip && form.qty_mode === 'strips';
  const paidUnits   = enterStrips
    ? (Number(form.quantity) || 0) * perStrip
    : (Number(form.quantity) || 0);

  // ── Scheme maths (Feature B) ────────────────────────────────────────────
  // The pharmacist enters the PAID quantity; the scheme adds free bonus units
  // on top.  Stock stored = paid + bonus; the invoice is still paid-only.
  const scheme      = resolveScheme(form.scheme, form.scheme_buy, form.scheme_free);
  const schemeCalc  = schemePreview(paidUnits, scheme);
  const bonusUnits  = schemeCalc.bonus;
  const totalUnits  = schemeCalc.total;   // paid + bonus — what enters stock

  // ── Payment / credit maths (Feature 1 + A) ──────────────────────────────
  // Invoice total = PAID units x per-unit cost (bonus units are free).  The
  // advance is applied first, then cash; whatever is left becomes credit.
  const costPrice    = Number(form.cost_price) || 0;
  const invoiceTotal = Math.round(paidUnits * costPrice * 100) / 100;
  // Advance actually usable = min(typed, balance, invoice total).
  const advanceUsed  = Math.min(
    Number(form.advance_used) || 0, advanceBalance, invoiceTotal,
  );
  const remaining    = Math.max(0, Math.round((invoiceTotal - advanceUsed) * 100) / 100);
  const paidNow      = Math.min(Number(form.amount_paid) || 0, remaining);
  const creditAmount = Math.max(0, Math.round((remaining - paidNow) * 100) / 100);
  const needsDueDate = creditAmount > 0;
  // True when the advance alone settles the whole invoice — no cash/UPI needed.
  const fullyCovered = invoiceTotal > 0 && remaining <= 0;
  const effectiveCost = totalUnits > 0 && costPrice > 0
    ? Math.round((costPrice * paidUnits / totalUnits) * 100) / 100
    : 0;

  // Derived advance pre-fill (Feature A).  The box value is driven off the
  // CALCULATED invoice total (qty × cost), never off a single field, so it can
  // no longer show ₹40 when the invoice is really ₹400.
  //   • Untouched → auto-fill min(balance, invoice total) and re-run live as
  //     quantity or price change.  With no invoice yet (total 0) the box is
  //     empty rather than showing the full balance.
  //   • Touched   → respect the pharmacist's figure; only trim it DOWN so it
  //     can never exceed what this invoice can absorb.
  useEffect(() => {
    if (advanceTouched) {
      if (invoiceTotal <= 0) return;
      const cap = Math.min(advanceBalance, invoiceTotal);
      setForm((prev) => (Number(prev.advance_used) || 0) > cap
        ? { ...prev, advance_used: String(cap) }
        : prev);
      return;
    }
    const auto = invoiceTotal > 0 ? Math.min(advanceBalance, invoiceTotal) : 0;
    set('advance_used', auto > 0 ? String(auto) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceTotal, advanceBalance, advanceTouched]);

  // Auto-fill "Amount Paid Now" with the remaining-after-advance figure until
  // the pharmacist edits it, so the default is a fully-paid delivery.  Credit
  // then only arises when they deliberately lower this number.
  useEffect(() => {
    if (paidTouched) return;
    set('amount_paid', remaining > 0 ? String(remaining) : '');
  }, [remaining, paidTouched]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    // Client-side validation (backend re-checks everything too).
    if (!form.supplier_id)             return setError('Please choose a supplier.');
    if (!form.supplier_invoice_number.trim()) return setError('Invoice number is required.');
    if (!form.supplier_invoice_date)   return setError('Invoice date is required.');
    if (!form.batch_number.trim())     return setError('Batch number is required.');
    if (!form.quantity || Number(form.quantity) <= 0) return setError('Quantity must be a positive number.');
    if (!form.expiry_month || !form.expiry_year) return setError('Expiry month and year are required.');
    if (!form.mrp || Number(form.mrp) <= 0) return setError('MRP must be a positive number.');
    // A "Custom" scheme needs both numbers filled in.
    if (form.scheme === 'CUSTOM' && !scheme) {
      return setError('Enter both Buy and Free quantities for the custom scheme.');
    }
    // Credit without a due date has no reminder schedule — block it here so
    // the pharmacist fixes it before the request round-trips.
    if (needsDueDate && !form.due_date) {
      return setError('A due date is required when part of the invoice is unpaid.');
    }
    // Combine the two dropdowns into the "YYYY-MM" string the backend expects.
    const expiry_date = `${form.expiry_year}-${form.expiry_month}`;
    // Expiry must be in the future (compare "YYYY-MM" to the current month).
    if (expiry_date < todayISO().slice(0, 7)) return setError('Expiry date must be in the future.');

    setLoading(true);
    try {
      const payload = {
        product_id:              product.id,
        supplier_id:             Number(form.supplier_id),
        supplier_invoice_number: form.supplier_invoice_number.trim(),
        supplier_invoice_date:   form.supplier_invoice_date,
        batch_number:            form.batch_number.trim(),
        // Send the PAID units (strips converted).  The backend adds any scheme
        // bonus itself, so we must NOT include bonus units here.
        quantity:                paidUnits,
        expiry_date:             expiry_date,               // "YYYY-MM"
        mrp:                     Number(form.mrp),
        cost_price:              form.cost_price ? Number(form.cost_price) : null,
        // Strip pricing (Feature 3): for a strip medicine we also send the
        // whole-strip and per-unit prices so the backend can refresh the
        // product's strip_mrp/unit_mrp with the latest figures.  Null for
        // non-strip medicines (the backend ignores them).
        strip_mrp:               isStrip && form.strip_mrp ? Number(form.strip_mrp) : null,
        unit_mrp:                isStrip && form.mrp        ? Number(form.mrp)        : null,
        // Payment / supplier credit
        amount_paid:             paidNow,
        payment_mode:            form.payment_mode,
        supplier_invoice_total:  invoiceTotal || null,
        due_date:                needsDueDate ? form.due_date : null,
        // Advance balance adjustment (Feature A)
        advance_used:            advanceUsed > 0 ? advanceUsed : 0,
        // Purchase scheme (Feature B)
        scheme_buy:              scheme ? scheme.buy : null,
        scheme_free:             scheme ? scheme.free : null,
        scheme_label:            scheme ? scheme.label : null,
      };
      const { data } = await api.post('/inventory/add-stock', payload);
      onAdded(product.id, data.new_total_stock, data.message);
      onClose();
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not add stock.');
    } finally {
      setLoading(false);
    }
  }

  const SECTION = { fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-hint)', margin: '4px 0 10px' };

  return createPortal(
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(30,27,75,0.35)', backdropFilter: 'blur(3px)', zIndex: 1200, display: 'flex', justifyContent: 'flex-end' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440, maxWidth: '95vw', height: '100%',
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(28px)', WebkitBackdropFilter: 'blur(28px)',
          borderLeft: '1px solid rgba(255,255,255,0.8)',
          boxShadow: '-12px 0 40px rgba(99,102,241,0.14)',
          display: 'flex', flexDirection: 'column',
          transform: shown ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.25s ease',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: '1px solid rgba(99,102,241,0.12)' }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-hint)', fontWeight: 600 }}>ADD STOCK</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>{product.name}</div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 24, color: 'var(--text-muted)', cursor: 'pointer' }}>×</button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: 22, overflowY: 'auto', flex: 1 }}>
          <div style={SECTION}>Supplier Details</div>
          <Field label="Supplier" required>
            <select value={form.supplier_id} onChange={(e) => set('supplier_id', e.target.value)}>
              <option value="">— select supplier —</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Invoice No." required>
            <input value={form.supplier_invoice_number} onChange={(e) => set('supplier_invoice_number', e.target.value)} placeholder="e.g. INV-2025-001" />
          </Field>
          <Field label="Invoice Date" required>
            <input type="date" value={form.supplier_invoice_date} onChange={(e) => set('supplier_invoice_date', e.target.value)} />
          </Field>

          <div style={{ ...SECTION, marginTop: 18 }}>Batch Details</div>
          <Field label="Batch No." required>
            <input value={form.batch_number} onChange={(e) => set('batch_number', e.target.value)} placeholder="e.g. AMX-001" />
          </Field>

          {/* ── Purchase scheme (Feature B) ─────────────────────────────────
              Distributor schemes like "5+1" (buy 5, get 1 free).  The bonus
              units enter stock free; the invoice stays paid-only. */}
          <div style={{ ...SECTION, marginTop: 6 }}>Purchase Scheme (optional)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: form.scheme === 'CUSTOM' ? 10 : 4 }}>
            {SCHEME_PRESETS.map(([value, label]) => {
              const active = form.scheme === value;
              return (
                <button
                  key={value || 'none'} type="button"
                  onClick={() => set('scheme', value)}
                  style={{
                    padding: '6px 14px', borderRadius: 'var(--radius)',
                    fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                    border: active ? '1px solid var(--accent)' : '1px solid var(--glass-border)',
                    background: active ? 'var(--accent-light)' : 'rgba(255,255,255,0.6)',
                    color: active ? 'var(--accent-dark)' : 'var(--text-secondary)',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {form.scheme === 'CUSTOM' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Buy</span>
              <input type="number" min="1" value={form.scheme_buy} onChange={(e) => set('scheme_buy', e.target.value)} placeholder="5" style={{ width: 70 }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-hint)' }}>+</span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Free</span>
              <input type="number" min="1" value={form.scheme_free} onChange={(e) => set('scheme_free', e.target.value)} placeholder="1" style={{ width: 70 }} />
            </div>
          )}
          {scheme && paidUnits > 0 && (
            <div style={{
              background: 'var(--info-bg)', border: '1px solid rgba(14,165,233,0.22)',
              borderRadius: 'var(--radius)', padding: '10px 14px', marginBottom: 12, fontSize: 12.5,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ color: 'var(--text-secondary)' }}>Quantity you're buying (paid)</span>
                <strong>{paidUnits.toLocaleString('en-IN')}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ color: 'var(--text-secondary)' }}>Scheme</span>
                <strong>{scheme.label}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, color: 'var(--ok)' }}>
                <span>Bonus units (free)</span>
                <strong>+{bonusUnits.toLocaleString('en-IN')}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 4, marginTop: 4 }}>
                <span style={{ fontWeight: 700, color: 'var(--text)' }}>Total stock added</span>
                <strong style={{ color: 'var(--accent-dark)' }}>{totalUnits.toLocaleString('en-IN')} units</strong>
              </div>
              {effectiveCost > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, color: 'var(--text-hint)' }}>
                  <span>Effective cost/unit</span>
                  <span>{inr(effectiveCost)}</span>
                </div>
              )}
            </div>
          )}

          {/* Strip medicines: let the pharmacist count in strips (how the box
              actually arrives) while we still store individual units. */}
          {isStrip && (
            <div style={{
              background: 'rgba(255,255,255,0.55)', border: '1px solid var(--glass-border)',
              borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 14,
            }}>
              <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
                {[['strips', 'Enter in strips'], ['units', 'Enter units']].map(([mode, label]) => (
                  <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="radio" name="qty_mode" checked={form.qty_mode === mode}
                      onChange={() => set('qty_mode', mode)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Units per strip: <strong>{perStrip}</strong> (from the medicine record)
              </div>
              {enterStrips && (
                <div style={{ fontSize: 13, color: 'var(--accent-dark)', fontWeight: 600, marginTop: 4 }}>
                  Total units: {totalUnits.toLocaleString('en-IN')}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px' }}>
            <Field label={enterStrips ? 'Number of Strips' : 'Quantity (units)'} required>
              <input
                type="number" min="1" value={form.quantity}
                onChange={(e) => set('quantity', e.target.value)}
                placeholder={enterStrips ? 'e.g. 50' : 'e.g. 100'}
              />
            </Field>
            <Field label="Expiry (Month/Year)" required>
              <MonthYearSelect
                month={form.expiry_month} year={form.expiry_year}
                onMonth={(v) => set('expiry_month', v)} onYear={(v) => set('expiry_year', v)}
              />
            </Field>
          </div>

          {/* Pricing.  For a strip medicine the pharmacist enters the whole-strip
              price and we auto-derive the per-UNIT price (`form.mrp`) that stock
              and billing actually use.  For a normal medicine it is one MRP field. */}
          {isStrip ? (
            <>
              {/* Strip MRP (typed) + Unit MRP (auto, editable) */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '12px' }}>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: '#1e1b4b', display: 'block', marginBottom: '4px' }}>
                    Strip MRP (₹) *
                    <span style={{ fontSize: '10px', color: '#64748b', fontWeight: 400 }}>
                      {' '}— per strip of {perStrip} tablets
                    </span>
                  </label>
                  <input
                    type="number" step="0.01" min="0" required
                    value={form.strip_mrp}
                    onChange={(e) => {
                      const smrp = e.target.value;
                      set('strip_mrp', smrp);
                      // Auto-calculate the per-unit MRP (what the batch stores
                      // and billing uses).  Blank the derived field if the strip
                      // price is cleared so we never bill from a stale figure.
                      if (smrp !== '' && perStrip > 0) {
                        set('mrp', (parseFloat(smrp) / perStrip).toFixed(2));
                      } else {
                        set('mrp', '');
                      }
                    }}
                    placeholder="e.g. 95.00"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '14px' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: '#1e1b4b', display: 'block', marginBottom: '4px' }}>
                    Unit MRP (₹)
                    <span style={{ fontSize: '10px', color: '#64748b', fontWeight: 400 }}>
                      {' '}— per tablet (auto)
                    </span>
                  </label>
                  <input
                    type="number" step="0.01" min="0"
                    value={form.mrp}
                    onChange={(e) => set('mrp', e.target.value)}
                    placeholder="auto-calculated"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '14px', background: 'rgba(99,102,241,0.04)' }}
                  />
                </div>
              </div>
              <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                Unit MRP = Strip MRP ÷ {perStrip} · editable if your unit price differs
              </div>

              {/* Purchase Price (per unit) on its own row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '12px' }}>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: '#1e1b4b', display: 'block', marginBottom: '4px' }}>
                    Purchase Price (₹)
                    <span style={{ fontSize: '10px', color: '#64748b', fontWeight: 400 }}> — per unit, optional</span>
                  </label>
                  <input
                    type="number" step="0.01" min="0"
                    value={form.cost_price} onChange={(e) => set('cost_price', e.target.value)}
                    placeholder="what you paid"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '14px' }}
                  />
                  <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '3px' }}>
                    Used for profit tracking and expiry loss calculation
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '12px' }}>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: '#1e1b4b', display: 'block', marginBottom: '4px' }}>
                  MRP (₹) *
                  <span style={{ fontSize: '10px', color: '#64748b', fontWeight: 400 }}> — printed on pack</span>
                </label>
                <input
                  type="number" step="0.01" min="0" required
                  value={form.mrp} onChange={(e) => set('mrp', e.target.value)}
                  placeholder="e.g. 95.00"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '14px' }}
                />
              </div>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: '#1e1b4b', display: 'block', marginBottom: '4px' }}>
                  Purchase Price (₹)
                  <span style={{ fontSize: '10px', color: '#64748b', fontWeight: 400 }}> — optional</span>
                </label>
                <input
                  type="number" step="0.01" min="0"
                  value={form.cost_price} onChange={(e) => set('cost_price', e.target.value)}
                  placeholder="what you paid"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '14px' }}
                />
                <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '3px' }}>
                  Used for profit tracking and expiry loss calculation
                </div>
              </div>
            </div>
          )}

          {/* ── Payment details (Feature 1) ──────────────────────────── */}
          {/*
            Anything not paid at delivery becomes supplier credit — money we
            owe.  The invoice total is derived from units x cost price, so it
            stays correct whether the pharmacist entered strips or units.
          */}
          <div style={{ ...SECTION, marginTop: 20 }}>Payment Details</div>

          {/* ── Advance available (Feature A) ─────────────────────────────
              This supplier is holding money of ours (overpayment or return
              credit).  Offer to spend it on this delivery instead of cash. */}
          {advanceBalance > 0 && invoiceTotal > 0 && (
            <div style={{
              background: 'var(--warn-bg)', border: '1px solid rgba(245,158,11,0.3)',
              borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 12,
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--warn)' }}>
                💰 Advance Available: {inr(advanceBalance)}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 8 }}>
                from {suppliers.find((s) => String(s.id) === String(form.supplier_id))?.name || 'this supplier'}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Use advance:</span>
                <input
                  type="number" min="0" step="0.01"
                  value={form.advance_used}
                  onChange={(e) => { set('advance_used', e.target.value); setAdvanceTouched(true); }}
                  style={{ width: 110 }}
                />
                {/* Use All → cap at what this invoice can absorb and hand control
                    back to the auto-fill (touched = false) so it tracks again. */}
                <button type="button" onClick={() => { set('advance_used', String(Math.min(advanceBalance, invoiceTotal))); setAdvanceTouched(false); }}
                  style={{ background: 'none', border: '1px solid var(--warn)', color: 'var(--warn)', borderRadius: 'var(--radius)', padding: '4px 10px', fontSize: 11.5, cursor: 'pointer', fontWeight: 600 }}>
                  Use All
                </button>
                <button type="button" onClick={() => { set('advance_used', '0'); setAdvanceTouched(true); }}
                  title="Don't use advance"
                  style={{ background: 'none', border: 'none', color: 'var(--text-hint)', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>
                  ×
                </button>
              </div>
            </div>
          )}

          <div style={{
            background: 'rgba(255,255,255,0.55)', border: '1px solid var(--glass-border)',
            borderRadius: 'var(--radius)', padding: '14px 16px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: advanceUsed > 0 ? 6 : 12 }}>
              <span style={{ color: 'var(--text-secondary)' }}>Invoice Total (auto)</span>
              <strong style={{ color: 'var(--text)' }}>
                {costPrice > 0 ? inr(invoiceTotal) : '— enter purchase price'}
              </strong>
            </div>
            {/* Advance offset + remaining (Feature A) — only when advance is used */}
            {advanceUsed > 0 && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Less Advance Used</span>
                  <strong style={{ color: 'var(--ok)' }}>− {inr(advanceUsed)}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 12, borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 6 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Remaining</span>
                  <strong style={{ color: 'var(--text)' }}>{inr(remaining)}</strong>
                </div>
              </>
            )}

            {/* When the advance covers the whole invoice there is nothing left
                to pay — hide the payment mode + amount fields and confirm it. */}
            {fullyCovered ? (
              <div style={{
                background: 'var(--ok-bg)', border: '1px solid rgba(16,185,129,0.35)',
                borderRadius: 'var(--radius)', padding: '12px 14px',
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ok)' }}>
                  ✓ Fully covered by advance balance
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                  No additional payment needed.
                </div>
              </div>
            ) : (
              <>
                <Field label="Payment Mode" required>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {['CASH', 'UPI'].map((mode) => {
                      const active = form.payment_mode === mode;
                      return (
                        <button
                          key={mode} type="button"
                          onClick={() => set('payment_mode', mode)}
                          style={{
                            flex: 1, padding: '7px 0', borderRadius: 'var(--radius)',
                            fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                            border: active ? '1px solid var(--accent)' : '1px solid var(--glass-border)',
                            background: active ? 'var(--accent-light)' : 'rgba(255,255,255,0.6)',
                            color: active ? 'var(--accent-dark)' : 'var(--text-secondary)',
                          }}
                        >
                          {mode}
                        </button>
                      );
                    })}
                  </div>
                </Field>

                <Field label="Amount Paid Now (₹)" required>
                  <input
                    type="number" min="0" step="0.01"
                    value={form.amount_paid}
                    onChange={(e) => { setPaidTouched(true); set('amount_paid', e.target.value); }}
                    placeholder="0.00"
                  />
                  {remaining > 0 && (
                    <button
                      type="button"
                      onClick={() => { setPaidTouched(true); set('amount_paid', String(remaining)); }}
                      style={{
                        background: 'none', border: 'none', color: 'var(--accent)',
                        fontSize: 11.5, cursor: 'pointer', padding: '4px 0 0',
                      }}
                    >
                      Pay {advanceUsed > 0 ? 'remaining' : 'full invoice'} ({inr(remaining)})
                    </button>
                  )}
                </Field>
              </>
            )}

            {/* Credit block — only when something is left unpaid */}
            {needsDueDate && (
              <div style={{
                background: 'var(--warn-bg)', border: '1px solid rgba(245,158,11,0.25)',
                borderRadius: 'var(--radius)', padding: '12px 14px', marginTop: 6,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 10 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Credit Amount (auto)</span>
                  <strong style={{ color: 'var(--warn)' }}>{inr(creditAmount)}</strong>
                </div>
                <Field label="Due Date" required>
                  <input
                    type="date" min={todayISO()}
                    value={form.due_date}
                    onChange={(e) => set('due_date', e.target.value)}
                  />
                </Field>
                <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: 0 }}>
                  Payment reminders are scheduled 5 days before, on, and 2 days after this date.
                </p>
              </div>
            )}
          </div>

          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 10 }}>{error}</p>}
        </form>

        {/* Footer actions */}
        <div style={{ display: 'flex', gap: 10, padding: '16px 22px', borderTop: '1px solid rgba(99,102,241,0.12)' }}>
          <button type="button" className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button type="button" className="btn-primary" onClick={handleSubmit} disabled={loading} style={{ flex: 1 }}>
            {loading ? 'Saving…' : 'Add Stock ✓'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Batch breakdown popover ───────────────────────────────────────────────

/**
 * Small floating card showing the batch breakdown for a product, anchored to
 * the clicked stock number.  Rendered via a portal (position:fixed) so it is
 * never clipped by the table's overflow container.
 */
function BatchPopover({ anchorRect, batches, loading, onClose }) {
  // Position just below the clicked element.
  const top  = anchorRect.bottom + 6;
  const left = Math.min(anchorRect.left, window.innerWidth - 300);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <>
      {/* Invisible full-screen catcher closes the popover on outside click */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1300 }} />
      <div style={{
        position: 'fixed', top, left, width: 280, zIndex: 1301,
        background: 'rgba(255,255,255,0.97)',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.85)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: '0 12px 40px rgba(99,102,241,0.18)',
        padding: '12px 14px',
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-hint)', marginBottom: 8 }}>
          Batch Breakdown
        </div>
        {loading ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '6px 0' }}>Loading…</div>
        ) : batches.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '6px 0' }}>No stock batches yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {batches.map((b) => (
              <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                <div>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {b.batch_number || '—'}
                    {/* Scheme badge (Feature B) — only when the batch was on a scheme */}
                    {b.scheme_label && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 6,
                        background: 'var(--info-bg)', color: 'var(--info)',
                      }}>
                        {b.scheme_label}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Expiry {formatMonthYear(b.expiry_date)}
                    {b.scheme_label && b.bonus_quantity > 0 && ` · ${b.bonus_quantity} bonus`}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700 }}>{b.quantity_available} units</span>
                  <ExpiryBadge status={b.expiry_status} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}

// ─── Tab 1: Products ───────────────────────────────────────────────────────

function ProductsTab({ categories, suppliers, showToast }) {
  const [products, setProducts]           = useState([]);
  const [total, setTotal]                 = useState(0);
  const [page, setPage]                   = useState(1);
  const [search, setSearch]               = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loading, setLoading]             = useState(false);
  const [showAddModal, setShowAddModal]   = useState(false);
  const [editProduct, setEditProduct]     = useState(null);   // full product for edit modal
  const [addStockProduct, setAddStockProduct] = useState(null); // product for slide-in
  const [popover, setPopover]             = useState(null);   // { anchorRect, batches, loading }
  const limit = 20;

  // Debounce search: wait 300ms after typing stops before hitting the API
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchProducts = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page, limit });
    if (debouncedSearch) params.set('search', debouncedSearch);
    api.get(`/inventory/products?${params}`)
      .then(({ data }) => { setProducts(data.items); setTotal(data.total); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [debouncedSearch, page]);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  // Open the batch-breakdown popover for a product (fetch batches on demand).
  async function openBatchPopover(e, product) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setPopover({ anchorRect: rect, batches: [], loading: true });
    try {
      const { data } = await api.get(`/inventory/batches/${product.id}`);
      // Show batches that still have stock, earliest expiry first (already sorted).
      setPopover({ anchorRect: rect, batches: data.filter((b) => b.quantity_available > 0), loading: false });
    } catch {
      setPopover({ anchorRect: rect, batches: [], loading: false });
    }
  }

  // Load full product detail, then open the edit modal.
  async function openEdit(product) {
    try {
      const { data } = await api.get(`/inventory/products/${product.id}`);
      setEditProduct(data);
    } catch {
      showToast('Could not load product for editing.');
    }
  }

  function handleCreated(newProduct) {
    setProducts((prev) => [
      {
        id: newProduct.id, name: newProduct.name,
        generic_name: newProduct.generic_name, barcode: newProduct.barcode,
        current_stock: newProduct.current_stock,
        min_stock_level: newProduct.min_stock_level,
        gst_rate: newProduct.gst_rate, is_active: newProduct.is_active,
      },
      ...prev,
    ]);
    setTotal((t) => t + 1);
    showToast(`Medicine added — ${newProduct.name}`);
  }

  function handleEdited(updated) {
    setProducts((prev) => prev.map((p) => (
      p.id === updated.id
        ? { ...p, name: updated.name, generic_name: updated.generic_name, barcode: updated.barcode, gst_rate: updated.gst_rate, min_stock_level: updated.min_stock_level }
        : p
    )));
    showToast(`Saved — ${updated.name}`);
  }

  // After a successful Add Stock, update that product's stock number in place.
  function handleStockAdded(productId, newTotal, message) {
    setProducts((prev) => prev.map((p) => (
      p.id === productId ? { ...p, current_stock: newTotal } : p
    )));
    showToast(message);
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, generic name, or barcode…"
          style={{ maxWidth: 380 }}
        />
        <div style={{ marginLeft: 'auto' }}>
          <button className="btn-primary" onClick={() => setShowAddModal(true)}>
            + Add New Medicine
          </button>
        </div>
      </div>

      {/* Product table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
        ) : products.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
            {debouncedSearch ? 'No products match that search.' : 'No products yet. Click "+ Add New Medicine" to get started.'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ background: 'var(--bg)' }}>
                {['Name', 'Generic Name', 'Barcode', 'Stock', 'Min Stock', 'GST%', 'Status', 'Actions'].map((h) => (
                  <th key={h} style={{ padding: '12px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const stockOk = p.current_stock >= p.min_stock_level;
                return (
                  <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '11px 14px', fontWeight: 600 }}>{p.name}</td>
                    <td style={{ padding: '11px 14px', color: 'var(--text-muted)' }}>{p.generic_name || '—'}</td>
                    <td style={{ padding: '11px 14px', fontFamily: 'monospace', fontSize: 12 }}>{p.barcode || '—'}</td>
                    {/* Clickable stock number → batch breakdown popover */}
                    <td style={{ padding: '11px 14px' }}>
                      <button
                        onClick={(e) => openBatchPopover(e, p)}
                        title="Click to see batch breakdown"
                        style={{
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          fontWeight: 700, fontSize: 14, padding: 0,
                          color: stockOk ? 'var(--ok)' : 'var(--danger)',
                          textDecoration: 'underline dotted', textUnderlineOffset: 3,
                        }}
                      >
                        {p.current_stock}
                      </button>
                    </td>
                    <td style={{ padding: '11px 14px' }}>{p.min_stock_level}</td>
                    <td style={{ padding: '11px 14px' }}>{p.gst_rate}%</td>
                    <td style={{ padding: '11px 14px' }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '3px 8px',
                        borderRadius: 4, background: stockOk ? 'var(--ok)' : 'var(--danger)', color: '#fff',
                      }}>
                        {stockOk ? 'In Stock' : 'Low'}
                      </span>
                    </td>
                    {/* Row actions */}
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={() => setAddStockProduct(p)}
                          className="btn-primary"
                          style={{ padding: '5px 10px', fontSize: 12 }}
                        >
                          + Add Stock
                        </button>
                        <button
                          onClick={() => openEdit(p)}
                          className="btn-secondary"
                          style={{ padding: '5px 10px', fontSize: 12 }}
                        >
                          ✏ Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', justifyContent: 'flex-end' }}>
          <button disabled={page === 1} onClick={() => setPage((p) => p - 1)} className="btn-secondary" style={{ padding: '6px 14px', fontSize: 13 }}>← Prev</button>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Page {page} of {totalPages}</span>
          <button disabled={page === totalPages} onClick={() => setPage((p) => p + 1)} className="btn-secondary" style={{ padding: '6px 14px', fontSize: 13 }}>Next →</button>
        </div>
      )}

      {/* Add product modal */}
      {showAddModal && (
        <ProductFormModal
          categories={categories}
          onClose={() => setShowAddModal(false)}
          onSaved={handleCreated}
        />
      )}

      {/* Edit product modal */}
      {editProduct && (
        <ProductFormModal
          existing={editProduct}
          categories={categories}
          onClose={() => setEditProduct(null)}
          onSaved={handleEdited}
        />
      )}

      {/* Add Stock slide-in panel */}
      {addStockProduct && (
        <AddStockPanel
          product={addStockProduct}
          suppliers={suppliers}
          onClose={() => setAddStockProduct(null)}
          onAdded={handleStockAdded}
        />
      )}

      {/* Batch breakdown popover */}
      {popover && (
        <BatchPopover
          anchorRect={popover.anchorRect}
          batches={popover.batches}
          loading={popover.loading}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  );
}

// ─── Tab 2: Add Stock (bulk entry) ─────────────────────────────────────────

const BLANK_ROW = () => ({
  key: Math.random().toString(36).slice(2),
  product: null,           // { id, name } once chosen
  batch_number: '', quantity: '', expiry_month: '', expiry_year: '', mrp: '', cost_price: '',
  // Purchase scheme (Feature B) — '' = None, or a preset / 'CUSTOM'
  scheme: '', scheme_buy: '', scheme_free: '',
});

function BulkAddStockTab({ suppliers, showToast }) {
  const [supplierId, setSupplierId]   = useState('');
  const [invoiceNo, setInvoiceNo]     = useState('');
  const [invoiceDate, setInvoiceDate] = useState(todayISO());
  const [rows, setRows]               = useState([BLANK_ROW(), BLANK_ROW()]);
  const [error, setError]             = useState('');
  const [submitting, setSubmitting]   = useState(false);
  const [result, setResult]           = useState(null);   // { added, failed:[{name,msg}] }

  // ── Payment / supplier credit state ────────────────────────────────────
  // One payment covers the WHOLE delivery, not each medicine — the supplier
  // sends one invoice, so the pharmacist pays one figure against it.
  const [amountPaid, setAmountPaid]   = useState('0');
  const [paymentMode, setPaymentMode] = useState('CASH');
  const [dueDate, setDueDate]         = useState('');
  // Advance balance for the chosen supplier (Feature A).
  const [advanceBalance, setAdvanceBalance] = useState(0);
  const [advanceUsedInput, setAdvanceUsedInput] = useState('');
  // Has the pharmacist edited "Amount Paid Now" yet?  Until they do it follows
  // the remaining-after-advance figure (default = pay the delivery in full).
  const [paidTouched, setPaidTouched] = useState(false);
  // Same idea for the "Use advance" box.  Until the pharmacist edits it, the
  // field auto-follows min(advance balance, invoice total) and updates live as
  // the rows' quantities/prices change.  Once they type in it, respect it.
  const [advanceTouched, setAdvanceTouched] = useState(false);

  function setRow(key, patch) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addRow()          { setRows((prev) => [...prev, BLANK_ROW()]); }
  function removeRow(key)    { setRows((prev) => prev.filter((r) => r.key !== key)); }

  // ── Advance balance (Feature A) ─────────────────────────────────────────
  // Fetch the advance we hold with the chosen supplier so it can offset this
  // whole delivery instead of paying fresh cash.
  useEffect(() => {
    // A new supplier means a fresh advance figure, so drop any manual edit and
    // let the auto-fill effect below decide the box value again.
    setAdvanceTouched(false);
    if (!supplierId) { setAdvanceBalance(0); setAdvanceUsedInput(''); return; }
    let cancelled = false;
    api.get(`/supplier-credit/supplier/${supplierId}`)
      .then(({ data }) => {
        if (cancelled) return;
        const adv = Number(data?.account?.advance_balance) || 0;
        setAdvanceBalance(adv);
        // Do NOT pre-fill advanceUsedInput here — that ran before the rows had
        // been totalled and left the box showing a stale/partial figure.  The
        // derived auto-fill effect below sets it from the CALCULATED invoice
        // total instead, and re-runs live as the rows change.
      })
      .catch(() => { if (!cancelled) { setAdvanceBalance(0); setAdvanceUsedInput(''); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId]);

  // ── Payment maths ───────────────────────────────────────────────────────
  // Each row's line total = purchase price x PAID quantity.  Rows without a
  // purchase price contribute 0 (it is an optional field), so they simply do
  // not add to the amount we owe.  Scheme bonus units are free, so they do not
  // change the invoice.
  function lineTotal(r) {
    return (parseFloat(r.cost_price) || 0) * (parseInt(r.quantity, 10) || 0);
  }
  // Round to paise at every step — floats drift otherwise (0.1 + 0.2 !== 0.3).
  const invoiceTotal = Math.round(rows.reduce((sum, r) => sum + lineTotal(r), 0) * 100) / 100;

  // Advance actually usable across the whole delivery.
  const advanceUsed = Math.min(parseFloat(advanceUsedInput) || 0, advanceBalance, invoiceTotal);
  const afterAdvance = Math.max(0, Math.round((invoiceTotal - advanceUsed) * 100) / 100);

  // Paying MORE than what's left after the advance is pointless, so cap it.
  const paidNow = Math.min(parseFloat(amountPaid) || 0, afterAdvance);
  const creditAmount = Math.max(0, Math.round((afterAdvance - paidNow) * 100) / 100);
  const needsDueDate = creditAmount > 0;
  // True when the advance alone settles the whole delivery — no cash/UPI needed.
  const fullyCovered = invoiceTotal > 0 && afterAdvance <= 0;

  // Derived advance pre-fill (Feature A).  The box value is driven off the
  // CALCULATED invoice total (sum of qty × cost across all rows), never off a
  // single field, so it can no longer show a partial figure.
  //   • Untouched → auto-fill min(balance, invoice total), re-running live as
  //     any row's qty/price change.  With no total yet the box is empty.
  //   • Touched   → respect the pharmacist's figure; only trim it DOWN so it
  //     can never exceed what this delivery can absorb.
  useEffect(() => {
    if (advanceTouched) {
      if (invoiceTotal <= 0) return;
      const cap = Math.min(advanceBalance, invoiceTotal);
      setAdvanceUsedInput((prev) => (parseFloat(prev) || 0) > cap ? String(cap) : prev);
      return;
    }
    const auto = invoiceTotal > 0 ? Math.min(advanceBalance, invoiceTotal) : 0;
    setAdvanceUsedInput(auto > 0 ? String(auto) : '');
  }, [invoiceTotal, advanceBalance, advanceTouched]);

  // Auto-follow the remaining-after-advance figure in "Amount Paid Now" until
  // the pharmacist edits it — default is a fully-paid delivery.
  useEffect(() => {
    if (paidTouched) return;
    setAmountPaid(afterAdvance > 0 ? String(afterAdvance) : '0');
  }, [afterAdvance, paidTouched]);

  /**
   * Split the single payment across the rows.
   *
   * We pay rows off one at a time in order until the money runs out
   * ("waterfall"), rather than splitting the payment evenly.  Two reasons:
   *   1. Every row lands on an exact paise figure, and the parts always add
   *      back up to exactly what was typed — an even split leaves rounding
   *      crumbs that make the ledger disagree with the paper invoice.
   *   2. A fully-paid delivery creates NO credit rows at all, so the supplier
   *      ledger never shows debt that did not exist.
   * Returns an array of amounts, one per row, in the same order.
   */
  /**
   * Split the single advance across the rows the same waterfall way (Feature A).
   * Advance is applied to a row BEFORE cash, so it consumes each row's total
   * from the top.  Returns an array of advance amounts, one per row.
   */
  function allocateAdvance(filledRows) {
    let remaining = advanceUsed;
    return filledRows.map((r) => {
      const owed = Math.round(lineTotal(r) * 100) / 100;
      const use  = Math.min(remaining, owed);
      remaining  = Math.round((remaining - use) * 100) / 100;
      return use;
    });
  }

  async function handleSubmitAll() {
    setError('');
    setResult(null);

    if (!supplierId)        return setError('Please choose a supplier.');
    if (!invoiceNo.trim())  return setError('Invoice number is required.');
    if (!invoiceDate)       return setError('Invoice date is required.');

    // Keep only rows that have a medicine chosen.
    const filled = rows.filter((r) => r.product);
    if (filled.length === 0) return setError('Add at least one medicine.');

    // Validate each filled row.
    for (const r of filled) {
      if (!r.batch_number.trim()) return setError(`Batch number missing for ${r.product.name}.`);
      if (!r.quantity || Number(r.quantity) <= 0) return setError(`Quantity must be positive for ${r.product.name}.`);
      if (!r.expiry_month || !r.expiry_year) return setError(`Expiry month and year missing for ${r.product.name}.`);
      // Combine dropdowns into "YYYY-MM" and check it is in the future.
      if (`${r.expiry_year}-${r.expiry_month}` < todayISO().slice(0, 7)) return setError(`Expiry must be in the future for ${r.product.name}.`);
      if (!r.mrp || Number(r.mrp) <= 0) return setError(`MRP must be positive for ${r.product.name}.`);
      // A "Custom" scheme needs both numbers.
      if (r.scheme === 'CUSTOM' && !resolveScheme(r.scheme, r.scheme_buy, r.scheme_free)) {
        return setError(`Enter both Buy and Free for the custom scheme on ${r.product.name}.`);
      }
    }

    // Credit without a due date has no reminder schedule, and the backend
    // rejects it anyway — catch it here so nothing is written before the
    // pharmacist fixes it.  (An empty/garbled Amount Paid reads as 0 via
    // parseFloat above, i.e. the whole invoice goes on credit.)
    if (needsDueDate && !dueDate) {
      return setError('Due date is required when paying on credit.');
    }

    setSubmitting(true);
    const failed = [];
    let added = 0;
    // Waterfall the single advance, then the single payment, across the rows.
    // Advance is applied to each row BEFORE cash (see allocateAdvance).
    const advancePerRow = allocateAdvance(filled);
    let payRemaining = paidNow;
    const paidPerRow = filled.map((r, i) => {
      const rowTotal = Math.round(lineTotal(r) * 100) / 100;
      const rowLeft  = Math.round((rowTotal - advancePerRow[i]) * 100) / 100;
      const pay      = Math.min(payRemaining, rowLeft);
      payRemaining   = Math.round((payRemaining - pay) * 100) / 100;
      return pay;
    });
    // Collected so we can report the real credit figure after the run — rows
    // can fail individually, so we cannot trust the pre-submit estimate.
    let creditCreated = 0;

    // Submit each row one at a time (offline-safe, clear per-row errors).
    for (let i = 0; i < filled.length; i += 1) {
      const r          = filled[i];
      const rowTotal   = Math.round(lineTotal(r) * 100) / 100;
      const rowAdvance = advancePerRow[i];
      const rowPaid    = paidPerRow[i];
      // This row leaves a balance -> it needs the due date attached.
      const rowCredit  = Math.round((rowTotal - rowAdvance - rowPaid) * 100) / 100;
      const rowScheme  = resolveScheme(r.scheme, r.scheme_buy, r.scheme_free);
      try {
        const { data } = await api.post('/inventory/add-stock', {
          product_id:              r.product.id,
          supplier_id:             Number(supplierId),
          supplier_invoice_number: invoiceNo.trim(),
          supplier_invoice_date:   invoiceDate,
          batch_number:            r.batch_number.trim(),
          // Paid quantity — backend adds the scheme bonus on top.
          quantity:                Number(r.quantity),
          expiry_date:             `${r.expiry_year}-${r.expiry_month}`,
          mrp:                     Number(r.mrp),
          cost_price:              r.cost_price ? Number(r.cost_price) : null,
          // Payment / supplier credit — this row's share of the one payment.
          amount_paid:             rowPaid,
          payment_mode:            paymentMode,
          supplier_invoice_total:  rowTotal || null,
          due_date:                rowCredit > 0 ? dueDate : null,
          // Advance balance adjustment (Feature A) — this row's share.
          advance_used:            rowAdvance > 0 ? rowAdvance : 0,
          // Purchase scheme (Feature B).
          scheme_buy:              rowScheme ? rowScheme.buy : null,
          scheme_free:             rowScheme ? rowScheme.free : null,
          scheme_label:            rowScheme ? rowScheme.label : null,
        });
        added += 1;
        creditCreated += Number(data.credit_amount) || 0;
      } catch (err) {
        failed.push({ name: r.product.name, msg: err.response?.data?.detail || 'Failed' });
      }
    }
    setSubmitting(false);
    setResult({ added, failed });
    if (added > 0) {
      // Mention the credit so the pharmacist knows a debt was opened without
      // having to go and look at the supplier ledger.
      const creditNote = creditCreated > 0 ? ` — ${inr(creditCreated)} on credit` : '';
      showToast(`${added} medicine${added > 1 ? 's' : ''} added successfully${creditNote}`);
    }

    // If everything succeeded, reset the form for the next delivery.
    if (failed.length === 0) {
      setRows([BLANK_ROW(), BLANK_ROW()]);
      setInvoiceNo('');
      setAmountPaid('0');
      setPaymentMode('CASH');
      setDueDate('');
      setAdvanceUsedInput('');
      setAdvanceBalance(0);
      setPaidTouched(false);
      setAdvanceTouched(false);
    }
  }

  const TH = { padding: '9px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-hint)', borderBottom: '1px solid var(--border)' };
  const TD = { padding: '8px 10px', verticalAlign: 'top' };

  return (
    <div>
      <h2 style={{ fontSize: 18, marginBottom: 6 }}>Add Stock — Bulk Entry</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 18 }}>
        Received a delivery with several medicines? Add them all under one supplier invoice.
      </p>

      {/* Shared supplier / invoice header */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 16px' }}>
          <Field label="Supplier" required>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">— select supplier —</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Invoice No." required>
            <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="e.g. INV-2025-001" />
          </Field>
          <Field label="Invoice Date" required>
            <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </Field>
        </div>
      </div>

      {/* Medicine rows */}
      <div className="card" style={{ padding: 0, overflow: 'visible' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 820 }}>
            <thead>
              <tr>
                <th style={{ ...TH, minWidth: 220 }}>Medicine</th>
                <th style={TH}>Batch No.</th>
                <th style={TH}>Qty</th>
                <th style={{ ...TH, minWidth: 150 }}>Scheme</th>
                <th style={{ ...TH, minWidth: 150 }}>Expiry</th>
                <th style={TH}>MRP</th>
                <th style={TH}>Purchase Price</th>
                <th style={TH}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...TD, minWidth: 220 }}>
                    {r.product ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600 }}>{r.product.name}</span>
                        <button
                          onClick={() => setRow(r.key, { product: null })}
                          style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}
                        >
                          change
                        </button>
                      </div>
                    ) : (
                      <MedicineSearchBox
                        placeholder="Search medicine…"
                        onSelect={(prod) => setRow(r.key, {
                          product: { id: prod.id, name: prod.name },
                          // Pre-fill MRP from the last known price for convenience.
                          mrp: r.mrp || (prod.mrp ? String(prod.mrp) : ''),
                        })}
                      />
                    )}
                  </td>
                  <td style={TD}><input value={r.batch_number} onChange={(e) => setRow(r.key, { batch_number: e.target.value })} style={{ width: 110 }} /></td>
                  <td style={TD}><input type="number" min="1" value={r.quantity} onChange={(e) => setRow(r.key, { quantity: e.target.value })} style={{ width: 70 }} /></td>
                  {/* Scheme (Feature B) — per-row dropdown + live bonus badge */}
                  <td style={{ ...TD, minWidth: 150 }}>
                    <select value={r.scheme} onChange={(e) => setRow(r.key, { scheme: e.target.value })} style={{ width: 90 }}>
                      {SCHEME_PRESETS.map(([value, label]) => (
                        <option key={value || 'none'} value={value}>{label}</option>
                      ))}
                    </select>
                    {r.scheme === 'CUSTOM' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                        <input type="number" min="1" value={r.scheme_buy} onChange={(e) => setRow(r.key, { scheme_buy: e.target.value })} placeholder="5" style={{ width: 42 }} />
                        <span style={{ fontSize: 12, color: 'var(--text-hint)' }}>+</span>
                        <input type="number" min="1" value={r.scheme_free} onChange={(e) => setRow(r.key, { scheme_free: e.target.value })} placeholder="1" style={{ width: 42 }} />
                      </div>
                    )}
                    {(() => {
                      const sc = resolveScheme(r.scheme, r.scheme_buy, r.scheme_free);
                      const paid = parseInt(r.quantity, 10) || 0;
                      if (!sc || paid <= 0) return null;
                      const { bonus, total } = schemePreview(paid, sc);
                      return (
                        <div style={{ fontSize: 11, color: 'var(--info)', marginTop: 4, fontWeight: 600 }}>
                          Qty: {paid} → Total: {total} ({bonus} bonus)
                        </div>
                      );
                    })()}
                  </td>
                  <td style={{ ...TD, minWidth: 150 }}>
                    <MonthYearSelect
                      month={r.expiry_month} year={r.expiry_year}
                      onMonth={(v) => setRow(r.key, { expiry_month: v })}
                      onYear={(v) => setRow(r.key, { expiry_year: v })}
                    />
                  </td>
                  <td style={TD}><input type="number" min="0.01" step="0.01" value={r.mrp} onChange={(e) => setRow(r.key, { mrp: e.target.value })} style={{ width: 80 }} /></td>
                  <td style={TD}><input type="number" min="0" step="0.01" value={r.cost_price} onChange={(e) => setRow(r.key, { cost_price: e.target.value })} style={{ width: 80 }} placeholder="—" /></td>
                  <td style={TD}>
                    <button
                      onClick={() => removeRow(r.key)}
                      disabled={rows.length === 1}
                      title="Remove row"
                      style={{ background: 'transparent', border: 'none', color: 'var(--danger)', fontSize: 18, cursor: rows.length === 1 ? 'not-allowed' : 'pointer', opacity: rows.length === 1 ? 0.3 : 1 }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '10px 14px' }}>
          <button className="btn-secondary" onClick={addRow} style={{ fontSize: 13 }}>+ Add Row</button>
        </div>
      </div>

      {/* ── PAYMENT DETAILS ─────────────────────────────────────────────────
          One payment for the whole delivery.  Whatever is left unpaid becomes
          supplier credit (money we owe), which is why a due date is forced as
          soon as the credit figure goes above zero. */}
      <div style={{
        background: 'var(--accent-light)',
        border: '1px solid rgba(99,102,241,0.15)',
        borderRadius: 'var(--radius-lg)',
        padding: '16px 20px',
        marginTop: 16,
      }}>
        <div style={{
          fontSize: 12, fontWeight: 700, color: 'var(--accent)',
          letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 14,
        }}>
          Payment Details
        </div>

        {/* ── Advance available (Feature A) ───────────────────────────────
            The supplier is holding an advance of ours — offer to spend it on
            this whole delivery before paying cash. */}
        {advanceBalance > 0 && invoiceTotal > 0 && (
          <div style={{
            background: 'var(--warn-bg)', border: '1px solid rgba(245,158,11,0.3)',
            borderRadius: 'var(--radius)', padding: '12px 16px', marginBottom: 14,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--warn)' }}>
              💰 Advance Available: {inr(advanceBalance)}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 8 }}>
              from {suppliers.find((s) => String(s.id) === String(supplierId))?.name || 'this supplier'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Use advance:</span>
              <input
                type="number" min="0" step="0.01"
                value={advanceUsedInput}
                onChange={(e) => { setAdvanceUsedInput(e.target.value); setAdvanceTouched(true); }}
                style={{ width: 120 }}
              />
              {/* Use All → cap at what this delivery can absorb and hand control
                  back to the auto-fill (touched = false) so it tracks again. */}
              <button type="button" onClick={() => { setAdvanceUsedInput(String(Math.min(advanceBalance, invoiceTotal))); setAdvanceTouched(false); }}
                style={{ background: 'none', border: '1px solid var(--warn)', color: 'var(--warn)', borderRadius: 'var(--radius)', padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
                Use All
              </button>
              <button type="button" onClick={() => { setAdvanceUsedInput('0'); setAdvanceTouched(true); }}
                title="Don't use advance"
                style={{ background: 'none', border: 'none', color: 'var(--text-hint)', fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>
                ×
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
          {/* Invoice Total — auto-calculated from the rows above */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', display: 'block', marginBottom: 4 }}>
              Invoice Total (₹)
            </label>
            <div style={{
              padding: '8px 12px', background: 'rgba(0,0,0,0.04)',
              borderRadius: 'var(--radius)', fontSize: 14, fontWeight: 600, color: 'var(--text)',
            }}>
              {inr(invoiceTotal)}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-hint)', marginTop: 3 }}>
              Purchase price × qty, summed across all rows
            </div>
            {advanceUsed > 0 && (
              <div style={{ fontSize: 11, color: 'var(--ok)', marginTop: 4, fontWeight: 600 }}>
                − {inr(advanceUsed)} advance → {inr(afterAdvance)} remaining
              </div>
            )}
          </div>

          {/* Amount Paid Now — hidden once the advance covers the whole invoice */}
          {!fullyCovered && (
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', display: 'block', marginBottom: 4 }}>
              Amount Paid Now (₹) *
            </label>
            <input
              type="number" min="0" step="0.01" placeholder="0.00"
              value={amountPaid}
              onChange={(e) => { setPaidTouched(true); setAmountPaid(e.target.value); }}
              style={{ width: '100%' }}
            />
            {afterAdvance > 0 && (
              <button
                type="button"
                onClick={() => { setPaidTouched(true); setAmountPaid(String(afterAdvance)); }}
                style={{
                  background: 'none', border: 'none', color: 'var(--accent)',
                  fontSize: 10.5, cursor: 'pointer', padding: '3px 0 0',
                }}
              >
                Pay {advanceUsed > 0 ? 'remaining' : 'full invoice'} ({inr(afterAdvance)})
              </button>
            )}
          </div>
          )}

          {/* Credit Amount — auto (also hidden when fully covered) */}
          {!fullyCovered && (
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', display: 'block', marginBottom: 4 }}>
              Credit Amount (₹)
            </label>
            <div style={{
              padding: '8px 12px',
              background: creditAmount > 0 ? 'var(--danger-bg)' : 'rgba(0,0,0,0.04)',
              borderRadius: 'var(--radius)', fontSize: 14, fontWeight: 600,
              color: creditAmount > 0 ? 'var(--danger)' : 'var(--text-secondary)',
            }}>
              {inr(creditAmount)}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-hint)', marginTop: 3 }}>
              {advanceUsed > 0 ? 'Remaining − Amount Paid' : 'Invoice Total − Amount Paid'}
            </div>
          </div>
          )}
        </div>

        {/* Fully covered by advance — no cash/UPI needed */}
        {fullyCovered && (
          <div style={{
            marginTop: 14,
            background: 'var(--ok-bg)', border: '1px solid rgba(16,185,129,0.35)',
            borderRadius: 'var(--radius)', padding: '12px 16px',
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ok)' }}>
              ✓ Fully covered by advance balance
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              No additional payment needed.
            </div>
          </div>
        )}

        {/* Payment Mode — hidden once the advance covers the whole invoice */}
        {!fullyCovered && (
        <div style={{ marginTop: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', display: 'block', marginBottom: 8 }}>
            Payment Mode *
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            {['CASH', 'UPI'].map((mode) => {
              const active = paymentMode === mode;
              return (
                <button
                  key={mode} type="button"
                  onClick={() => setPaymentMode(mode)}
                  style={{
                    padding: '8px 20px', borderRadius: 'var(--radius)',
                    border: active ? '2px solid var(--accent)' : '1px solid var(--glass-border)',
                    background: active ? 'var(--accent-light)' : 'rgba(255,255,255,0.6)',
                    color: active ? 'var(--accent-dark)' : 'var(--text-secondary)',
                    fontWeight: active ? 700 : 400, cursor: 'pointer', fontSize: 13,
                  }}
                >
                  {mode === 'CASH' ? '💵 Cash' : '📱 UPI'}
                </button>
              );
            })}
          </div>
        </div>
        )}

        {/* Due Date — only when something is left unpaid */}
        {needsDueDate && (
          <div style={{ marginTop: 14 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--danger)', display: 'block', marginBottom: 4 }}>
              Credit Due Date *{' '}
              <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>
                — required when credit amount {'>'} 0
              </span>
            </label>
            <input
              type="date" min={todayISO()}
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              style={{ width: 200, border: '2px solid var(--danger)' }}
            />
            <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '6px 0 0' }}>
              Payment reminders are scheduled 5 days before, on, and 2 days after this date.
            </p>
          </div>
        )}
      </div>

      {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 12 }}>{error}</p>}

      {/* Per-row result summary (shown when some rows failed) */}
      {result && result.failed.length > 0 && (
        <div style={{ marginTop: 12, background: 'var(--danger-bg)', border: '1px solid var(--danger)', borderRadius: 10, padding: '12px 16px', fontSize: 13 }}>
          <strong>{result.added} added, {result.failed.length} failed:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {result.failed.map((f, i) => <li key={i}>{f.name}: {f.msg}</li>)}
          </ul>
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <button className="btn-primary" onClick={handleSubmitAll} disabled={submitting} style={{ padding: '12px 28px', fontSize: 15 }}>
          {submitting ? 'Submitting…' : 'Submit All'}
        </button>
      </div>
    </div>
  );
}

// ─── Tab 3: Purchase History ───────────────────────────────────────────────

function PurchaseHistoryTab({ suppliers }) {
  const [items, setItems]     = useState([]);
  const [total, setTotal]     = useState(0);
  const [offset, setOffset]   = useState(0);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(null);   // id of the expanded row
  const limit = 25;

  // Filters
  const [search, setSearch]       = useState('');
  const [debounced, setDebounced] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [dateFrom, setDateFrom]   = useState('');
  const [dateTo, setDateTo]       = useState('');

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to first page whenever a non-search filter changes.
  useEffect(() => { setOffset(0); }, [supplierId, dateFrom, dateTo]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit, offset });
    if (debounced)  params.set('search', debounced);
    if (supplierId) params.set('supplier_id', supplierId);
    if (dateFrom)   params.set('date_from', dateFrom);
    if (dateTo)     params.set('date_to', dateTo);
    api.get(`/inventory/purchase-history?${params}`)
      .then(({ data }) => { setItems(data.items); setTotal(data.total); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [debounced, supplierId, dateFrom, dateTo, offset]);

  const TH = { padding: '11px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-hint)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
  const TD = { padding: '10px 12px' };

  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search medicine or supplier…"
          style={{ maxWidth: 280 }}
        />
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">All suppliers</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          From <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          To <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </label>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>No purchase records found.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 900 }}>
              <thead>
                <tr>
                  {['Date', 'Supplier', 'Invoice No', 'Medicine', 'Batch', 'Qty', 'Scheme', 'MRP', 'Cost', 'Added By'].map((h) => (
                    <th key={h} style={TH}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <Fragment key={r.id}>
                    <tr
                      onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                      style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                    >
                      <td style={TD}>{formatDate(r.supplier_invoice_date)}</td>
                      <td style={TD}>{r.supplier_name}</td>
                      <td style={{ ...TD, fontFamily: 'monospace', fontSize: 12 }}>{r.supplier_invoice_number}</td>
                      <td style={{ ...TD, fontWeight: 600 }}>{r.product_name}</td>
                      <td style={TD}>{r.batch_number || '—'}</td>
                      <td style={{ ...TD, fontWeight: 700 }}>{r.quantity}</td>
                      <td style={TD}>
                        {r.scheme_label ? (
                          <span style={{
                            fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 6,
                            background: 'var(--info-bg)', color: 'var(--info)',
                          }}>
                            {r.scheme_label}
                          </span>
                        ) : '—'}
                      </td>
                      <td style={TD}>{inr(r.mrp)}</td>
                      <td style={TD}>{r.cost_price != null ? inr(r.cost_price) : '—'}</td>
                      <td style={{ ...TD, color: 'var(--text-muted)' }}>{r.added_by || '—'}</td>
                    </tr>
                    {expanded === r.id && (
                      <tr style={{ background: 'var(--bg)' }}>
                        <td colSpan={10} style={{ padding: '12px 18px' }}>
                          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', fontSize: 13 }}>
                            <div><span style={{ color: 'var(--text-hint)' }}>Batch: </span><strong>{r.batch_number || '—'}</strong></div>
                            <div><span style={{ color: 'var(--text-hint)' }}>Expiry: </span><strong>{formatMonthYear(r.expiry_date)}</strong></div>
                            <div><span style={{ color: 'var(--text-hint)' }}>Quantity: </span><strong>{r.quantity} units{r.scheme_label ? ' paid' : ''}</strong></div>
                            {r.scheme_label && (
                              <div>
                                <span style={{ color: 'var(--text-hint)' }}>Scheme: </span>
                                <strong>
                                  {r.scheme_label} — {r.quantity} paid + {r.bonus_quantity} bonus = {r.quantity + r.bonus_quantity} total
                                </strong>
                              </div>
                            )}
                            <div><span style={{ color: 'var(--text-hint)' }}>MRP: </span><strong>{inr(r.mrp)}</strong></div>
                            <div><span style={{ color: 'var(--text-hint)' }}>Cost: </span><strong>{r.cost_price != null ? inr(r.cost_price) : '—'}</strong></div>
                            <div><span style={{ color: 'var(--text-hint)' }}>Recorded: </span><strong>{formatDate(r.created_at)}</strong></div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', justifyContent: 'flex-end' }}>
          <button disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - limit))} className="btn-secondary" style={{ padding: '6px 14px', fontSize: 13 }}>← Prev</button>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Page {page} of {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setOffset((o) => o + limit)} className="btn-secondary" style={{ padding: '6px 14px', fontSize: 13 }}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ─── Main Medicines Page ───────────────────────────────────────────────────

export default function Inventory() {
  const [activeTab, setActiveTab]     = useState('products');
  const [categories, setCategories]   = useState([]);
  const [suppliers, setSuppliers]     = useState([]);
  const [toast, setToast]             = useState(null);

  // Load lookup lists once on mount — they rarely change.
  useEffect(() => {
    Promise.all([
      api.get('/inventory/categories'),
      api.get('/suppliers/'),
    ]).then(([catRes, supRes]) => {
      setCategories(catRes.data);
      setSuppliers(supRes.data);
    }).catch(() => {});
  }, []);

  // Brief success message at the top of the screen, auto-hides.
  const showToast = useCallback((message) => {
    setToast(message);
    setTimeout(() => setToast(null), 2800);
  }, []);

  const TABS = [
    { id: 'products', label: 'Products' },
    { id: 'add-stock', label: 'Add Stock' },
    { id: 'history', label: 'Purchase History' },
  ];

  const TAB_STYLE = (active) => ({
    padding: '9px 20px', fontSize: 14, fontWeight: 600,
    background: active ? 'var(--accent)' : 'var(--surface)',
    color:      active ? '#fff' : 'var(--text-muted)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    cursor: 'pointer',
  });

  return (
    <div>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Medicines</h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: 20 }}>
        Manage medicines, add stock, and review purchase history — all in one place.
      </p>

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {TABS.map((t) => (
          <button key={t.id} style={TAB_STYLE(activeTab === t.id)} onClick={() => setActiveTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'products' && (
        <ProductsTab categories={categories} suppliers={suppliers} showToast={showToast} />
      )}
      {activeTab === 'add-stock' && (
        <BulkAddStockTab suppliers={suppliers} showToast={showToast} />
      )}
      {activeTab === 'history' && (
        <PurchaseHistoryTab suppliers={suppliers} />
      )}

      {/* Toast */}
      {toast && createPortal(
        <div style={{
          position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(16,185,129,0.96)', color: '#fff',
          padding: '10px 20px', borderRadius: 10, fontSize: 13, fontWeight: 600,
          boxShadow: '0 10px 30px rgba(0,0,0,0.2)', zIndex: 2000,
        }}>
          {toast}
        </div>,
        document.body,
      )}
    </div>
  );
}
