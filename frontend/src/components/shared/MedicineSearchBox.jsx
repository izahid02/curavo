/**
 * MedicineSearchBox — reusable medicine search dropdown.
 *
 * Calls GET /api/search/medicines?q=... after the user types 2+ characters,
 * debounced 300 ms so we don't flood the server on every keystroke.
 *
 * Props:
 *   onSelect(product)  — called when the user clicks or presses Enter on a row.
 *                        `product` is the full MedicineSearchResult object
 *                        (id, name, category, hsn_code, available_stock,
 *                         nearest_expiry, mrp, low_stock,
 *                         selling_price, gst_rate, unit).
 *   placeholder        — input placeholder text (optional)
 *   autoFocus          — focus the input on mount (optional, default false)
 *   inputRef           — ref forwarded to the <input> element so parent
 *                        components can call .focus() programmatically
 *                        (used by Billing.jsx for the F2 keyboard shortcut).
 *   className          — CSS class added to the root wrapper <div> (optional)
 *
 * Keyboard shortcuts (active when the dropdown is open):
 *   ArrowDown / ArrowUp — move highlight
 *   Enter               — select highlighted row
 *   Escape              — close dropdown and clear input
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

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

// ─── Component ────────────────────────────────────────────────────────────────

export default function MedicineSearchBox({
  onSelect,
  placeholder = 'Search medicine, generic name, HSN…',
  autoFocus   = false,
  inputRef,       // optional external ref → forwarded to <input>
  className,
}) {
  const [query,       setQuery]       = useState('');
  const [results,     setResults]     = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [open,        setOpen]        = useState(false);
  const [highlighted, setHighlighted] = useState(0);  // index of focused row

  // Fall back to an internal ref when the parent does not pass one.
  // This lets the component focus itself after the user selects an item.
  const internalRef = useRef(null);
  const ref         = inputRef ?? internalRef;

  // Ref to the dropdown list — used to scroll the highlighted row into view
  const listRef = useRef(null);

  // ── Auto-focus on mount ───────────────────────────────────────────────────
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);  // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Scroll highlighted row into view ─────────────────────────────────────
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[highlighted];
    item?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  // ── Selection ─────────────────────────────────────────────────────────────
  function handleSelect(product) {
    onSelect(product);
    // Clear the box so the pharmacist can immediately scan/type the next item
    setQuery('');
    setResults([]);
    setOpen(false);
    setHighlighted(0);
    ref.current?.focus();
  }

  // ── Keyboard navigation ───────────────────────────────────────────────────
  function handleKeyDown(e) {
    if (!open || results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted(h => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSelect(results[highlighted]);
    } else if (e.key === 'Escape') {
      setQuery('');
      setResults([]);
      setOpen(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ position: 'relative' }} className={className}>

      {/* ── Search input ── */}
      <div style={{ position: 'relative' }}>
        <input
          ref={ref}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
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

      {/* ── Dropdown ── */}
      {open && (
        <div ref={listRef} style={{
          position:           'absolute',
          top:                'calc(100% + 4px)',
          left:               0,
          right:              0,
          zIndex:             200,
          background:         'rgba(255,255,255,0.95)',
          backdropFilter:     'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border:             '1px solid rgba(255,255,255,0.82)',
          borderRadius:       'var(--radius-lg)',
          boxShadow:          '0 8px 32px rgba(99,102,241,0.14)',
          maxHeight:          360,
          overflowY:          'auto',
        }}>

          {/* ── Empty state ── */}
          {results.length === 0 && (
            <div style={{
              padding: '20px 16px', textAlign: 'center',
              color: 'var(--text-hint)', fontSize: 14,
            }}>
              No medicines found for "{query}"
            </div>
          )}

          {/* ── Result rows ── */}
          {results.map((product, idx) => (
            <button
              key={product.id}
              onClick={() => handleSelect(product)}
              onMouseEnter={() => setHighlighted(idx)}
              style={{
                display:       'flex',
                alignItems:    'flex-start',
                justifyContent:'space-between',
                width:         '100%',
                padding:       '11px 14px',
                textAlign:     'left',
                background:    idx === highlighted
                  ? 'rgba(99,102,241,0.08)'
                  : 'transparent',
                border:        'none',
                borderBottom:  idx < results.length - 1
                  ? '1px solid rgba(0,0,0,0.05)'
                  : 'none',
                cursor:        'pointer',
                transition:    'background 0.1s',
              }}
            >
              {/* Left: name + category + detail line */}
              <div style={{ flex: 1, minWidth: 0 }}>

                {/* Line 1: bold name + category pill */}
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
                </div>

                {/* Line 2: stock · expiry · MRP */}
                <div style={{
                  fontSize: 12, color: 'var(--text-secondary)', marginTop: 3,
                  display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
                }}>
                  {/* Strip medicines read more usefully as "₹95/strip ·
                      ₹9.50/tablet · 15 strips in stock" (Feature 3).  We lead
                      with the two prices, then the whole-strip stock count. */}
                  {product.is_strip && product.units_per_strip ? (
                    <>
                      {product.strip_mrp != null && (
                        <>
                          <span>{inr(product.strip_mrp)}/strip</span>
                          <span style={{ color: 'var(--text-hint)' }}>·</span>
                          <span>{inr(product.unit_mrp)}/tablet</span>
                          <span style={{ color: 'var(--text-hint)' }}>·</span>
                        </>
                      )}
                      <span>{product.available_strips} strips in stock</span>
                      <span style={{ color: 'var(--text-hint)' }}>·</span>
                      <span>Expiry: {formatExpiry(product.nearest_expiry)}</span>
                    </>
                  ) : (
                    <>
                      <span>Stock: {product.available_stock} units</span>
                      <span style={{ color: 'var(--text-hint)' }}>·</span>
                      <span>Expiry: {formatExpiry(product.nearest_expiry)}</span>
                      <span style={{ color: 'var(--text-hint)' }}>·</span>
                      <span>MRP: {inr(product.mrp)}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Right: low-stock indicator (red dot) */}
              {product.low_stock && (
                <div
                  title="Low stock — below minimum level"
                  style={{
                    flexShrink:   0,
                    marginLeft:   10,
                    marginTop:    3,
                    width:        8,
                    height:       8,
                    borderRadius: '50%',
                    background:   'var(--danger)',
                  }}
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
