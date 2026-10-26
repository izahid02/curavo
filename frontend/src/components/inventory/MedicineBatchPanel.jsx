/**
 * Medicine Batch popover — the full batch breakdown for ONE medicine.
 *
 * Opened by clicking a medicine's NAME (or its stock number) in the Medicines
 * table.  It appears as a POPOVER anchored just below whatever was clicked,
 * rather than a full-height slide-in from the right.
 *
 * Why a popover and not a slide-in:
 *   the pharmacist is glancing at prices for the row their eye is already on.
 *   A right-side panel drags attention across the whole screen and hides the
 *   table behind a dark backdrop; a popover keeps the row, and its neighbours,
 *   in view.  There is deliberately NO dark backdrop — only an invisible
 *   full-screen layer whose single job is to catch the "click outside to
 *   close" event.
 *
 * Why margin is per batch and not per medicine:
 *   the same tablet bought in January and again in June routinely has two
 *   different costs, while the MRP printed on the strip stays the same.  A
 *   single product-level "margin" would be an average of two real numbers and
 *   equal to neither, which is exactly the figure a pharmacist must not price
 *   from.  So every row carries its own.
 *
 * Everything comes from ONE request:
 *   GET /api/inventory/products/{id}/batches
 * which joins the purchase cost in from stock_purchases.
 */
import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/api';
import { getUser } from '../../lib/auth';
import { inr, formatMonthYear, stockLabel, marginTone } from '../../lib/inventoryFormat';

/** Fixed popover width.  Kept in one constant so the clamping maths below and
 *  the actual style can never drift apart. */
const POPOVER_WIDTH = 580;
/** Breathing room we always leave between the popover and the window edge. */
const EDGE_GAP = 16;

/**
 * Colour for the expiry cell.
 *
 * Deliberately COARSER than the six-level ExpiryBadge on the expiry alerts
 * page.  Here the pharmacist is checking prices, not triaging expiry, so three
 * bands answer the only question being asked — is this batch fine, going off
 * soon, or already dead stock?
 *
 *   red   → already expired (cannot be sold at all)
 *   amber → expires within 90 days
 *   green → more than 90 days left
 */
function expiryTone(daysToExpiry) {
  if (daysToExpiry < 0)  return { color: 'var(--danger)', label: 'Expired' };
  if (daysToExpiry <= 90) return { color: 'var(--warn)',   label: `${daysToExpiry}d left` };
  return                        { color: 'var(--ok)',      label: null };
}

/** Small coloured dot used next to a margin percentage. */
function Dot({ color }) {
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
      background: color, flexShrink: 0,
    }} />
  );
}

// ─── Batch edit ────────────────────────────────────────────────────────────

/** Roles allowed to correct a batch.  Must match _BATCH_EDIT_ROLES in
 *  backend/app/routers/inventory.py — the backend enforces it either way, but
 *  hiding a button nobody may press is friendlier than a 403. */
const BATCH_EDIT_ROLES = ['Owner', 'Administrator'];

const MONTHS = [
  ['01', 'Jan'], ['02', 'Feb'], ['03', 'Mar'], ['04', 'Apr'],
  ['05', 'May'], ['06', 'Jun'], ['07', 'Jul'], ['08', 'Aug'],
  ['09', 'Sep'], ['10', 'Oct'], ['11', 'Nov'], ['12', 'Dec'],
];
// Starts two years back, not at today: the whole point of editing a batch is
// often to correct an expiry that has ALREADY passed so the stock can be
// returned to the supplier.
const EDIT_YEARS = Array.from({ length: 17 }, (_, i) => new Date().getFullYear() - 2 + i);

const EDIT_INPUT = {
  width: '100%', padding: '5px 7px', fontSize: 12,
  border: '1px solid rgba(99,102,241,0.25)', borderRadius: 6,
  boxSizing: 'border-box', background: '#fff',
};

