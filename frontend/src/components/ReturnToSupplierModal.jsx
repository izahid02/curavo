/*
 * Return to Supplier modal (Feature 2)
 * ─────────────────────────────────────────────────────────────────────────
 * Opened from the Expiry Alerts page for expired (or nearly expired) batches.
 *
 * THE MONEY RULE the pharmacist needs to see clearly:
 *   The supplier does not refund cash — they send replacement medicine of
 *   equivalent value.  The GST originally paid cannot be reclaimed, so the
 *   pharmacy absorbs it:
 *
 *     gross     = quantity x purchase price
 *     GST loss  = gross x gst_rate / 100
 *     net value = gross - GST loss     ← this reduces what we owe the supplier
 *
 * The arithmetic below mirrors supplier_return_service.calculate_return_value
 * so the preview matches what the backend records exactly.  The backend
 * remains the source of truth — this is display only.
 *
 * Rendered via createPortal(…, document.body): a fixed-position child of a
 * card with backdrop-filter gets clipped (see CLAUDE.md).
 */
import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';

function formatINR(amount) {
  const n = Number(amount ?? 0);
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const RETURN_TYPES = [
  ['SAME_MEDICINE',      'Same medicine replacement'],
  ['DIFFERENT_MEDICINE', 'Different medicine replacement'],
  ['PENDING',            'Pending (replacement later)'],
];

export default function ReturnToSupplierModal({ batch, onClose, onDone }) {
  // The backend preview gives us the supplier, cost price, GST rate and the
  // current outstanding balance — everything we need to show credit impact.
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');

  const [quantity,   setQuantity]   = useState(String(batch.quantity_available ?? 0));
  const [returnType, setReturnType] = useState('SAME_MEDICINE');
  const [replNotes,  setReplNotes]  = useState('');
  const [notes,      setNotes]      = useState('');
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/inventory/return-preview/${batch.id}`);
        if (!cancelled) setPreview(data);
      } catch (err) {
        if (!cancelled) {
          setLoadErr(
            err.response?.data?.detail
            ?? 'Could not load return details for this batch.',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [batch.id]);

  // Live recalculation as the quantity changes — same formula as the backend.
  const calc = useMemo(() => {
    if (!preview) return null;
    const qty  = Number(quantity) || 0;
    const cost = Number(preview.purchase_price) || 0;
    const rate = Number(preview.gst_rate) || 0;

    // ── Scheme split (Feature B) ──────────────────────────────────────────
    // Only the PAID units carry value; the free bonus units cost us nothing.
    // Mirror the backend's proportional split so the preview matches exactly.
    const bonusInBatch   = Number(preview.bonus_quantity) || 0;
    const totalReceived  = Number(preview.total_received) || 0;
    const hasScheme      = Boolean(preview.scheme_label) && bonusInBatch > 0 && totalReceived > 0;
    let bonusReturned = 0;
    let paidReturned  = qty;
    if (hasScheme) {
      bonusReturned = Math.round(qty * (bonusInBatch / totalReceived));
      bonusReturned = Math.min(bonusReturned, qty);
      paidReturned  = qty - bonusReturned;
    }

    // Value is based on the PAID units only.
    const gross = Math.round(paidReturned * cost * 100) / 100;
    const gst   = Math.round(gross * rate) / 100;
    const net   = Math.round((gross - gst) * 100) / 100;

    const outstanding = Number(preview.supplier_outstanding) || 0;
    // Credit can never go below zero — any excess is held as an advance.
    const after = Math.max(0, Math.round((outstanding - net) * 100) / 100);

    return { qty, gross, gst, net, outstanding, after, rate, hasScheme, bonusReturned, paidReturned };
  }, [preview, quantity]);

  const maxQty = preview?.quantity_available ?? batch.quantity_available ?? 0;
  const qtyInvalid = calc && (calc.qty <= 0 || calc.qty > maxQty);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (qtyInvalid) { setError(`Enter a quantity between 1 and ${maxQty}.`); return; }

    setSaving(true);
    try {
      const { data } = await api.post('/inventory/return-to-supplier', {
        batch_id:          batch.id,
        return_quantity:   calc.qty,
        supplier_id:       preview.supplier_id,
        return_type:       returnType,
        replacement_notes: replNotes.trim() || null,
        notes:             notes.trim() || null,
      });
      onDone(data);
    } catch (err) {
      setError(err.response?.data?.detail ?? 'Could not process the return. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(30,27,75,0.35)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: 520, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto',
          background: 'rgba(255,255,255,0.94)', backdropFilter: 'blur(24px)',
          border: '1px solid rgba(255,255,255,0.75)', borderRadius: 18,
          padding: 28, boxShadow: '0 20px 60px rgba(99,102,241,0.18)',
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1e1b4b', marginBottom: 4 }}>
          Return to Supplier — {batch.product_name}
        </h2>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 18 }}>
          Batch: <strong>{batch.batch_number || '—'}</strong> · Qty available:{' '}
          <strong>{maxQty}</strong>
        </p>

        {loading && <p style={{ fontSize: 14, color: '#9ca3af' }}>Loading return details…</p>}

        {loadErr && (
          <div style={{
            background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)',
            color: '#e11d48', borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 14,
          }}>
            {loadErr}
          </div>
        )}

        {preview && calc && (
          <>
            {/* Supplier (resolved from the original stock purchase) */}
            <div style={{
              background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.18)',
              borderRadius: 12, padding: '10px 14px', marginBottom: 18,
            }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: '#9ca3af' }}>
                Supplier
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#1e1b4b' }}>
                {preview.supplier_name}
              </div>
              <div style={{ fontSize: 11.5, color: '#9ca3af', marginTop: 2 }}>
                Auto-filled from the original stock purchase
              </div>
            </div>

            {/* Quantity */}
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 6 }}>
              Return Quantity * <span style={{ fontWeight: 400, color: '#9ca3af' }}>(max: {maxQty})</span>
            </label>
            <input
              type="number" min="1" max={maxQty}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              style={{
                width: '100%', marginBottom: 18,
                borderColor: qtyInvalid ? '#e11d48' : undefined,
              }}
            />

            {/* Value breakdown */}
            <div style={{
              background: 'rgba(255,255,255,0.66)', border: '1px solid rgba(255,255,255,0.8)',
              borderRadius: 12, padding: '14px 16px', marginBottom: 18,
            }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: '#9ca3af', marginBottom: 10 }}>
                Return Value Calculation{calc.hasScheme ? ` (${preview.scheme_label} Scheme)` : ''}
              </div>
              {/* Scheme breakdown (Feature B) — paid vs bonus units being returned */}
              {calc.hasScheme && (
                <div style={{
                  background: 'rgba(14,165,233,0.08)', border: '1px solid rgba(14,165,233,0.2)',
                  borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 12.5,
                }}>
                  <div style={{ fontWeight: 600, color: '#0284c7', marginBottom: 4 }}>Scheme breakdown</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ color: '#6b7280' }}>Paid units being returned</span>
                    <strong style={{ color: '#1e1b4b' }}>{calc.paidReturned}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#6b7280' }}>Bonus units being returned</span>
                    <strong style={{ color: '#059669' }}>{calc.bonusReturned} (free)</strong>
                  </div>
                  <div style={{ fontSize: 11, color: '#0284c7', marginTop: 5 }}>
                    Bonus units have ₹0 value — only paid units are reclaimed.
                  </div>
                </div>
              )}
              {[
                ['Purchase Price',            `${formatINR(preview.purchase_price)}/unit`, '#6b7280'],
                [calc.hasScheme ? `Gross Value (${calc.paidReturned} paid units)` : 'Gross Value', formatINR(calc.gross), '#6b7280'],
                [`GST Deduction (${calc.rate}%)`, `− ${formatINR(calc.gst)}`,               '#e11d48'],
              ].map(([label, value, color]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                  <span style={{ color: '#6b7280' }}>{label}</span>
                  <span style={{ color, fontWeight: 600 }}>{value}</span>
                </div>
              ))}
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                borderTop: '1px solid rgba(0,0,0,0.07)', paddingTop: 8, marginTop: 4,
              }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#1e1b4b' }}>Net Return Value</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: '#059669' }}>{formatINR(calc.net)}</span>
              </div>
            </div>

            {/* Return type */}
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 8 }}>
              Return Type *
            </label>
            <div style={{ marginBottom: 16 }}>
              {RETURN_TYPES.map(([value, label]) => (
                <label
                  key={value}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    fontSize: 13.5, color: '#1e1b4b', marginBottom: 7, cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio" name="return_type" value={value}
                    checked={returnType === value}
                    onChange={() => setReturnType(value)}
                  />
                  {label}
                </label>
              ))}
            </div>

            {/* Notes */}
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 6 }}>
              Replacement Notes
            </label>
            <input
              value={replNotes}
              onChange={(e) => setReplNotes(e.target.value)}
              placeholder="e.g. Will receive 40 units Metformin next delivery"
              style={{ width: '100%', marginBottom: 14 }}
            />

            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 6 }}>
              Additional Notes
            </label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Batch expired March 2026"
              style={{ width: '100%', marginBottom: 18 }}
            />

            {/* Credit impact */}
            <div style={{
              background: 'rgba(16,185,129,0.09)', border: '1px solid rgba(16,185,129,0.22)',
              borderRadius: 12, padding: '12px 16px', marginBottom: 18,
            }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: '#059669', marginBottom: 8 }}>
                Credit Impact
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                <span style={{ color: '#6b7280' }}>Current supplier outstanding</span>
                <span style={{ fontWeight: 600, color: '#6b7280' }}>{formatINR(calc.outstanding)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: '#6b7280' }}>After return</span>
                <span style={{ fontWeight: 700, color: '#059669' }}>{formatINR(calc.after)}</span>
              </div>
              {calc.outstanding <= 0 && (
                <div style={{ fontSize: 12, color: '#0284c7', marginTop: 8 }}>
                  No outstanding credit with this supplier — {formatINR(calc.net)} will be held
                  as an advance and used against the next credit purchase.
                </div>
              )}
            </div>
          </>
        )}

        {error && (
          <div style={{
            background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)',
            color: '#e11d48', borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 14,
          }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={saving || !preview || qtyInvalid}>
            {saving ? 'Processing…' : 'Process Return ✓'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
