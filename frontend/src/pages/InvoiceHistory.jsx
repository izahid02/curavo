/**
 * Invoice History Page
 *
 * Shows a paginated, filterable table of all invoices.
 * Clicking a row opens a detail modal with full line items.
 * The modal has a "Return Invoice" button to reverse a sale.
 *
 * Filters: date preset (Today / This Week / This Month / All)
 *          + text search by invoice number or patient name
 *          + status filter (All / Completed / Returned)
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatDateTimeShort, getTodayIST } from '../lib/datetime';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inr(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

// Show invoice timestamps in IST (see lib/datetime.js for why).
const fmtDate = formatDateTimeShort;

/** Return ISO date strings for preset filters, anchored to TODAY in IST. */
function presetDates(preset) {
  // getTodayIST() is "YYYY-MM-DD" for today in IST — the day the pharmacy is
  // actually having. Building the anchor date from it (at UTC noon, so no
  // timezone can roll it to a neighbouring day) keeps every preset on the
  // right calendar day regardless of the PC's clock zone.
  const todayStr = getTodayIST();
  const today = new Date(todayStr + 'T12:00:00Z');
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;

  if (preset === 'today') {
    return { date_from: todayStr, date_to: todayStr };
  }
  if (preset === 'week') {
    const mon = new Date(today);
    mon.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));  // Monday
    return { date_from: fmt(mon), date_to: todayStr };
  }
  if (preset === 'month') {
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    return { date_from: fmt(first), date_to: todayStr };
  }
  return {};   // 'all' — no date filter
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function InvoiceHistory() {
  const [datePreset,  setDatePreset]  = useState('today');
  const [search,      setSearch]      = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page,        setPage]        = useState(1);

  const [invoices,    setInvoices]    = useState([]);
  const [total,       setTotal]       = useState(0);
  const [loading,     setLoading]     = useState(false);
  const [loadError,   setLoadError]   = useState(null);

  // Detail modal
  const [detail,      setDetail]      = useState(null);   // full InvoiceOut
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedNum, setSelectedNum] = useState(null);

  // Return flow
  const [returning,   setReturning]   = useState(false);
  const [returnReason, setReturnReason] = useState('');
  const [returnError, setReturnError] = useState(null);
  const [showReturnForm, setShowReturnForm] = useState(false);

  const LIMIT = 20;

  // ── Fetch list ──────────────────────────────────────────────────────────────
  const fetchList = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = {
        page,
        limit: LIMIT,
        ...presetDates(datePreset),
      };
      if (search.trim()) params.search = search.trim();
      if (statusFilter)  params.status = statusFilter;

      const res = await api.get('/billing/invoices', { params });
      setInvoices(res.data.items);
      setTotal(res.data.total);
    } catch (err) {
      setLoadError(err.response?.data?.detail || 'Failed to load invoices');
    } finally {
      setLoading(false);
    }
  }, [page, datePreset, search, statusFilter]);

  useEffect(() => { fetchList(); }, [fetchList]);

  // Reset to page 1 when filters change
  useEffect(() => { setPage(1); }, [datePreset, search, statusFilter]);

  // ── Open detail modal ───────────────────────────────────────────────────────
  async function openDetail(invoiceNumber) {
    setSelectedNum(invoiceNumber);
    setDetail(null);
    setDetailLoading(true);
    setShowReturnForm(false);
    setReturnReason('');
    setReturnError(null);
    try {
      const res = await api.get(`/billing/invoices/${invoiceNumber}`);
      setDetail(res.data);
    } catch (err) {
      setDetail({ error: err.response?.data?.detail || 'Failed to load invoice' });
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setSelectedNum(null);
    setDetail(null);
    setShowReturnForm(false);
  }

  // ── Process return ──────────────────────────────────────────────────────────
  async function processReturn() {
    if (!detail || returning) return;
    setReturning(true);
    setReturnError(null);
    try {
      const res = await api.post(`/billing/invoices/${detail.invoice_number}/return`, {
        reason: returnReason || null,
      });
      setDetail(res.data);     // update modal with returned status
      setShowReturnForm(false);
      fetchList();             // refresh list to show new status
    } catch (err) {
      setReturnError(err.response?.data?.detail || 'Return failed');
    } finally {
      setReturning(false);
    }
  }

  const totalPages = Math.ceil(total / LIMIT);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, marginBottom: 20 }}>
        Invoice History
      </h1>

      {/* ── Filter bar ── */}
      <div className="card" style={{ padding: '14px 18px', marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>

          {/* Date presets */}
          <div style={{ display: 'flex', gap: 4 }}>
            {[
              { key: 'today', label: 'Today' },
              { key: 'week',  label: 'This Week' },
              { key: 'month', label: 'This Month' },
              { key: 'all',   label: 'All' },
            ].map(p => (
              <button
                key={p.key}
                onClick={() => setDatePreset(p.key)}
                style={{
                  padding: '6px 14px', fontSize: 13, fontWeight: 600,
                  background: datePreset === p.key ? 'var(--brand)' : 'var(--bg)',
                  color:      datePreset === p.key ? '#fff' : 'var(--text)',
                  border: `1px solid ${datePreset === p.key ? 'var(--brand)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius)',
                }}>
                {p.label}
              </button>
            ))}
          </div>

          {/* Status filter */}
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            style={{ width: 'auto', padding: '6px 10px', fontSize: 13 }}>
            <option value="">All Statuses</option>
            <option value="COMPLETED">Completed</option>
            <option value="RETURNED">Returned</option>
          </select>

          {/* Search box */}
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search invoice no. or patient…"
            style={{ flex: 1, minWidth: 180, fontSize: 13, padding: '6px 10px' }}
          />
        </div>
      </div>

      {/* ── Invoice table ── */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            Loading…
          </div>
        ) : loadError ? (
          <div style={{ padding: 20, color: 'var(--danger)' }}>{loadError}</div>
        ) : invoices.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            No invoices found for the selected filters.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
                {['Invoice No.', 'Date', 'Patient', 'Items', 'Total', 'Payment', 'Status'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, fontSize: 13 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoices.map(inv => (
                <tr
                  key={inv.invoice_number}
                  onClick={() => openDetail(inv.invoice_number)}
                  style={{
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                    background: selectedNum === inv.invoice_number ? 'rgba(99,102,241,0.08)' : 'transparent',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => { if (selectedNum !== inv.invoice_number) e.currentTarget.style.background = 'var(--bg)'; }}
                  onMouseLeave={e => { if (selectedNum !== inv.invoice_number) e.currentTarget.style.background = 'transparent'; }}>
                  <td style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--brand)' }}>
                    {inv.invoice_number}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 13 }}>
                    {fmtDate(inv.invoice_date)}
                  </td>
                  <td style={{ padding: '10px 14px' }}>{inv.patient_name}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'center' }}>{inv.item_count}</td>
                  <td style={{ padding: '10px 14px', fontWeight: 600 }}>{inr(inv.total_amount)}</td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-muted)' }}>{inv.payment_method}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <StatusBadge status={inv.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16, alignItems: 'center' }}>
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            style={{ padding: '6px 14px', fontSize: 13, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            ← Prev
          </button>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Page {page} of {totalPages}  ({total} invoices)
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            style={{ padding: '6px 14px', fontSize: 13, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            Next →
          </button>
        </div>
      )}

      {/* ===== DETAIL MODAL ===== */}
      {selectedNum && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}
          onClick={e => { if (e.target === e.currentTarget) closeDetail(); }}>
          <div style={{
            width: '90%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', padding: 28,
            background: 'rgba(255,255,255,0.65)',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            border: '1px solid rgba(255,255,255,0.80)',
            borderRadius: 16,
            boxShadow: '0 20px 60px rgba(99,102,241,0.12)',
          }}>
            {detailLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                Loading…
              </div>
            ) : detail?.error ? (
              <div style={{ color: 'var(--danger)' }}>{detail.error}</div>
            ) : detail ? (
              <>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, color: 'var(--brand)' }}>
                      {detail.invoice_number}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                      {fmtDate(detail.invoice_date)}
                    </div>
                    <div style={{ fontSize: 14, marginTop: 4 }}>
                      {detail.patient_name}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                    <StatusBadge status={detail.status} />
                    <button
                      onClick={closeDetail}
                      style={{ background: 'transparent', border: 'none', fontSize: 22, color: 'var(--text-muted)', cursor: 'pointer', lineHeight: 1 }}>
                      ×
                    </button>
                  </div>
                </div>

                {/* Items table */}
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      <th style={{ padding: '6px 6px', textAlign: 'left' }}>Product</th>
                      <th style={{ padding: '6px 6px', textAlign: 'right' }}>Qty</th>
                      <th style={{ padding: '6px 6px', textAlign: 'right' }}>Price</th>
                      <th style={{ padding: '6px 6px', textAlign: 'right' }}>GST</th>
                      <th style={{ padding: '6px 6px', textAlign: 'right' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((item, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '6px 6px' }}>
                          <div>{item.product_name}</div>
                          {item.batch_number && (
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              Batch: {item.batch_number}
                            </div>
                          )}
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            HSN rate: {item.gst_rate}%
                          </div>
                        </td>
                        <td style={{ padding: '6px 6px', textAlign: 'right' }}>{item.quantity}</td>
                        <td style={{ padding: '6px 6px', textAlign: 'right' }}>{inr(item.taxable_amount)}</td>
                        <td style={{ padding: '6px 6px', textAlign: 'right', color: 'var(--text-muted)' }}>
                          {inr(item.gst_amount)}
                        </td>
                        <td style={{ padding: '6px 6px', textAlign: 'right', fontWeight: 600 }}>
                          {inr(item.line_total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Totals */}
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, fontSize: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Subtotal</span>
                    <span>{inr(detail.subtotal)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: 'var(--text-muted)' }}>GST</span>
                    <span>{inr(detail.gst_amount)}</span>
                  </div>
                  {parseFloat(detail.discount_amount) > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ color: 'var(--text-muted)' }}>Discount</span>
                      <span>- {inr(detail.discount_amount)}</span>
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontWeight: 700, fontSize: 16 }}>
                    <span>Total</span>
                    <span style={{ color: 'var(--brand)' }}>{inr(detail.total_amount)}</span>
                  </div>
                  <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 13 }}>
                    Payment: <strong style={{ color: 'var(--text)' }}>{detail.payment_method}</strong>
                  </div>
                </div>

                {/* Return section */}
                {detail.status === 'COMPLETED' && (
                  <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
                    {!showReturnForm ? (
                      <button
                        onClick={() => setShowReturnForm(true)}
                        style={{
                          background: 'transparent', border: '1px solid var(--danger)',
                          color: 'var(--danger)', borderRadius: 'var(--radius)',
                          padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                        }}>
                        Return Invoice
                      </button>
                    ) : (
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: 'var(--danger)' }}>
                          Confirm Return
                        </div>
                        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
                          This will restore all stock and mark the invoice as RETURNED.
                          This cannot be undone.
                        </p>
                        <textarea
                          value={returnReason}
                          onChange={e => setReturnReason(e.target.value)}
                          placeholder="Return reason (optional)…"
                          rows={2}
                          style={{
                            width: '100%', resize: 'vertical', fontSize: 13,
                            padding: '8px 10px', border: '1px solid var(--border)',
                            borderRadius: 'var(--radius)', fontFamily: 'var(--font-body)',
                          }}
                        />
                        {returnError && (
                          <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 6 }}>
                            {returnError}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                          <button
                            onClick={() => setShowReturnForm(false)}
                            style={{
                              flex: 1, background: 'var(--bg)', border: '1px solid var(--border)',
                              color: 'var(--text)', borderRadius: 'var(--radius)',
                              padding: '8px', fontSize: 13,
                            }}>
                            Cancel
                          </button>
                          <button
                            onClick={processReturn}
                            disabled={returning}
                            style={{
                              flex: 1, background: 'var(--danger)', color: '#fff',
                              border: 'none', borderRadius: 'var(--radius)',
                              padding: '8px', fontSize: 13, fontWeight: 600,
                              cursor: returning ? 'not-allowed' : 'pointer',
                            }}>
                            {returning ? 'Processing…' : 'Confirm Return'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const colors = {
    COMPLETED: { bg: 'var(--ok-bg)',     color: 'var(--ok)' },
    RETURNED:  { bg: 'var(--danger-bg)', color: 'var(--danger)' },
  };
  const c = colors[status] || { bg: 'var(--bg)', color: 'var(--text-muted)' };
  return (
    <span style={{
      background: c.bg, color: c.color,
      padding: '3px 10px', borderRadius: 20,
      fontSize: 12, fontWeight: 600,
    }}>
      {status}
    </span>
  );
}
