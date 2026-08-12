/**
 * Invoice History Page
 *
 * Shows a paginated, filterable table of all invoices.
 * Clicking a row opens a detail modal with full line items.
 * The modal has a per-item return checklist (partial returns).
 *
 * Filters: period tab (Today / Yesterday / This Week / This Month / All)
 *          + text search by invoice number or patient name
 *          + status filter (All / Completed / Partial Return / Returned)
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { formatDateTimeShort } from '../lib/datetime';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inr(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

// Show invoice timestamps in IST (see lib/datetime.js for why).
const fmtDate = formatDateTimeShort;

/**
 * The date-window tabs.
 *
 * ⚠ THE BROWSER NO LONGER WORKS OUT THE DATES.  It used to build a
 * date_from/date_to pair here in JavaScript, which put the definition of "this
 * week" on the PC's own clock and timezone — so on a machine set to anything
 * but IST the window could miss invoices the pharmacist had just created, and
 * "This Week" came back empty.  Now we send the NAME of the period and the
 * server, which is the only thing that knows the timestamps are stored in UTC,
 * turns it into the right window.  (See backend/app/utils/dates.py.)
 */
const PERIODS = [
  { key: 'today',     label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week',      label: 'This Week' },
  { key: 'month',     label: 'This Month' },
  { key: 'all',       label: 'All' },
];

// ─── Main component ───────────────────────────────────────────────────────────

export default function InvoiceHistory() {
  const [period,      setPeriod]      = useState('today');
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
  // Per-line return selection, keyed by invoice_item id:
  //   { [itemId]: { checked: bool, qty: number } }
  const [returnLines, setReturnLines] = useState({});

  const LIMIT = 20;

  // ── Fetch list ──────────────────────────────────────────────────────────────
  const fetchList = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Send the period NAME, not a computed date range — the server owns the
      // definition of "this week" because it owns the timezone (see PERIODS).
      const params = { page, limit: LIMIT, period };
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
  }, [page, period, search, statusFilter]);

  useEffect(() => { fetchList(); }, [fetchList]);

  // Reset to page 1 when filters change
  useEffect(() => { setPage(1); }, [period, search, statusFilter]);

  /**
   * Start every returnable line unchecked with its full remaining quantity
   * pre-filled.  Unchecked-by-default is deliberate: a return is usually ONE
   * item off the bill, and a checklist that arrives all-ticked invites someone
   * to hit Confirm and put four medicines the customer still has back on the
   * shelf as sellable stock.
   */
  function buildReturnLines(invoice) {
    const lines = {};
    (invoice.items || []).forEach((item) => {
      const remaining = item.quantity - (item.returned_qty || 0);
      if (remaining > 0) lines[item.id] = { checked: false, qty: remaining };
    });
    return lines;
  }

  // ── Open detail modal ───────────────────────────────────────────────────────
  async function openDetail(invoiceNumber) {
    setSelectedNum(invoiceNumber);
    setDetail(null);
    setDetailLoading(true);
    setShowReturnForm(false);
    setReturnReason('');
    setReturnError(null);
    setReturnLines({});
    try {
      const res = await api.get(`/billing/invoices/${invoiceNumber}`);
      setDetail(res.data);
      setReturnLines(buildReturnLines(res.data));
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
    setReturnLines({});
  }

  /** Tick / untick one line. */
  function toggleLine(itemId) {
    setReturnLines((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], checked: !prev[itemId]?.checked },
    }));
  }

  /** Change the quantity on one line, clamped to 1..remaining. */
  function setLineQty(itemId, raw, max) {
    const n = Math.max(1, Math.min(Number(max), Number(raw) || 1));
    setReturnLines((prev) => ({
      ...prev,
      // Typing a quantity implies you want the line — tick it automatically so
      // a filled-in box can never be silently ignored on submit.
      [itemId]: { checked: true, qty: n },
    }));
  }

  /**
   * The refund preview, computed the SAME way the backend computes the real
   * refund (billing_service._refund_for): each line's share of its own
   * line_total, less its share of any bill-level discount.
   *
   * ⚠ If you change one, change the other — a preview that disagrees with the
   * money actually refunded is worse than no preview.
   * The home visit charge is not refundable (the pharmacist already travelled),
   * so it is not in here either.
   */
  const refundPreview = useMemo(() => {
    if (!detail?.items) return 0;
    const itemsGross = detail.items.reduce((s, it) => s + Number(it.line_total || 0), 0);
    const discount   = Number(detail.discount_amount || 0);

    return detail.items.reduce((sum, item) => {
      const line = returnLines[item.id];
      if (!line?.checked || !item.quantity) return sum;
      let gross = Number(item.line_total) * line.qty / item.quantity;
      if (discount > 0 && itemsGross > 0) gross -= discount * gross / itemsGross;
      return sum + gross;
    }, 0);
  }, [detail, returnLines]);

  const selectedCount = Object.values(returnLines).filter((l) => l.checked).length;

  // ── Process return ──────────────────────────────────────────────────────────
  async function processReturn() {
    if (!detail || returning) return;

    const items = Object.entries(returnLines)
      .filter(([, line]) => line.checked && line.qty > 0)
      .map(([id, line]) => ({ invoice_item_id: Number(id), return_qty: line.qty }));

    if (items.length === 0) {
      setReturnError('Tick at least one item to return.');
      return;
    }

    setReturning(true);
    setReturnError(null);
    try {
      const res = await api.post(`/billing/invoices/${detail.invoice_number}/return`, {
        items,
        reason: returnReason || null,
      });
      setDetail(res.data);                       // updated status + returned_qty
      setReturnLines(buildReturnLines(res.data)); // remaining quantities shrink
      setShowReturnForm(false);
      fetchList();                                // refresh list to show new status
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

          {/* Period tabs */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {PERIODS.map(p => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                style={{
                  padding: '6px 14px', fontSize: 13, fontWeight: 600,
                  background: period === p.key ? 'var(--brand)' : 'var(--bg)',
                  color:      period === p.key ? '#fff' : 'var(--text)',
                  border: `1px solid ${period === p.key ? 'var(--brand)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius)',
                  cursor: 'pointer',
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
            <option value="PARTIAL_RETURN">Partial Return</option>
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
                          {item.returned_qty > 0 && (
                            <div style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 600 }}>
                              {item.returned_qty} returned
                            </div>
                          )}
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

                {/* ── Return section ──────────────────────────────────────
                    Shown while ANY line still has unreturned units, so a
                    partly-returned invoice can be returned again later. */}
                {detail.status !== 'RETURNED' && Object.keys(returnLines).length > 0 && (
                  <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
                    {!showReturnForm ? (
                      <button
                        onClick={() => setShowReturnForm(true)}
                        style={{
                          background: 'transparent', border: '1px solid var(--danger)',
                          color: 'var(--danger)', borderRadius: 'var(--radius)',
                          padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                        }}>
                        Return Items
                      </button>
                    ) : (
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, color: 'var(--danger)' }}>
                          Return Items — {detail.invoice_number}
                        </div>
                        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 12 }}>
                          Tick only what the customer is handing back. Stock goes
                          back to the same batch it was sold from. This cannot be undone.
                        </p>

                        {/* ── The checklist ─────────────────────────────── */}
                        <div style={{
                          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                          overflow: 'hidden', marginBottom: 12,
                        }}>
                          {detail.items.map((item) => {
                            const remaining = item.quantity - (item.returned_qty || 0);
                            const line = returnLines[item.id];

                            // A fully returned line still shows, greyed out, so
                            // the pharmacist can see it was already handled
                            // rather than wondering where it went.
                            if (remaining <= 0) {
                              return (
                                <div key={item.id} style={{
                                  padding: '10px 12px', fontSize: 13,
                                  borderBottom: '1px solid var(--border)',
                                  color: 'var(--text-muted)', background: 'var(--bg)',
                                }}>
                                  <span style={{ textDecoration: 'line-through' }}>{item.product_name}</span>
                                  {' '}— already returned in full ({item.quantity})
                                </div>
                              );
                            }

                            return (
                              <div key={item.id} style={{
                                padding: '10px 12px',
                                borderBottom: '1px solid var(--border)',
                                background: line?.checked ? 'rgba(225,29,72,0.05)' : 'transparent',
                              }}>
                                <label style={{
                                  display: 'flex', alignItems: 'flex-start', gap: 10,
                                  cursor: 'pointer', fontSize: 13,
                                }}>
                                  <input
                                    type="checkbox"
                                    checked={Boolean(line?.checked)}
                                    onChange={() => toggleLine(item.id)}
                                    style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0, cursor: 'pointer' }}
                                  />
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                                      <strong>{item.product_name}</strong>
                                      <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                                        {inr(item.line_total)}
                                      </span>
                                    </div>
                                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                                      {item.batch_number ? `Batch: ${item.batch_number} · ` : ''}
                                      {item.quantity} sold
                                      {item.returned_qty > 0 && ` · ${item.returned_qty} already returned`}
                                    </div>
                                  </div>
                                </label>

                                {line?.checked && (
                                  <div style={{
                                    display: 'flex', alignItems: 'center', gap: 8,
                                    marginTop: 8, marginLeft: 26, fontSize: 12.5,
                                  }}>
                                    <span style={{ color: 'var(--text-muted)' }}>Return qty:</span>
                                    <input
                                      type="number"
                                      min={1}
                                      max={remaining}
                                      value={line.qty}
                                      onChange={(e) => setLineQty(item.id, e.target.value, remaining)}
                                      style={{
                                        width: 72, padding: '4px 8px', fontSize: 13,
                                        border: '1px solid var(--border)', borderRadius: 6,
                                      }}
                                    />
                                    <span style={{ color: 'var(--text-hint)' }}>(max: {remaining})</span>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <textarea
                          value={returnReason}
                          onChange={e => setReturnReason(e.target.value)}
                          placeholder="Return reason (optional)…"
                          rows={2}
                          style={{
                            width: '100%', resize: 'vertical', fontSize: 13,
                            padding: '8px 10px', border: '1px solid var(--border)',
                            borderRadius: 'var(--radius)', fontFamily: 'var(--font-body)',
                            boxSizing: 'border-box',
                          }}
                        />

                        {/* Refund preview — the selected lines only */}
                        <div style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                          marginTop: 12, fontSize: 14,
                        }}>
                          <span style={{ color: 'var(--text-muted)' }}>
                            Refund amount{selectedCount > 0 ? ` (${selectedCount} item${selectedCount === 1 ? '' : 's'})` : ''}
                          </span>
                          <strong style={{ fontSize: 16, color: 'var(--danger)' }}>
                            {inr(refundPreview)}
                          </strong>
                        </div>
                        {Number(detail.home_visit_charge) > 0 && (
                          <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 2 }}>
                            Home visit charge of {inr(detail.home_visit_charge)} is not refunded —
                            the visit already happened.
                          </div>
                        )}

                        {returnError && (
                          <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>
                            {returnError}
                          </div>
                        )}

                        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                          <button
                            onClick={() => setShowReturnForm(false)}
                            style={{
                              flex: 1, background: 'var(--bg)', border: '1px solid var(--border)',
                              color: 'var(--text)', borderRadius: 'var(--radius)',
                              padding: '8px', fontSize: 13, cursor: 'pointer',
                            }}>
                            Cancel
                          </button>
                          <button
                            onClick={processReturn}
                            disabled={returning || selectedCount === 0}
                            style={{
                              flex: 1, background: 'var(--danger)', color: '#fff',
                              border: 'none', borderRadius: 'var(--radius)',
                              padding: '8px', fontSize: 13, fontWeight: 600,
                              opacity: selectedCount === 0 ? 0.5 : 1,
                              cursor: (returning || selectedCount === 0) ? 'not-allowed' : 'pointer',
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
    COMPLETED:      { bg: 'var(--ok-bg)',     color: 'var(--ok)',     label: 'COMPLETED' },
    // Amber, not red: some of this sale is still good and still counts as
    // revenue.  Treating it as a full return visually would misread the day.
    PARTIAL_RETURN: { bg: 'var(--warn-bg)',   color: 'var(--warn)',   label: 'PARTIAL RETURN' },
    RETURNED:       { bg: 'var(--danger-bg)', color: 'var(--danger)', label: 'RETURNED' },
  };
  const c = colors[status] || { bg: 'var(--bg)', color: 'var(--text-muted)', label: status };
  return (
    <span style={{
      background: c.bg, color: c.color,
      padding: '3px 10px', borderRadius: 20,
      fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {c.label}
    </span>
  );
}
