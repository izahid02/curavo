/**
 * MedicineSearchBox — reusable medicine search dropdown.
 *
 * Calls GET /api/search/medicines?q=... after the user types 2+ characters,
 * debounced 300 ms so we don't flood the server on every keystroke.
 *
 * ONE ROW PER BATCH
 * -----------------
 * The backend returns one row per SELLABLE BATCH, not one per medicine.  A
 * product with two deliveries in stock shows two rows — each with its own
 * batch number, quantity and expiry — earliest expiry first (FEFO).  The
 * pharmacist picks the exact box they are holding off the shelf, and that
 * batch_id travels into the bill.
 *
 * Batches expiring within 30 days are excluded by the backend: they must go
 * back to the supplier, not onto a bill.  When EVERY batch of a medicine is
 * expired or inside that window, the backend still returns the medicine with
 * available_stock 0 — we grey it out, say why, and list `alternatives`
 * (in-stock brands sharing the same generic name) directly underneath, which
 * ARE clickable.
 *
 * Props:
 *   onSelect(product)  — called when the user clicks or presses Enter on a row.
 *                        `product` is the full MedicineSearchResult object
 *                        (id, batch_id, batch_number, name, available_stock,
 *                         nearest_expiry, mrp, rack_location, low_stock,
 *                         selling_price, gst_rate, unit, strip fields…).
 *                        Alternatives are full rows too, so clicking one hands
 *                        back exactly the same shape.
 *   placeholder        — input placeholder text (optional)
 *   autoFocus          — focus the input on mount (optional, default false)
 *   inputRef           — ref forwarded to the <input> element so parent
 *                        components can call .focus() programmatically
 *                        (used by Billing.jsx for the F2 keyboard shortcut).
 *   className          — CSS class added to the root wrapper <div> (optional)
 *   oneRowPerProduct   — collapse the batch rows to one row per medicine
 *                        (default false).  Used by screens that are picking a
 *                        PRODUCT rather than a physical box — e.g. Add Stock,
 *                        where the batch does not exist yet.
 *   allowOutOfStock    — let the user select a greyed-out row (default false).
 *                        Also for Add Stock: you must be able to restock a
 *                        medicine precisely because it has run out.
 *
 * Keyboard shortcuts (active when the dropdown is open):
 *   ArrowDown / ArrowUp — move highlight (skips rows that can't be selected)
 *   Enter               — select highlighted row
 *   Escape              — close dropdown and clear input
 *
 * WHY THE DROPDOWN IS RENDERED THROUGH A PORTAL
 * ---------------------------------------------
 * It used to be `position: absolute` inside this component's wrapper.  That
 * cannot work reliably on the Billing screen, for two separate reasons:
 *
 *   1. Every `.card` sets backdrop-filter, and a non-`none` backdrop-filter
 *      creates a NEW STACKING CONTEXT.  An absolutely-positioned child's
 *      z-index then only competes INSIDE its own card, so it can never outrank
 *      a later sibling card — the bill items table painted straight over the
 *      dropdown.  (This is the trap documented in CLAUDE.md § design system.)
 *   2. The bill items list is now a scroll container with `overflow: auto`,
 *      and an absolutely-positioned element is CLIPPED by any scrolling
 *      ancestor.  Even with the stacking fixed, the list would be cut off.
 *
 * createPortal(…, document.body) sidesteps both: the dropdown is no longer a
 * descendant of any card or any scroll container, so nothing can clip it or
 * paint over it.  The price is that it must be positioned manually in viewport
 * coordinates (`position: fixed`) and re-measured whenever anything moves —
 * see the measure/reposition effects below.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/api';

// Gap between the input and the dropdown, and the tallest the list may get.
const DROPDOWN_GAP        = 4;
const DROPDOWN_MAX_HEIGHT = 400;
// Below this much free space underneath the input, the list opens UPWARDS
// instead — a fixed-position element that runs off the bottom of the viewport
// cannot be scrolled to, so it would simply be unreachable.
const DROPDOWN_MIN_BELOW  = 180;
// Above the sticky page furniture (1100/1200) so nothing on the page can cover
// the list, but BELOW the modals (2000).  A dropdown that outranks the receipt
// or camera modal would float on top of them, which is worse than the bug we
// are fixing here.
const DROPDOWN_Z_INDEX    = 1500;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert "YYYY-MM" → "Mar 2026".
 * Returns "—" for null/undefined so the UI always has something to show.
 */
