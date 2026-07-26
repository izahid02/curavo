/*
 * Supplier Credit Management (Feature 1)
 * ─────────────────────────────────────────────────────────────────────────
 * Rendered as the "Credit Management" tab on the Suppliers page.
 *
 * Shows what the pharmacy OWES its suppliers — the mirror image of the
 * Credit page, which tracks what patients owe US.
 *
 * Contains:
 *   - Three summary cards: Total We Owe / Overdue / Advance Balance
 *   - A table of every supplier with an outstanding or advance balance
 *   - [Pay Supplier] modal   — records a payment (applied oldest-debt-first)
 *   - [View History] panel   — the supplier's full credit ledger
 *
 * Both overlays use createPortal(…, document.body) — required, because a
 * fixed-position child of a card with backdrop-filter gets clipped
 * (see CLAUDE.md, learned in Phase 1).
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { formatDateOnly } from '../lib/datetime';

/* Indian currency format — ₹1,23,456.00 (lakh/crore grouping, not thousands) */
function formatINR(amount) {
  const n = Number(amount ?? 0);
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* "in 5 days" / "3 days overdue" / "due today" — plain English beats a raw date */
function describeDue(days) {
  if (days === null || days === undefined) return '—';
  if (days < 0)  return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
  if (days === 0) return 'Due today';
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

/* Colour-coded status pill, using the shared badge classes from global.css */
function StatusBadge({ status }) {
  const map = {
    OVERDUE:  ['badge-danger',  'Overdue'],
    DUE_SOON: ['badge-warn',    'Due soon'],
    PENDING:  ['badge-info',    'Pending'],
    ADVANCE:  ['badge-ok',      'In advance'],
  };
  const [cls, label] = map[status] ?? ['badge-neutral', status];
  return <span className={cls}>{label}</span>;
}

/* ═══════════════════════════════════════════════════════════════════════
   Pay Supplier modal
   ═══════════════════════════════════════════════════════════════════════ */
function PayModal({ row, onClose, onPaid }) {
  const [amount, setAmount]   = useState('');
  const [mode,   setMode]     = useState('CASH');
  const [notes,  setNotes]    = useState('');
  const [saving, setSaving]   = useState(false);
  const [error,  setError]    = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    const value = Number(amount);
    if (!value || value <= 0) { setError('Enter an amount greater than zero.'); return; }

    setSaving(true);
    try {
      const { data } = await api.post('/supplier-credit/payment', {
        supplier_id:  row.supplier_id,
        amount:       value,
        payment_mode: mode,
        notes:        notes.trim() || null,
      });
      onPaid(data.message);
    } catch (err) {
      setError(err.response?.data?.detail ?? 'Could not record the payment. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // Paying more than is owed is allowed (it becomes an advance), but the
  // pharmacist should know that is what will happen before they confirm.
  const overpaying = Number(amount) > Number(row.outstanding);

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
          width: 460, maxWidth: '100%',
          background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(24px)',
          border: '1px solid rgba(255,255,255,0.75)', borderRadius: 18,
          padding: 28, boxShadow: '0 20px 60px rgba(99,102,241,0.18)',
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1e1b4b', marginBottom: 4 }}>
          Pay Supplier — {row.supplier_name}
        </h2>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
          Outstanding: <strong style={{ color: '#e11d48' }}>{formatINR(row.outstanding)}</strong>
          {Number(row.advance) > 0 && (
            <> · Advance held: <strong style={{ color: '#059669' }}>{formatINR(row.advance)}</strong></>
          )}
        </p>

        {/* Amount */}
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 6 }}>
          Amount *
        </label>
        <input
          type="number" step="0.01" min="0" autoFocus
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          style={{ width: '100%', marginBottom: 6 }}
        />
        {/* Quick-fill: clearing the whole balance is the common case */}
        {Number(row.outstanding) > 0 && (
          <button
            type="button"
            onClick={() => setAmount(String(row.outstanding))}
            style={{
              background: 'none', border: 'none', color: '#6366f1',
              fontSize: 12, cursor: 'pointer', padding: 0, marginBottom: 16,
            }}
          >
            Pay full outstanding ({formatINR(row.outstanding)})
          </button>
        )}

        {/* Payment mode */}
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', margin: '10px 0 6px' }}>
          Payment Mode *
        </label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {['CASH', 'UPI'].map((m) => (
            <button
              key={m} type="button" onClick={() => setMode(m)}
              style={{
                flex: 1, padding: '9px 0', borderRadius: 10, fontSize: 13, fontWeight: 600,
                cursor: 'pointer',
                border: mode === m ? '1px solid #6366f1' : '1px solid rgba(255,255,255,0.75)',
                background: mode === m ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.6)',
                color: mode === m ? '#4f46e5' : '#6b7280',
              }}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Notes */}
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 6 }}>
          Notes
        </label>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Cheque no. 4471"
          style={{ width: '100%', marginBottom: 16 }}
        />

        {overpaying && (
          <div style={{
            background: 'rgba(14,165,233,0.12)', border: '1px solid rgba(14,165,233,0.25)',
            color: '#0284c7', borderRadius: 10, padding: '9px 14px', fontSize: 12.5, marginBottom: 14,
          }}>
            This is more than the outstanding balance. The extra{' '}
            <strong>{formatINR(Number(amount) - Number(row.outstanding))}</strong> will be held as an
            advance and used against this supplier's next credit purchase.
          </div>
        )}

        {error && (
          <div style={{
            background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)',
            color: '#e11d48', borderRadius: 10, padding: '9px 14px', fontSize: 13, marginBottom: 14,
          }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Recording…' : 'Record Payment'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   History slide-in panel — the supplier's full credit ledger
   ═══════════════════════════════════════════════════════════════════════ */
function HistoryPanel({ supplierId, onClose }) {
  const [ledger,  setLedger]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/supplier-credit/supplier/${supplierId}`);
        if (!cancelled) setLedger(data);
      } catch {
        if (!cancelled) setError('Could not load this supplier’s credit history.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [supplierId]);

  // Each transaction type gets its own colour so the ledger scans quickly.
  const TYPE_STYLE = {
    CREDIT:            { label: 'Credit taken',    color: '#e11d48', sign: '+' },
    PAYMENT:           { label: 'Payment made',    color: '#059669', sign: '−' },
    RETURN_ADJUSTMENT: { label: 'Return adjusted', color: '#0284c7', sign: '−' },
    ADVANCE:           { label: 'Advance',         color: '#d97706', sign: '' },
  };

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(30,27,75,0.35)', backdropFilter: 'blur(4px)',
        display: 'flex', justifyContent: 'flex-end',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: 560, maxWidth: '100%', height: '100%', overflowY: 'auto',
        background: 'rgba(255,255,255,0.94)', backdropFilter: 'blur(24px)',
        borderLeft: '1px solid rgba(255,255,255,0.75)', padding: 28,
        boxShadow: '-20px 0 60px rgba(99,102,241,0.18)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1e1b4b' }}>
              {ledger?.supplier?.name ?? 'Credit history'}
            </h2>
            {ledger?.supplier?.phone && (
              <p style={{ fontSize: 13, color: '#9ca3af' }}>{ledger.supplier.phone}</p>
            )}
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 22, lineHeight: 1 }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {loading && <p style={{ fontSize: 14, color: '#9ca3af' }}>Loading…</p>}
        {error && (
          <div style={{
            background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)',
            color: '#e11d48', borderRadius: 10, padding: '10px 16px', fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {ledger && (
          <>
            {/* Account summary */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24,
            }}>
              {[
                ['Outstanding',  ledger.account.outstanding,     '#e11d48'],
                ['Advance held', ledger.account.advance_balance, '#059669'],
                ['Total credit', ledger.account.total_credit,    '#6b7280'],
                ['Total paid',   ledger.account.total_paid,      '#6b7280'],
              ].map(([label, value, color]) => (
                <div key={label} style={{
                  background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(255,255,255,0.75)',
                  borderRadius: 12, padding: '12px 16px',
                }}>
                  <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: '#9ca3af' }}>
                    {label}
                  </div>
                  <div style={{ fontSize: 17, fontWeight: 700, color }}>{formatINR(value)}</div>
                </div>
              ))}
            </div>

            {/* Transactions, newest first */}
            <h3 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6, color: '#9ca3af', marginBottom: 10 }}>
              Transactions
            </h3>

            {ledger.transactions.length === 0 && (
              <p style={{ fontSize: 14, color: '#9ca3af' }}>No credit activity yet.</p>
            )}

            {ledger.transactions.map((tx) => {
              const style = TYPE_STYLE[tx.type] ?? { label: tx.type, color: '#6b7280', sign: '' };
              return (
                <div key={tx.id} style={{
                  background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(255,255,255,0.75)',
                  borderRadius: 12, padding: '12px 16px', marginBottom: 8,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: style.color }}>
                      {style.label}
                      {tx.payment_mode && (
                        <span style={{ fontWeight: 500, color: '#9ca3af' }}> · {tx.payment_mode}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: style.color }}>
                      {style.sign}{formatINR(tx.amount)}
                    </div>
                  </div>

                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 3 }}>
                    {tx.created_at ? formatDateOnly(tx.created_at) : '—'}
                    {tx.invoice_number && <> · Invoice {tx.invoice_number}</>}
                    {tx.due_date && <> · Due {formatDateOnly(tx.due_date)}</>}
                  </div>

                  {/* Only CREDIT rows carry a meaningful running balance */}
                  {tx.type === 'CREDIT' && (
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 5 }}>
                      Paid {formatINR(tx.paid_amount)} · Balance{' '}
                      <strong>{formatINR(tx.balance)}</strong>{' '}
                      <span className={
                        tx.status === 'CLEARED' ? 'badge-ok'
                          : tx.status === 'OVERDUE' ? 'badge-danger'
                          : tx.status === 'PARTIAL' ? 'badge-warn' : 'badge-info'
                      }>
                        {tx.status}
                      </span>
                    </div>
                  )}

                  {tx.notes && (
                    <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4, fontStyle: 'italic' }}>
                      {tx.notes}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Main tab
   ═══════════════════════════════════════════════════════════════════════ */
export default function SupplierCredit() {
  const [summary, setSummary] = useState(null);
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [toast,   setToast]   = useState('');

  const [payRow,     setPayRow]     = useState(null);
  const [historyFor, setHistoryFor] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Both calls are independent — fire them together rather than in series.
      const [s, r] = await Promise.all([
        api.get('/supplier-credit/summary'),
        api.get('/supplier-credit/suppliers'),
      ]);
      setSummary(s.data);
      setRows(r.data);
    } catch {
      setError('Could not load supplier credit. Is the server running?');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function handlePaid(message) {
    setPayRow(null);
    setToast(message);
    load();
    setTimeout(() => setToast(''), 5000);
  }

  const cards = [
    { label: 'Total We Owe',    value: summary?.total_outstanding, color: '#e11d48', accent: 'linear-gradient(90deg,#f43f5e,#fb7185)' },
    { label: 'Overdue Amount',  value: summary?.total_overdue,     color: '#d97706', accent: 'linear-gradient(90deg,#f59e0b,#fbbf24)' },
    { label: 'Advance Balance', value: summary?.total_advance,     color: '#059669', accent: 'linear-gradient(90deg,#10b981,#34d399)' },
  ];

  return (
    <div>
      {/* ── Summary cards ─────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14, marginBottom: 20 }}>
        {cards.map((c, i) => (
          <div key={c.label} style={{
            position: 'relative', overflow: 'hidden',
            background: 'rgba(255,255,255,0.52)', backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.75)', borderRadius: 14,
            padding: '18px 20px', boxShadow: '0 4px 20px rgba(99,102,241,0.06)',
            animation: `fadeUp 0.4s ease ${i * 0.05}s both`,
          }}>
            {/* 3px gradient top border — the standard stat-card treatment */}
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: c.accent }} />
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: '#9ca3af', marginBottom: 6 }}>
              {c.label}
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: c.color }}>
              {loading ? '…' : formatINR(c.value)}
            </div>
          </div>
        ))}
      </div>

      {/* ── Toast ─────────────────────────────────────────────────── */}
      {toast && (
        <div style={{
          background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)',
          color: '#059669', borderRadius: 10, padding: '10px 16px', fontSize: 13, marginBottom: 16,
        }}>
          {toast}
        </div>
      )}

      {error && (
        <div style={{
          background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)',
          color: '#e11d48', borderRadius: 10, padding: '10px 16px', fontSize: 13, marginBottom: 16,
        }}>
          {error}
        </div>
      )}

      {/* ── Suppliers with credit ─────────────────────────────────── */}
      <div style={{
        background: 'rgba(255,255,255,0.52)', backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.75)', borderRadius: 14,
        overflow: 'hidden', boxShadow: '0 4px 20px rgba(99,102,241,0.06)',
      }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '2fr 1.2fr 1.2fr 1.4fr 1fr 190px',
          gap: 12, padding: '12px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.6)',
          fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: '#9ca3af', fontWeight: 600,
        }}>
          <div>Supplier</div>
          <div style={{ textAlign: 'right' }}>Outstanding</div>
          <div style={{ textAlign: 'right' }}>Advance</div>
          <div>Next Due</div>
          <div>Status</div>
          <div style={{ textAlign: 'right' }}>Actions</div>
        </div>

        {loading && (
          <div style={{ padding: 24, fontSize: 14, color: '#9ca3af' }}>Loading…</div>
        )}

        {!loading && rows.length === 0 && (
          <div style={{ padding: 28, textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 4 }}>
              No supplier credit outstanding.
            </p>
            <p style={{ fontSize: 13, color: '#9ca3af' }}>
              Credit is created automatically when you add stock without paying the full invoice.
            </p>
          </div>
        )}

        {!loading && rows.map((row) => (
          <div key={row.supplier_id} style={{
            display: 'grid', gridTemplateColumns: '2fr 1.2fr 1.2fr 1.4fr 1fr 190px',
            gap: 12, padding: '14px 20px', alignItems: 'center',
            borderBottom: '1px solid rgba(255,255,255,0.4)', fontSize: 13.5,
          }}>
            <div>
              <div style={{ fontWeight: 600, color: '#1e1b4b' }}>{row.supplier_name}</div>
              {row.supplier_phone && (
                <div style={{ fontSize: 12, color: '#9ca3af' }}>{row.supplier_phone}</div>
              )}
            </div>
            <div style={{ textAlign: 'right', fontWeight: 700, color: Number(row.outstanding) > 0 ? '#e11d48' : '#9ca3af' }}>
              {formatINR(row.outstanding)}
            </div>
            <div style={{ textAlign: 'right', color: Number(row.advance) > 0 ? '#059669' : '#9ca3af' }}>
              {formatINR(row.advance)}
            </div>
            <div style={{ color: '#6b7280' }}>
              {row.next_due_date
                ? <>
                    {formatDateOnly(row.next_due_date)}
                    <div style={{ fontSize: 12, color: row.days_until_due < 0 ? '#e11d48' : '#9ca3af' }}>
                      {describeDue(row.days_until_due)}
                    </div>
                  </>
                : '—'}
            </div>
            <div><StatusBadge status={row.status} /></div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {Number(row.outstanding) > 0 && (
                <button
                  className="btn-primary"
                  style={{ fontSize: 12, padding: '6px 12px' }}
                  onClick={() => setPayRow(row)}
                >
                  Pay Supplier
                </button>
              )}
              <button
                className="btn-secondary"
                style={{ fontSize: 12, padding: '6px 12px' }}
                onClick={() => setHistoryFor(row.supplier_id)}
              >
                History
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Overlays ──────────────────────────────────────────────── */}
      {payRow && (
        <PayModal row={payRow} onClose={() => setPayRow(null)} onPaid={handlePaid} />
      )}
      {historyFor && (
        <HistoryPanel supplierId={historyFor} onClose={() => setHistoryFor(null)} />
      )}
    </div>
  );
}
