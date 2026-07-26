/**
 * PatientHistoryPanel — compact patient-history card for the Billing screen.
 *
 * Appears in the RIGHT column of the billing page (above the Bill Summary)
 * the moment a patient is selected.  It gives the pharmacist an at-a-glance
 * recap WITHOUT leaving the billing screen:
 *
 *   • the patient's most recent prescription (thumbnail → click to enlarge)
 *   • their last 3 visits, each with the medicines that were dispensed
 *
 * Data sources (both authenticated via our axios instance):
 *   GET /prescriptions/patient/{id}   → newest prescription is item [0]
 *   GET /patients/{id}/invoices?limit=3 → last 3 invoices (merged items)
 *
 * The prescription image is loaded as an authenticated blob (useAuthedImage)
 * because the image endpoint needs a Bearer token that a plain <img> can't send.
 *
 * Props:
 *   patientId    — the selected patient's id
 *   patientName  — display name for the header
 *   onClose      — called when the pharmacist clicks the × (clears the panel)
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuthedImage } from '../../hooks/useAuthedImage';
import PrescriptionLightbox from '../shared/PrescriptionLightbox';
import { parseBackendDate, formatDateOnly } from '../../lib/datetime';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function inr(n) {
  if (n == null) return '₹0';
  return '₹' + Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  });
}

/** "5 days ago", "Today", "Yesterday" from an ISO timestamp (compared in IST). */
function relativeDays(iso) {
  const then = parseBackendDate(iso);
  if (!then) return null;
  // Compare calendar days in IST (en-CA → "YYYY-MM-DD").
  const IST = 'Asia/Kolkata';
  const d0 = new Date(then.toLocaleDateString('en-CA', { timeZone: IST }));
  const d1 = new Date(new Date().toLocaleDateString('en-CA', { timeZone: IST }));
  const days = Math.round((d1 - d0) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

/** "15 Jan" short date for a visit row (IST). */
function shortDate(iso) {
  const d = parseBackendDate(iso);
  if (!d) return '—';
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
}

/** "15 Jan 2025" long date for the prescription caption (IST). */
function longDate(iso) {
  const d = parseBackendDate(iso);
  return d ? formatDateOnly(iso) : '';
}

// ─── Prescription preview (full-width, authed) ───────────────────────────────

function RxPreview({ rx, onOpen }) {
  const isPdf = rx?.mime_type === 'application/pdf';
  const { url, loading, error } = useAuthedImage(
    rx ? `/prescriptions/${rx.id}/image` : null,
    { skip: isPdf },
  );

  return (
    <div
      onClick={onOpen}
      style={{
        borderRadius: 'var(--radius)', overflow: 'hidden',
        border: '1px solid var(--glass-border)', cursor: 'pointer',
        background: '#f8f9fa',
      }}
      title="Click to view full size"
    >
      {/* Thumbnail area */}
      <div style={{
        width: '100%', height: 120, background: '#f8f9fa',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {isPdf ? (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
            <div style={{ fontSize: 30 }}>📄</div>
            <div style={{ fontSize: 11, marginTop: 2 }}>PDF prescription</div>
          </div>
        ) : loading ? (
          <span style={{ fontSize: 12, color: 'var(--text-hint)' }}>Loading…</span>
        ) : error || !url ? (
          <span style={{ fontSize: 12, color: 'var(--text-hint)' }}>Preview unavailable</span>
        ) : (
          <img
            src={url}
            alt="Last prescription"
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        )}
      </div>

      {/* Caption bar */}
      <div style={{
        padding: '6px 10px', background: 'rgba(255,255,255,0.7)',
        borderTop: '1px solid var(--glass-border)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          {longDate(rx.uploaded_at)}
          {rx.invoice_number && (
            <span style={{ marginLeft: 6, fontFamily: 'monospace', color: 'var(--accent)' }}>
              {rx.invoice_number}
            </span>
          )}
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', flexShrink: 0 }}>
          View full size
        </span>
      </div>
    </div>
  );
}

// ─── Payment-method badge ────────────────────────────────────────────────────

function methodBadge(method) {
  const m = (method || 'CASH').toUpperCase();
  const isCredit = m === 'CREDIT';
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
      padding: '1px 6px', borderRadius: 20,
      background: isCredit ? 'var(--danger-bg)' : 'var(--accent-light)',
      color:      isCredit ? 'var(--danger)'    : 'var(--accent)',
    }}>
      {m}
    </span>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function PatientHistoryPanel({ patientId, patientName, onClose }) {
  const [latestRx, setLatestRx] = useState(null);
  const [visits,   setVisits]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [lightboxRx, setLightboxRx] = useState(null);

  useEffect(() => {
    if (!patientId) return;
    let cancelled = false;
    setLoading(true);
    setLatestRx(null);
    setVisits([]);

    // Fetch the newest prescription and the last 3 visits in parallel.
    Promise.all([
      api.get(`/prescriptions/patient/${patientId}`).catch(() => ({ data: [] })),
      api.get(`/patients/${patientId}/invoices`, { params: { limit: 3 } }).catch(() => ({ data: [] })),
    ]).then(([rxRes, invRes]) => {
      if (cancelled) return;
      const rxList = rxRes.data || [];
      setLatestRx(rxList.length > 0 ? rxList[0] : null);
      setVisits(invRes.data || []);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [patientId]);

  const lastVisit = visits.length > 0 ? relativeDays(visits[0].created_at) : null;

  return (
    <div style={panelStyle}>
      {/* ── Header ── */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <span style={{ fontSize: 15 }}>👤</span>
            <span style={{
              fontSize: 14, fontWeight: 700, color: 'var(--text)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {patientName}
            </span>
          </div>
          <button
            onClick={onClose}
            title="Hide history panel"
            style={{
              background: 'none', border: 'none', color: 'var(--text-hint)',
              fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: '0 2px', flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
          {loading ? 'Loading history…' : lastVisit ? `Last visit: ${lastVisit}` : 'No visits yet'}
        </div>
      </div>

      {/* ── Last prescription ── */}
      <div style={{ flexShrink: 0, marginTop: 12 }}>
        <div style={sectionLabel}>📋 Last Prescription</div>
        {loading ? (
          <div style={hintStyle}>Loading…</div>
        ) : latestRx ? (
          <RxPreview rx={latestRx} onOpen={() => setLightboxRx(latestRx)} />
        ) : (
          <div style={{
            ...hintStyle, textAlign: 'center', padding: '14px 10px',
            background: 'rgba(255,255,255,0.4)', borderRadius: 'var(--radius)',
            border: '1px dashed var(--glass-border)',
          }}>
            No Rx on file
          </div>
        )}
      </div>

      {/* ── Last 3 visits (scrollable) ── */}
      <div style={{ flexShrink: 0, marginTop: 14 }}>
        <div style={sectionLabel}>🕐 Last 3 Visits</div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 4 }}>
        {loading ? (
          <div style={hintStyle}>Loading…</div>
        ) : visits.length === 0 ? (
          <div style={hintStyle}>No past visits.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {visits.map(v => (
              <div key={v.id} style={{
                background: 'rgba(255,255,255,0.5)',
                border: '1px solid var(--glass-border)',
                borderRadius: 'var(--radius)', padding: '8px 10px',
              }}>
                {/* Visit header: date · total · method */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                    {shortDate(v.created_at)}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                    · {inr(v.total_amount)}
                  </span>
                  {methodBadge(v.payment_method)}
                  {v.status === 'RETURNED' && (
                    <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--danger)' }}>RETURNED</span>
                  )}
                </div>
                {/* Medicine bullets */}
                {v.items?.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {v.items.map((it, i) => (
                      <div key={i} style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                        • {it.product_name}
                        {it.quantity > 1 && (
                          <span style={{ color: 'var(--text-hint)' }}> × {it.quantity}</span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>No items</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Full-size lightbox ── */}
      {lightboxRx && (
        <PrescriptionLightbox rx={lightboxRx} onClose={() => setLightboxRx(null)} />
      )}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const panelStyle = {
  display: 'flex', flexDirection: 'column',
  maxHeight: 420,
  background: 'rgba(255,255,255,0.6)',
  backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
  border: '1px solid rgba(255,255,255,0.8)',
  borderRadius: 12,
  padding: '14px 16px',
  fontFamily: 'var(--font-body)',
  // Subtle slide-in from the right when the patient is selected.
  animation: 'slideInRight 0.3s ease both',
};

const sectionLabel = {
  fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.07em', color: 'var(--text-hint)', marginBottom: 6,
};

const hintStyle = {
  fontSize: 12, color: 'var(--text-hint)', padding: '4px 0',
};