/** One labelled field inside the inline edit form. */
function EditField({ label, hint, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase',
        color: 'var(--text-hint)', marginBottom: 3,
      }}>
        {label}
      </div>
      {children}
      {hint && <div style={{ fontSize: 9.5, color: 'var(--text-hint)', marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

/**
 * The inline edit form that replaces a batch row when [Edit] is clicked.
 *
 * WHY IT REPLACES THE ROW instead of opening another modal:
 * this panel is ALREADY a portal-rendered popover.  A modal on top of it would
 * be a third stacking layer over a `backdrop-filter` ancestor, which is exactly
 * the arrangement that paints things underneath each other in this app
 * (CLAUDE.md § design system).  Editing in place also keeps the neighbouring
 * batches visible, which is what the pharmacist is comparing against.
 *
 * ⚠ PRICES ARE TYPED IN THE PHARMACIST'S BASIS AND SENT PER UNIT.
 * A strip medicine is priced per STRIP on the box, so that is what the MRP box
 * asks for — and this component divides by units_per_strip before sending,
 * because the backend never receives the word "strip" (CLAUDE.md § core domain
 * model).  Getting this backwards is the ₹95-strip-billed-at-₹950 bug.
 */
function BatchEditForm({ batch, isStrip, perStrip, onCancel, onSaved }) {
  // expiry_date arrives as "YYYY-MM-DD" (the last day of the expiry month).
  const [expMonth, setExpMonth] = useState((batch.expiry_date || '').slice(5, 7) || '01');
  const [expYear,  setExpYear]  = useState(
    Number((batch.expiry_date || '').slice(0, 4)) || new Date().getFullYear(),
  );

  const [form, setForm] = useState({
    batch_number: batch.batch_number || '',
    quantity:     String(batch.quantity_available ?? ''),
    // Shown in the pharmacist's basis: strip price for a strip medicine.
    mrp: String(
      isStrip
        ? (batch.strip_mrp ?? Number(batch.selling_price || 0) * perStrip)
        : (batch.selling_price ?? ''),
    ),
    // purchase_price from the API is the per-UNIT cost; show it per strip too
    // so both prices on this form are read in the same basis.
    purchase_price: batch.purchase_price != null
      ? String(Number(batch.purchase_price) * (isStrip ? perStrip : 1))
      : '',
    discount_percent: String(batch.discount_percent ?? 0),
    scheme_label:     batch.scheme_label || '',
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  const set = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  async function handleSave() {
    setError('');
    if (!form.batch_number.trim()) return setError('Batch number cannot be blank.');
    if (form.quantity === '' || Number(form.quantity) < 0) {
      return setError('Quantity must be zero or more.');
    }
    if (!form.mrp || Number(form.mrp) <= 0) return setError('MRP must be greater than zero.');

    setSaving(true);
    try {
      // Convert BOTH prices from the entry basis down to one unit, exactly as
      // the Add Stock panel does.  Full precision — no rounding here, or a
      // ₹86.10 strip of 15 drifts by nearly a rupee across a delivery.
      const divisor = isStrip ? perStrip : 1;
      const payload = {
        batch_number:     form.batch_number.trim(),
        quantity:         Number(form.quantity),
        expiry_date:      `${expYear}-${expMonth}`,
        selling_price:    Number(form.mrp) / divisor,
        discount_percent: Number(form.discount_percent) || 0,
        scheme_label:     form.scheme_label.trim(),
      };
      if (isStrip) payload.strip_mrp = Number(form.mrp);
      if (form.purchase_price !== '') {
        payload.purchase_price = Number(form.purchase_price) / divisor;
      }

      const { data } = await api.put(`/inventory/batches/${batch.batch_id}`, payload);
      onSaved(data.message || 'Batch updated');
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not save this batch.');
      setSaving(false);
    }
  }

  const basisNote = isStrip ? `per strip (${perStrip} units)` : 'per unit';

  return (
    <div style={{
      background: 'rgba(99,102,241,0.05)',
      border: '1px solid rgba(99,102,241,0.2)',
      borderRadius: 8, padding: 12,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10, color: 'var(--accent-dark)' }}>
        Edit batch {batch.batch_number || `#${batch.batch_id}`}
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10,
      }}>
        <EditField label="Batch Number">
          <input style={EDIT_INPUT} value={form.batch_number}
            onChange={(e) => set('batch_number', e.target.value)} />
        </EditField>

        <EditField label="Quantity" hint="in units, on hand now">
          <input style={EDIT_INPUT} type="number" min="0" value={form.quantity}
            onChange={(e) => set('quantity', e.target.value)} />
        </EditField>

        <EditField label="Expiry">
          <div style={{ display: 'flex', gap: 4 }}>
            <select style={EDIT_INPUT} value={expMonth} onChange={(e) => setExpMonth(e.target.value)}>
              {MONTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select style={EDIT_INPUT} value={expYear} onChange={(e) => setExpYear(e.target.value)}>
              {EDIT_YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </EditField>

        <EditField label="MRP" hint={`${basisNote}, incl. GST`}>
          <input style={EDIT_INPUT} type="number" step="0.01" min="0" value={form.mrp}
            onChange={(e) => set('mrp', e.target.value)} />
        </EditField>

        <EditField label="Purchase Price" hint={`S.Rate ${basisNote}, ex-GST`}>
          <input style={EDIT_INPUT} type="number" step="0.01" min="0" value={form.purchase_price}
            onChange={(e) => set('purchase_price', e.target.value)} />
        </EditField>

        <EditField label="Discount %" hint="off the S.Rate">
          <input style={EDIT_INPUT} type="number" step="0.01" min="0" max="100"
            value={form.discount_percent}
            onChange={(e) => set('discount_percent', e.target.value)} />
        </EditField>

        <EditField label="Scheme" hint="e.g. 5+1, in packs">
          <input style={EDIT_INPUT} value={form.scheme_label} placeholder="—"
            onChange={(e) => set('scheme_label', e.target.value)} />
        </EditField>
      </div>

      {/* Say plainly what a quantity change means — this is a correction of the
          count, not a delivery, and the supplier ledger is left alone. */}
      {Number(form.quantity) !== batch.quantity_available && (
        <div style={{ fontSize: 10.5, color: 'var(--warn)', marginTop: 8 }}>
          Stock will be adjusted by{' '}
          {Number(form.quantity) - batch.quantity_available > 0 ? '+' : ''}
          {Number(form.quantity) - batch.quantity_available} units and recorded as a
          manual ADJUST movement.
        </div>
      )}

      {error && (
        <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 8 }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
        <button className="btn-secondary" onClick={onCancel} disabled={saving}
          style={{ padding: '5px 14px', fontSize: 12 }}>
          Cancel
        </button>
        <button className="btn-primary" onClick={handleSave} disabled={saving}
          style={{ padding: '5px 14px', fontSize: 12 }}>
          {saving ? 'Saving…' : 'Save Batch'}
        </button>
      </div>
    </div>
  );
}

/**
 * @param product   the row that was clicked (used for the header until the
 *                  request lands, so the popover is never blank)
 * @param anchor    { top, left, anchorTop } from getBoundingClientRect() of the
 *                  clicked element — see openBatchPanel() in Inventory.jsx
 * @param onClose   close the popover
 * @param onAddStock  swap this popover for the Add Stock slide-in
 */
export default function MedicineBatchPanel({ product, anchor, onClose, onAddStock, onEdited }) {
  const [data, setData]       = useState(null);    // { product, batches }
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  // batch_id of the row currently being edited in place, or null.
  const [editingId, setEditingId] = useState(null);
  // Bumped after a save to re-run the fetch below and show the new figures.
  const [reloadKey, setReloadKey] = useState(0);

  // Only an Owner/Administrator may correct a batch — same rule the backend
  // enforces.  getUser() reads the user saved at login (see lib/auth.js).
  const canEdit = BATCH_EDIT_ROLES.includes(getUser()?.role_name);

  // ── Positioning ──────────────────────────────────────────────────────────
  // The popover is `position: fixed`, NOT absolute.  Absolute positioning would
  // be measured against the nearest positioned ancestor and get clipped by the
  // table's overflow container; fixed is measured against the viewport and
  // escapes it.  (It also pairs with the portal below — both are about getting
  // out of the table's stacking/overflow context.)
  const popRef = useRef(null);
  // `flipUp` = there was not enough room under the clicked row, so the popover
  // opens UPWARDS from it instead of running off the bottom of the screen.
  const [flipUp, setFlipUp]     = useState(false);
  const [maxHeight, setMaxHeight] = useState(null);

  const safeAnchor = anchor || { top: 120, left: 40, anchorTop: 100 };

  /**
   * Measure the rendered popover and decide whether it fits below the clicked
   * row.  useLayoutEffect (not useEffect) so the flip happens BEFORE the browser
   * paints — otherwise the user sees one frame of the popover hanging off the
   * bottom of the window before it jumps up.
   *
   * Re-runs when `data` arrives because the popover's height changes the moment
   * the batch rows replace the "Loading…" line.
   */
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const height      = el.offsetHeight;
    const spaceBelow  = window.innerHeight - safeAnchor.top - EDGE_GAP;
    const spaceAbove  = safeAnchor.anchorTop - EDGE_GAP * 2;
    // Flip only when it genuinely helps — no point opening upwards into an
    // even smaller gap near the top of the page.
    const shouldFlip  = height > spaceBelow && spaceAbove > spaceBelow;
    setFlipUp(shouldFlip);
    // Whichever direction we end up in, never let the popover exceed the space
    // available: the batch table scrolls inside it instead.
    setMaxHeight(Math.max(200, shouldFlip ? spaceAbove : spaceBelow));
  }, [data, loading, error, safeAnchor.top, safeAnchor.anchorTop]);

  // Close on Escape — standard popover behaviour, and faster than aiming at ×.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Fetch the batches whenever the popover opens for a different medicine.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.get(`/inventory/products/${product.id}/batches`)
      .then(({ data: res }) => { if (!cancelled) setData(res); })
      .catch(() => { if (!cancelled) setError('Could not load batches for this medicine.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // reloadKey re-runs this after a batch edit so the row, the margin and the
    // totals line all show the saved figures rather than the pre-edit ones.
  }, [product.id, reloadKey]);

  // Until the request lands, fall back to the row data we were handed so the
  // header is never blank.
  const info     = data?.product ?? product;
  const batches  = data?.batches ?? [];
  const isStrip  = Boolean(info.is_strip && info.units_per_strip);
  const perStrip = Number(info.units_per_strip) || 1;
  // "Basis" = the pack the pharmacist thinks in — a strip for tablets, the unit
  // itself for a syrup bottle.  Prices and costs are shown in this basis.
  const basis    = isStrip ? 'strip' : 'unit';

  // GST rate of this medicine — needed to take the tax back out of the MRP
  // before any margin is measured (see rowFigures).
  const gstRate = Number(info.gst_rate) || 0;

  /**
   * Everything one batch row displays, derived in one place so the table cell
   * and the summary below can never disagree.
   *
   *   mrp_ex_gst = MRP × 100 / (100 + gst_rate)
   *   margin %   = (mrp_ex_gst − purchase cost) / mrp_ex_gst × 100
   *
   * ⚠ THE TAX COMES OUT OF THE MRP FIRST.  MRP is GST-INCLUSIVE — the tax is
   * already inside the price on the box and we hand it to the government — while
   * the purchase cost is EX-GST.  Comparing them raw flatters every margin,
   * because only one side is carrying tax.  This is the same rule the Add Stock
   * profit card uses (ProfitAnalysis in Inventory.jsx); if the two ever disagree,
   * the same batch shows a green margin on one screen and an amber one on the
   * other.
   *
   * Both figures are converted to the SAME basis first.  (The ratio is
   * identical per-unit or per-strip, but showing per-strip money next to a
   * per-strip margin is what the pharmacist can check against the invoice.)
   */
  function rowFigures(b) {
    // The API sends per-UNIT prices, plus a ready-made strip_mrp that has
    // already had the ×15-from-₹6.67 rounding tail cleaned up.  Use that when
    // it is there rather than multiplying again and reintroducing the paise.
    const sellPerBasis = isStrip
      ? Number(b.strip_mrp ?? (b.selling_price || 0) * perStrip)
      : Number(b.selling_price || 0);
    // The same selling price with its GST removed — what actually stays with us.
    const sellExGst    = sellPerBasis > 0 ? sellPerBasis * 100 / (100 + gstRate) : 0;
    // purchase_price is null for stock received before cost price was recorded.
    const hasCost      = b.purchase_price !== null && b.purchase_price !== undefined;
    const costPerBasis = hasCost ? Number(b.purchase_price) * (isStrip ? perStrip : 1) : null;
    const marginPct    = hasCost && sellExGst > 0
      ? ((sellExGst - costPerBasis) / sellExGst) * 100
      : null;
    return { sellPerBasis, sellExGst, costPerBasis, marginPct };
  }

  // ── Summary figures (single line at the bottom of the popover) ────────────
  const totalUnits = batches.reduce((sum, b) => sum + (b.quantity_available || 0), 0);
  const totalStock = stockLabel(totalUnits, isStrip, perStrip);
  // "Active" = still sellable.  Expired batches are listed (they are physically
  // on the shelf until returned) but never counted as usable stock.
  const activeCount = batches.filter((b) => b.is_active).length;
  const expiredCount = batches.length - activeCount;
  // Best margin across batches that actually have a recorded cost.
  const best = batches.reduce((top, b) => {
    const { marginPct } = rowFigures(b);
    if (marginPct === null) return top;
    return (top === null || marginPct > top.marginPct) ? { marginPct, batch: b } : top;
  }, null);

  // ── Table columns ────────────────────────────────────────────────────────
  // A non-strip medicine has no strip price and no separate unit price, so the
  // MRP column is simply "MRP" and the Unit MRP column disappears entirely
  // rather than repeating the same number twice.
  const baseColumns = isStrip
    ? ['Batch No', 'Scheme', 'Stock', 'Expiry', 'Strip MRP', 'Unit MRP', 'Buy Price', 'Margin']
    : ['Batch No', 'Scheme', 'Stock', 'Expiry', 'MRP', 'Buy Price', 'Margin'];
  // The edit column only exists for roles that may actually use it, so a
  // Pharmacist does not see a button that would 403.
  const columns = canEdit ? [...baseColumns, ''] : baseColumns;

  // Tighter than the old slide-in — 8 columns have to live inside 580px now.
  const TH = {
    padding: '6px 8px', textAlign: 'left', whiteSpace: 'nowrap',
    fontSize: 11, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase',
    color: 'var(--text-hint)', borderBottom: '1px solid rgba(99,102,241,0.14)',
  };
  const TD = {
    padding: '8px', verticalAlign: 'top',
    borderBottom: '1px solid rgba(99,102,241,0.08)', fontSize: 12,
  };
  // Secondary lines inside a cell (raw units, "n free", days-to-expiry).
  const SUB = { fontSize: 10, color: 'var(--text-hint)', marginTop: 1 };
  // The Edit column is PINNED to the right edge.
  //
  // Eight columns do not fit in 580px, so the table scrolls sideways — and the
  // edit button, being last, sat permanently off the right edge.  The feature
  // existed and nobody could reach it.  Sticky keeps it against the edge
  // whatever the horizontal scroll is doing; the background is opaque so the
  // Margin column slides underneath it rather than showing through.
  const STICKY_EDIT = {
    position: 'sticky', right: 0, zIndex: 1,
    // Matches the popover's own near-white background, but fully opaque: at
    // 98% the Margin column would ghost through as it scrolls underneath.
    background: '#fff',
    boxShadow: '-6px 0 6px -6px rgba(15,23,42,0.18)',
  };

  // Horizontal clamp: if the popover would spill past the right edge, slide it
  // back left by exactly the overspill.  A transform is used rather than
  // changing `left` so the popover still *starts* from the clicked element and
  // only moves as much as it has to.  The Math.min stops a very narrow window
  // from shoving it off the LEFT edge while fixing the right.
  const overspill = Math.max(0, safeAnchor.left + POPOVER_WIDTH - window.innerWidth + EDGE_GAP);
  const shiftX    = Math.min(overspill, Math.max(0, safeAnchor.left - EDGE_GAP));

  return createPortal(
    <>
      {/* Invisible click-catcher.  NOT a dark backdrop — the table behind stays
          fully visible and legible; this layer exists only so a click anywhere
          off the popover closes it. */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 999, background: 'transparent' }}
      />

      <div
        ref={popRef}
        role="dialog"
        aria-label={`Batches for ${info.name}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          // When flipped, anchor the BOTTOM of the popover just above the
          // clicked row instead of the top just below it.
          top:    flipUp ? undefined : safeAnchor.top,
          bottom: flipUp ? window.innerHeight - safeAnchor.anchorTop + 8 : undefined,
          left: safeAnchor.left,
          transform: shiftX ? `translateX(-${shiftX}px)` : 'none',
          width: POPOVER_WIDTH,
          maxWidth: `calc(100vw - ${EDGE_GAP * 2}px)`,
          maxHeight: maxHeight ?? undefined,
          background: 'rgba(255,255,255,0.98)',
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(99,102,241,0.15)',
          borderRadius: 12,
          boxShadow: '0 8px 40px rgba(0,0,0,0.15)',
          zIndex: 1000,
          padding: 16,
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* ── Compact header ───────────────────────────────────────────────
            Name + one grey line of identity.  No big block of padding: the
            popover has to stay short enough to sit next to its row. */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 10, marginBottom: 10,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', lineHeight: 1.2 }}>
              {info.name}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
              {/* Only the parts we actually have — no dangling separators. */}
              {[
                info.generic_name,
                info.gst_rate !== null && info.gst_rate !== undefined ? `GST: ${Number(info.gst_rate)}%` : null,
                info.hsn_code ? `HSN: ${info.hsn_code}` : null,
                isStrip ? `${perStrip} units/strip` : null,
              ].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent', border: 'none', fontSize: 20,
              color: 'var(--text-hint)', cursor: 'pointer', lineHeight: 1,
              padding: 0, flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* ── Batch table ─────────────────────────────────────────────────
            Scrolls in BOTH directions inside the popover: vertically when a
            medicine has many batches, horizontally because 8 columns do not
            always fit in 580px on a narrow screen. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'auto', margin: '0 -4px' }}>
          {loading ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              Loading batches…
            </div>
          ) : error ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--danger)', fontSize: 13 }}>
              {error}
            </div>
          ) : batches.length === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No stock in hand. Use “+ Add Stock” below to record a delivery.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {columns.map((h, i) => (
                    <th
                      key={h || `actions-${i}`}
                      style={canEdit && i === columns.length - 1
                        ? { ...TH, ...STICKY_EDIT }
                        : TH}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => {
                  const { sellPerBasis, sellExGst, costPerBasis, marginPct } = rowFigures(b);
                  const qty   = stockLabel(b.quantity_available, isStrip, perStrip);
                  const exp   = expiryTone(b.days_to_expiry);
                  const tone  = marginPct === null ? null : marginTone(marginPct);

                  // While a row is being edited it is REPLACED by the form, so
                  // the pharmacist is never looking at stale numbers next to
                  // the boxes they are typing into.
                  if (editingId === b.batch_id) {
                    return (
                      <tr key={b.batch_id}>
                        <td colSpan={columns.length} style={{ padding: '8px 4px' }}>
                          <BatchEditForm
                            batch={b}
                            isStrip={isStrip}
                            perStrip={perStrip}
                            onCancel={() => setEditingId(null)}
                            onSaved={(message) => {
                              setEditingId(null);
                              setReloadKey((k) => k + 1);
                              if (onEdited) onEdited(message);
                            }}
                          />
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <tr key={b.batch_id}>
                      {/* Batch number, with the distributor underneath.
                          Deliberately NOT its own column: eight already do not
                          fit in 580px, and "who sold us this box" belongs with
                          the box's identity rather than off at the far right
                          where it would need a sideways scroll to read. */}
                      <td style={{ ...TD, fontWeight: 600, fontFamily: 'monospace' }}>
                        {b.batch_number || '—'}
                        {b.supplier_name && (
                          <div
                            style={{ ...SUB, fontFamily: 'inherit', fontWeight: 600, maxWidth: 130 }}
                            title={b.supplier_name}
                          >
                            {b.supplier_name}
                          </div>
                        )}
                      </td>

                      {/* Scheme, e.g. "5+1" — counted in packs, not tablets */}
                      <td style={TD}>
                        {b.scheme_label ? (
                          <span style={{
                            fontSize: 10.5, fontWeight: 700, padding: '2px 6px', borderRadius: 5,
                            background: 'var(--info-bg)', color: 'var(--info)', whiteSpace: 'nowrap',
                          }}>
                            {b.scheme_label}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-hint)' }}>—</span>
                        )}
                        {b.bonus_quantity > 0 && (
                          <div style={SUB}>{b.bonus_quantity.toLocaleString('en-IN')} free</div>
                        )}
                      </td>

                      {/* Stock — strips headline, raw units underneath */}
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        <div style={{ fontWeight: 700 }}>
                          {qty.sub ? qty.main : `${qty.main} units`}
                        </div>
                        {qty.sub && <div style={SUB}>{qty.sub}</div>}
                      </td>

                      {/* Expiry — colour says how urgent, not just when */}
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        <div style={{ fontWeight: 600, color: exp.color }}>
                          {formatMonthYear(b.expiry_date)}
                        </div>
                        {exp.label && <div style={{ ...SUB, color: exp.color }}>{exp.label}</div>}
                      </td>

                      {/* MRP — per strip for a strip medicine, else plain MRP */}
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>{inr(sellPerBasis)}</td>

                      {/* Unit MRP — strip medicines only */}
                      {isStrip && (
                        <td style={{ ...TD, whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                          {inr(b.unit_mrp ?? b.selling_price)}
                        </td>
                      )}

                      {/* Buy price — ex-GST cost in the same basis as the MRP */}
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        {costPerBasis === null ? (
                          <span style={{ color: 'var(--text-hint)' }}>—</span>
                        ) : (
                          <>
                            <div>{inr(costPerBasis)}</div>
                            <div style={SUB}>/{basis}</div>
                            {/* Say so when this is not the invoice rate: a
                                discount and a scheme both lower what a unit
                                really cost, and a pharmacist comparing this
                                against the distributor's bill should not be
                                left wondering why they differ. */}
                            {b.scheme_label && (
                              <div style={{ ...SUB, color: 'var(--ok)' }}>
                                incl. {b.scheme_label}
                              </div>
                            )}
                          </>
                        )}
                      </td>

                      {/* Margin — the number this whole popover exists for.
                          Measured on the ex-GST MRP, so hovering explains where
                          the smaller-looking figure comes from. */}
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        {marginPct === null ? (
                          <span style={{ color: 'var(--text-hint)' }}>—</span>
                        ) : (
                          <div
                            style={{ display: 'flex', alignItems: 'center', gap: 5 }}
                            title={`Both sides ex-GST: MRP ${inr(sellPerBasis)} incl. ${gstRate}% GST = ${inr(sellExGst)}, against a cost of ${inr(costPerBasis)}`}
                          >
                            <strong style={{ color: tone.color, fontSize: 13 }}>
                              {marginPct.toFixed(1)}%
                            </strong>
                            <Dot color={tone.color} />
                          </div>
                        )}
                      </td>

                      {/* Edit — corrects a mistyped batch, quantity, expiry or
                          price.  Owner/Administrator only. */}
                      {canEdit && (
                        <td style={{ ...TD, ...STICKY_EDIT, whiteSpace: 'nowrap', textAlign: 'right' }}>
                          <button
                            onClick={() => setEditingId(b.batch_id)}
                            title="Edit this batch"
                            style={{
                              padding: '3px 8px', fontSize: 11, fontWeight: 600,
                              background: 'var(--accent-light)',
                              border: '1px solid rgba(99,102,241,0.25)',
                              borderRadius: 6, color: 'var(--accent-dark)', cursor: 'pointer',
                            }}
                          >
                            ✏ Edit
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Summary bar ─────────────────────────────────────────────────
            One line, not the old stacked block: totals on the left, the action
            on the right.  Everything the old panel said is still here, just
            written as a sentence instead of a list. */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, flexWrap: 'wrap',
          borderTop: '1px solid rgba(99,102,241,0.12)',
          marginTop: 10, paddingTop: 10,
        }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 0 }}>
            <span>Total: </span>
            <strong style={{ color: 'var(--text)' }}>
              {totalStock.sub ? `${totalStock.main} ${totalStock.sub}` : `${totalStock.main} units`}
            </strong>
            {' · '}
            <strong style={{ color: 'var(--text)' }}>{activeCount}</strong>
            <span> batch{activeCount === 1 ? '' : 'es'}</span>
            {/* Only worth mentioning expired batches when there ARE some. */}
            {expiredCount > 0 && (
              <span style={{ color: 'var(--danger)' }}> · {expiredCount} expired</span>
            )}
            {best && (
              <>
                {' · '}
                <span>Best: </span>
                <strong style={{ color: marginTone(best.marginPct).color }}>
                  {best.marginPct.toFixed(1)}%
                </strong>
              </>
            )}
          </div>

          <button
            className="btn-primary"
            onClick={() => onAddStock(product)}
            style={{ padding: '6px 12px', fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            + Add Stock
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