function formatExpiry(ym) {
  if (!ym) return '—';
  const [year, month] = ym.split('-');
  return new Date(parseInt(year), parseInt(month) - 1).toLocaleDateString('en-IN', {
    month: 'short',
    year:  'numeric',
  });
}

/** Format as Indian Rupees: ₹12.50 */
function inr(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Stable React key for a row.  Two batches of the same medicine share a
 * product id, so the batch id has to be part of the key or React would treat
 * them as the same element.
 */
function rowKey(product, suffix = '') {
  return `${product.id}-${product.batch_id ?? 'none'}${suffix}`;
}

/** The small "· " separator between facts on the detail line. */
function Dot() {
  return <span style={{ color: 'var(--text-hint)' }}>·</span>;
}

/**
 * Line 2 of a row: prices · stock · expiry · rack.
 * Strip medicines read more usefully as "₹95/strip · ₹9.50/tablet · 15 strips",
 * so they get their own arrangement.
 */
function DetailLine({ product, compact = false }) {
  const isStrip = product.is_strip && product.units_per_strip;

  return (
    <div style={{
      fontSize: compact ? 11.5 : 12,
      color: 'var(--text-secondary)',
      marginTop: 3,
      display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
    }}>
      {isStrip ? (
        <>
          {product.strip_mrp != null && (
            <>
              <span>{inr(product.strip_mrp)}/strip</span>
              <Dot />
              <span>{inr(product.unit_mrp)}/tablet</span>
              <Dot />
            </>
          )}
          <span>{product.available_strips} strips</span>
        </>
      ) : (
        <>
          <span>MRP: {inr(product.mrp)}</span>
          <Dot />
          <span>{product.available_stock} {product.unit || 'units'}</span>
        </>
      )}

      <Dot />
      <span>{formatExpiry(product.nearest_expiry)}</span>

      {/* Rack is optional — only shown when the product has one recorded, so
          we never print a dangling "Rack:" with nothing after it. */}
      {product.rack_location && (
        <>
          <Dot />
          <span>Rack: {product.rack_location}</span>
        </>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MedicineSearchBox({
  onSelect,
  placeholder = 'Search medicine, generic name, HSN…',
  autoFocus   = false,
  inputRef,       // optional external ref → forwarded to <input>
  className,
  oneRowPerProduct = false,
  allowOutOfStock  = false,
}) {
  const [query,       setQuery]       = useState('');
  const [results,     setResults]     = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [open,        setOpen]        = useState(false);
  const [highlighted, setHighlighted] = useState(0);  // index into `entries`

  // Fall back to an internal ref when the parent does not pass one.
  // This lets the component focus itself after the user selects an item.
  const internalRef = useRef(null);
  const ref         = inputRef ?? internalRef;

  // Ref to the dropdown list — used to scroll the highlighted row into view
  const listRef = useRef(null);
  // The wrapper that stays in the document (input + spinner).  Used by the
  // click-outside check, since the list itself is no longer inside it.
  const wrapRef = useRef(null);

  // Where to paint the portalled dropdown, in VIEWPORT coordinates.
  // null until it has been measured, so we never paint a frame at 0,0.
  const [pos, setPos] = useState(null);

  // ── Flatten the response into the exact list of rendered rows ─────────────
  // An out-of-stock medicine contributes its own (greyed) row PLUS one row per
  // alternative.  Keeping them in one flat array means the arrow keys, the
  // highlight index and listRef.current.children all line up 1:1.
  const entries = useMemo(() => {
    let rows = results;

    // Add Stock and friends want the MEDICINE, not a particular box: collapse
    // the batch rows down to the first (= FEFO) row of each product.
    if (oneRowPerProduct) {
      const seen = new Set();
      rows = rows.filter(r => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
    }

    const flat = [];
    rows.forEach(product => {
      flat.push({
        kind:       'result',
        product,
        // A greyed-out row is normally dead: you cannot bill stock that isn't
        // sellable.  Screens that are restocking pass allowOutOfStock.
        selectable: !product.out_of_stock || allowOutOfStock,
      });

      // Alternatives hang off out-of-stock rows only, and only when the
      // backend actually found an in-stock brand of the same generic.
      if (!oneRowPerProduct && product.out_of_stock) {
        (product.alternatives || []).forEach((alt, altIdx) => {
          flat.push({
            kind:       'alt',
            product:    alt,
            parent:     product,
            firstAlt:   altIdx === 0,   // this one renders the section heading
            selectable: true,
          });
        });
      }
    });
    return flat;
  }, [results, oneRowPerProduct, allowOutOfStock]);

  // ── Auto-focus on mount ───────────────────────────────────────────────────
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Position the portalled dropdown ───────────────────────────────────────
  /**
   * Measure the input and work out where the list should sit.
   *
   * The list is `position: fixed`, so these are VIEWPORT coordinates and they
   * go stale the moment anything scrolls or resizes — hence the listeners in
   * the effect below.
   *
   * It normally hangs below the input.  When there is not enough room down
   * there it flips ABOVE instead: a fixed element that overflows the bottom of
   * the viewport is unreachable, because the page cannot scroll to it.
   */
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();

    // 8px of breathing room so the list never touches the viewport edge.
    const spaceBelow = window.innerHeight - rect.bottom - DROPDOWN_GAP - 8;
    const spaceAbove = rect.top - DROPDOWN_GAP - 8;
    const dropUp     = spaceBelow < DROPDOWN_MIN_BELOW && spaceAbove > spaceBelow;

    setPos({
      left:   rect.left,
      width:  rect.width,
      // Anchor to whichever edge the list is growing away from, so it stays
      // glued to the input as it changes height with the result count.
      top:    dropUp ? undefined : rect.bottom + DROPDOWN_GAP,
      bottom: dropUp ? window.innerHeight - rect.top + DROPDOWN_GAP : undefined,
      // Never taller than the room actually available; 120px floor so a badly
      // squeezed layout still shows a row or two rather than a sliver.
      maxHeight: Math.max(
        120,
        Math.min(DROPDOWN_MAX_HEIGHT, dropUp ? spaceAbove : spaceBelow),
      ),
    });
  }, [ref]);

  // Measure BEFORE the browser paints (useLayoutEffect, not useEffect) so the
  // list never appears for one frame in the wrong place.  `entries` is a
  // dependency because the row count changes the height, which can flip it.
  useLayoutEffect(() => {
    if (open) measure();
    else setPos(null);
  }, [open, entries, measure]);

  // Keep it glued to the input while the page moves underneath it.
  //
  // ⚠ The scroll listener uses CAPTURE (`true`).  Scroll events from an inner
  // container do not bubble, and on the Billing screen the search box sits
  // inside <main> (which scrolls) above the bill items list (which also
  // scrolls).  Without capture the list would silently detach from the input
  // the first time either of those scrolled.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, measure]);

  // ── Close when the user clicks away ───────────────────────────────────────
  // The list lives in document.body now, so "outside" means outside BOTH the
  // input wrapper and the list itself.  This mattered less when the dropdown
  // was in-flow; a fixed, always-on-top list that never closes would sit over
  // whatever the pharmacist clicked next.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e) {
      if (wrapRef.current?.contains(e.target)) return;
      if (listRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // ── Debounced search ──────────────────────────────────────────────────────
  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.get('/search/medicines', { params: { q: query } });
        setResults(res.data);
        setHighlighted(0);
        setOpen(true);
      } catch {
        setResults([]);
        setOpen(false);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  // ── Start on the first row the user can actually pick ─────────────────────
  // If the top result is out of stock, highlighting it would make Enter do
  // nothing.  Jump the highlight to the first selectable entry instead.
  useEffect(() => {
    if (entries.length === 0) return;
    if (entries[highlighted]?.selectable) return;
    const firstSelectable = entries.findIndex(e => e.selectable);
    if (firstSelectable !== -1) setHighlighted(firstSelectable);
  }, [entries]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scroll highlighted row into view ─────────────────────────────────────
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[highlighted];
    item?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  // ── Selection ─────────────────────────────────────────────────────────────
  function handleSelect(entry) {
    if (!entry?.selectable) return;   // greyed-out rows are inert
    onSelect(entry.product);
    // Clear the box so the pharmacist can immediately scan/type the next item
    setQuery('');
    setResults([]);
    setOpen(false);
    setHighlighted(0);
    ref.current?.focus();
  }

  /**
   * Move the highlight by one row, skipping over anything that cannot be
   * selected (greyed-out out-of-stock rows).  Stops at the ends of the list
   * rather than wrapping around.
   */
  function moveHighlight(step) {
    setHighlighted(current => {
      let i = current + step;
      while (i >= 0 && i < entries.length && !entries[i].selectable) i += step;
      // Ran off either end without finding a selectable row — stay put.
      if (i < 0 || i >= entries.length) return current;
      return i;
    });
  }

  // ── Keyboard navigation ───────────────────────────────────────────────────
  function handleKeyDown(e) {
    if (!open || entries.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveHighlight(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveHighlight(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSelect(entries[highlighted]);
    } else if (e.key === 'Escape') {
      setQuery('');
      setResults([]);
      setOpen(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div ref={wrapRef} style={{ position: 'relative' }} className={className}>

      {/* ── Search input ── */}
      <div style={{ position: 'relative' }}>
        <input
          ref={ref}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          // Clicking away closes the list but keeps the typed query and its
          // results.  Without this, clicking back into the box would leave the
          // pharmacist staring at a search term with no list and no way to get
          // it back except retyping.
          onFocus={() => { if (entries.length > 0) setOpen(true); }}
          placeholder={placeholder}
          autoComplete="off"
          style={{
            fontSize: 16, padding: '12px 40px 12px 14px',
            borderRadius: 'var(--radius)', width: '100%',
          }}
        />

        {/* Loading spinner — shown while fetching */}
        {loading && (
          <div style={{
            position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
            pointerEvents: 'none',
          }}>
            <div className="spin" style={{
              width: 16, height: 16,
              border: '2px solid rgba(99,102,241,0.2)',
              borderTopColor: 'var(--accent)',
              borderRadius: '50%',
            }} />
          </div>
        )}
      </div>

      {/* ── Dropdown ──
          Portalled to document.body so no card's stacking context can paint
          over it and no scroll container can clip it (see the file header).
          `pos` is measured from the input in viewport coordinates. */}
      {open && pos && createPortal(
        <div ref={listRef} style={{
          position:           'fixed',
          top:                pos.top,
          bottom:             pos.bottom,
          left:               pos.left,
          width:              pos.width,
          zIndex:             DROPDOWN_Z_INDEX,
          // Near-opaque on purpose: at 0.95 the bill rows underneath showed
          // through the glass and the two sets of medicine names read as one.
          background:         'rgba(255,255,255,0.98)',
          backdropFilter:     'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border:             '1px solid rgba(99,102,241,0.15)',
          borderRadius:       'var(--radius-lg)',
          boxShadow:          '0 8px 40px rgba(0,0,0,0.15)',
          maxHeight:          pos.maxHeight,
          overflowY:          'auto',
        }}>

          {/* ── Empty state ── */}
          {entries.length === 0 && (
            <div style={{
              padding: '20px 16px', textAlign: 'center',
              color: 'var(--text-hint)', fontSize: 14,
            }}>
              No medicines found for "{query}"
            </div>
          )}

          {/* ── Rows ── */}
          {entries.map((entry, idx) => {
            const product    = entry.product;
            const isHighlight = idx === highlighted;

            // ═══ An alternative suggested under an out-of-stock medicine ═══
            if (entry.kind === 'alt') {
              return (
                <div key={rowKey(product, `-alt-${entry.parent.id}`)} style={{
                  // Tinted + inset so it reads as "belonging to" the greyed
                  // row above it rather than as a search result of its own.
                  background:  'rgba(16,185,129,0.05)',
                  borderBottom: idx < entries.length - 1
                    ? '1px solid rgba(0,0,0,0.05)'
                    : 'none',
                  padding: entry.firstAlt ? '6px 14px 0 26px' : '0 14px 0 26px',
                }}>
                  {entry.firstAlt && (
                    <div style={{
                      fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase',
                      letterSpacing: '0.06em', color: 'var(--ok)',
                      marginBottom: 4,
                    }}>
                      Alternatives with same generic
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => handleSelect(entry)}
                    onMouseEnter={() => setHighlighted(idx)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '7px 8px', marginBottom: 6,
                      border: 'none', borderRadius: 'var(--radius)',
                      background: isHighlight ? 'rgba(16,185,129,0.14)' : 'transparent',
                      cursor: 'pointer', transition: 'background 0.1s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text)' }}>
                        {product.name}
                      </span>
                      <span style={{
                        fontSize: 10, fontWeight: 600, padding: '2px 7px',
                        borderRadius: 20, background: 'var(--ok-bg)', color: 'var(--ok)',
                      }}>
                        In stock
                      </span>
                    </div>
                    <DetailLine product={product} compact />
                  </button>
                </div>
              );
            }

            // ═══ A normal search result (one batch, or one greyed medicine) ═══
            const unavailable = product.out_of_stock;

            return (
              <button
                key={rowKey(product)}
                type="button"
                onClick={() => handleSelect(entry)}
                onMouseEnter={() => entry.selectable && setHighlighted(idx)}
                disabled={!entry.selectable}
                style={{
                  display:       'flex',
                  alignItems:    'flex-start',
                  justifyContent:'space-between',
                  gap:           10,
                  width:         '100%',
                  padding:       '11px 14px',
                  textAlign:     'left',
                  background:    isHighlight && entry.selectable
                    ? 'rgba(99,102,241,0.08)'
                    : 'transparent',
                  border:        'none',
                  borderBottom:  idx < entries.length - 1
                    ? '1px solid rgba(0,0,0,0.05)'
                    : 'none',
                  // Greyed out and inert: this stock cannot go on a bill.
                  opacity:       unavailable && !entry.selectable ? 0.55 : 1,
                  cursor:        entry.selectable ? 'pointer' : 'not-allowed',
                  transition:    'background 0.1s',
                }}
              >
                {/* Left: name + badges, then the detail line */}
                <div style={{ flex: 1, minWidth: 0 }}>

                  {/* Line 1: bold name + category pill (+ stock warning) */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
                      {product.name}
                    </span>

                    {product.category && (
                      <span style={{
                        fontSize:   10,
                        fontWeight: 500,
                        padding:    '2px 8px',
                        borderRadius: 20,
                        background: 'var(--accent-light)',
                        color:      'var(--accent)',
                        whiteSpace: 'nowrap',
                      }}>
                        {product.category}
                      </span>
                    )}

                    {/* Two different problems, two different messages: stock
                        that exists but is too close to expiry has to be
                        RETURNED, whereas an empty shelf has to be REORDERED. */}
                    {unavailable && (
                      <span style={{
                        fontSize: 10, fontWeight: 600, padding: '2px 8px',
                        borderRadius: 20, whiteSpace: 'nowrap',
                        background: product.all_batches_near_expiry ? 'var(--warn-bg)' : 'var(--danger-bg)',
                        color:      product.all_batches_near_expiry ? 'var(--warn)'    : 'var(--danger)',
                      }}>
                        {product.all_batches_near_expiry
                          ? 'Near expiry — return to supplier'
                          : 'Out of stock'}
                      </span>
                    )}
                  </div>

                  {/* Line 2 — only meaningful when there is a batch to describe */}
                  {unavailable ? (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>
                      {product.all_batches_near_expiry
                        ? 'All batches expire within 30 days — not sellable'
                        : 'No stock available'}
                      {product.rack_location && ` · Rack: ${product.rack_location}`}
                    </div>
                  ) : (
                    <DetailLine product={product} />
                  )}
                </div>

                {/* Right: batch number (top) + low-stock dot */}
                <div style={{
                  flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
                  marginTop: 2,
                }}>
                  {product.batch_number && (
                    <span style={{
                      fontSize: 11, color: '#94a3b8', fontWeight: 500,
                      whiteSpace: 'nowrap',
                    }}>
                      Batch: {product.batch_number}
                    </span>
                  )}

                  {product.low_stock && !unavailable && (
                    <span
                      title="Low stock — below minimum level"
                      style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: 'var(--danger)', display: 'inline-block',
                      }}
                    />
                  )}
                </div>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
