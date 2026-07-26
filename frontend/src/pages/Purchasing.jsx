/**
 * Purchasing page — Phase 2, Step 2.
 *
 * Three tabs:
 *   1. Purchase Orders — create POs, view status, update status
 *   2. Receive Stock (GRN) — record actual stock arriving, creates batches
 *   3. History — searchable lists of all POs and GRNs
 *
 * Business rules enforced here:
 *   - A PO does NOT affect stock.  Only a GRN does.
 *   - Margin % is shown live as the user types purchase/selling prices.
 *   - Line totals are auto-computed.
 *   - RECEIVED / PARTIALLY_RECEIVED are set by the backend, not selectable manually.
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { getTodayIST } from '../lib/datetime';

// ---------------------------------------------------------------------------
// Currency formatting (Indian format with ₹)
// ---------------------------------------------------------------------------

function formatINR(amount) {
  if (amount == null || amount === '') return '—';
  return Number(amount).toLocaleString('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 2,
  });
}

// ---------------------------------------------------------------------------
// Status badge colors
// ---------------------------------------------------------------------------

const STATUS_BADGE = {
  DRAFT:               'badge-neutral',
  SENT:                'badge-info',
  PARTIALLY_RECEIVED:  'badge-warn',
  RECEIVED:            'badge-ok',
  CANCELLED:           'badge-danger',
};

function StatusBadge({ status }) {
  return <span className={STATUS_BADGE[status] ?? 'badge-neutral'}>{status?.replace('_', ' ')}</span>;
}

// ---------------------------------------------------------------------------
// Small reusable label + input
// ---------------------------------------------------------------------------

function Field({ label, required, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{
        fontSize: 11, fontWeight: 600, color: '#6b7280',
        textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>
        {label}
        {required && <span style={{ color: '#e11d48', marginLeft: 2 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ─── TAB 1: PURCHASE ORDERS ─────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/** Modal for creating a new Purchase Order */
