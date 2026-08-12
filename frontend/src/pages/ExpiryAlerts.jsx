/**
 * Expiry Alerts Page
 *
 * Shows all batches grouped by how close they are to expiry.
 * Each section is a collapsible card with a count badge.
 *
 * THREE SECTIONS, THREE ACTIONS:
 *   Already Expired    → too late to sell; send it back        (red)
 *   Expires in 30 Days → act now; return or discount hard      (red)
 *   Expires in 60 Days → act soon; return or discount to shift (amber)
 *
 * There is deliberately no 7-day or 90-day section any more.  A 7-day batch
 * needs exactly the same decision as a 25-day one, so splitting them just made
 * the pharmacist read two lists to make one call; and 90 days is too far out to
 * act on, so it read as noise.  Batches inside 7 days now appear in the 30-day
 * section.  The backend buckets match this exactly (get_expiry_alerts).
 *
 * ALL THREE sections offer [↩ Return to Supplier] — the whole point of the
 * 30/60-day warning is that returning EARLY, while the supplier will still
 * accept the stock, is the option that saves money.
 *
 * "GST Loss" — when stock is returned to the supplier the pharmacy recovers the
 * COST price, so the only real loss is the GST paid on it:
 *     est_loss = quantity_available × effective_cost × (gst_rate / 100)
 * effective_cost is the price AFTER any supplier discount — if we bought at 5%
 * off, we lost GST on what we actually paid, not on the rate card.  The backend
 * computes this and sends it as `est_loss` (null when no cost price was ever
 * recorded — we then show "—" instead of a fake ₹0.00).
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

/** Money, always two decimals, with the rupee sign. */
function rupees(value) {
  return `₹${Number(value || 0).toFixed(2)}`;
}

/**
 * How the supplier discount reads in the table.
 *
 * The backend stores the discount PER INDIVIDUAL UNIT (like every other price),
 * but a pharmacist buys tablets by the strip and the distributor quotes the
 * discount per strip — so for a strip medicine we scale it back up before
 * showing it.  Returns null when no discount was recorded, so the cell can
 * show a plain "—".
 */
function discountLabel(batch) {
  const pct = Number(batch.discount_percent) || 0;
  const amt = Number(batch.discount_amount) || 0;
  if (pct <= 0 && amt <= 0) return null;

  const per      = Number(batch.units_per_strip) || 0;
  const isStrip  = Boolean(batch.is_strip) && per > 0;
  const perBasis = isStrip ? amt * per : amt;
  const basis    = isStrip ? 'strip' : 'unit';

  return `${pct.toFixed(pct % 1 === 0 ? 0 : 2)}% (${rupees(perBasis)}/${basis})`;
}

// ─── Section config ────────────────────────────────────────────────────────
//
// `warning` renders a call-to-action strip under the section header.  Only the
// 60-day section has one: it is the only bucket where there is still time for
// the advice ("return or discount") to change the outcome.

const SECTIONS = [
  {
    key: 'expired',
    label: 'Already Expired',
    color: 'var(--danger)',
    bg: 'var(--danger-bg)',
  },
  {
    key: 'expires_30',
    label: 'Expires in 30 Days',
    color: 'var(--danger)',
    bg: 'var(--danger-bg)',
  },
  {
    key: 'expires_60',
    label: 'Expires in 60 Days',
    color: 'var(--warn)',
    bg: 'var(--warn-bg)',
    warning:
      '⚠ Act now — these medicines expire within 2 months. '
      + 'Return to supplier or apply discount to sell faster.',
  },
];

// ─── One collapsible section card ─────────────────────────────────────────

function AlertSection({ label, color, bg, warning, items, onReturn }) {
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
            GST Loss (if returned) {rupees(totalLoss)}
          </span>
        )}

        {/* Chevron toggle */}
        <span style={{ fontSize: 16, color, marginLeft: 4 }}>
          {open ? '▲' : '▼'}
        </span>
      </div>

      {/* Call-to-action strip (60-day section only) — there is still time for
          this advice to change the outcome, which is the whole point of the
          section existing. */}
      {open && warning && items.length > 0 && (
        <div style={{
          background: 'rgba(255,255,255,0.55)',
          borderBottom: `1px solid ${color}`,
          padding: '10px 20px',
          fontSize: 12.5,
          fontWeight: 600,
          color,
          lineHeight: 1.5,
        }}>
          {warning}
        </div>
      )}

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
                    'Days Left', 'Qty Available', 'Purchase Price', 'Discount',
                    'GST Loss (if returned)',
                    // Every section can send stock back now — returning EARLY
                    // is exactly what the 30/60-day warnings are asking for.
                    'Action',
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
                  const hasCost  = b.cost_price != null && Number(b.cost_price) > 0;
                  const discount = discountLabel(b);
                  // What the medicine really cost after the discount — the
                  // figure the GST loss is actually calculated on.
                  const effective = b.effective_cost != null
                    ? Number(b.effective_cost)
                    : null;
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
                      {/* Purchase price = the RATE CARD cost recorded on the
                          stock purchase, before any discount.  Shows "—" when
                          the pharmacist didn't record a cost. */}
                      <td style={{ padding: '9px 14px' }}>
                        {hasCost ? rupees(b.cost_price) : '—'}
                      </td>
                      {/* Discount the supplier gave on this purchase.  Shown in
                          the basis it was quoted in (per strip for a strip
                          medicine), because that is how the invoice read. */}
                      <td
                        style={{
                          padding: '9px 14px',
                          color: discount ? 'var(--ok)' : 'var(--text-hint)',
                          fontWeight: discount ? 600 : 400,
                          whiteSpace: 'nowrap',
                        }}
                        title={discount
                          ? 'Discount the supplier gave when this stock was purchased'
                          : 'No discount was recorded on this purchase'}
                      >
                        {discount || '—'}
                      </td>
                      {/* Est. loss — "—" (with a hint) when we have no cost to
                          work from.  The sub-line names the price the GST was
                          calculated on, so a discounted batch does not look
                          like it is using the wrong number. */}
                      <td
                        style={{ padding: '9px 14px', fontWeight: 700, color: b.est_loss != null ? color : 'var(--text-hint)' }}
                        title={b.est_loss == null
                          ? 'Add purchase price to calculate loss'
                          : 'GST calculated on discounted price. Cost price itself is recoverable on return.'}
                      >
                        {b.est_loss != null ? rupees(b.est_loss) : '—'}
                        {b.est_loss != null && effective != null && (
                          <div style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--text-hint)', marginTop: 2 }}>
                            GST on {rupees(effective)} effective cost
                          </div>
                        )}
                      </td>
                      {/* Return to Supplier — recovers the cost price (minus the
                          unrecoverable GST) against what we owe that supplier. */}
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

  // Canonical headline count — distinct PRODUCTS expired/expiring within 60 days.
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
        Loss shown = GST only (cost price is recovered when stock is returned to the supplier),
        calculated on the discounted price where a supplier discount was given.
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
            No batches are expiring within the next 60 days.
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
              warning={s.warning}
              items={alerts[s.key] ?? []}
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
