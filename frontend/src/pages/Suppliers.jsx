/**
 * Suppliers page — full CRUD for medicine suppliers.
 *
 * Layout:
 *   - Search bar + "Add Supplier" button at the top
 *   - Glass card table listing all suppliers
 *   - Add / Edit modal (shared form, opened via portal)
 *   - Delete confirmation modal
 *
 * Uses createPortal for modals to avoid clipping by the sidebar overflow.
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import SupplierCredit from '../components/SupplierCredit';

// ---------------------------------------------------------------------------
// Tiny reusable form field
// ---------------------------------------------------------------------------

function Field({ label, value, onChange, placeholder, required, type = 'text' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}{required && <span style={{ color: '#e11d48', marginLeft: 2 }}>*</span>}
      </label>
      {type === 'textarea' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          style={{ resize: 'vertical' }}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / Edit modal
// ---------------------------------------------------------------------------

const EMPTY_FORM = { name: '', contact_person: '', phone: '', address: '', gst_number: '' };

function SupplierModal({ supplier, onClose, onSaved }) {
  // If "supplier" is passed in we are editing; otherwise we are adding.
  const isEdit = Boolean(supplier);

  const [form, setForm]       = useState(supplier ? {
    name:           supplier.name           ?? '',
    contact_person: supplier.contact_person ?? '',
    phone:          supplier.phone          ?? '',
    address:        supplier.address        ?? '',
    gst_number:     supplier.gst_number     ?? '',
  } : { ...EMPTY_FORM });
  const [saving, setSaving]   = useState(false);
  const [error,  setError]    = useState('');

  // Convenience: update one field in the form object
  function set(field) {
    return (value) => setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) { setError('Supplier name is required.'); return; }

    // Build the payload — omit empty strings so the backend stores NULL
    const payload = {};
    for (const [k, v] of Object.entries(form)) {
      payload[k] = v.trim() || null;
    }
    // name must not be null
    if (!payload.name) { setError('Supplier name is required.'); return; }

    setSaving(true);
    try {
      if (isEdit) {
        await api.put(`/suppliers/${supplier.id}`, payload);
      } else {
        await api.post('/suppliers/', payload);
      }
      onSaved();
    } catch (err) {
      setError(err.response?.data?.detail ?? 'Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(30,27,75,0.35)',
      backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: 480, maxWidth: '100%',
        background: 'rgba(255,255,255,0.92)',
        backdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.75)',
        borderRadius: 18,
        padding: 28,
        boxShadow: '0 20px 60px rgba(99,102,241,0.18)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1e1b4b' }}>
            {isEdit ? 'Edit Supplier' : 'Add Supplier'}
          </h2>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 20, color: '#9ca3af', lineHeight: 1,
          }}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Supplier Name" value={form.name}           onChange={set('name')}           placeholder="e.g. Medline Distributors" required />
          <Field label="Contact Person" value={form.contact_person} onChange={set('contact_person')} placeholder="e.g. Rajesh Kumar" />
          <Field label="Phone"          value={form.phone}          onChange={set('phone')}          placeholder="e.g. 9876543210" type="tel" />
          <Field label="GST Number"     value={form.gst_number}     onChange={set('gst_number')}     placeholder="15-digit GSTIN" />
          <Field label="Address"        value={form.address}        onChange={set('address')}        placeholder="Full address" type="textarea" />

          {error && (
            <div style={{
              background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)',
              color: '#e11d48', borderRadius: 8, padding: '10px 14px', fontSize: 13,
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving} style={{ minWidth: 110 }}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Supplier'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// Delete confirmation modal
// ---------------------------------------------------------------------------

function DeleteModal({ supplier, onClose, onDeleted }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError]       = useState('');

  const hasHistory = supplier.batch_count > 0;

  async function handleDelete() {
    setDeleting(true);
    setError('');
    try {
      await api.delete(`/suppliers/${supplier.id}`);
      onDeleted();
    } catch (err) {
      setError(err.response?.data?.detail ?? 'Could not delete supplier.');
      setDeleting(false);
    }
  }

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(30,27,75,0.35)',
      backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: 420, maxWidth: '100%',
        background: 'rgba(255,255,255,0.92)',
        backdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.75)',
        borderRadius: 18,
        padding: 28,
        boxShadow: '0 20px 60px rgba(225,29,72,0.15)',
      }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1e1b4b', marginBottom: 10 }}>
          Delete Supplier
        </h2>
        <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 16 }}>
          Are you sure you want to delete <strong style={{ color: '#1e1b4b' }}>{supplier.name}</strong>?
        </p>

        {/* Warn if the supplier has purchase history */}
        {hasHistory && (
          <div style={{
            background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.3)',
            color: '#b45309', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16,
          }}>
            ⚠️ This supplier has <strong>{supplier.batch_count}</strong> stock batch(es) linked to it.
            Deletion will be blocked to protect your purchase history.
          </div>
        )}

        {error && (
          <div style={{
            background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)',
            color: '#e11d48', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16,
          }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose} disabled={deleting}>Cancel</button>
          <button
            className="btn-danger"
            onClick={handleDelete}
            disabled={deleting || hasHistory}
            style={{ minWidth: 100 }}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [error,     setError]     = useState('');

  // Which tab is showing: 'list' (supplier records) or 'credit' (what we owe).
  // The Dashboard credit widget links here with ?tab=credit, so we read the
  // query string once on mount to honour that deep link.
  const [tab, setTab] = useState(() => (
    new URLSearchParams(window.location.search).get('tab') === 'credit' ? 'credit' : 'list'
  ));

  // Which modal is open: null | 'add' | { edit: supplier } | { delete: supplier }
  const [modal, setModal] = useState(null);

  const fetchSuppliers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = search ? { search } : {};
      const { data } = await api.get('/suppliers/', { params });
      setSuppliers(data);
    } catch {
      setError('Could not load suppliers. Is the server running?');
    } finally {
      setLoading(false);
    }
  }, [search]);

  // Re-fetch whenever search changes (with a short debounce)
  useEffect(() => {
    const timer = setTimeout(fetchSuppliers, 300);
    return () => clearTimeout(timer);
  }, [fetchSuppliers]);

  function closeAndRefresh() {
    setModal(null);
    fetchSuppliers();
  }

  return (
    <div>
      {/* ── Page heading ──────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1e1b4b', marginBottom: 2 }}>Suppliers</h1>
          <p style={{ fontSize: 14, color: '#9ca3af' }}>
            {tab === 'credit'
              ? 'Money the pharmacy owes its suppliers'
              : loading ? 'Loading…' : `${suppliers.length} supplier${suppliers.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        {/* Add Supplier only makes sense on the list tab */}
        {tab === 'list' && (
          <button
            className="btn-primary"
            onClick={() => setModal('add')}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {/* "+" icon */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add Supplier
          </button>
        )}
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, borderBottom: '1px solid rgba(255,255,255,0.6)' }}>
        {[
          ['list',   'Supplier List'],
          ['credit', 'Credit Management'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '9px 16px', fontSize: 14,
              fontWeight: tab === key ? 700 : 500,
              color: tab === key ? '#4f46e5' : '#6b7280',
              borderBottom: tab === key ? '2px solid #6366f1' : '2px solid transparent',
              marginBottom: -1,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Credit Management tab ─────────────────────────────────── */}
      {tab === 'credit' && <SupplierCredit />}

      {/* ── Supplier List tab ─────────────────────────────────────── */}
      {tab === 'list' && (
      <>
      {/* ── Search bar ────────────────────────────────────────────── */}
      <div style={{ marginBottom: 16, maxWidth: 340 }}>
        <input
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: '100%' }}
        />
      </div>

      {/* ── Error banner ──────────────────────────────────────────── */}
      {error && (
        <div style={{
          background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)',
          color: '#e11d48', borderRadius: 10, padding: '10px 16px', fontSize: 13, marginBottom: 16,
        }}>
          {error}
        </div>
      )}

      {/* ── Suppliers table ───────────────────────────────────────── */}
      <div style={{
        background: 'rgba(255,255,255,0.52)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.75)',
        borderRadius: 14,
        overflow: 'hidden',
        boxShadow: '0 4px 20px rgba(99,102,241,0.06)',
      }}>
        {/* Table header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1.5fr 1.2fr 1.4fr 80px 90px',
          padding: '12px 20px',
          borderBottom: '1px solid rgba(0,0,0,0.06)',
          fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.07em', color: '#9ca3af',
        }}>
          <span>Name</span>
          <span>Contact Person</span>
          <span>Phone</span>
          <span>GST Number</span>
          <span style={{ textAlign: 'center' }}>Batches</span>
          <span style={{ textAlign: 'right' }}>Actions</span>
        </div>

        {/* Rows */}
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{
              padding: '14px 20px', borderBottom: '1px solid rgba(0,0,0,0.04)',
              animation: 'pulse 1.5s ease-in-out infinite',
            }}>
              <div style={{ height: 14, width: '60%', background: '#e5e7eb', borderRadius: 4 }} />
            </div>
          ))
        ) : suppliers.length === 0 ? (
          <div style={{ padding: '32px 20px', textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>
            {search ? `No suppliers match "${search}"` : 'No suppliers yet. Add your first one above.'}
          </div>
        ) : (
          suppliers.map((s) => (
            <div
              key={s.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '2fr 1.5fr 1.2fr 1.4fr 80px 90px',
                padding: '13px 20px',
                borderBottom: '1px solid rgba(0,0,0,0.04)',
                alignItems: 'center',
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(99,102,241,0.03)'}
              onMouseLeave={(e) => e.currentTarget.style.background = ''}
            >
              {/* Name */}
              <span style={{ fontSize: 14, fontWeight: 600, color: '#1e1b4b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.name}
              </span>

              {/* Contact person */}
              <span style={{ fontSize: 13, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.contact_person || <span style={{ color: '#d1d5db' }}>—</span>}
              </span>

              {/* Phone */}
              <span style={{ fontSize: 13, color: '#6b7280' }}>
                {s.phone || <span style={{ color: '#d1d5db' }}>—</span>}
              </span>

              {/* GST Number */}
              <span style={{ fontSize: 12, color: '#6366f1', fontFamily: 'monospace', letterSpacing: '0.04em' }}>
                {s.gst_number || <span style={{ color: '#d1d5db', fontFamily: 'inherit', letterSpacing: 0 }}>—</span>}
              </span>

              {/* Batch count badge */}
              <div style={{ textAlign: 'center' }}>
                <span className={s.batch_count > 0 ? 'badge badge-accent' : 'badge badge-neutral'}>
                  {s.batch_count}
                </span>
              </div>

              {/* Edit / Delete buttons */}
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setModal({ edit: s })}
                  style={{
                    background: 'rgba(99,102,241,0.08)',
                    border: '1px solid rgba(99,102,241,0.2)',
                    color: '#6366f1',
                    borderRadius: 7,
                    padding: '5px 10px',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Edit
                </button>
                <button
                  onClick={() => setModal({ delete: s })}
                  style={{
                    background: 'rgba(244,63,94,0.07)',
                    border: '1px solid rgba(244,63,94,0.2)',
                    color: '#e11d48',
                    borderRadius: 7,
                    padding: '5px 10px',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── Modals ────────────────────────────────────────────────── */}
      {modal === 'add' && (
        <SupplierModal
          supplier={null}
          onClose={() => setModal(null)}
          onSaved={closeAndRefresh}
        />
      )}
      {modal?.edit && (
        <SupplierModal
          supplier={modal.edit}
          onClose={() => setModal(null)}
          onSaved={closeAndRefresh}
        />
      )}
      {modal?.delete && (
        <DeleteModal
          supplier={modal.delete}
          onClose={() => setModal(null)}
          onDeleted={closeAndRefresh}
        />
      )}
      </>
      )}
    </div>
  );
}