function NewPOModal({ suppliers, products, onClose, onSaved }) {
  const [supplierId,    setSupplierId]    = useState('');
  const [expectedDate,  setExpectedDate]  = useState('');
  const [notes,         setNotes]         = useState('');
  const [lines,         setLines]         = useState([{ product_id: '', qty: '', unit_price: '' }]);
  const [saving,        setSaving]        = useState(false);
  const [error,         setError]         = useState('');

  function addLine() {
    setLines(prev => [...prev, { product_id: '', qty: '', unit_price: '' }]);
  }

  function removeLine(idx) {
    setLines(prev => prev.filter((_, i) => i !== idx));
  }

  function updateLine(idx, field, value) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  }

  function lineTotal(line) {
    const q = parseFloat(line.qty);
    const p = parseFloat(line.unit_price);
    return (!isNaN(q) && !isNaN(p)) ? (q * p).toFixed(2) : null;
  }

  const grandTotal = lines.reduce((sum, l) => {
    const t = lineTotal(l);
    return sum + (t ? parseFloat(t) : 0);
  }, 0);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!supplierId) { setError('Please select a supplier.'); return; }
    if (lines.some(l => !l.product_id || !l.qty || !l.unit_price)) {
      setError('All line item fields are required.'); return;
    }
    const payload = {
      supplier_id:   parseInt(supplierId),
      expected_date: expectedDate || null,
      notes:         notes || null,
      items: lines.map(l => ({
        product_id:       parseInt(l.product_id),
        quantity_ordered: parseInt(l.qty),
        unit_price:       parseFloat(l.unit_price),
      })),
    };
    setSaving(true);
    try {
      await api.post('/purchasing/orders', payload);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.detail ?? 'Failed to create PO. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(30,27,75,0.35)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.75)', borderRadius: 18,
        padding: '28px 32px', width: '100%', maxWidth: 760,
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1e1b4b', margin: 0 }}>New Purchase Order</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af' }}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Field label="Supplier" required>
              <select value={supplierId} onChange={e => setSupplierId(e.target.value)} required>
                <option value="">Select supplier…</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Expected Delivery Date">
              <input type="date" value={expectedDate} onChange={e => setExpectedDate(e.target.value)} />
            </Field>
          </div>

          <Field label="Notes">
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ resize: 'vertical' }} />
          </Field>

          {/* Line items */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Line Items
              </span>
              <button type="button" onClick={addLine} className="btn-secondary" style={{ fontSize: 12, padding: '5px 12px' }}>
                + Add Item
              </button>
            </div>

            {/* Header row */}
            <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr 1.5fr 1.5fr 32px', gap: 8, marginBottom: 6 }}>
              {['Product', 'Qty', 'Unit Price (₹)', 'Line Total', ''].map(h => (
                <span key={h} style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{h}</span>
              ))}
            </div>

            {lines.map((line, idx) => (
              <div key={idx} style={{ display: 'grid', gridTemplateColumns: '3fr 1fr 1.5fr 1.5fr 32px', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                <select value={line.product_id} onChange={e => updateLine(idx, 'product_id', e.target.value)}>
                  <option value="">Select product…</option>
                  {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input type="number" min="1" placeholder="Qty" value={line.qty} onChange={e => updateLine(idx, 'qty', e.target.value)} />
                <input type="number" min="0.01" step="0.01" placeholder="0.00" value={line.unit_price} onChange={e => updateLine(idx, 'unit_price', e.target.value)} />
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1e1b4b', display: 'flex', alignItems: 'center' }}>
                  {lineTotal(line) != null ? `₹${parseFloat(lineTotal(line)).toLocaleString('en-IN')}` : '—'}
                </div>
                <button type="button" onClick={() => removeLine(idx)} disabled={lines.length === 1}
                  style={{ background: 'none', border: 'none', color: '#e11d48', fontSize: 18, cursor: lines.length === 1 ? 'not-allowed' : 'pointer', padding: 0, opacity: lines.length === 1 ? 0.3 : 1 }}>
                  ×
                </button>
              </div>
            ))}

            <div style={{ textAlign: 'right', paddingTop: 12, borderTop: '1px solid rgba(0,0,0,0.06)', marginTop: 8 }}>
              <span style={{ fontSize: 13, color: '#6b7280', marginRight: 8 }}>Grand Total:</span>
              <span style={{ fontSize: 17, fontWeight: 700, color: '#1e1b4b' }}>
                {formatINR(grandTotal)}
              </span>
            </div>
          </div>

          {error && <div style={{ color: '#e11d48', fontSize: 13, padding: '8px 12px', background: 'rgba(244,63,94,0.08)', borderRadius: 8 }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 8 }}>
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Creating…' : 'Create PO'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

/** PO Detail modal — shows full info + allows status update */
function PODetailModal({ po, onClose, onStatusChanged, onReceiveAgainst }) {
  const [newStatus, setNewStatus] = useState('');
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');

  // Which statuses can be manually set from the UI for this PO's current status
  const MANUAL_TRANSITIONS = {
    DRAFT:               ['SENT', 'CANCELLED'],
    SENT:                ['CANCELLED'],
    PARTIALLY_RECEIVED:  ['CANCELLED'],
    RECEIVED:            [],
    CANCELLED:           [],
  };
  const allowed = MANUAL_TRANSITIONS[po.status] ?? [];

  async function applyStatus() {
    if (!newStatus) return;
    setSaving(true);
    setError('');
    try {
      await api.patch(`/purchasing/orders/${po.id}/status`, { status: newStatus });
      onStatusChanged();
    } catch (err) {
      setError(err.response?.data?.detail ?? 'Failed to update status.');
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(30,27,75,0.35)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.75)', borderRadius: 18,
        padding: '28px 32px', width: '100%', maxWidth: 700,
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1e1b4b', margin: '0 0 4px' }}>{po.po_number}</h2>
            <StatusBadge status={po.status} />
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af' }}>×</button>
        </div>

        {/* Meta */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 20 }}>
          {[
            ['Supplier', po.supplier_name],
            ['Order Date', po.order_date],
            ['Expected', po.expected_date ?? '—'],
            ['Total', formatINR(po.total_amount)],
          ].map(([k, v]) => (
            <div key={k}>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 2 }}>{k}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#1e1b4b' }}>{v}</div>
            </div>
          ))}
        </div>

        {po.notes && (
          <div style={{ marginBottom: 16, padding: '10px 14px', background: 'rgba(99,102,241,0.07)', borderRadius: 8, fontSize: 13, color: '#4b5563' }}>
            {po.notes}
          </div>
        )}

        {/* Items table */}
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
          <thead>
            <tr>
              {['Product', 'Qty Ordered', 'Unit Price', 'Line Total'].map(h => (
                <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.07em', paddingBottom: 8, borderBottom: '1px solid rgba(0,0,0,0.06)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {po.items?.map((item, i) => (
              <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                <td style={{ padding: '9px 0', fontSize: 13, color: '#1e1b4b', fontWeight: 500 }}>{item.product_name}</td>
                <td style={{ padding: '9px 8px', fontSize: 13, color: '#374151' }}>{item.quantity_ordered}</td>
                <td style={{ padding: '9px 8px', fontSize: 13, color: '#374151' }}>{formatINR(item.unit_price)}</td>
                <td style={{ padding: '9px 8px', fontSize: 13, fontWeight: 600, color: '#1e1b4b' }}>{formatINR(item.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Status update + Receive button */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {allowed.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select value={newStatus} onChange={e => setNewStatus(e.target.value)} style={{ minWidth: 160 }}>
                <option value="">Update status…</option>
                {allowed.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <button className="btn-secondary" onClick={applyStatus} disabled={!newStatus || saving} style={{ whiteSpace: 'nowrap' }}>
                {saving ? 'Saving…' : 'Apply'}
              </button>
            </div>
          )}
          {po.status !== 'CANCELLED' && po.status !== 'RECEIVED' && (
            <button
              className="btn-primary"
              onClick={() => onReceiveAgainst(po)}
              style={{ marginLeft: allowed.length > 0 ? 'auto' : undefined }}
            >
              Receive Against This PO →
            </button>
          )}
        </div>

        {error && <div style={{ color: '#e11d48', fontSize: 12, marginTop: 10 }}>{error}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// ─── TAB 2: RECEIVE STOCK (GRN) ─────────────────────────────────────────────
// ---------------------------------------------------------------------------

function GRNForm({ suppliers, products, pos, prefillPoId, onSaved }) {
  const today = getTodayIST();

  const [supplierId,     setSupplierId]     = useState('');
  const [poId,           setPoId]           = useState(prefillPoId ? String(prefillPoId) : '');
  const [receiptDate,    setReceiptDate]    = useState(today);
  const [invoiceNumber,  setInvoiceNumber]  = useState('');
  const [notes,          setNotes]          = useState('');
  const [lines,          setLines]          = useState([emptyLine()]);
  const [saving,         setSaving]         = useState(false);
  const [error,          setError]          = useState('');
  const [successMsg,     setSuccessMsg]     = useState('');

  // Pre-fill supplier when PO is selected
  useEffect(() => {
    if (prefillPoId) {
      const po = pos.find(p => p.id === prefillPoId);
      if (po) setSupplierId(String(po.supplier_id ?? ''));
    }
  }, [prefillPoId, pos]);

  function emptyLine() {
    return { product_id: '', qty: '', purchase_price: '', selling_price: '', mrp: '', mfg_date: '', expiry_date: '', batch_number: '' };
  }

  function addLine() {
    setLines(prev => [...prev, emptyLine()]);
  }

  function removeLine(idx) {
    setLines(prev => prev.filter((_, i) => i !== idx));
  }

  function updateLine(idx, field, value) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  }

  function lineTotal(line) {
    const q = parseFloat(line.qty);
    const p = parseFloat(line.purchase_price);
    return (!isNaN(q) && !isNaN(p)) ? q * p : null;
  }

  function margin(line) {
    const buy  = parseFloat(line.purchase_price);
    const sell = parseFloat(line.selling_price);
    if (!isNaN(buy) && !isNaN(sell) && buy > 0) {
      return (((sell - buy) / buy) * 100).toFixed(1);
    }
    return null;
  }

  const grandTotal = lines.reduce((sum, l) => {
    const t = lineTotal(l);
    return sum + (t != null ? t : 0);
  }, 0);

  // Filter POs by supplier if one is selected
  const filteredPos = supplierId
    ? pos.filter(p => String(p.supplier_id) === supplierId && p.status !== 'CANCELLED' && p.status !== 'RECEIVED')
    : pos.filter(p => p.status !== 'CANCELLED' && p.status !== 'RECEIVED');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccessMsg('');

    if (!supplierId) { setError('Please select a supplier.'); return; }
    if (lines.some(l => !l.product_id || !l.qty || !l.purchase_price || !l.selling_price || !l.mrp || !l.expiry_date)) {
      setError('Product, Qty, Purchase Price, Selling Price, MRP, and Expiry Date are required for each line.'); return;
    }

    const payload = {
      supplier_id:    parseInt(supplierId),
      po_id:          poId ? parseInt(poId) : null,
      receipt_date:   receiptDate || null,
      invoice_number: invoiceNumber || null,
      notes:          notes || null,
      items: lines.map(l => ({
        product_id:        parseInt(l.product_id),
        quantity_received: parseInt(l.qty),
        purchase_price:    parseFloat(l.purchase_price),
        selling_price:     parseFloat(l.selling_price),
        mrp:               parseFloat(l.mrp),
        expiry_date:       l.expiry_date,
        mfg_date:          l.mfg_date || null,
        batch_number:      l.batch_number || null,
      })),
    };

    setSaving(true);
    try {
      const { data } = await api.post('/purchasing/grn', payload);
      setSuccessMsg(`Stock received. GRN: ${data.grn_number}. ${data.items.length} batch(es) added to inventory.`);
      // Reset form
      setSupplierId(''); setPoId(''); setReceiptDate(today);
      setInvoiceNumber(''); setNotes(''); setLines([emptyLine()]);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.detail ?? 'Failed to create GRN. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {successMsg && (
        <div style={{ padding: '12px 16px', background: 'rgba(5,150,105,0.1)', border: '1px solid rgba(5,150,105,0.25)', borderRadius: 10, color: '#065f46', fontSize: 13, fontWeight: 500 }}>
          ✓ {successMsg}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        <Field label="Supplier" required>
          <select value={supplierId} onChange={e => { setSupplierId(e.target.value); setPoId(''); }} required>
            <option value="">Select supplier…</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="PO Reference (optional)">
          <select value={poId} onChange={e => setPoId(e.target.value)}>
            <option value="">Direct / Walk-in purchase</option>
            {filteredPos.map(p => <option key={p.id} value={p.id}>{p.po_number} ({p.supplier_name})</option>)}
          </select>
        </Field>
        <Field label="Receipt Date" required>
          <input type="date" value={receiptDate} onChange={e => setReceiptDate(e.target.value)} required />
        </Field>
        <Field label="Supplier Invoice Number">
          <input type="text" placeholder="INV-12345" value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} />
        </Field>
        <Field label="Notes" >
          <input type="text" value={notes} onChange={e => setNotes(e.target.value)} />
        </Field>
      </div>

      {/* Line items */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Items Received
          </span>
          <button type="button" onClick={addLine} className="btn-secondary" style={{ fontSize: 12, padding: '5px 12px' }}>
            + Add Item
          </button>
        </div>

        {lines.map((line, idx) => {
          const m = margin(line);
          const lt = lineTotal(line);
          return (
            <div key={idx} style={{
              background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(255,255,255,0.8)',
              borderRadius: 12, padding: '16px', marginBottom: 12,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Item {idx + 1}</span>
                <button type="button" onClick={() => removeLine(idx)} disabled={lines.length === 1}
                  style={{ background: 'none', border: 'none', color: '#e11d48', fontSize: 13, cursor: lines.length === 1 ? 'not-allowed' : 'pointer', opacity: lines.length === 1 ? 0.3 : 1 }}>
                  Remove
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                <Field label="Product" required>
                  <select value={line.product_id} onChange={e => updateLine(idx, 'product_id', e.target.value)}>
                    <option value="">Select product…</option>
                    {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Field>
                <Field label="Qty Received" required>
                  <input type="number" min="1" placeholder="0" value={line.qty} onChange={e => updateLine(idx, 'qty', e.target.value)} />
                </Field>
                <Field label="Purchase Price ₹" required>
                  <input type="number" min="0.01" step="0.01" placeholder="0.00" value={line.purchase_price} onChange={e => updateLine(idx, 'purchase_price', e.target.value)} />
                </Field>
                <Field label={
                  <span>
                    Selling Price ₹{' '}
                    {m !== null && (
                      <span style={{ color: parseFloat(m) >= 0 ? '#059669' : '#e11d48', fontWeight: 700 }}>
                        ({m}%)
                      </span>
                    )}
                  </span>
                } required>
                  <input type="number" min="0.01" step="0.01" placeholder="0.00" value={line.selling_price} onChange={e => updateLine(idx, 'selling_price', e.target.value)} />
                </Field>
                <Field label="MRP ₹" required>
                  <input type="number" min="0.01" step="0.01" placeholder="0.00" value={line.mrp} onChange={e => updateLine(idx, 'mrp', e.target.value)} />
                </Field>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.5fr 1fr', gap: 10, alignItems: 'end' }}>
                <Field label="Mfg Date">
                  <input type="date" value={line.mfg_date} onChange={e => updateLine(idx, 'mfg_date', e.target.value)} />
                </Field>
                <Field label="Expiry Date" required>
                  <input type="date" value={line.expiry_date} onChange={e => updateLine(idx, 'expiry_date', e.target.value)} />
                </Field>
                <Field label="Batch Number">
                  <input type="text" placeholder="BATCH-001" value={line.batch_number} onChange={e => updateLine(idx, 'batch_number', e.target.value)} />
                </Field>
                <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>Line Total</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#1e1b4b', marginLeft: 'auto' }}>
                    {lt != null ? formatINR(lt) : '—'}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        <div style={{ textAlign: 'right', paddingTop: 10, borderTop: '1px solid rgba(0,0,0,0.06)' }}>
          <span style={{ fontSize: 13, color: '#6b7280', marginRight: 8 }}>Grand Total:</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: '#1e1b4b' }}>{formatINR(grandTotal)}</span>
        </div>
      </div>

      {error && <div style={{ color: '#e11d48', fontSize: 13, padding: '8px 12px', background: 'rgba(244,63,94,0.08)', borderRadius: 8 }}>{error}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Receive Stock'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// ─── TAB 3: HISTORY ──────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

function GRNDetailModal({ grn, onClose }) {
  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(30,27,75,0.35)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.75)', borderRadius: 18,
        padding: '28px 32px', width: '100%', maxWidth: 760,
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1e1b4b', margin: '0 0 4px' }}>{grn.grn_number}</h2>
            <span style={{ fontSize: 12, color: '#6b7280' }}>
              {grn.supplier_name} · {grn.receipt_date}
              {grn.po_number && <> · PO: {grn.po_number}</>}
            </span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af' }}>×</button>
        </div>

        {grn.invoice_number && (
          <div style={{ marginBottom: 12, fontSize: 13, color: '#6b7280' }}>
            Supplier Invoice: <strong style={{ color: '#1e1b4b' }}>{grn.invoice_number}</strong>
          </div>
        )}

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Product', 'Batch', 'Qty', 'Purchase', 'Selling', 'MRP', 'Expiry', 'Total'].map(h => (
                <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.07em', paddingBottom: 8, borderBottom: '1px solid rgba(0,0,0,0.06)', paddingRight: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grn.items?.map((item, i) => (
              <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                <td style={{ padding: '9px 12px 9px 0', fontSize: 13, fontWeight: 500, color: '#1e1b4b' }}>{item.product_name}</td>
                <td style={{ padding: '9px 12px 9px 0', fontSize: 12, color: '#6b7280' }}>{item.batch_number ?? '—'}</td>
                <td style={{ padding: '9px 12px 9px 0', fontSize: 13 }}>{item.quantity_received}</td>
                <td style={{ padding: '9px 12px 9px 0', fontSize: 13 }}>{formatINR(item.purchase_price)}</td>
                <td style={{ padding: '9px 12px 9px 0', fontSize: 13 }}>{formatINR(item.selling_price)}</td>
                <td style={{ padding: '9px 12px 9px 0', fontSize: 13 }}>{formatINR(item.mrp)}</td>
                <td style={{ padding: '9px 12px 9px 0', fontSize: 13 }}>{item.expiry_date}</td>
                <td style={{ padding: '9px 0', fontSize: 13, fontWeight: 600, color: '#1e1b4b' }}>{formatINR(item.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ textAlign: 'right', paddingTop: 12, borderTop: '1px solid rgba(0,0,0,0.06)', marginTop: 8 }}>
          <span style={{ fontSize: 13, color: '#6b7280', marginRight: 8 }}>Total:</span>
          <span style={{ fontSize: 17, fontWeight: 700, color: '#1e1b4b' }}>{formatINR(grn.total_amount)}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// ─── MAIN PAGE COMPONENT ─────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

export default function Purchasing() {
  const [tab,        setTab]        = useState('pos');       // 'pos' | 'grn' | 'history'
  const [historyTab, setHistoryTab] = useState('pos');       // 'pos' | 'grns'

  // Shared lookup data
  const [suppliers, setSuppliers] = useState([]);
  const [products,  setProducts]  = useState([]);

  // PO list state
  const [pos,         setPos]         = useState([]);
  const [poTotal,     setPoTotal]     = useState(0);
  const [poPage,      setPoPage]      = useState(1);
  const [poStatus,    setPoStatus]    = useState('');
  const [showNewPO,   setShowNewPO]   = useState(false);
  const [selectedPO,  setSelectedPO]  = useState(null);

  // GRN list state (history tab)
  const [grns,       setGrns]       = useState([]);
  const [grnTotal,   setGrnTotal]   = useState(0);
  const [grnPage,    setGrnPage]    = useState(1);
  const [selectedGRN, setSelectedGRN] = useState(null);

  // Pre-fill GRN with a PO from the detail modal
  const [prefillPoId, setPrefillPoId] = useState(null);

  const LIMIT = 15;

  // ── Data loading ──────────────────────────────────────────────────────────

  const loadSuppliers = useCallback(() => {
    api.get('/suppliers/').then(({ data }) => setSuppliers(data)).catch(() => {});
  }, []);

  const loadProducts = useCallback(() => {
    api.get('/inventory/products?limit=100').then(({ data }) => setProducts(data.items ?? [])).catch(() => {});
  }, []);

  const loadPOs = useCallback(() => {
    const params = new URLSearchParams({ page: poPage, limit: LIMIT });
    if (poStatus) params.set('status', poStatus);
    api.get(`/purchasing/orders?${params}`).then(({ data }) => {
      setPos(data.items ?? []);
      setPoTotal(data.total ?? 0);
    }).catch(() => {});
  }, [poPage, poStatus]);

  const loadGRNs = useCallback(() => {
    api.get(`/purchasing/grn?page=${grnPage}&limit=${LIMIT}`).then(({ data }) => {
      setGrns(data.items ?? []);
      setGrnTotal(data.total ?? 0);
    }).catch(() => {});
  }, [grnPage]);

  // Load lookup data on mount
  useEffect(() => { loadSuppliers(); loadProducts(); }, [loadSuppliers, loadProducts]);

  // Load POs when tab or filter changes
  useEffect(() => { if (tab === 'pos' || tab === 'history') loadPOs(); }, [tab, loadPOs]);

  // Load GRNs when history tab is active
  useEffect(() => { if (tab === 'history' && historyTab === 'grns') loadGRNs(); }, [tab, historyTab, loadGRNs]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleReceiveAgainstPO(po) {
    setPrefillPoId(po.id);
    setSelectedPO(null);
    setTab('grn');
  }

  function handlePOSaved() {
    setShowNewPO(false);
    loadPOs();
  }

  function handlePOStatusChanged() {
    setSelectedPO(null);
    loadPOs();
    // Re-fetch the PO detail
    if (selectedPO) {
      api.get(`/purchasing/orders/${selectedPO.id}`).then(({ data }) => setSelectedPO(data)).catch(() => {});
    }
  }

  function handleGRNSaved() {
    loadPOs();   // PO status may have changed
    loadGRNs();
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  const tabStyle = (active) => ({
    padding: '9px 20px', borderRadius: 8, fontSize: 13, fontWeight: 500,
    border: 'none', cursor: 'pointer',
    background: active ? 'var(--accent)' : 'rgba(255,255,255,0.5)',
    color: active ? '#fff' : 'var(--text-secondary)',
    backdropFilter: active ? undefined : 'blur(8px)',
    transition: 'all 0.2s',
  });

  const subTabStyle = (active) => ({
    padding: '6px 16px', borderRadius: 6, fontSize: 12, fontWeight: 500,
    border: active ? '1px solid var(--accent)' : '1px solid rgba(0,0,0,0.08)',
    cursor: 'pointer',
    background: active ? 'rgba(99,102,241,0.1)' : 'rgba(255,255,255,0.6)',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
  });

  const totalPages = (total) => Math.ceil(total / LIMIT) || 1;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ animation: 'fadeUp 0.4s ease' }}>

      {/* Page header */}
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1e1b4b', margin: '0 0 4px' }}>Purchase Management</h1>
          <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
            Manage purchase orders and receive stock into inventory.
          </p>
        </div>
        {tab === 'pos' && (
          <button className="btn-primary" onClick={() => setShowNewPO(true)}>+ New PO</button>
        )}
      </div>

      {/* Main tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <button style={tabStyle(tab === 'pos')}    onClick={() => setTab('pos')}>Purchase Orders</button>
        <button style={tabStyle(tab === 'grn')}    onClick={() => setTab('grn')}>Receive Stock (GRN)</button>
        <button style={tabStyle(tab === 'history')} onClick={() => setTab('history')}>History</button>
      </div>

      {/* ── TAB 1: PURCHASE ORDERS ──────────────────────────────────────── */}
      {tab === 'pos' && (
        <div style={{ background: 'var(--glass)', backdropFilter: 'blur(24px)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-lg)', padding: 24 }}>

          {/* Filters */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 18, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 500 }}>Status:</span>
            {['', 'DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'].map(s => (
              <button key={s} onClick={() => { setPoStatus(s); setPoPage(1); }}
                style={{
                  padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 500,
                  border: poStatus === s ? '1px solid var(--accent)' : '1px solid rgba(0,0,0,0.08)',
                  background: poStatus === s ? 'rgba(99,102,241,0.1)' : 'rgba(255,255,255,0.6)',
                  color: poStatus === s ? 'var(--accent)' : '#6b7280', cursor: 'pointer',
                }}>
                {s || 'All'}
              </button>
            ))}
          </div>

          {pos.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af', fontSize: 14 }}>
              No purchase orders yet. Click "+ New PO" to create one.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['PO Number', 'Supplier', 'Date', 'Expected', 'Items', 'Total', 'Status'].map(h => (
                    <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.07em', paddingBottom: 10, borderBottom: '1px solid rgba(0,0,0,0.06)', paddingRight: 16 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pos.map(po => (
                  <tr key={po.id} onClick={() => api.get(`/purchasing/orders/${po.id}`).then(({ data }) => setSelectedPO(data))}
                    style={{ cursor: 'pointer', borderBottom: '1px solid rgba(0,0,0,0.04)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.04)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ padding: '11px 16px 11px 0', fontSize: 13, fontWeight: 600, color: '#1e1b4b' }}>{po.po_number}</td>
                    <td style={{ padding: '11px 16px 11px 0', fontSize: 13, color: '#374151' }}>{po.supplier_name}</td>
                    <td style={{ padding: '11px 16px 11px 0', fontSize: 12, color: '#6b7280' }}>{po.order_date}</td>
                    <td style={{ padding: '11px 16px 11px 0', fontSize: 12, color: '#6b7280' }}>{po.expected_date ?? '—'}</td>
                    <td style={{ padding: '11px 16px 11px 0', fontSize: 13 }}>{po.item_count}</td>
                    <td style={{ padding: '11px 16px 11px 0', fontSize: 13, fontWeight: 500 }}>{formatINR(po.total_amount)}</td>
                    <td style={{ padding: '11px 0', fontSize: 12 }}><StatusBadge status={po.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Pagination */}
          {poTotal > LIMIT && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
              <button className="btn-secondary" disabled={poPage === 1} onClick={() => setPoPage(p => p - 1)} style={{ padding: '5px 14px', fontSize: 12 }}>← Prev</button>
              <span style={{ fontSize: 12, color: '#6b7280', alignSelf: 'center' }}>Page {poPage} of {totalPages(poTotal)}</span>
              <button className="btn-secondary" disabled={poPage >= totalPages(poTotal)} onClick={() => setPoPage(p => p + 1)} style={{ padding: '5px 14px', fontSize: 12 }}>Next →</button>
            </div>
          )}
        </div>
      )}

      {/* ── TAB 2: RECEIVE STOCK (GRN) ──────────────────────────────────── */}
      {tab === 'grn' && (
        <div style={{ background: 'var(--glass)', backdropFilter: 'blur(24px)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-lg)', padding: 24 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: '#1e1b4b', margin: '0 0 6px' }}>Receive Stock (Goods Receipt Note)</h3>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 20px' }}>
            Fill this form when physical stock arrives. Each item creates a new inventory batch.
          </p>
          <GRNForm
            suppliers={suppliers}
            products={products}
            pos={pos.length > 0 ? pos : []}
            prefillPoId={prefillPoId}
            onSaved={handleGRNSaved}
          />
        </div>
      )}

      {/* ── TAB 3: HISTORY ──────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div style={{ background: 'var(--glass)', backdropFilter: 'blur(24px)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-lg)', padding: 24 }}>

          {/* Sub-tabs */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            <button style={subTabStyle(historyTab === 'pos')}  onClick={() => setHistoryTab('pos')}>Purchase Orders</button>
            <button style={subTabStyle(historyTab === 'grns')} onClick={() => { setHistoryTab('grns'); loadGRNs(); }}>Goods Receipt Notes</button>
          </div>

          {/* History: POs */}
          {historyTab === 'pos' && (
            <>
              {pos.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', fontSize: 14 }}>No purchase orders found.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {['PO Number', 'Supplier', 'Order Date', 'Expected', 'Items', 'Total', 'Status'].map(h => (
                        <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.07em', paddingBottom: 10, borderBottom: '1px solid rgba(0,0,0,0.06)', paddingRight: 16 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pos.map(po => (
                      <tr key={po.id} onClick={() => api.get(`/purchasing/orders/${po.id}`).then(({ data }) => setSelectedPO(data))}
                        style={{ cursor: 'pointer', borderBottom: '1px solid rgba(0,0,0,0.04)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.04)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        <td style={{ padding: '11px 16px 11px 0', fontSize: 13, fontWeight: 600, color: '#1e1b4b' }}>{po.po_number}</td>
                        <td style={{ padding: '11px 16px 11px 0', fontSize: 13, color: '#374151' }}>{po.supplier_name}</td>
                        <td style={{ padding: '11px 16px 11px 0', fontSize: 12, color: '#6b7280' }}>{po.order_date}</td>
                        <td style={{ padding: '11px 16px 11px 0', fontSize: 12, color: '#6b7280' }}>{po.expected_date ?? '—'}</td>
                        <td style={{ padding: '11px 16px 11px 0', fontSize: 13 }}>{po.item_count}</td>
                        <td style={{ padding: '11px 16px 11px 0', fontSize: 13, fontWeight: 500 }}>{formatINR(po.total_amount)}</td>
                        <td style={{ padding: '11px 0' }}><StatusBadge status={po.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {/* History: GRNs */}
          {historyTab === 'grns' && (
            <>
              {grns.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', fontSize: 14 }}>No goods receipts found.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {['GRN Number', 'Supplier', 'PO Ref', 'Date', 'Items', 'Total'].map(h => (
                        <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.07em', paddingBottom: 10, borderBottom: '1px solid rgba(0,0,0,0.06)', paddingRight: 16 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {grns.map(grn => (
                      <tr key={grn.id} onClick={() => api.get(`/purchasing/grn/${grn.id}`).then(({ data }) => setSelectedGRN(data))}
                        style={{ cursor: 'pointer', borderBottom: '1px solid rgba(0,0,0,0.04)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.04)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        <td style={{ padding: '11px 16px 11px 0', fontSize: 13, fontWeight: 600, color: '#1e1b4b' }}>{grn.grn_number}</td>
                        <td style={{ padding: '11px 16px 11px 0', fontSize: 13, color: '#374151' }}>{grn.supplier_name}</td>
                        <td style={{ padding: '11px 16px 11px 0', fontSize: 12, color: '#6b7280' }}>{grn.po_number ?? '—'}</td>
                        <td style={{ padding: '11px 16px 11px 0', fontSize: 12, color: '#6b7280' }}>{grn.receipt_date}</td>
                        <td style={{ padding: '11px 16px 11px 0', fontSize: 13 }}>{grn.item_count}</td>
                        <td style={{ padding: '11px 0', fontSize: 13, fontWeight: 500 }}>{formatINR(grn.total_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {grnTotal > LIMIT && (
                <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
                  <button className="btn-secondary" disabled={grnPage === 1} onClick={() => setGrnPage(p => p - 1)} style={{ padding: '5px 14px', fontSize: 12 }}>← Prev</button>
                  <span style={{ fontSize: 12, color: '#6b7280', alignSelf: 'center' }}>Page {grnPage} of {totalPages(grnTotal)}</span>
                  <button className="btn-secondary" disabled={grnPage >= totalPages(grnTotal)} onClick={() => setGrnPage(p => p + 1)} style={{ padding: '5px 14px', fontSize: 12 }}>Next →</button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── MODALS ─────────────────────────────────────────────────────── */}

      {showNewPO && (
        <NewPOModal
          suppliers={suppliers}
          products={products}
          onClose={() => setShowNewPO(false)}
          onSaved={handlePOSaved}
        />
      )}

      {selectedPO && (
        <PODetailModal
          po={selectedPO}
          onClose={() => setSelectedPO(null)}
          onStatusChanged={handlePOStatusChanged}
          onReceiveAgainst={handleReceiveAgainstPO}
        />
      )}

      {selectedGRN && (
        <GRNDetailModal grn={selectedGRN} onClose={() => setSelectedGRN(null)} />
      )}
    </div>
  );
}
