/**
 * Medicines Management Page (unified inventory).
 *
 * ONE page that replaces the old separate "Medicines" + "Purchasing" pages.
 * Three tabs:
 *   1. Products        — searchable table of all medicines.  Each row has
 *                        [+ Add Stock] and [✏ Edit] buttons, and a clickable
 *                        medicine NAME that slides in the full batch panel
 *                        (every batch with its expiry, prices and margin).
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
import MedicineBatchPanel from '../components/inventory/MedicineBatchPanel';
import { formatDateOnly, getTodayIST } from '../lib/datetime';
// Money / stock / margin formatting lives in lib so the batch panel shows the
// exact same figures and margin colours as this page (see inventoryFormat.js).
import { inr, formatMonthYear, stockLabel, marginTone } from '../lib/inventoryFormat';

// ─── Small reusable helpers ────────────────────────────────────────────────

/** Format an ISO date string as a full Indian date "15 Jan 2025" in IST. */
const formatDate = formatDateOnly;

/** Today's date as "YYYY-MM-DD" (IST) for date-input defaults. */
const todayISO = getTodayIST;

/** Round to paise. JS floats drift (0.1 + 0.2 !== 0.3), so do this at every step. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Round to 4 decimals — used for PER-UNIT prices only.
 *
 * A ₹86.10 strip of 15 tablets is ₹5.74 a tablet, and 5% off that is ₹0.287.
 * Rounded to paise, each tablet is half a paisa out; multiplied back up over a
 * 150-unit delivery that is nearly a rupee off the invoice total, which is
 * exactly the sort of drift a pharmacist notices when reconciling.  Line
 * totals still round to paise (round2) — that IS the money.
 *
 * This matches the backend, which stores per-unit costs at 4dp for the same
 * reason (inventory_service._UNIT).
 */
function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

// ─── Profit margin (Fix 2) ─────────────────────────────────────────────────
//
// The pharmacist needs to see, WHILE typing, whether a delivery is actually
// worth buying. A 6% margin on a fast-moving tablet is a loss once you count
// shelf space and expiry risk, and that is invisible if all you see is two
// numbers side by side.
//
// ⚠ THE TWO PRICES MUST BOTH BE EX-GST, AND ONLY ONE OF THEM STARTS THAT WAY.
// MRP is GST-INCLUSIVE — the tax is already inside the price printed on the
// box, and we hand it straight to the government, so it was never ours.  The
// purchase cost is EX-GST — the supplier adds the tax on top of it.  Comparing
// them as they arrive flatters every margin, because the MRP side is carrying
// tax that the cost side is not.  So the tax comes out of the MRP first:
//
//   mrp_ex_gst   = mrp × 100 / (100 + gst_rate)
//   gross_profit = mrp_ex_gst − effective_cost
//   margin_pct   = gross_profit / mrp_ex_gst × 100
//
// Worked example — MRP ₹100 (incl. 5% GST), effective cost ₹81.795:
//   mrp_ex_gst = 100 / 1.05 = ₹95.24
//   margin     = (95.24 − 81.795) / 95.24 = 14.1%
// Comparing against the ₹100 sticker price instead would have claimed 18.2%.
//
// Both prices must also be in the SAME basis — per strip for a strip medicine,
// per unit otherwise.

/**
 * Live profit card shown under the pricing fields.
 *
 * Props:
 *   basis          — 'strip' or 'unit'; only used for the labels
 *   gstRate        — the product's GST %, used to strip tax out of the MRP
 *   sellingPrice   — MRP in that basis, GST-INCLUSIVE (as printed on the pack)
 *   purchaseCost   — RATE CARD ex-GST cost in that basis, before any discount
 *   discountPct    — supplier discount as a percentage (0 when none)
 *   discountAmount — the same discount in ₹, in the entry basis (0 when none)
 *   discountedCost — purchaseCost − discountAmount; what we actually pay
 *   discountTotal  — the discount across the WHOLE line (₹ saved on this
 *                    delivery), and grossTotal the pre-discount line value.
 *                    The discount row is stated in these line figures because
 *                    "₹30 off ₹600" is what the pharmacist checks against the
 *                    paper invoice; a per-strip figure means nothing there.
 *   grossTotal     — purchaseCost × quantity, before the discount
 *   schemeLabel    — e.g. "5+1", or null when no scheme is selected
 *   effectiveCost  — discountedCost after free bonus units are ALSO counted
 *   effectivePerUnit — the same figure expressed per individual unit (strip
 *                    medicines only), so the pharmacist can sanity-check it
 *                    against the per-tablet MRP
 *
 * Margin is always measured against what we REALLY pay — the post-discount,
 * ex-GST cost.  Changing that number is the whole reason the discount is worth
 * typing in.
 */
function ProfitAnalysis({
  basis, gstRate = 0, sellingPrice, purchaseCost,
  discountPct = 0, discountAmount = 0, discountedCost,
  discountTotal = 0, grossTotal = 0,
  schemeLabel, effectiveCost, effectivePerUnit,
}) {
  // Nothing useful to say until both prices are in.
  if (!(sellingPrice > 0) || !(purchaseCost > 0)) return null;

  // Take the GST back out of the MRP so both sides of the comparison are
  // pre-tax.  With no GST rate on the product this is just the MRP, so nothing
  // breaks for a zero-rated medicine.
  const rate      = Number(gstRate) || 0;
  const sellExGst = round2(sellingPrice * 100 / (100 + rate));

  // Fall back to the rate card when the caller passes no discount at all.
  const netCost   = discountedCost > 0 ? discountedCost : purchaseCost;
  const hasDiscount = discountAmount > 0 && netCost < purchaseCost;

  const gross     = round2(sellExGst - netCost);
  const marginPct = (gross / sellExGst) * 100;
  const tone      = marginTone(marginPct);

  // The scheme block only makes sense when the bonus actually lowers the cost
  // further than the discount already did.
  const hasScheme = Boolean(schemeLabel) && effectiveCost > 0 && effectiveCost < netCost;
  const effMargin = hasScheme ? ((sellExGst - effectiveCost) / sellExGst) * 100 : null;

  const Row = ({ label, value, strong, color }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 3 }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <strong style={{ color: color || 'var(--text)', fontWeight: strong ? 700 : 600 }}>{value}</strong>
    </div>
  );

  return (
    <div style={{
      background: tone.bg, border: `1px solid ${tone.border}`,
      borderRadius: 'var(--radius)', padding: '12px 14px',
      marginTop: 12, fontSize: 12.5,
    }}>
      <div style={{
        fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
        color: tone.color, marginBottom: 8,
      }}>
        Profit Analysis
      </div>
      <Row label={`Selling price (MRP, incl. GST)`} value={`${inr(sellingPrice)}/${basis}`} />
      {/* The MRP with its tax removed — this is the figure the margin is
          measured against, so it is shown rather than hidden in the maths. */}
      {rate > 0 && (
        <Row
          label={`MRP ex-GST (÷ ${(1 + rate / 100).toFixed(2)})`}
          value={`${inr(sellExGst)}/${basis}`}
        />
      )}
      <Row label="Purchase cost (S.Rate, ex-GST)" value={`${inr(purchaseCost)}/${basis}`} />
      {/* Supplier discount → the cost we actually pay.  Shown as its own two
          lines so the pharmacist can see WHY the margin moved. */}
      {hasDiscount && (
        <>
          <Row
            label={`Discount${discountPct > 0 ? ` (${round2(discountPct)}%)` : ''}`}
            // Stated across the whole delivery — "− ₹30.00 on ₹600 total" —
            // because that is the line the paper invoice prints.  Falls back to
            // the per-basis figure before a quantity has been typed.
            value={grossTotal > 0
              ? `− ${inr(discountTotal)} on ${inr(grossTotal)} total`
              : `− ${inr(discountAmount)}/${basis}`}
            color="var(--ok)"
          />
          <Row label="Effective cost" value={`${inr(netCost)}/${basis}`} strong />
        </>
      )}
      <Row label="Gross profit" value={`${inr(gross)}/${basis}`} color={tone.color} />
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderTop: `1px solid ${tone.border}`, paddingTop: 6, marginTop: 6,
      }}>
        <span style={{ fontWeight: 700, color: 'var(--text)' }}>Margin</span>
        <strong style={{ color: tone.color, fontSize: 15 }}>{marginPct.toFixed(1)}%</strong>
      </div>

      {hasScheme && (
        <div style={{ borderTop: `1px solid ${tone.border}`, paddingTop: 7, marginTop: 7 }}>
          <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
            With {schemeLabel} scheme
          </div>
          <Row label={`Effective cost/${basis}`} value={inr(effectiveCost)} />
          {effectivePerUnit != null && basis === 'strip' && (
            <Row label="Effective cost/unit" value={inr(effectivePerUnit)} />
          )}
          <Row label="Effective margin" value={`${effMargin.toFixed(1)}%`} color="var(--ok)" strong />
        </div>
      )}
    </div>
  );
}

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

