/**
 * Expiry Alerts Page
 *
 * Shows all batches grouped by how close they are to expiry.
 * Each section is a collapsible card with a count badge.
 *
 * Colour coding matches global.css design tokens:
 *   Expired / 7-day  → var(--danger)   red
 *   30-day / 60-day  → var(--warn)     orange
 *   90-day           → var(--ok)       green
 *
 * "Estimated Loss" — when expired stock is returned to the supplier the
 * pharmacy recovers the COST price, so the only real loss is the GST paid:
 *     est_loss = quantity_available × cost_price × (gst_rate / 100)
 * The backend computes this and sends it as `est_loss` (null when the cost
 * price was never recorded — in that case we show "—" instead of a fake ₹0.00).
 */
import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import ReturnToSupplierModal from '../components/ReturnToSupplierModal';

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * A batch's stored expiry date can be a data-entry typo (e.g. "0229-03-12",
 * year 229).  Anything before year 2000 or after 2060 is clearly not a real
 * pharmacy expiry date, so we flag it instead of showing "656470 days ago".
 */
function isInvalidExpiry(isoDate) {
  if (!isoDate) return true;
  const year = Number(String(isoDate).slice(0, 4));
  return !year || year < 2000 || year > 2060;
}

// ─── Section config ────────────────────────────────────────────────────────

const SECTIONS = [
  { key: 'expired', label: 'Already Expired',   color: 'var(--danger)', bg: 'var(--danger-bg)' },
  { key: 'warn_7',  label: 'Expires in 7 Days',  color: 'var(--danger)', bg: 'var(--danger-bg)' },
  { key: 'warn_30', label: 'Expires in 30 Days', color: 'var(--warn)',   bg: 'var(--warn-bg)' },
  { key: 'warn_60', label: 'Expires in 60 Days', color: 'var(--warn)',   bg: 'var(--warn-bg)' },
  { key: 'warn_90', label: 'Expires in 90 Days', color: 'var(--ok)',    bg: 'var(--ok-bg)' },
];

// ─── One collapsible section card ─────────────────────────────────────────

