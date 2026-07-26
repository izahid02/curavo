/**
 * Credit Management Page
 *
 * Shows all patients who have an outstanding credit balance.
 * Two tabs: "All Credit" and "Overdue Only".
 *
 * Features:
 *   - 4 summary cards at the top (totals + overdue counts)
 *   - Searchable patient table with status badges
 *   - "Receive Payment" modal — records a payment via POST /api/credit/payment
 *   - "View History" modal — shows all credit transactions for a patient
 *   - URL param ?tab=overdue opens the overdue tab directly (used by Dashboard link)
 */
import { createPortal } from 'react-dom';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDateOnly } from '../lib/datetime';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function inr(amount) {
  return '₹' + Number(amount || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// IST-aware date (see lib/datetime.js) — used for tx timestamps + due dates.
const fmtDate = formatDateOnly;

function StatusBadge({ status }) {
  const map = {
    OVERDUE:  { bg: 'var(--danger-bg)',   color: 'var(--danger)',  label: 'Overdue'  },
    PARTIAL:  { bg: 'var(--warn-bg)',     color: 'var(--warn)',    label: 'Partial'  },
    PENDING:  { bg: 'rgba(156,163,175,0.15)', color: '#6b7280',   label: 'Pending'  },
    CLEARED:  { bg: 'var(--ok-bg)',       color: 'var(--ok)',      label: 'Cleared'  },
    PAYMENT:  { bg: 'var(--ok-bg)',       color: 'var(--ok)',      label: 'Payment'  },
  };
  const s = map[status] || map.PENDING;
  return (
    <span style={{
      background: s.bg, color: s.color,
      fontSize: 11, fontWeight: 700,
      padding: '3px 10px', borderRadius: 20,
      textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>
      {s.label}
    </span>
  );
}

// ─── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, danger }) {
  return (
    <div style={{
      flex: 1,
      background: danger ? 'rgba(244,63,94,0.06)' : 'rgba(255,255,255,0.52)',
      backdropFilter: 'blur(20px)',
      border: `1px solid ${danger ? 'rgba(225,29,72,0.20)' : 'rgba(255,255,255,0.75)'}`,
      borderRadius: 14,
      padding: '18px 20px',
      borderTop: `3px solid ${danger ? 'var(--danger)' : 'var(--accent)'}`,
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.07em', color: danger ? 'var(--danger)' : 'var(--text-secondary)',
        marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700,
        color: danger ? 'var(--danger)' : 'var(--text)' }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>{sub}</div>
      )}
    </div>
  );
}

// ─── Receive Payment Modal ────────────────────────────────────────────────────

function PaymentModal({ patient, onClose, onSuccess }) {
  const [amount, setAmount]   = useState('');
  const [notes, setNotes]     = useState('');
  // How the money came in. CASH is the default because most counter payments
  // at the pharmacy are cash; UPI is recorded so the day's cash can be
  // reconciled against the drawer.
  const [paymentMode, setPaymentMode] = useState('CASH');
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');

  async function handleSubmit() {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setErr('Enter a valid amount.'); return; }
    if (amt > parseFloat(patient.outstanding)) {
      setErr(`Amount cannot exceed outstanding balance (${inr(patient.outstanding)}).`);
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await api.post('/credit/payment', {
        patient_id:   patient.patient_id,
        amount:       amt,
        notes:        notes || null,
        payment_mode: paymentMode,
      });
      onSuccess(`Payment of ${inr(amt)} (${paymentMode}) recorded for ${patient.name}`);
      onClose();
    } catch (e) {
      setErr(e.response?.data?.detail || 'Failed to record payment. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={onClose}
    >
      <div
        style={{
          width: '90%', maxWidth: 400,
          background: 'rgba(255,255,255,0.75)', backdropFilter: 'blur(28px)',
          WebkitBackdropFilter: 'blur(28px)',
          border: '1px solid rgba(255,255,255,0.85)',
          borderRadius: 18, padding: 28,
          boxShadow: '0 20px 60px rgba(99,102,241,0.14)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>
              Receive Payment
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
              {patient.name}
            </div>
          </div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: 22, color: 'var(--text-hint)', cursor: 'pointer', padding: '0 4px' }}>
            ×
          </button>
        </div>

        {/* Outstanding */}
        <div style={{
          background: 'rgba(225,29,72,0.07)', border: '1px solid rgba(225,29,72,0.18)',
          borderRadius: 10, padding: '10px 14px', marginBottom: 16,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Outstanding</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--danger)' }}>
            {inr(patient.outstanding)}
          </span>
        </div>

        {/* Payment mode — same toggle-button style as the billing screen */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            Payment Mode *
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            {[['CASH', '💵 CASH'], ['UPI', '📱 UPI']].map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setPaymentMode(mode)}
                style={{
                  flex: 1, padding: '10px 4px', fontSize: 14, fontWeight: 600,
                  background: paymentMode === mode ? 'var(--accent)' : 'var(--glass)',
                  color:      paymentMode === mode ? '#fff' : 'var(--text)',
                  border: `2px solid ${paymentMode === mode ? 'var(--accent)' : 'var(--glass-border)'}`,
                  borderRadius: 'var(--radius)',
                  cursor: 'pointer',
                }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Amount input */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 5 }}>
            Amount Received (₹) *
          </label>
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="Enter amount"
            autoFocus
            style={{ fontSize: 16, width: '100%', fontWeight: 600 }}
          />
        </div>

        {/* Notes */}
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 5 }}>
            Notes (optional)
          </label>
          <input
            type="text"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. Cash received at counter"
            style={{ fontSize: 13, width: '100%' }}
          />
        </div>

        {err && (
          <div style={{
            background: 'var(--danger-bg)', border: '1px solid rgba(225,29,72,0.2)',
            borderRadius: 8, padding: '8px 12px', marginBottom: 14,
            color: 'var(--danger)', fontSize: 13,
          }}>
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose}
            style={{
              flex: 1, padding: '10px', background: 'transparent',
              border: '1px solid var(--glass-border)', borderRadius: 'var(--radius)',
              color: 'var(--text-secondary)', fontSize: 14, cursor: 'pointer',
            }}>
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !amount}
            style={{
              flex: 2, padding: '10px', background: 'var(--ok)',
              border: 'none', borderRadius: 'var(--radius)',
              color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer',
              opacity: (!amount || saving) ? 0.7 : 1,
            }}>
            {saving ? 'Recording…' : 'Record Payment'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Transaction History Modal ────────────────────────────────────────────────

function HistoryModal({ patient, onClose }) {
  const [txs, setTxs]       = useState([]);
  const [account, setAcc]   = useState(null);
  const [loading, setLoad]  = useState(true);

  useEffect(() => {
    api.get(`/credit/patient/${patient.patient_id}`)
      .then(r => {
        setAcc(r.data.account);
        setTxs(r.data.transactions);
      })
      .catch(() => {})
      .finally(() => setLoad(false));
  }, [patient.patient_id]);

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={onClose}
    >
      <div
        style={{
          width: '95%', maxWidth: 600, maxHeight: '85vh',
          display: 'flex', flexDirection: 'column',
          background: 'rgba(255,255,255,0.75)', backdropFilter: 'blur(28px)',
          WebkitBackdropFilter: 'blur(28px)',
          border: '1px solid rgba(255,255,255,0.85)',
          borderRadius: 18, padding: 28,
          boxShadow: '0 20px 60px rgba(99,102,241,0.14)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>
              Credit History — {patient.name}
            </div>
            {account && (
              <div style={{ display: 'flex', gap: 20, marginTop: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Outstanding: <strong style={{ color: account.outstanding > 0 ? 'var(--danger)' : 'var(--ok)' }}>
                    {inr(account.outstanding)}
                  </strong>
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Total Given: {inr(account.total_credit)}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Total Paid: {inr(account.total_paid)}
                </span>
              </div>
            )}
          </div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: 22, color: 'var(--text-hint)', cursor: 'pointer', padding: '0 4px' }}>
            ×
          </button>
        </div>

        {/* Transaction list */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-hint)' }}>Loading…</div>
          ) : txs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-hint)' }}>No transactions found.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid rgba(0,0,0,0.06)' }}>
                  {['Date', 'Type', 'Amount', 'Due Date', 'Balance', 'Status'].map(h => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: 'left',
                      fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                      letterSpacing: '0.07em', color: 'var(--text-hint)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {txs.map(tx => (
                  <tr key={tx.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                    <td style={{ padding: '9px 10px', color: 'var(--text-secondary)', fontSize: 12 }}>
                      {fmtDate(tx.created_at)}
                    </td>
                    <td style={{ padding: '9px 10px' }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                        background: tx.type === 'CREDIT' ? 'rgba(225,29,72,0.1)' : 'rgba(5,150,105,0.1)',
                        color: tx.type === 'CREDIT' ? 'var(--danger)' : 'var(--ok)',
                      }}>
                        {tx.type}
                      </span>
                    </td>
                    <td style={{ padding: '9px 10px', fontWeight: 600 }}>
                      {tx.type === 'CREDIT' ? inr(tx.amount) : (
                        <span style={{ color: 'var(--ok)' }}>+{inr(tx.amount)}</span>
                      )}
                    </td>
                    <td style={{ padding: '9px 10px', fontSize: 12, color: 'var(--text-secondary)' }}>
                      {tx.due_date ? fmtDate(tx.due_date) : '—'}
                    </td>
                    <td style={{ padding: '9px 10px', fontWeight: 600,
                      color: parseFloat(tx.balance) > 0 ? 'var(--danger)' : 'var(--ok)' }}>
                      {tx.type === 'CREDIT' ? inr(tx.balance) : '—'}
                    </td>
                    <td style={{ padding: '9px 10px' }}>
                      {tx.type === 'CREDIT' ? <StatusBadge status={tx.status} /> : <StatusBadge status="PAYMENT" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Credit History tab ───────────────────────────────────────────────────────

const PAGE_SIZE = 50;

/**
 * Full ledger of every credit event across all patients, newest first.
 *
 * Unlike the "All Credit" tab (which shows one row per patient with their
 * current balance), this shows one row per TRANSACTION — both money given on
 * credit and money received back — so the owner can audit the whole trail.
 *
 * Filtering happens on the server (GET /api/credit/history) because the table
 * is paginated; filtering client-side would only filter the current page.
 */
function HistoryTab() {
  const [rows, setRows]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(0);
  const [loading, setLoading] = useState(true);

  // Filters
  const [typeFilter, setTypeFilter] = useState('');   // '' = both types
  const [dateFrom, setDateFrom]     = useState('');
  const [dateTo, setDateTo]         = useState('');
  const [search, setSearch]         = useState('');   // patient name, matched locally

  useEffect(() => {
    setLoading(true);
    const params = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (typeFilter) params.type      = typeFilter;
    if (dateFrom)   params.date_from = dateFrom;
    if (dateTo)     params.date_to   = dateTo;

    api.get('/credit/history', { params })
      .then(r => { setRows(r.data.items); setTotal(r.data.total); })
      .catch(() => { setRows([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [page, typeFilter, dateFrom, dateTo]);

  // Whenever a filter changes we must go back to page 1, otherwise the user
  // can end up on an offset past the end of the new (smaller) result set.
  useEffect(() => { setPage(0); }, [typeFilter, dateFrom, dateTo]);

  // Patient-name search filters the loaded page only — the pharmacist uses it
  // to pick a name out of the visible rows, not to search the whole ledger.
  const visible = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(r => r.patient_name.toLowerCase().includes(q));
  }, [rows, search]);

  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <div>
      {/* Filter bar */}
      <div style={{
        display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center',
        padding: '12px 20px', borderBottom: '1px solid rgba(0,0,0,0.06)',
      }}>
        <input
          placeholder="Search patient on this page…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ fontSize: 13, width: 220, padding: '7px 12px' }}
        />
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          style={{ fontSize: 13, padding: '7px 12px' }}
        >
          <option value="">All types</option>
          <option value="CREDIT">Credit given</option>
          <option value="PAYMENT">Payments received</option>
        </select>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>From</label>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          style={{ fontSize: 13, padding: '6px 10px' }} />
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>To</label>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
          style={{ fontSize: 13, padding: '6px 10px' }} />
        {(typeFilter || dateFrom || dateTo || search) && (
          <button
            onClick={() => { setTypeFilter(''); setDateFrom(''); setDateTo(''); setSearch(''); }}
            style={{
              background: 'transparent', border: '1px solid var(--glass-border)',
              borderRadius: 20, padding: '6px 14px', fontSize: 12,
              color: 'var(--text-secondary)', cursor: 'pointer',
            }}>
            Clear
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-hint)' }}>
          Loading transactions…
        </div>
      ) : visible.length === 0 ? (
        <div style={{ padding: 56, textAlign: 'center' }}>
          <div style={{ fontSize: 38, marginBottom: 10 }}>🧾</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
            No transactions found
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Try widening the date range or clearing the filters.
          </div>
        </div>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                  {['Date', 'Patient', 'Type', 'Amount', 'Payment Mode',
                    'Invoice', 'Notes', 'Balance After'].map(h => (
                    <th key={h} style={{
                      padding: '11px 14px', textAlign: 'left',
                      fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                      letterSpacing: '0.07em', color: 'var(--text-hint)', whiteSpace: 'nowrap',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(tx => (
                  <tr key={tx.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                    <td style={{ padding: '11px 14px', color: 'var(--text-secondary)', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {fmtDate(tx.created_at)}
                    </td>
                    <td style={{ padding: '11px 14px', fontWeight: 600, color: 'var(--text)' }}>
                      {tx.patient_name}
                    </td>
                    <td style={{ padding: '11px 14px' }}>
                      {/* CREDIT = money out (red), PAYMENT = money in (green) */}
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20,
                        background: tx.type === 'CREDIT' ? 'var(--danger-bg)' : 'var(--ok-bg)',
                        color:      tx.type === 'CREDIT' ? 'var(--danger)'   : 'var(--ok)',
                      }}>
                        {tx.type}
                      </span>
                    </td>
                    <td style={{ padding: '11px 14px', fontWeight: 700, whiteSpace: 'nowrap',
                      color: tx.type === 'CREDIT' ? 'var(--danger)' : 'var(--ok)' }}>
                      {tx.type === 'PAYMENT' ? '+' : ''}{inr(tx.amount)}
                    </td>
                    <td style={{ padding: '11px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                      {tx.payment_mode
                        ? (tx.payment_mode === 'UPI' ? '📱 UPI' : '💵 CASH')
                        : '—'}
                    </td>
                    <td style={{ padding: '11px 14px', fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                      {tx.invoice_number || '—'}
                    </td>
                    <td style={{ padding: '11px 14px', fontSize: 12, color: 'var(--text-secondary)', maxWidth: 200 }}>
                      {tx.notes || '—'}
                    </td>
                    <td style={{ padding: '11px 14px', fontWeight: 600,
                      color: parseFloat(tx.balance_after) > 0 ? 'var(--text)' : 'var(--ok)' }}>
                      {inr(tx.balance_after)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '12px 20px', borderTop: '1px solid rgba(0,0,0,0.06)',
              fontSize: 12, color: 'var(--text-secondary)',
            }}>
              <span>
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  style={pagerBtn(page === 0)}>
                  ← Previous
                </button>
                <button
                  onClick={() => setPage(p => Math.min(lastPage, p + 1))}
                  disabled={page >= lastPage}
                  style={pagerBtn(page >= lastPage)}>
                  Next →
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function pagerBtn(disabled) {
  return {
    padding: '6px 14px', fontSize: 12, borderRadius: 20,
    background: 'var(--glass)', border: '1px solid var(--glass-border)',
    color: disabled ? 'var(--text-hint)' : 'var(--text)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}

// ─── Defaulters tab ───────────────────────────────────────────────────────────

/** Colour scheme for the risk badge — thresholds are decided by the backend. */
function RiskBadge({ level }) {
  const map = {
    HIGH:   { bg: 'var(--danger-bg)',          color: 'var(--danger)' },
    MEDIUM: { bg: 'var(--warn-bg)',            color: 'var(--warn)'   },
    LOW:    { bg: 'rgba(234,179,8,0.14)',      color: '#a16207'       },
  };
  const s = map[level] || map.LOW;
  return (
    <span style={{
      background: s.bg, color: s.color,
      fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
      textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>
      {level}
    </span>
  );
}

/**
 * Patients who currently have at least one unpaid transaction past its due
 * date, worst risk first.  Risk level and ordering both come from the backend
 * so this table and any future report cannot drift apart.
 */
function DefaultersTab({ onReceive, onHistory }) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');

  useEffect(() => {
    setLoading(true);
    api.get('/credit/defaulters')
      .then(r => setRows(r.data))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  const visible = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(r =>
      r.name.toLowerCase().includes(q) || (r.phone && r.phone.includes(q))
    );
  }, [rows, search]);

  return (
    <div>
      <div style={{ padding: '12px 20px', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
        <input
          placeholder="Search by name or phone…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ fontSize: 13, width: 260, padding: '7px 12px' }}
        />
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-hint)' }}>
          Loading defaulters…
        </div>
      ) : visible.length === 0 ? (
        <div style={{ padding: 56, textAlign: 'center' }}>
          <div style={{ fontSize: 38, marginBottom: 10 }}>✅</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
            No defaulters
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            No patient has ever missed a due date.
          </div>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                {['Patient', 'Phone', 'Total Outstanding', 'Times Overdue',
                  'Oldest Overdue', 'Last Payment', 'Risk Level', 'Actions'].map(h => (
                  <th key={h} style={{
                    padding: '11px 14px', textAlign: 'left',
                    fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.07em', color: 'var(--text-hint)', whiteSpace: 'nowrap',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(d => (
                <tr key={d.patient_id} style={{
                  borderBottom: '1px solid rgba(0,0,0,0.04)',
                  background: d.risk_level === 'HIGH' ? 'rgba(244,63,94,0.04)' : 'transparent',
                }}>
                  <td style={{ padding: '12px 14px' }}>
                    <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 14 }}>{d.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                      #{d.patient_id}
                    </div>
                  </td>
                  <td style={{ padding: '12px 14px', color: 'var(--text-secondary)' }}>
                    {d.phone || '—'}
                  </td>
                  <td style={{ padding: '12px 14px', fontWeight: 700, fontSize: 15,
                    color: parseFloat(d.outstanding) > 0 ? 'var(--danger)' : 'var(--ok)' }}>
                    {inr(d.outstanding)}
                  </td>
                  {/* Lifetime count — how many separate bills went late ever */}
                  <td style={{ padding: '12px 14px', fontWeight: 600 }}>
                    {d.times_overdue}
                    <span style={{ fontSize: 10, color: 'var(--text-hint)', fontWeight: 500, display: 'block' }}>
                      all time
                    </span>
                  </td>
                  {/* Only patients who owe late money TODAY get a date here.
                      Historical defaulters (late before, square now) show a
                      green "paid up" note instead of a misleading "0 days". */}
                  <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }}>
                    {d.currently_overdue ? (
                      <span style={{ color: 'var(--danger)' }}>
                        {fmtDate(d.oldest_overdue_date)}
                        <span style={{ display: 'block', fontSize: 10, fontWeight: 700 }}>
                          {d.days_overdue} day{d.days_overdue === 1 ? '' : 's'} late
                        </span>
                      </span>
                    ) : (
                      <span style={{ color: 'var(--ok)', fontSize: 12, fontWeight: 600 }}>
                        Paid up
                        <span style={{ display: 'block', fontSize: 10, fontWeight: 500, color: 'var(--text-hint)' }}>
                          was late before
                        </span>
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '12px 14px', color: 'var(--text-secondary)', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {d.last_payment_date ? fmtDate(d.last_payment_date) : 'Never'}
                  </td>
                  <td style={{ padding: '12px 14px' }}>
                    <RiskBadge level={d.risk_level} />
                  </td>
                  <td style={{ padding: '12px 14px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {/* Nothing to collect from a patient who owes ₹0 — the
                          payment modal would reject the amount anyway. */}
                      {parseFloat(d.outstanding) > 0 && (
                        <button
                          onClick={() => onReceive({
                            patient_id:  d.patient_id,
                            name:        d.name,
                            outstanding: d.outstanding,
                          })}
                          style={{
                            padding: '6px 12px', fontSize: 12, fontWeight: 600,
                            background: 'var(--ok)', color: '#fff',
                            border: 'none', borderRadius: 20, cursor: 'pointer', whiteSpace: 'nowrap',
                          }}>
                          ₹ Receive
                        </button>
                      )}
                      <button
                        onClick={() => onHistory({ patient_id: d.patient_id, name: d.name })}
                        style={{
                          padding: '6px 12px', fontSize: 12, fontWeight: 500,
                          background: 'var(--glass)', color: 'var(--text)',
                          border: '1px solid var(--glass-border)',
                          borderRadius: 20, cursor: 'pointer', whiteSpace: 'nowrap',
                        }}>
                        History
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Credit() {
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab]     = useState(searchParams.get('tab') === 'overdue' ? 'overdue' : 'all');
  const [summary, setSummary]         = useState(null);
  const [loading, setLoading]         = useState(true);
  const [searchTerm, setSearchTerm]   = useState('');
  const [paymentModal, setPaymentModal] = useState(null);   // patient row or null
  const [historyModal, setHistoryModal] = useState(null);   // patient row or null
  const [toast, setToast]             = useState('');        // success message
  // Bumped after a payment is recorded. Used as the `key` on the Defaulters
  // and History tabs so they remount and re-fetch — without it those tables
  // would still show the balance from before the payment.
  const [refreshKey, setRefreshKey]   = useState(0);

  // ── Fetch summary data ────────────────────────────────────────────────────
  const fetchSummary = useCallback(() => {
    setLoading(true);
    api.get('/credit/summary')
      .then(r => setSummary(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  // ── Toast ─────────────────────────────────────────────────────────────────
  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  }

  // ── Filtered rows for the current tab ────────────────────────────────────
  const rows = useMemo(() => {
    if (!summary) return [];
    let list = summary.patients;
    if (activeTab === 'overdue') {
      list = list.filter(p => p.is_overdue);
      // sort by oldest due date ascending (most overdue first)
      list = [...list].sort((a, b) => {
        if (!a.oldest_due_date) return 1;
        if (!b.oldest_due_date) return -1;
        return new Date(a.oldest_due_date) - new Date(b.oldest_due_date);
      });
    }
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.phone && p.phone.includes(q))
      );
    }
    return list;
  }, [summary, activeTab, searchTerm]);

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>

      {/* ── Summary cards ──────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
          {[1,2,3,4].map(i => (
            <div key={i} style={{
              flex: 1, height: 96, borderRadius: 14,
              background: 'rgba(255,255,255,0.52)',
              animation: 'pulse 1.5s ease-in-out infinite',
            }} />
          ))}
        </div>
      ) : summary && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
          <SummaryCard
            label="Total Outstanding"
            value={inr(summary.total_outstanding)}
            sub={`${summary.total_patients_with_credit} patient${summary.total_patients_with_credit !== 1 ? 's' : ''} on credit`}
          />
          <SummaryCard
            label="Patients on Credit"
            value={summary.total_patients_with_credit}
            sub="with unpaid balance"
          />
          <SummaryCard
            label="Overdue Amount"
            value={inr(summary.overdue_amount)}
            sub="past due date"
            danger={summary.overdue_count > 0}
          />
          <SummaryCard
            label="Overdue Patients"
            value={summary.overdue_count}
            sub={summary.overdue_count > 0 ? 'require attention' : 'none overdue'}
            danger={summary.overdue_count > 0}
          />
        </div>
      )}

      {/* ── Main card ──────────────────────────────────────────────────── */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>

        {/* Tabs + search row */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 20px', borderBottom: '1px solid rgba(0,0,0,0.06)',
          flexWrap: 'wrap', gap: 10,
        }}>
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 4 }}>
            {[
              { key: 'all',        label: 'All Credit' },
              { key: 'overdue',    label: `Overdue Only${summary?.overdue_count > 0 ? ` (${summary.overdue_count})` : ''}` },
              { key: 'history',    label: 'History' },
              { key: 'defaulters', label: 'Defaulters' },
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                style={{
                  padding: '7px 16px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', border: 'none',
                  background: activeTab === key
                    ? ((key === 'overdue' || key === 'defaulters') ? 'var(--danger)' : 'var(--accent)')
                    : 'transparent',
                  color: activeTab === key ? '#fff' : 'var(--text-secondary)',
                  transition: 'all 0.15s',
                }}>
                {label}
              </button>
            ))}
          </div>

          {/* Search — the History and Defaulters tabs bring their own filter
              bars, so this one is only shown for the two patient-list tabs. */}
          {(activeTab === 'all' || activeTab === 'overdue') && (
            <input
              placeholder="Search by name or phone…"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              style={{ fontSize: 13, width: 260, padding: '8px 14px' }}
            />
          )}
        </div>

        {/* Table */}
        {activeTab === 'history' ? (
          <HistoryTab key={refreshKey} />
        ) : activeTab === 'defaulters' ? (
          <DefaultersTab
            key={refreshKey}
            onReceive={setPaymentModal}
            onHistory={setHistoryModal}
          />
        ) : loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-hint)' }}>
            Loading credit data…
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '56px', textAlign: 'center' }}>
            <div style={{ fontSize: 38, marginBottom: 10 }}>💳</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
              {activeTab === 'overdue' ? 'No overdue accounts' : 'No credit accounts'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {activeTab === 'overdue'
                ? 'All credit accounts are paid on time.'
                : 'No patients have outstanding credit yet.'}
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                  {['Patient', 'Phone', 'Outstanding', 'Due Date', 'Status', 'Actions'].map(h => (
                    <th key={h} style={{
                      padding: '11px 16px', textAlign: 'left',
                      fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                      letterSpacing: '0.07em', color: 'var(--text-hint)',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(patient => (
                  <tr key={patient.patient_id} style={{
                    borderBottom: '1px solid rgba(0,0,0,0.04)',
                    background: patient.is_overdue ? 'rgba(244,63,94,0.03)' : 'transparent',
                    transition: 'background 0.12s',
                  }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.5)'}
                    onMouseLeave={e => e.currentTarget.style.background = patient.is_overdue ? 'rgba(244,63,94,0.03)' : 'transparent'}
                  >
                    {/* Patient name */}
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 14 }}>
                        {patient.name}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                        #{patient.patient_id}
                      </div>
                    </td>

                    {/* Phone */}
                    <td style={{ padding: '12px 16px', color: 'var(--text-secondary)' }}>
                      {patient.phone || '—'}
                    </td>

                    {/* Outstanding */}
                    <td style={{ padding: '12px 16px' }}>
                      <span style={{
                        fontWeight: 700, fontSize: 15,
                        color: patient.is_overdue ? 'var(--danger)' : 'var(--text)',
                      }}>
                        {inr(patient.outstanding)}
                      </span>
                    </td>

                    {/* Due date */}
                    <td style={{ padding: '12px 16px', color: patient.is_overdue ? 'var(--danger)' : 'var(--text-secondary)' }}>
                      {patient.oldest_due_date ? (
                        <span style={{ fontWeight: patient.is_overdue ? 600 : 400 }}>
                          {fmtDate(patient.oldest_due_date)}
                          {patient.is_overdue && (
                            <span style={{ display: 'block', fontSize: 10, color: 'var(--danger)', fontWeight: 700 }}>
                              OVERDUE
                            </span>
                          )}
                        </span>
                      ) : '—'}
                    </td>

                    {/* Status badge */}
                    <td style={{ padding: '12px 16px' }}>
                      <StatusBadge status={patient.status} />
                    </td>

                    {/* Actions */}
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          onClick={() => setPaymentModal(patient)}
                          style={{
                            padding: '6px 12px', fontSize: 12, fontWeight: 600,
                            background: 'var(--ok)', color: '#fff',
                            border: 'none', borderRadius: 20, cursor: 'pointer',
                            whiteSpace: 'nowrap',
                          }}>
                          ₹ Receive
                        </button>
                        <button
                          onClick={() => setHistoryModal(patient)}
                          style={{
                            padding: '6px 12px', fontSize: 12, fontWeight: 500,
                            background: 'var(--glass)', color: 'var(--text)',
                            border: '1px solid var(--glass-border)',
                            borderRadius: 20, cursor: 'pointer',
                            whiteSpace: 'nowrap',
                          }}>
                          History
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Modals ────────────────────────────────────────────────────── */}
      {paymentModal && (
        <PaymentModal
          patient={paymentModal}
          onClose={() => setPaymentModal(null)}
          onSuccess={msg => {
            setPaymentModal(null);
            showToast(msg);
            fetchSummary();               // refresh All Credit / Overdue tabs
            setRefreshKey(k => k + 1);    // refresh History / Defaulters tabs
          }}
        />
      )}

      {historyModal && (
        <HistoryModal
          patient={historyModal}
          onClose={() => setHistoryModal(null)}
        />
      )}

      {/* ── Toast notification ─────────────────────────────────────────── */}
      {toast && createPortal(
        <div style={{
          position: 'fixed', bottom: 28, right: 28, zIndex: 2000,
          background: 'var(--ok)', color: '#fff',
          padding: '12px 22px', borderRadius: 12, fontSize: 14, fontWeight: 600,
          boxShadow: '0 8px 24px rgba(5,150,105,0.35)',
          animation: 'fadeUp 0.3s ease',
        }}>
          ✓ {toast}
        </div>,
        document.body
      )}
    </div>
  );
}