// Category and Unit deliberately live OUTSIDE this form.  A pharmacist filling
// in a new medicine has no use for either: the category was never used to drive
// anything, and "unit" is decided by the strip settings below (a strip medicine
// is counted in tablets, everything else in its own pack).  Both columns still
// exist on the products table — we simply stop sending them, and PUT uses
// exclude_unset so an existing product keeps whatever it already had.
const BLANK_PRODUCT = {
  name: '', generic_name: '', brand: '', manufacturer: '',
  hsn_code: '',
  // 5% is the rate most medicines actually carry in India, so it is the
  // default a pharmacist has to change least often.
  gst_rate: '5', barcode: '', rack_location: '',
  min_stock_level: '10',
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
function ProductFormModal({ existing, onClose, onSaved }) {
  const isEdit = Boolean(existing);
  const [form, setForm] = useState(() =>
    existing
      ? {
          name: existing.name ?? '',
          generic_name: existing.generic_name ?? '',
          brand: existing.brand ?? '',
          manufacturer: existing.manufacturer ?? '',
          hsn_code: existing.hsn_code ?? '',
          // An existing product keeps ITS rate; the 5% fallback only applies to
          // a row so old it has no rate recorded at all.
          gst_rate: String(existing.gst_rate ?? '5'),
          barcode: existing.barcode ?? '',
          rack_location: existing.rack_location ?? '',
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
        // Category and Unit are not in `form` at all any more, so they are not
        // in this payload either — PUT uses exclude_unset, so an existing
        // product's stored values are left exactly as they were.
        ...form,
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
              <option value="28">28%</option>
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
 *
 * `compact` shrinks the pair for the Bulk Add Stock cards, where the Expiry
 * field is one of six columns: short month names ("Jan") and tighter padding,
 * so "September" cannot push the box wider than its grid cell.  The VALUES are
 * identical either way — only the visible label changes.
 */
function MonthYearSelect({ month, year, onMonth, onYear, compact }) {
  const boxStyle = compact
    ? { flex: 1, minWidth: 0, padding: '8px 4px', fontSize: 12 }
    : { flex: 1 };
  return (
    <div style={{ display: 'flex', gap: compact ? 4 : 8 }}>
      <select value={month} onChange={(e) => onMonth(e.target.value)} required style={boxStyle}>
        <option value="">{compact ? 'MM' : 'Month'}</option>
        {MONTHS.map(([value, label]) => (
          <option key={value} value={value}>{compact ? label.slice(0, 3) : label}</option>
        ))}
      </select>
      <select value={year} onChange={(e) => onYear(e.target.value)} required style={boxStyle}>
        <option value="">{compact ? 'YYYY' : 'Year'}</option>
        {EXPIRY_YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
    </div>
  );
}

// ─── Add Stock slide-in panel ──────────────────────────────────────────────

const BLANK_STOCK = {
  supplier_id: '', supplier_invoice_number: '', supplier_invoice_date: todayISO(),
  batch_number: '', quantity: '', expiry_month: '', expiry_year: '', mrp: '', cost_price: '',
  // Strip pricing (Feature 3 + Fix 8): for a strip medicine the pharmacist types
  // the whole-strip price here.  The per-UNIT price that batches store and
  // billing uses is ALWAYS derived as strip_mrp ÷ units_per_strip — it is shown
  // read-only and can never be typed, so the two can never disagree.
  // Empty/unused for non-strip medicines (those use `mrp` directly).
  strip_mrp: '',
  // Supplier discount — the distributor's trade discount, always a PERCENTAGE
  // of the purchase price.  A percentage is basis-independent (5% off is 5% off
  // whether you read the invoice in strips or in tablets), so there is only one
  // box and nothing to keep in sync.  The rupee figure is derived from it.
  discount_percent: '',
  // Payment / supplier credit (Feature 1)
  amount_paid: '', payment_mode: 'CASH', due_date: '',
  // Advance balance adjustment (Feature A) — how much advance to spend
  advance_used: '',
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
 * Bonus / total preview for a scheme (Feature B) — mirrors the backend exactly
 * (inventory_service._compute_scheme).
 *
 * A SCHEME IS QUOTED IN PACKS, NOT TABLETS.  "5+1" on a strip medicine means
 * buy 5 STRIPS, get 1 strip free.  Stock is counted in individual units, so the
 * scheme is scaled by `perPack` (units_per_strip for a strip medicine, 1 for
 * everything else — a syrup bottle already IS the pack) before the arithmetic.
 *
 *   bonus = floor(paidUnits / (buy × perPack)) × (free × perPack)
 *
 * @param paidUnits  quantity bought, in individual units
 * @param scheme     { buy, free, label } from resolveScheme, in PACKS
 * @param perPack    units per pack (strip); 1 for non-strip medicines
 */
function schemePreview(paidUnits, scheme, perPack = 1) {
  if (!scheme || !paidUnits || paidUnits <= 0) {
    return { bonus: 0, total: paidUnits || 0 };
  }
  const per       = perPack > 0 ? perPack : 1;
  const buyUnits  = scheme.buy * per;
  const freeUnits = scheme.free * per;
  const bonus = Math.floor(paidUnits / buyUnits) * freeUnits;
  return { bonus, total: paidUnits + bonus };
}

/**
 * Resolve a supplier discount — mirrors the backend exactly
 * (inventory_service.compute_discount).  If you change one, change both.
 *
 * A distributor's discount arrives in one of two shapes and they mean the same
 * thing, so we normalise to all three figures at once:
 *
 *   percent typed → amount  = cost × percent / 100
 *   amount typed  → percent = amount / cost × 100
 *   effective     = cost − amount
 *
 * The percentage wins when both are somehow set.  Both Add Stock forms now only
 * ever offer a PERCENTAGE box and pass 0 for the amount, so the amount branch
 * exists purely so this helper still matches the backend's compute_discount()
 * for anything reading an older stored row.  A discount can wipe out the cost
 * but never invert it — a fat-fingered "₹100 off a ₹60 strip" clamps to 100%,
 * it does not record the supplier paying us.
 *
 * ⚠ CALL THIS WITH PER-UNIT FIGURES, not per-strip ones.  Per-unit is what the
 * backend receives and what it does its own arithmetic on, so working in the
 * same basis here means the preview on screen and the stored invoice land on
 * the same paisa.  Callers multiply back up by units_per_strip for display.
 *
 * Money comes back at 4dp (round4) for the same reason the backend keeps 4dp:
 * 5% off ₹5.74 is ₹0.287, and rounding that to paise per tablet drifts the
 * invoice by nearly a rupee across a full delivery.
 */
function computeDiscount(costPerUnit, percentInput, amountInput) {
  const cost = Number(costPerUnit) || 0;
  let pct = Number(percentInput) || 0;
  let amt = Number(amountInput) || 0;

  if (cost <= 0) return { percent: 0, amount: 0, effective: 0 };

  if (pct > 0) {
    amt = round4(cost * pct / 100);
  } else if (amt <= 0) {
    pct = 0;
    amt = 0;
  }

  // Clamp BEFORE deriving the percentage, so an over-large rupee discount
  // reads as 100% rather than a nonsensical 167%.
  amt = Math.min(amt, cost);
  if (amt > 0) pct = round2((amt / cost) * 100);

  return { percent: pct, amount: round4(amt), effective: round4(cost - amt) };
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

  // ── Strip handling (Feature 3 + Fix 8) ──────────────────────────────────
  // Stock is ALWAYS stored in individual units, but a strip medicine is ALWAYS
  // entered in strips — that is how the box arrives and how the distributor's
  // invoice reads.  There is deliberately no "enter units" escape hatch any
  // more: the old toggle meant the same field sometimes held strips and
  // sometimes tablets, and a mis-set toggle silently multiplied stock by 20.
  const isStrip  = Boolean(product.is_strip && product.units_per_strip);
  const perStrip = Number(product.units_per_strip) || 1;
  // "Basis" = the unit the pharmacist types prices and quantities in.
  const basis    = isStrip ? 'strip' : 'unit';
  const qtyTyped = Number(form.quantity) || 0;
  const paidUnits = isStrip ? qtyTyped * perStrip : qtyTyped;

  // ── Pricing (Fix 8 + Fix 2) ─────────────────────────────────────────────
  // Both MRP and purchase price are typed in the SAME basis as the quantity, so
  // the profit maths compares like with like.  The per-unit figures the backend
  // stores are derived here and shown read-only.
  const sellPerBasis = isStrip ? (Number(form.strip_mrp) || 0) : (Number(form.mrp) || 0);
  const costPerBasis = Number(form.cost_price) || 0;   // the S.Rate, as typed
  const unitMrp  = round4(isStrip && perStrip > 0 ? sellPerBasis / perStrip : sellPerBasis);
  const unitCost = round4(isStrip && perStrip > 0 ? costPerBasis / perStrip : costPerBasis);

  // ── Supplier discount ───────────────────────────────────────────────────
  // A distributor knocks money off the rate card BEFORE charging GST, so the
  // discount lowers three things at once: the goods value on the invoice, the
  // tax charged on it, and what the medicine really cost us (profit margin and,
  // later, expiry loss).
  //
  // The discount is entered as a PERCENTAGE only.  A percentage is
  // basis-independent — 5% off is 5% off whether the invoice is read in strips
  // or in tablets — so there is nothing to convert and no second box that could
  // drift out of step with the first.
  //
  // The maths is still done PER UNIT (the same basis the backend works in) so
  // the preview here and the stored invoice can never round apart.
  const discount      = computeDiscount(unitCost, form.discount_percent, 0);
  const unitDiscount  = discount.amount;                        // ₹ off, per unit
  const netUnitCost   = discount.effective || unitCost;         // post-discount, per unit
  // The same two figures expressed per strip, purely for the labels — the
  // pharmacist reads the invoice in strips.
  const netCostBasis  = isStrip ? round4(netUnitCost * perStrip) : netUnitCost;
  const discountBasis = isStrip ? round2(unitDiscount * perStrip) : unitDiscount;

  function setDiscountPercent(value) {
    setForm((prev) => ({ ...prev, discount_percent: value }));
  }

  // ── Scheme maths (Feature B) ────────────────────────────────────────────
  // The pharmacist enters the PAID quantity; the scheme adds free bonus units
  // on top.  Stock stored = paid + bonus; the invoice is still paid-only.
  const scheme      = resolveScheme(form.scheme, form.scheme_buy, form.scheme_free);
  // "5+1" means 5 STRIPS for a strip medicine, so the scheme scales by the
  // pack size — same rule the backend applies (see schemePreview).
  const schemeCalc  = schemePreview(paidUnits, scheme, isStrip ? perStrip : 1);
  const bonusUnits  = schemeCalc.bonus;
  const totalUnits  = schemeCalc.total;   // paid + bonus — what enters stock

  // ── Payment / credit maths (Feature 1 + A) ──────────────────────────────
  // This mirrors a real distributor's invoice, line for line:
  //
  //   S.Rate × PAID units        ← rate card value (bonus units are free)
  //   − trade discount           ← knocked off FIRST
  //   = goods value
  //   + GST on the GOODS VALUE   ← tax is charged AFTER the discount
  //   = invoice total            ← this is what we owe
  //
  // GST on a PURCHASE is added on top of the rate — the opposite of a sale,
  // where GST is already inside the MRP and gets extracted out.  Charging it on
  // the pre-discount rate (what this used to do) over-stated every discounted
  // supplier debt by the tax on the discount.
  //
  // The advance is applied first, then cash; whatever is left becomes credit.
  const gstRate       = Number(product.gst_rate) || 0;
  const grossGoods    = round2(paidUnits * unitCost);      // before discount
  const goodsValue    = round2(paidUnits * netUnitCost);   // after discount, ex-GST
  // Derived by subtraction (not qty × discount) so the three lines on screen
  // always reconcile exactly — no stray paisa in the middle of the breakdown.
  const discountTotal = round2(grossGoods - goodsValue);
  const gstOnPurchase = round2(goodsValue * gstRate / 100);
  const invoiceTotal  = round2(goodsValue + gstOnPurchase);
  // Advance actually usable = min(typed, balance, invoice total).
  const advanceUsed  = Math.min(
    Number(form.advance_used) || 0, advanceBalance, invoiceTotal,
  );
  const remaining    = Math.max(0, round2(invoiceTotal - advanceUsed));
  const paidNow      = Math.min(Number(form.amount_paid) || 0, remaining);
  const creditAmount = Math.max(0, round2(remaining - paidNow));
  const needsDueDate = creditAmount > 0;
  // True when the advance alone settles the whole invoice — no cash/UPI needed.
  const fullyCovered = invoiceTotal > 0 && remaining <= 0;
  // Scheme bonus lowers what each unit really cost us — shown in the profit
  // card. Expressed in the entry basis so it lines up with the MRP above it.
  // It starts from the DISCOUNTED cost, because a discount and a bonus both
  // reduce the same real figure: what one tablet on this shelf actually cost.
  // (Same order the backend applies them in — discount first, then scheme.)
  const effectiveCost = totalUnits > 0 && netCostBasis > 0
    ? round2(netCostBasis * paidUnits / totalUnits)
    : 0;
  const effectiveCostPerUnit = totalUnits > 0 && netUnitCost > 0
    ? round2(netUnitCost * paidUnits / totalUnits)
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
    if (!form.quantity || Number(form.quantity) <= 0) {
      return setError(isStrip ? 'Number of strips must be a positive number.' : 'Quantity must be a positive number.');
    }
    if (!form.expiry_month || !form.expiry_year) return setError('Expiry month and year are required.');
    if (!(sellPerBasis > 0)) {
      return setError(isStrip ? 'Strip MRP must be a positive number.' : 'MRP must be a positive number.');
    }
    // Fix 9 — purchase price is now MANDATORY.  Without it there is no profit
    // figure, no expiry-loss figure, and the supplier invoice total comes out
    // as ₹0, which silently records a delivery as fully paid.
    if (!(costPerBasis > 0)) return setError('Purchase price is required.');
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
        // The batch always stores PER-UNIT prices — a strip is a pricing
        // convenience, never a storage unit.  Extra decimals are kept so
        // ₹26.72 ÷ 20 does not drift the invoice total by a few paise.
        mrp:                     Number(unitMrp.toFixed(4)),
        cost_price:              Number(unitCost.toFixed(4)),
        // Supplier discount — only the percentage is sent.  It is
        // basis-independent (unlike the prices above, which had to be divided
        // down to per-unit), and the backend derives the rupee figure from it
        // with the same formula, so the two can never round apart.
        discount_percent:        discount.percent,
        // Strip pricing (Feature 3): for a strip medicine we also send the
        // whole-strip and per-unit prices so the backend can refresh the
        // product's strip_mrp/unit_mrp with the latest figures.  Null for
        // non-strip medicines (the backend ignores them).
        strip_mrp:               isStrip ? sellPerBasis : null,
        unit_mrp:                isStrip ? Number(unitMrp.toFixed(4)) : null,
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
          <div style={{ ...SECTION, marginTop: 6 }}>
            Purchase Scheme (optional)
            {/* Spell out the unit the scheme counts in — "5+1" on a strip
                medicine means 5 STRIPS, not 5 tablets. */}
            <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>
              — counted in {isStrip ? 'strips' : 'units'}
            </span>
          </div>
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
                <span style={{ color: 'var(--text-secondary)' }}>
                  {isStrip ? "Strips you're buying (paid)" : "Quantity you're buying (paid)"}
                </span>
                <strong>
                  {isStrip
                    ? `${qtyTyped.toLocaleString('en-IN')} strips`
                    : paidUnits.toLocaleString('en-IN')}
                </strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ color: 'var(--text-secondary)' }}>Scheme</span>
                <strong>{scheme.label} {isStrip ? '(strips)' : ''}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, color: 'var(--ok)' }}>
                <span>Bonus {isStrip ? 'strips' : 'units'} (free)</span>
                <strong>
                  {isStrip
                    ? `+${(bonusUnits / perStrip).toLocaleString('en-IN')} strips (${bonusUnits.toLocaleString('en-IN')} units)`
                    : `+${bonusUnits.toLocaleString('en-IN')}`}
                </strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 4, marginTop: 4 }}>
                <span style={{ fontWeight: 700, color: 'var(--text)' }}>Total stock added</span>
                <strong style={{ color: 'var(--accent-dark)' }}>{totalUnits.toLocaleString('en-IN')} units</strong>
              </div>
              {effectiveCostPerUnit > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, color: 'var(--text-hint)' }}>
                  <span>Effective cost/unit</span>
                  <span>{inr(effectiveCostPerUnit)}</span>
                </div>
              )}
            </div>
          )}

          {/* Strip medicines are ALWAYS counted in strips (Fix 8) — that is how
              the box arrives and how the distributor's invoice reads.  Units per
              strip comes from the medicine record and the unit count is derived,
              so there is nothing here that can be set wrong. */}
          {isStrip && (
            <div style={{
              background: 'rgba(255,255,255,0.55)', border: '1px solid var(--glass-border)',
              borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 14,
            }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Units per strip: <strong>{perStrip}</strong> (from the medicine record)
              </div>
              <div style={{ fontSize: 13, color: 'var(--accent-dark)', fontWeight: 600, marginTop: 4 }}>
                Total units: {totalUnits.toLocaleString('en-IN')}
                {qtyTyped > 0 && (
                  <span style={{ fontWeight: 400, color: 'var(--text-hint)' }}>
                    {' '}({qtyTyped.toLocaleString('en-IN')} × {perStrip}
                    {bonusUnits > 0 ? ` + ${bonusUnits.toLocaleString('en-IN')} bonus` : ''})
                  </span>
                )}
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px' }}>
            <Field label={isStrip ? 'Number of Strips' : 'Quantity (units)'} required>
              <input
                type="number" min="1" value={form.quantity}
                onChange={(e) => set('quantity', e.target.value)}
                placeholder={isStrip ? 'e.g. 4' : 'e.g. 100'}
              />
            </Field>
            <Field label="Expiry (Month/Year)" required>
              <MonthYearSelect
                month={form.expiry_month} year={form.expiry_year}
                onMonth={(v) => set('expiry_month', v)} onYear={(v) => set('expiry_year', v)}
              />
            </Field>
          </div>

          {/* ── Pricing ────────────────────────────────────────────────────
              Both prices are typed in the SAME basis as the quantity: per strip
              for a strip medicine, per unit otherwise.  The per-unit figures the
              batch stores are derived and shown read-only (Fix 8) — a typed unit
              price could disagree with the strip price, and billing prices from
              the per-unit figure, so a ₹95 strip price entered in the unit box
              would bill a strip at ₹950. */}
          {isStrip ? (
            <>
              {/* Strip MRP (typed) + Unit MRP (derived, read-only) */}
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
                    onChange={(e) => set('strip_mrp', e.target.value)}
                    placeholder="e.g. 32.55"
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
                  <div style={{
                    width: '100%', padding: '8px 10px', borderRadius: '8px',
                    border: '1px dashed rgba(99,102,241,0.3)', fontSize: '14px',
                    background: 'rgba(99,102,241,0.05)', fontWeight: 600,
                    color: unitMrp > 0 ? 'var(--accent-dark)' : 'var(--text-hint)',
                  }}>
                    {unitMrp > 0 ? unitMrp.toFixed(2) : '—'}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                Unit MRP = Strip MRP ÷ {perStrip} · always calculated, never typed
              </div>

              {/* Purchase Price — per strip, mandatory (Fix 9) */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '12px' }}>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: '#1e1b4b', display: 'block', marginBottom: '4px' }}>
                    Purchase Price (₹) *
                    <span style={{ fontSize: '10px', color: '#64748b', fontWeight: 400 }}> — per strip, before GST</span>
                  </label>
                  <input
                    type="number" step="0.01" min="0" required
                    value={form.cost_price} onChange={(e) => set('cost_price', e.target.value)}
                    placeholder="e.g. 26.72"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '14px' }}
                  />
                  <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '3px' }}>
                    Used for profit tracking and expiry loss calculation
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: '#1e1b4b', display: 'block', marginBottom: '4px' }}>
                    Purchase / unit (₹)
                    <span style={{ fontSize: '10px', color: '#64748b', fontWeight: 400 }}> — auto</span>
                  </label>
                  <div style={{
                    width: '100%', padding: '8px 10px', borderRadius: '8px',
                    border: '1px dashed rgba(99,102,241,0.3)', fontSize: '14px',
                    background: 'rgba(99,102,241,0.05)', fontWeight: 600,
                    color: unitCost > 0 ? 'var(--accent-dark)' : 'var(--text-hint)',
                  }}>
                    {unitCost > 0 ? unitCost.toFixed(2) : '—'}
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
                  Purchase Price (₹) *
                  <span style={{ fontSize: '10px', color: '#64748b', fontWeight: 400 }}> — before GST</span>
                </label>
                <input
                  type="number" step="0.01" min="0" required
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

          {/* ── Supplier discount (optional) ──────────────────────────────
              Distributors routinely knock a trade discount off the rate card
              ("5% trade discount").  Recording it matters because the margin,
              and later the expiry loss, are both wrong by exactly the discount
              if we don't.  It is entered as a PERCENTAGE only — a percentage
              reads the same whether the invoice is in strips or tablets, so
              there is no basis to get wrong and no second box to keep in sync
              with this one. */}
          <div style={{ ...SECTION, marginTop: 18 }}>
            Supplier Discount (optional)
          </div>
          <div style={{
            background: 'rgba(255,255,255,0.55)', border: '1px solid var(--glass-border)',
            borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 4,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', width: 78 }}>
                Discount %
              </label>
              <input
                type="number" min="0" max="100" step="0.01"
                value={form.discount_percent}
                onChange={(e) => setDiscountPercent(e.target.value)}
                placeholder="e.g. 5"
                style={{ width: 100 }}
              />
              <span style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>of total purchase price</span>
            </div>

            {/* Live confirmation of what the discount actually did, stated
                against the WHOLE line (price × quantity) — that is the figure
                the pharmacist is checking against the paper invoice.  Only
                shown once there is a purchase price to discount FROM. */}
            {unitDiscount > 0 && (
              <div style={{
                borderTop: '1px solid rgba(0,0,0,0.08)', marginTop: 10, paddingTop: 8,
              }}>
                {grossGoods > 0 ? (
                  <>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                      {round2(discount.percent)}% of {inr(grossGoods)} ={' '}
                      <strong style={{ color: 'var(--ok)' }}>{inr(discountTotal)} saved</strong>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ok)', marginTop: 2 }}>
                      → Effective cost: {inr(goodsValue)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                      GST is charged on {inr(goodsValue)}, not on {inr(grossGoods)}
                      {' · '}{inr(netCostBasis)}/{basis}
                    </div>
                  </>
                ) : (
                  // No quantity typed yet, so there is no line total to show —
                  // fall back to the per-basis figure so the box still confirms
                  // that the percentage was understood.
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                    {round2(discount.percent)}% off {inr(costPerBasis)} → effective{' '}
                    <strong style={{ color: 'var(--ok)' }}>{inr(netCostBasis)}/{basis}</strong>
                    {' — enter a quantity to see the total saving.'}
                  </div>
                )}
              </div>
            )}
            {costPerBasis <= 0 && form.discount_percent && (
              <div style={{ fontSize: 11.5, color: 'var(--warn)', marginTop: 8 }}>
                Enter the purchase price first — there is nothing to discount yet.
              </div>
            )}
          </div>

          {/* ── Profit analysis (Fix 2) ───────────────────────────────────
              Appears the moment both prices are in, so a thin-margin delivery
              is obvious BEFORE the stock is accepted. */}
          <ProfitAnalysis
            basis={basis}
            gstRate={gstRate}
            sellingPrice={sellPerBasis}
            purchaseCost={costPerBasis}
            discountPct={discount.percent}
            discountAmount={discountBasis}
            discountedCost={netCostBasis}
            discountTotal={discountTotal}
            grossTotal={grossGoods}
            schemeLabel={scheme ? scheme.label : null}
            effectiveCost={effectiveCost}
            effectivePerUnit={effectiveCostPerUnit}
          />

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
            {/* Invoice breakdown — laid out the way a distributor's invoice
                prints, so the pharmacist can tick it off line by line:
                    S.Rate × qty  −  discount  =  goods value  +  GST  =  total
                The discount comes off BEFORE the tax, which is why the GST line
                is smaller than "GST on the rate card" would be. */}
            {costPerBasis > 0 ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                  {/* Fix 3 — label the quantity in the basis the pharmacist
                      actually typed.  They entered 5 strips; showing "× 75
                      units" next to a per-strip price reads like the maths is
                      wrong, even though the total is right (75 × ₹6.67 and
                      5 × ₹100 are the same ₹500). */}
                  <span style={{ color: 'var(--text-secondary)' }}>
                    S.Rate {inr(costPerBasis)} × {qtyTyped.toLocaleString('en-IN')} {isStrip ? 'strips' : 'units'}
                    {isStrip && qtyTyped > 0 && (
                      <span style={{ color: 'var(--text-hint)' }}>
                        {' '}({paidUnits.toLocaleString('en-IN')} units)
                      </span>
                    )}
                  </span>
                  <span style={{ color: 'var(--text)' }}>{inr(grossGoods)}</span>
                </div>
                {/* Discount + goods value only appear when there IS a discount —
                    otherwise they would just repeat the line above. */}
                {discountTotal > 0 && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        Less Discount{discount.percent > 0 ? ` (${round2(discount.percent)}%)` : ''}
                      </span>
                      <span style={{ color: 'var(--ok)' }}>− {inr(discountTotal)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                      <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Goods Value</span>
                      <span style={{ color: 'var(--text)', fontWeight: 600 }}>{inr(goodsValue)}</span>
                    </div>
                  </>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 6 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    GST ({gstRate}%{discountTotal > 0 ? ' on goods value' : ''})
                  </span>
                  <span style={{ color: 'var(--text)' }}>+ {inr(gstOnPurchase)}</span>
                </div>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', fontSize: 13,
                  borderTop: '1px solid rgba(0,0,0,0.10)', paddingTop: 6,
                  marginBottom: advanceUsed > 0 ? 6 : 12,
                }}>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Invoice Total (incl. GST)</span>
                  <strong style={{ color: 'var(--text)' }}>{inr(invoiceTotal)}</strong>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 12 }}>
                <span style={{ color: 'var(--text-secondary)' }}>Invoice Total (auto)</span>
                <strong style={{ color: 'var(--text-hint)' }}>— enter purchase price</strong>
              </div>
            )}
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