function AlertSection({ label, color, bg, items, canReturn, onReturn }) {
  const [open, setOpen] = useState(true);   // start expanded

  // Estimated total loss for this section — sum only the batches where the
  // backend could compute a loss (est_loss is null when no cost was recorded).
  const totalLoss = items.reduce(
    (sum, b) => sum + (b.est_loss != null ? Number(b.est_loss) : 0),
    0,
  );

  return (
    <div style={{
      border: `1px solid ${color}`,
      borderRadius: 'var(--radius)',
      overflow: 'hidden',
      marginBottom: 16,
    }}>
      {/* Section header — click to collapse/expand */}
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          background: bg,
          borderBottom: open ? `1px solid ${color}` : 'none',
          padding: '14px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        {/* Colour dot */}
        <span style={{
          width: 12, height: 12, borderRadius: '50%',
          background: color, flexShrink: 0,
        }} />

        {/* Title */}
        <span style={{ fontWeight: 700, fontSize: 15, color, flex: 1 }}>{label}</span>

        {/* Count badge */}
        <span style={{
          background: color, color: '#fff',
          borderRadius: 20, padding: '3px 10px',
          fontSize: 13, fontWeight: 700,
        }}>
          {items.length} {items.length === 1 ? 'batch' : 'batches'}
        </span>

        {/* GST-only loss — the cost price is recovered on return, so the ONLY
            money lost is the GST already paid. Labelled explicitly so it is not
            confused with the full stock-value loss shown on Reports. */}
        {totalLoss > 0 && (
          <span
            style={{ fontSize: 12, color, opacity: 0.85, fontWeight: 600 }}
            title="Amount lost in GST if returned to supplier. Cost price is recoverable."
          >
            GST Loss (if returned) ₹{totalLoss.toFixed(2)}
          </span>
        )}

        {/* Chevron toggle */}
        <span style={{ fontSize: 16, color, marginLeft: 4 }}>
          {open ? '▲' : '▼'}
        </span>
      </div>

      {/* Batch table — hidden when collapsed */}
      {open && (
        items.length === 0 ? (
          <div style={{ padding: '16px 20px', color: 'var(--text-muted)', fontSize: 13 }}>
            No batches in this category.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg)' }}>
                  {[
                    'Medicine Name', 'Batch No.', 'Supplier', 'Expiry Date',
                    'Days Left', 'Qty Available', 'Purchase Price', 'GST Loss (if returned)',
                    // Only expired and 7-day batches can be sent back, so the
                    // action column only exists on those two sections.
                    ...(canReturn ? ['Action'] : []),
                  ].map((h) => (
                    <th key={h} style={{
                      padding: '9px 14px', textAlign: 'left',
                      fontWeight: 600, color: 'var(--text-muted)',
                      borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((b) => {
                  const invalidDate = isInvalidExpiry(b.expiry_date);
                  const hasCost = b.cost_price != null && Number(b.cost_price) > 0;
                  return (
                    <tr key={b.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '9px 14px', fontWeight: 600 }}>
                        {b.product_name}
                      </td>
                      <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12 }}>
                        {b.batch_number || '—'}
                      </td>
                      <td style={{ padding: '9px 14px' }}>
                        {b.supplier_name || '—'}
                      </td>
                      <td style={{ padding: '9px 14px' }}>
                        {b.expiry_date}
                      </td>
                      <td style={{
                        padding: '9px 14px', fontWeight: 700,
                        color: (invalidDate || b.days_to_expiry < 0) ? 'var(--danger)' : color,
                      }}>
                        {invalidDate
                          ? '⚠ Invalid date'
                          : b.days_to_expiry < 0
                            ? `${Math.abs(b.days_to_expiry)} days ago`
                            : `${b.days_to_expiry} days`}
                      </td>
                      <td style={{ padding: '9px 14px', fontWeight: 600 }}>
                        {b.quantity_available}
                      </td>
                      {/* Purchase price = the cost recorded on the stock purchase.
                          Shows "—" when the pharmacist didn't record a cost. */}
                      <td style={{ padding: '9px 14px' }}>
                        {hasCost ? `₹${Number(b.cost_price).toFixed(2)}` : '—'}
                      </td>
                      {/* Est. loss — "—" (with a hint) when we have no cost to work from */}
                      <td
                        style={{ padding: '9px 14px', fontWeight: 700, color: b.est_loss != null ? color : 'var(--text-hint)' }}
                        title={b.est_loss == null
                          ? 'Add purchase price to calculate loss'
                          : 'Amount lost in GST if returned to supplier. Cost price is recoverable.'}
                      >
                        {b.est_loss != null ? `₹${Number(b.est_loss).toFixed(2)}` : '—'}
                      </td>
                      {/* Return to Supplier — recovers the cost price (minus the
                          unrecoverable GST) against what we owe that supplier. */}
                      {canReturn && (
                        <td style={{ padding: '9px 14px', whiteSpace: 'nowrap' }}>
                          <button
                            className="btn-secondary"
                            style={{ fontSize: 11.5, padding: '5px 10px' }}
                            onClick={() => onReturn(b)}
                            title={
                              b.quantity_available > 0
                                ? 'Send this stock back to the supplier'
                                : 'No stock left in this batch'
                            }
                            disabled={!b.quantity_available}
                          >
                            ↩ Return to Supplier
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export default function ExpiryAlerts() {
  const [alerts, setAlerts]   = useState(null);   // null = loading
  const [error, setError]     = useState('');

  // Which batch is being returned (null = modal closed), and the success
  // message shown after a return completes.
  const [returning, setReturning] = useState(null);
  const [toast,     setToast]     = useState('');

  // Extracted so the page can refetch after a return — a returned batch that
  // drops to zero quantity must disappear from these lists.
  function loadAlerts() {
    api.get('/inventory/alerts/expiry')
      .then(({ data }) => setAlerts(data))
      .catch(() => setError('Could not load expiry alerts.'));
  }

  useEffect(() => { loadAlerts(); }, []);

  function handleReturnDone(result) {
    setReturning(null);
    setToast(result.message
      ?? `Return processed. ₹${Number(result.net_return_value).toFixed(2)} credit adjusted`);
    loadAlerts();                              // refresh — the batch may now be empty
    setTimeout(() => setToast(''), 6000);
  }

  // Total count across all alert sections (excluding OK batches)
  const totalAlerts = alerts
    ? SECTIONS.reduce((sum, s) => sum + (alerts[s.key]?.length ?? 0), 0)
    : 0;

  // Canonical headline count — distinct PRODUCTS expired/expiring within 90 days.
  // This is the same number the sidebar badge and Dashboard card show, so the
  // three places always agree (per-section counts below are batch-level detail).
  const alertProductCount = alerts?.alert_product_count ?? 0;

  return (
    <div>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Expiry Alerts</h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: 12 }}>
        Batches that have expired or are expiring soon.
        Act on these to minimise stock loss.
      </p>

      {/* One canonical headline count (matches sidebar + dashboard). */}
      {alerts !== null && alertProductCount > 0 && (
        <p style={{ color: 'var(--text)', fontWeight: 600, marginBottom: 8 }}>
          {alertProductCount} {alertProductCount === 1 ? 'product needs' : 'products need'} attention
        </p>
      )}

      {/* Legend — clears up what "loss" means on this page (FIX 4c). */}
      <p style={{ color: 'var(--text-hint)', fontSize: 12, marginBottom: 24 }}>
        Loss shown = GST only (cost price is recovered when stock is returned to the supplier).
      </p>

      {error && (
        <div style={{ color: 'var(--danger)', marginBottom: 16 }}>{error}</div>
      )}

      {/* Success toast after a return is processed */}
      {toast && (
        <div style={{
          background: 'var(--ok-bg)', border: '1px solid rgba(16,185,129,0.25)',
          color: 'var(--ok)', borderRadius: 'var(--radius)',
          padding: '10px 16px', fontSize: 13, marginBottom: 16,
        }}>
          ✓ {toast}
        </div>
      )}

      {alerts === null && !error && (
        <div style={{ color: 'var(--text-muted)' }}>Loading alerts…</div>
      )}

      {alerts !== null && totalAlerts === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✓</div>
          <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--ok)', marginBottom: 6 }}>
            All Clear
          </div>
          <div style={{ color: 'var(--text-muted)' }}>
            No batches are expiring within the next 90 days.
          </div>
        </div>
      )}

      {alerts !== null && totalAlerts > 0 && (
        <div>
          {/* Summary bar */}
          <div style={{
            display: 'flex', gap: 12, marginBottom: 24,
            flexWrap: 'wrap',
          }}>
            {SECTIONS.map((s) => {
              const count = alerts[s.key]?.length ?? 0;
              if (count === 0) return null;
              return (
                <div key={s.key} className="card" style={{ padding: '12px 20px', display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: s.color }} />
                  <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{s.label}:</span>
                  <span style={{ fontWeight: 700, color: s.color }}>{count}</span>
                </div>
              );
            })}
          </div>

          {SECTIONS.map((s) => (
            <AlertSection
              key={s.key}
              label={s.label}
              color={s.color}
              bg={s.bg}
              items={alerts[s.key] ?? []}
              // Already-expired stock obviously goes back; 7-day stock can be
              // returned EARLY, while the supplier will still accept it.
              canReturn={s.key === 'expired' || s.key === 'warn_7'}
              onReturn={setReturning}
            />
          ))}
        </div>
      )}

      {/* ── Return to Supplier modal ──────────────────────────────── */}
      {returning && (
        <ReturnToSupplierModal
          batch={returning}
          onClose={() => setReturning(null)}
          onDone={handleReturnDone}
        />
      )}
    </div>
  );
}