// ─── Tab 1: Products ───────────────────────────────────────────────────────

function ProductsTab({ suppliers, showToast }) {
  const [products, setProducts]           = useState([]);
  const [total, setTotal]                 = useState(0);
  const [page, setPage]                   = useState(1);
  const [search, setSearch]               = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loading, setLoading]             = useState(false);
  const [showAddModal, setShowAddModal]   = useState(false);
  const [editProduct, setEditProduct]     = useState(null);   // full product for edit modal
  const [addStockProduct, setAddStockProduct] = useState(null); // product for slide-in
  // Product whose full batch breakdown is open in the popover (set by clicking
  // the medicine name).  null = popover closed.
  const [batchPanelProduct, setBatchPanelProduct] = useState(null);
  // Where to draw that popover.  Measured from the element that was clicked, so
  // the popover appears next to the row the pharmacist is already looking at
  // instead of flying in from the edge of the screen.
  const [popoverPos, setPopoverPos] = useState(null);
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

  // The popover does its own fetching, so opening it is "remember which medicine
  // was clicked, and where on screen it was".  Both the name and the stock
  // number call this.
  //
  // getBoundingClientRect() returns VIEWPORT coordinates, which is exactly what
  // a position:fixed popover needs — no scroll offsets to add.  We also keep the
  // element's own top so the popover can flip above the row when there is not
  // enough room below it.
  function openBatchPanel(e, product) {
    const rect = e.currentTarget.getBoundingClientRect();
    setPopoverPos({
      top: rect.bottom + 8,   // 8px below the clicked text
      left: rect.left,
      anchorTop: rect.top,    // used only when the popover has to flip upwards
    });
    setBatchPanelProduct(product);
  }

  function closeBatchPanel() {
    setBatchPanelProduct(null);
    setPopoverPos(null);
  }

  // "+ Add Stock" inside the batch popover: close the popover and open the Add
  // Stock slide-in, rather than stacking two overlays on top of each other.
  function openAddStockFromPanel(product) {
    closeBatchPanel();
    setAddStockProduct(product);
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
        // Needed by the Stock column so a brand-new strip medicine reads in
        // strips straight away, without waiting for a page refresh.
        is_strip: newProduct.is_strip, units_per_strip: newProduct.units_per_strip,
      },
      ...prev,
    ]);
    setTotal((t) => t + 1);
    showToast(`Medicine added — ${newProduct.name}`);
  }

  function handleEdited(updated) {
    setProducts((prev) => prev.map((p) => (
      p.id === updated.id
        ? {
            ...p,
            name: updated.name, generic_name: updated.generic_name,
            barcode: updated.barcode, gst_rate: updated.gst_rate,
            min_stock_level: updated.min_stock_level,
            // Toggling the strip switch changes how the Stock column reads.
            is_strip: updated.is_strip, units_per_strip: updated.units_per_strip,
          }
        : p
    )));
    showToast(`Saved — ${updated.name}`);
  }

  /**
   * A batch was corrected in the popover.  Editing a quantity changes the
   * medicine's total stock, so the row in the table behind the popover has to
   * be refetched — showing the pre-edit number next to a "stock adjusted"
   * toast is exactly the kind of disagreement that makes a pharmacist stop
   * trusting the screen.
   */
  async function handleBatchEdited(message) {
    showToast(message);
    if (!batchPanelProduct) return;
    try {
      const { data } = await api.get(`/inventory/products/${batchPanelProduct.id}`);
      setProducts((prev) => prev.map((p) => (
        p.id === data.id ? { ...p, current_stock: data.current_stock } : p
      )));
    } catch {
      // The toast already told the user the save worked; a failed refresh just
      // means the stock column is stale until the next search or page change.
    }
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
                // Strip medicines read in strips, everything else in units.
                // The low-stock comparison above stays in UNITS — min_stock_level
                // is stored in units, so comparing strips to it would be wrong.
                const stock = stockLabel(p.current_stock, p.is_strip, p.units_per_strip);
                return (
                  <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    {/* Medicine name → batch popover (expiry, prices, margin).
                        The name is the natural thing to click for "tell me
                        everything about this medicine", and the popover opens
                        right underneath it. */}
                    <td style={{ padding: '11px 14px', fontWeight: 600 }}>
                      <button
                        className="row-link"
                        onClick={(e) => openBatchPanel(e, p)}
                        title="Click to see all batches, prices and margins"
                      >
                        {p.name}
                      </button>
                    </td>
                    <td style={{ padding: '11px 14px', color: 'var(--text-muted)' }}>{p.generic_name || '—'}</td>
                    <td style={{ padding: '11px 14px', fontFamily: 'monospace', fontSize: 12 }}>{p.barcode || '—'}</td>
                    {/* The stock number opens the SAME popover — the dotted
                        underline was already teaching people to click it, so
                        it keeps working rather than going dead. */}
                    <td style={{ padding: '11px 14px' }}>
                      <button
                        onClick={(e) => openBatchPanel(e, p)}
                        title="Click to see batch breakdown"
                        style={{
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          fontWeight: 700, fontSize: 14, padding: 0,
                          color: stockOk ? 'var(--ok)' : 'var(--danger)',
                          textDecoration: 'underline dotted', textUnderlineOffset: 3,
                          textAlign: 'left', lineHeight: 1.3,
                        }}
                      >
                        <div>{stock.main}</div>
                        {stock.sub && (
                          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-hint)', textDecoration: 'none' }}>
                            {stock.sub}
                          </div>
                        )}
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
          onClose={() => setShowAddModal(false)}
          onSaved={handleCreated}
        />
      )}

      {/* Edit product modal */}
      {editProduct && (
        <ProductFormModal
          existing={editProduct}
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

      {/* Batch breakdown popover (opened from the medicine name / stock number).
          Keyed on the product id so clicking a DIFFERENT medicine while one is
          already open remounts it — otherwise the popover would keep the old
          medicine's measured height and flip decision for a frame. */}
      {batchPanelProduct && (
        <MedicineBatchPanel
          key={batchPanelProduct.id}
          product={batchPanelProduct}
          anchor={popoverPos}
          onClose={closeBatchPanel}
          onAddStock={openAddStockFromPanel}
          onEdited={handleBatchEdited}
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
  // Supplier discount — a PERCENTAGE of the purchase price, same as the
  // slide-in panel.  A percentage is basis-independent, so nothing has to be
  // converted between strips and units.
  discount_percent: '',
  // Purchase scheme (Feature B) — '' = None, or a preset / 'CUSTOM'
  scheme: '', scheme_buy: '', scheme_free: '',
});

/**
 * Everything one bulk row derives from what was typed into it (Fix 10).
 *
 * Kept in ONE function so the table cells, the invoice total and the submit
 * payload can never disagree — they all read the same object.  Same rules as
 * the single-medicine Add Stock panel:
 *   • a strip medicine is entered in STRIPS, prices are per STRIP
 *   • the backend always receives individual UNITS and per-UNIT prices
 *   • the invoice follows the distributor's order: S.Rate − discount = goods
 *     value, then GST charged ON THE GOODS VALUE
 */
function bulkRowCalc(r) {
  const p        = r.product;
  const isStrip  = Boolean(p?.is_strip && p?.units_per_strip);
  const perStrip = Number(p?.units_per_strip) || 1;
  const gstRate  = Number(p?.gst_rate) || 0;

  const qtyTyped  = parseInt(r.quantity, 10) || 0;      // strips OR units
  const paidUnits = isStrip ? qtyTyped * perStrip : qtyTyped;

  // Prices are typed in the same basis as the quantity.
  const sellPerBasis = parseFloat(r.mrp) || 0;
  const costPerBasis = parseFloat(r.cost_price) || 0;    // the S.Rate, as typed
  const unitMrp  = round4(isStrip && perStrip > 0 ? sellPerBasis / perStrip : sellPerBasis);
  const unitCost = round4(isStrip && perStrip > 0 ? costPerBasis / perStrip : costPerBasis);

  // Supplier discount — a percentage of the purchase price.  Worked out PER
  // UNIT (the basis the backend uses) so the row total on screen and the stored
  // invoice cannot round apart.  The discount comes off BEFORE GST (see below).
  const discount      = computeDiscount(unitCost, r.discount_percent, 0);
  const unitDiscount  = discount.amount;                        // ₹ off, per unit
  const netUnitCost   = discount.effective || unitCost;         // post-discount, per unit
  const netCostBasis  = isStrip ? round4(netUnitCost * perStrip) : netUnitCost;
  const discountBasis = isStrip ? round2(unitDiscount * perStrip) : unitDiscount;

  // Scheme bonus is counted in UNITS, exactly as the backend counts it.
  const scheme = resolveScheme(r.scheme, r.scheme_buy, r.scheme_free);
  const { bonus: bonusUnits, total: totalUnits } =
    schemePreview(paidUnits, scheme, isStrip ? perStrip : 1);

  // The invoice line, in the distributor's own order.
  const grossGoods    = round2(paidUnits * unitCost);       // rate card × qty
  const goodsValue    = round2(paidUnits * netUnitCost);    // after discount, ex-GST
  const discountTotal = round2(grossGoods - goodsValue);    // reconciles exactly
  const gstAmount     = round2(goodsValue * gstRate / 100); // tax on goods value
  const lineTotal     = round2(goodsValue + gstAmount);     // what we owe

  // Margin compares like with like: the MRP with its GST taken out, against the
  // post-discount ex-GST cost.  MRP is tax-inclusive, the cost is not, so
  // comparing them raw would flatter every row (see ProfitAnalysis).
  const sellExGst = sellPerBasis > 0 ? round2(sellPerBasis * 100 / (100 + gstRate)) : 0;
  const marginPct = sellExGst > 0 && netCostBasis > 0
    ? ((sellExGst - netCostBasis) / sellExGst) * 100
    : null;
  // Discount first, then the scheme bonus — same order the backend applies.
  const effectiveCost = totalUnits > 0 && netCostBasis > 0
    ? round2(netCostBasis * paidUnits / totalUnits)
    : 0;

  // Margin AFTER the free bonus units are counted (Fix 4b).  Buying 10 strips
  // and getting 1 free means the 11 strips cost what 10 did, so every strip
  // really cost less than the price on the invoice — that is the number the
  // pharmacist is actually earning on.  Only meaningful when a scheme is on and
  // it genuinely lowers the cost.
  const hasScheme = Boolean(scheme) && effectiveCost > 0 && effectiveCost < netCostBasis;
  const effectiveMarginPct = hasScheme && sellExGst > 0
    ? ((sellExGst - effectiveCost) / sellExGst) * 100
    : null;

  return {
    isStrip, perStrip, gstRate, qtyTyped, paidUnits,
    sellPerBasis, sellExGst, costPerBasis, unitMrp, unitCost,
    discount, netCostBasis, netUnitCost, unitDiscount, discountBasis,
    scheme, bonusUnits, totalUnits,
    grossGoods, discountTotal, goodsValue, gstAmount, lineTotal,
    marginPct, effectiveCost, effectiveMarginPct,
    // `baseCost` kept as an alias: it now means the POST-discount goods value,
    // which is what the invoice's tax is charged on.
    baseCost: goodsValue,
  };
}

// ─── Bulk row cards (Fix 11) ───────────────────────────────────────────────
//
// The bulk rows used to be a ten-column TABLE.  Every field was squeezed into
// ~70px, the helper text under each one ("= 150 units", "₹9.50/unit", the
// margin badge) had nowhere to go, and the whole thing scrolled sideways on any
// normal screen.  Each medicine is now its own CARD:
//
//   ┌───────────────────────────────────────────────────────────────┐
//   │ MEDICINE  [search…]                  BATCH NO. [AMX-001]   ×  │
//   │ QTY   GST   SCHEME   EXPIRY   MRP   PURCHASE PRICE            │
//   │ ─────────────────────────────────────────────────────────────  │
//   │ 10 strips × ₹86.10 − 5% + GST 5%                    ₹257.66   │
//   └───────────────────────────────────────────────────────────────┘
//
// Nothing about the DATA changed — every field still writes to the same row
// state through setRow, and every figure on screen still comes from the one
// bulkRowCalc() call, so the cards, the invoice breakdown and the submitted
// payload cannot disagree.

/** Uppercase mini-label above a field inside a medicine card. */
function CardLabel({ children }) {
  return (
    <label style={{
      display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
      textTransform: 'uppercase', color: 'var(--text-hint)', marginBottom: 4,
    }}>
      {children}
    </label>
  );
}

/** The small grey explanation line under a field ("= 150 units"). */
const CARD_HINT = { fontSize: 10.5, color: 'var(--text-hint)', marginTop: 3 };

/**
 * A narrow number box — the scheme's Buy/Free pair and the discount %.
 *
 * `className="no-spinner"` is what fixes Fix 11's first bug: at this width the
 * browser's native spinner arrows overlap the digits, so they are hidden in
 * global.css and the box reads as a plain number field.
 */
const MINI_INPUT = { width: 52, padding: '5px 6px', fontSize: 12, textAlign: 'center' };

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
  /** Trade discount for one row — a percentage, same as the slide-in panel. */
  function setRowDiscountPercent(key, value) {
    setRow(key, { discount_percent: value });
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
  // Each row's line total follows the distributor's invoice:
  //   (S.Rate × PAID quantity − trade discount) + GST on what is left.
  // Scheme bonus units are free, so they never change the invoice.
  function lineTotal(r) {
    return bulkRowCalc(r).lineTotal;
  }
  // Round to paise at every step — floats drift otherwise (0.1 + 0.2 !== 0.3).
  const invoiceTotal = round2(rows.reduce((sum, r) => sum + lineTotal(r), 0));
  // Ex-GST goods value and the tax, shown as their own lines so the total
  // reconciles against the distributor's paper invoice (Fix 10c).
  const invoiceBase  = round2(rows.reduce((sum, r) => sum + bulkRowCalc(r).baseCost, 0));
  const invoiceGst   = round2(invoiceTotal - invoiceBase);

  // Advance actually usable across the whole delivery.
  const advanceUsed = Math.min(parseFloat(advanceUsedInput) || 0, advanceBalance, invoiceTotal);
  const afterAdvance = Math.max(0, round2(invoiceTotal - advanceUsed));

  // Paying MORE than what's left after the advance is pointless, so cap it.
  const paidNow = Math.min(parseFloat(amountPaid) || 0, afterAdvance);
  const creditAmount = Math.max(0, round2(afterAdvance - paidNow));
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
      const c = bulkRowCalc(r);
      if (!r.batch_number.trim()) return setError(`Batch number missing for ${r.product.name}.`);
      if (c.qtyTyped <= 0) {
        return setError(`${c.isStrip ? 'Number of strips' : 'Quantity'} must be positive for ${r.product.name}.`);
      }
      if (!r.expiry_month || !r.expiry_year) return setError(`Expiry month and year missing for ${r.product.name}.`);
      // Combine dropdowns into "YYYY-MM" and check it is in the future.
      if (`${r.expiry_year}-${r.expiry_month}` < todayISO().slice(0, 7)) return setError(`Expiry must be in the future for ${r.product.name}.`);
      if (c.sellPerBasis <= 0) {
        return setError(`${c.isStrip ? 'Strip MRP' : 'MRP'} must be positive for ${r.product.name}.`);
      }
      // Fix 9 — purchase price is mandatory here too, for the same reasons as
      // the slide-in panel: no cost means no profit figure and a ₹0 invoice.
      if (c.costPerBasis <= 0) return setError(`Purchase price is required for ${r.product.name}.`);
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
      const rowTotal = lineTotal(r);
      const rowLeft  = round2(rowTotal - advancePerRow[i]);
      const pay      = Math.min(payRemaining, rowLeft);
      payRemaining   = round2(payRemaining - pay);
      return pay;
    });
    // Collected so we can report the real credit figure after the run — rows
    // can fail individually, so we cannot trust the pre-submit estimate.
    let creditCreated = 0;

    // Submit each row one at a time (offline-safe, clear per-row errors).
    for (let i = 0; i < filled.length; i += 1) {
      const r          = filled[i];
      const c          = bulkRowCalc(r);
      const rowTotal   = c.lineTotal;
      const rowAdvance = advancePerRow[i];
      const rowPaid    = paidPerRow[i];
      // This row leaves a balance -> it needs the due date attached.
      const rowCredit  = round2(rowTotal - rowAdvance - rowPaid);
      const rowScheme  = c.scheme;
      try {
        const { data } = await api.post('/inventory/add-stock', {
          product_id:              r.product.id,
          supplier_id:             Number(supplierId),
          supplier_invoice_number: invoiceNo.trim(),
          supplier_invoice_date:   invoiceDate,
          batch_number:            r.batch_number.trim(),
          // Paid quantity in individual UNITS (strips already multiplied out) —
          // the backend adds the scheme bonus on top.
          quantity:                c.paidUnits,
          expiry_date:             `${r.expiry_year}-${r.expiry_month}`,
          // Batches always store PER-UNIT prices, never per-strip.
          mrp:                     Number(c.unitMrp.toFixed(4)),
          cost_price:              Number(c.unitCost.toFixed(4)),
          // Supplier discount — only the percentage is sent; the backend
          // derives the rupee figure with the same formula, so the two can
          // never round apart.
          discount_percent:        c.discount.percent,
          // Refresh the product's cached strip prices from this delivery.
          strip_mrp:               c.isStrip ? c.sellPerBasis : null,
          unit_mrp:                c.isStrip ? Number(c.unitMrp.toFixed(4)) : null,
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

      {/* ── Medicine cards ──────────────────────────────────────────────────
          One card per medicine on the supplier's invoice.  See the block
          comment above CardLabel for why this is no longer a table. */}
      {rows.map((r) => {
        // ONE calculation per card, reused by every field and the footer below,
        // so the same figure can never read differently in two places (Fix 10).
        const c      = bulkRowCalc(r);
        const basis  = c.isStrip ? 'strips' : 'units';
        // A scheme is quoted in PACKS, so the bonus is shown in the basis the
        // quantity was typed in — free STRIPS for a strip medicine.
        const bonusInBasis = c.isStrip ? c.bonusUnits / c.perStrip : c.bonusUnits;
        return (
          <div key={r.key} style={{
            background: 'rgba(255,255,255,0.80)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(99,102,241,0.12)',
            borderRadius: 'var(--radius-lg)',
            padding: 16,
            marginBottom: 10,
            position: 'relative',
          }}>
            {/* ── Card header: which medicine, and which batch of it ──────── */}
            <div style={{
              display: 'flex', gap: 10, alignItems: 'flex-start',
              flexWrap: 'wrap', marginBottom: 12,
            }}>
              {/* Medicine — the widest field, since a medicine name is long */}
              <div style={{ flex: '2 1 240px', minWidth: 0 }}>
                <CardLabel>Medicine</CardLabel>
                {r.product ? (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600 }}>{r.product.name}</span>
                      <button
                        onClick={() => setRow(r.key, { product: null })}
                        style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}
                      >
                        change
                      </button>
                    </div>
                    {c.isStrip && (
                      <div style={CARD_HINT}>
                        Strip medicine · {c.perStrip} units/strip
                      </div>
                    )}
                  </div>
                ) : (
                  <MedicineSearchBox
                    placeholder="Search medicine…"
                    // Add Stock is picking a MEDICINE, not a box off the
                    // shelf: the batch being received does not exist yet.
                    // So collapse the per-batch rows to one per product,
                    // and keep out-of-stock medicines selectable — running
                    // out is the usual reason to be on this screen.
                    oneRowPerProduct
                    allowOutOfStock
                    onSelect={(prod) => setRow(r.key, {
                      // Keep the strip + GST fields on the row: every field
                      // and the submit payload derive from them.
                      product: {
                        id:              prod.id,
                        name:            prod.name,
                        gst_rate:        prod.gst_rate,
                        is_strip:        prod.is_strip,
                        units_per_strip: prod.units_per_strip,
                      },
                      // Pre-fill MRP from the last known price — the strip
                      // price for a strip medicine, since that is the basis
                      // this row is typed in.
                      mrp: r.mrp || (
                        prod.is_strip && prod.units_per_strip
                          ? (prod.strip_mrp ? String(prod.strip_mrp) : '')
                          : (prod.mrp ? String(prod.mrp) : '')
                      ),
                    })}
                  />
                )}
              </div>

              {/* Batch number — printed on the box, one per delivery */}
              <div style={{ flex: '1 1 140px', minWidth: 0 }}>
                <CardLabel>Batch No.</CardLabel>
                <input
                  value={r.batch_number}
                  onChange={(e) => setRow(r.key, { batch_number: e.target.value })}
                  placeholder="e.g. AMX-001"
                />
              </div>

              {/* Remove this medicine from the delivery.  The last remaining
                  card cannot be removed — an empty form has nothing to type
                  into. */}
              <button
                onClick={() => removeRow(r.key)}
                disabled={rows.length === 1}
                title="Remove medicine"
                style={{
                  marginTop: 20, padding: 6, border: 'none', background: 'transparent',
                  color: 'var(--danger)', fontSize: 18, flexShrink: 0, lineHeight: 1,
                  cursor: rows.length === 1 ? 'not-allowed' : 'pointer',
                  opacity: rows.length === 1 ? 0.3 : 1,
                }}
              >
                ×
              </button>
            </div>

            {/* ── The numbers: quantity, GST, scheme, expiry, prices ────────
                `auto-fit` gives six equal columns on a normal screen and wraps
                them onto a second line on a narrow one, so the card never
                needs a sideways scrollbar the way the old table did. */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: 10, alignItems: 'start',
            }}>

              {/* Quantity — strips for a strip medicine, with the unit count
                  spelled out underneath so nothing is ambiguous. */}
              <div>
                <CardLabel>{c.isStrip ? 'Strips' : 'Qty'}</CardLabel>
                <input
                  type="number" min="1" placeholder="0"
                  value={r.quantity}
                  onChange={(e) => setRow(r.key, { quantity: e.target.value })}
                />
                <div style={CARD_HINT}>{c.isStrip ? 'Strips' : 'Units'}</div>
                {c.isStrip && c.qtyTyped > 0 && (
                  <div style={{ fontSize: 10.5, color: 'var(--accent)', fontWeight: 600, marginTop: 1 }}>
                    = {c.paidUnits.toLocaleString('en-IN')} units
                  </div>
                )}
              </div>

              {/* GST — read-only: it belongs to the product, not the delivery */}
              <div>
                <CardLabel>GST %</CardLabel>
                <div style={{
                  padding: '9px 10px', borderRadius: 'var(--radius)',
                  border: '1px solid var(--border)', fontSize: 13, fontWeight: 600,
                  background: r.product ? 'var(--accent-light)' : 'rgba(0,0,0,0.03)',
                  color: r.product ? 'var(--accent-dark)' : 'var(--text-hint)',
                }}>
                  {r.product ? `${c.gstRate}%` : '—'}
                </div>
                <div style={CARD_HINT}>From the medicine</div>
              </div>

              {/* Scheme — "5+1" means buy 5 STRIPS, get 1 strip free. */}
              <div>
                <CardLabel>Scheme</CardLabel>
                <select value={r.scheme} onChange={(e) => setRow(r.key, { scheme: e.target.value })}>
                  {SCHEME_PRESETS.map(([value, label]) => (
                    <option key={value || 'none'} value={value}>
                      {value === 'CUSTOM' ? 'Custom…' : label}
                    </option>
                  ))}
                </select>

                {/* Custom scheme (Fix 11) — two plain number boxes, "Buy + Free".
                    The spinner arrows are hidden (.no-spinner in global.css)
                    because at this width they sat on top of the digits. */}
                {r.scheme === 'CUSTOM' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                    <input
                      type="number" min="1" className="no-spinner"
                      placeholder="Buy"
                      value={r.scheme_buy}
                      onChange={(e) => setRow(r.key, { scheme_buy: e.target.value })}
                      style={MINI_INPUT}
                    />
                    <span style={{ color: 'var(--text-hint)', fontSize: 14, fontWeight: 700 }}>+</span>
                    <input
                      type="number" min="1" className="no-spinner"
                      placeholder="Free"
                      value={r.scheme_free}
                      onChange={(e) => setRow(r.key, { scheme_free: e.target.value })}
                      style={MINI_INPUT}
                    />
                  </div>
                )}
                {/* Both boxes are needed before "Buy 5 get 1" means anything —
                    say so rather than silently ignoring a half-typed scheme
                    (the submit check rejects it too). */}
                {r.scheme === 'CUSTOM' && !c.scheme && (
                  <div style={{ ...CARD_HINT, color: 'var(--warn)' }}>
                    Fill in both Buy and Free
                  </div>
                )}

                {/* Live bonus preview — "5+2 → +2 strips free". */}
                {c.scheme && c.qtyTyped > 0 && (
                  c.bonusUnits > 0 ? (
                    <div style={{ fontSize: 10.5, color: 'var(--info)', fontWeight: 700, marginTop: 4 }}>
                      {c.scheme.label} → +{bonusInBasis.toLocaleString('en-IN')} {basis} free
                      <div style={{ ...CARD_HINT, marginTop: 1 }}>
                        {c.totalUnits.toLocaleString('en-IN')} units total
                      </div>
                    </div>
                  ) : (
                    // Only WHOLE sets earn a bonus: 4 strips on "5+1" earns
                    // nothing, and that is easier to see stated than guessed.
                    <div style={{ ...CARD_HINT, color: 'var(--warn)' }}>
                      {c.qtyTyped} {basis} — needs {c.scheme.buy} for a free set
                    </div>
                  )
                )}
                {r.product && !c.scheme && r.scheme !== 'CUSTOM' && (
                  <div style={CARD_HINT}>Counted in {basis}</div>
                )}
              </div>

              {/* Expiry — dropdowns only, so an impossible year cannot be typed */}
              <div>
                <CardLabel>Expiry</CardLabel>
                <MonthYearSelect
                  compact
                  month={r.expiry_month} year={r.expiry_year}
                  onMonth={(v) => setRow(r.key, { expiry_month: v })}
                  onYear={(v) => setRow(r.key, { expiry_year: v })}
                />
                <div style={CARD_HINT}>Month + year</div>
              </div>

              {/* MRP — per strip for a strip medicine, with the derived
                  per-unit price underneath so the two can be eyeballed.
                  Batches always STORE the per-unit figure. */}
              <div>
                <CardLabel>{c.isStrip ? 'Strip MRP' : 'MRP'}</CardLabel>
                <input
                  type="number" min="0.01" step="0.01" placeholder="0.00"
                  value={r.mrp}
                  onChange={(e) => setRow(r.key, { mrp: e.target.value })}
                />
                <div style={CARD_HINT}>{c.isStrip ? 'Per strip · incl. GST' : 'Per unit · incl. GST'}</div>
                {c.isStrip && c.unitMrp > 0 && (
                  <div style={{ fontSize: 10.5, color: 'var(--accent)', marginTop: 1 }}>
                    = {inr(c.unitMrp)}/unit
                  </div>
                )}
              </div>

              {/* Purchase price (mandatory — Fix 9) with the trade discount
                  underneath it, because the two are read together: the margin
                  badge below is measured against the DISCOUNTED cost. */}
              <div>
                <CardLabel>Purchase Price</CardLabel>
                <input
                  type="number" min="0.01" step="0.01" required
                  placeholder="required"
                  value={r.cost_price}
                  onChange={(e) => setRow(r.key, { cost_price: e.target.value })}
                  style={{
                    // Flag an empty price on a row that is otherwise filled in.
                    borderColor: r.product && c.costPerBasis <= 0 ? 'var(--danger)' : undefined,
                  }}
                />
                <div style={CARD_HINT}>{c.isStrip ? 'Per strip' : 'Per unit'} · ex-GST</div>

                {/* Trade discount — a PERCENTAGE only.  A rupee figure would
                    need a basis (per tablet? per strip? per line?), which is
                    exactly what used to mis-state a supplier debt. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5 }}>
                  <input
                    type="number" min="0" max="100" step="0.01" className="no-spinner"
                    placeholder="0"
                    value={r.discount_percent}
                    onChange={(e) => setRowDiscountPercent(r.key, e.target.value)}
                    title="Discount as a percentage of the purchase price"
                    style={MINI_INPUT}
                  />
                  <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>% disc.</span>
                </div>
                {/* The saving stated across the whole line once there is a
                    quantity — that is the figure the paper invoice prints. */}
                {c.unitDiscount > 0 && (
                  <div style={{ fontSize: 10.5, color: 'var(--ok)', fontWeight: 600, marginTop: 3 }}>
                    {c.grossGoods > 0
                      ? `−${inr(c.discountTotal)} on ${inr(c.grossGoods)}`
                      : `−${inr(c.discountBasis)}/${c.isStrip ? 'strip' : 'unit'}`}
                    <div style={{ fontWeight: 500, color: 'var(--text-hint)' }}>
                      Effective {inr(c.netCostBasis)}/{c.isStrip ? 'strip' : 'unit'}
                    </div>
                  </div>
                )}

                {/* Margin badge — both sides ex-GST (see ProfitAnalysis). */}
                {c.marginPct != null && (() => {
                  const tone = marginTone(c.marginPct);
                  return (
                    <div style={{ marginTop: 4 }}>
                      <span
                        title={`Both sides ex-GST: MRP ${inr(c.sellPerBasis)} incl. GST = ${inr(c.sellExGst)} ex-GST, against an effective cost of ${inr(c.netCostBasis)}`}
                        style={{
                          display: 'inline-block', padding: '2px 7px', borderRadius: 999,
                          fontSize: 10.5, fontWeight: 700,
                          background: tone.bg, color: tone.color,
                          border: `1px solid ${tone.border}`,
                        }}
                      >
                        {c.marginPct.toFixed(1)}% margin
                      </span>
                    </div>
                  );
                })()}
                {/* Margin AFTER the free bonus units are counted (Fix 4b) —
                    free stock can only ever lower the real cost. */}
                {c.effectiveMarginPct != null && (
                  <div style={{ marginTop: 3, fontSize: 10, fontWeight: 700, color: 'var(--ok)' }}>
                    {c.effectiveMarginPct.toFixed(1)}% effective (with {c.scheme.label})
                  </div>
                )}
              </div>

            </div>

            {/* ── Line total ───────────────────────────────────────────────
                The distributor's own order, spelled out so it can be checked
                against the paper invoice line by line: S.Rate × qty, minus the
                trade discount, then GST charged on WHAT IS LEFT. */}
            {c.lineTotal > 0 && (
              <div style={{
                marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
                gap: 12, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)',
              }}>
                <div>
                  {c.qtyTyped.toLocaleString('en-IN')} {basis} × {inr(c.costPerBasis)}
                  {c.discount.percent > 0 && ` − ${round2(c.discount.percent)}%`}
                  {c.gstRate > 0 && ` + GST ${c.gstRate}%`}
                  <div style={CARD_HINT}>
                    Goods {inr(c.goodsValue)} + GST {inr(c.gstAmount)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: 14 }}>
                    {inr(c.lineTotal)}
                  </div>
                  <div style={{ ...CARD_HINT, marginTop: 0 }}>incl. GST</div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <button className="btn-secondary" onClick={addRow} style={{ fontSize: 13 }}>
        + Add Medicine
      </button>

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

        {/* ── Per-medicine invoice breakdown (Fix 4a) ─────────────────────
            "Goods ₹600 + GST ₹30" is one lump sum — it cannot be checked
            against the distributor's paper invoice, which is itemised.  Spell
            out each line the way the paper does, in the basis the pharmacist
            typed (strips for a strip medicine, units otherwise). */}
        {rows.some((r) => r.product && bulkRowCalc(r).baseCost > 0) && (
          <div style={{
            background: 'rgba(255,255,255,0.55)', border: '1px solid var(--glass-border)',
            borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 14,
          }}>
            <div style={{
              fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
              color: 'var(--text-hint)', marginBottom: 8,
            }}>
              Invoice Breakdown
            </div>
            {rows.map((r) => {
              const c = bulkRowCalc(r);
              if (!r.product || c.baseCost <= 0) return null;
              const basis = c.isStrip ? 'strip' : 'unit';
              return (
                <div key={r.key} style={{
                  display: 'flex', justifyContent: 'space-between', gap: 12,
                  fontSize: 12, marginBottom: 4, flexWrap: 'wrap',
                }}>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    <strong style={{ color: 'var(--text)' }}>{r.product.name}</strong>
                    {': '}
                    {c.qtyTyped.toLocaleString('en-IN')} {basis}s × {inr(c.costPerBasis)}/{basis}
                    {/* Spell out the discount step — this row's tax is charged
                        on the figure AFTER it, not on the rate card. */}
                    {c.discountTotal > 0 && (
                      <span style={{ color: 'var(--ok)' }}>
                        {' '}− {inr(c.discountTotal)}
                        {c.discount.percent > 0 ? ` (${round2(c.discount.percent)}%)` : ''}
                      </span>
                    )}
                  </span>
                  <span style={{ color: 'var(--text)', whiteSpace: 'nowrap' }}>
                    = {inr(c.goodsValue)} + GST {inr(c.gstAmount)}
                  </span>
                </div>
              );
            })}
            <div style={{
              display: 'flex', justifyContent: 'space-between', fontSize: 12.5,
              borderTop: '1px solid rgba(0,0,0,0.10)', paddingTop: 6, marginTop: 6,
            }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>
                Goods {inr(invoiceBase)} + GST {inr(invoiceGst)}
              </span>
              <strong style={{ color: 'var(--text)' }}>{inr(invoiceTotal)}</strong>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
          {/* Invoice Total — auto-calculated from the rows above */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', display: 'block', marginBottom: 4 }}>
              Invoice Total (₹) — incl. GST
            </label>
            <div style={{
              padding: '8px 12px', background: 'rgba(0,0,0,0.04)',
              borderRadius: 'var(--radius)', fontSize: 14, fontWeight: 600, color: 'var(--text)',
            }}>
              {inr(invoiceTotal)}
            </div>
            {/* Goods value is already net of any discount, and the GST was
                charged on that — show the split, because this is exactly what
                the paper invoice looks like. */}
            {invoiceTotal > 0 && (
              <div style={{ fontSize: 10.5, color: 'var(--text-hint)', marginTop: 3, lineHeight: 1.6 }}>
                Goods {inr(invoiceBase)} + GST {inr(invoiceGst)}
              </div>
            )}
            <div style={{ fontSize: 10, color: 'var(--text-hint)', marginTop: 3 }}>
              (S.Rate × qty − discount) + GST on that, summed across all rows
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

const PH_TH = {
  padding: '11px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-hint)',
  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const PH_TD = { padding: '10px 12px' };

/**
 * The purchases from ONE distributor, loaded when their row is expanded.
 *
 * Lazily fetched rather than pulled down with the supplier list: a pharmacy
 * that has been running a year has thousands of purchase rows, and the
 * pharmacist opens one supplier at a time.
 */
function SupplierPurchaseRows({ supplierId, dateFrom, dateTo }) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);   // id of the expanded entry

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: 200, offset: 0, supplier_id: supplierId });
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo)   params.set('date_to', dateTo);
    api.get(`/inventory/purchase-history?${params}`)
      .then(({ data }) => setRows(data.items))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [supplierId, dateFrom, dateTo]);

  if (loading) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
        Loading purchases…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
        No purchases from this distributor in the selected dates.
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      {/* The API already returns newest first, which is the order a pharmacist
          scans a distributor's dealings in. */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 780 }}>
        <thead>
          <tr>
            {['Date', 'Invoice No', 'Medicine', 'Batch', 'Qty', 'Scheme', 'MRP', 'Cost', 'Added By'].map((h) => (
              <th key={h} style={PH_TH}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.id}>
              <tr
                onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(99,102,241,0.04)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
              >
                <td style={PH_TD}>{formatDate(r.supplier_invoice_date)}</td>
                <td style={{ ...PH_TD, fontFamily: 'monospace', fontSize: 12 }}>{r.supplier_invoice_number}</td>
                <td style={{ ...PH_TD, fontWeight: 600 }}>{r.product_name}</td>
                <td style={PH_TD}>{r.batch_number || '—'}</td>
                <td style={{ ...PH_TD, fontWeight: 700 }}>{r.quantity}</td>
                <td style={PH_TD}>
                  {r.scheme_label ? (
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 6,
                      background: 'var(--info-bg)', color: 'var(--info)',
                    }}>
                      {r.scheme_label}
                    </span>
                  ) : '—'}
                </td>
                <td style={PH_TD}>{inr(r.mrp)}</td>
                <td style={PH_TD}>{r.cost_price != null ? inr(r.cost_price) : '—'}</td>
                <td style={{ ...PH_TD, color: 'var(--text-muted)' }}>{r.added_by || '—'}</td>
              </tr>
              {expanded === r.id && (
                <tr style={{ background: 'rgba(255,255,255,0.6)' }}>
                  <td colSpan={9} style={{ padding: '12px 18px' }}>
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
  );
}

/**
 * Purchase History, GROUPED BY DISTRIBUTOR.
 *
 * WHY GROUPED AND NOT A FLAT LIST:
 * the flat list interleaved every supplier, so the question a pharmacist
 * actually asks — "what have I bought from Shakti, and what did it come to?" —
 * meant scrolling and filtering by eye.  Each distributor now gets one summary
 * line (entries, last purchase, total billed) and their deliveries open
 * underneath it as an accordion.
 *
 * The date filters stay at the top and apply to the DETAIL rows, not the
 * summary: the summary answers "who do I deal with", which should not change
 * shape as you narrow a date window.
 */
function PurchaseHistoryTab() {
  const [groups, setGroups]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId]   = useState(null);   // supplier_id of the open accordion

  const [search, setSearch]   = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo]     = useState('');

  useEffect(() => {
    setLoading(true);
    api.get('/inventory/purchase-history/by-supplier')
      .then(({ data }) => setGroups(data.suppliers || []))
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, []);

  // Filtering the supplier list is a client-side name match: the list is one
  // row per distributor, which is tens of rows, not thousands.
  const visible = groups.filter((g) =>
    !search.trim() || g.supplier_name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const grandTotal = visible.reduce((s, g) => s + Number(g.total_value || 0), 0);

  return (
    <div>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search distributor…"
          style={{ maxWidth: 280 }}
        />
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          From <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          To <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </label>
        <span style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>
          Dates filter the purchases inside each distributor
        </span>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading…
        </div>
      ) : visible.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
          No purchase records found.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {visible.map((g) => {
              const open = openId === g.supplier_id;
              return (
                <div key={g.supplier_id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  {/* Summary line — the whole row is the toggle, so there is no
                      small target to aim at. */}
                  <div
                    onClick={() => setOpenId(open ? null : g.supplier_id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
                      padding: '14px 18px', cursor: 'pointer',
                      background: open ? 'rgba(99,102,241,0.06)' : 'transparent',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                        {g.supplier_name}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                        Last purchase: {g.last_purchase_date ? formatDate(g.last_purchase_date) : '—'}
                        {' · '}{g.product_count} medicine{g.product_count === 1 ? '' : 's'}
                        {g.supplier_phone ? ` · ${g.supplier_phone}` : ''}
                      </div>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--accent-dark)' }}>
                        {inr(g.total_value)}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>
                        {g.entry_count} {g.entry_count === 1 ? 'entry' : 'entries'}
                      </div>
                    </div>

                    <button
                      onClick={(e) => { e.stopPropagation(); setOpenId(open ? null : g.supplier_id); }}
                      className="btn-secondary"
                      style={{ padding: '6px 14px', fontSize: 12.5, whiteSpace: 'nowrap' }}
                    >
                      {open ? 'Hide History' : 'View History →'}
                    </button>
                  </div>

                  {/* Detail — only mounted while open, so nothing is fetched
                      for the distributors the pharmacist did not ask about. */}
                  {open && (
                    <div style={{ borderTop: '1px solid var(--border)' }}>
                      <SupplierPurchaseRows
                        supplierId={g.supplier_id}
                        dateFrom={dateFrom}
                        dateTo={dateTo}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{
            marginTop: 14, textAlign: 'right', fontSize: 13, color: 'var(--text-muted)',
          }}>
            {visible.length} distributor{visible.length === 1 ? '' : 's'}
            {' · '}Total billed: <strong style={{ color: 'var(--text)' }}>{inr(grandTotal)}</strong>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main Medicines Page ───────────────────────────────────────────────────

export default function Inventory() {
  const [activeTab, setActiveTab]     = useState('products');
  const [suppliers, setSuppliers]     = useState([]);
  const [toast, setToast]             = useState(null);

  // Load lookup lists once on mount — they rarely change.
  // Categories are no longer fetched: the medicine form dropped the Category
  // field, and nothing else on this page reads them.
  useEffect(() => {
    api.get('/suppliers/')
      .then(({ data }) => setSuppliers(data))
      .catch(() => {});
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
        <ProductsTab suppliers={suppliers} showToast={showToast} />
      )}
      {activeTab === 'add-stock' && (
        <BulkAddStockTab suppliers={suppliers} showToast={showToast} />
      )}
      {activeTab === 'history' && (
        <PurchaseHistoryTab />
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
