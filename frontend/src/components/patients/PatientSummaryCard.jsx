/**
 * PatientSummaryCard
 *
 * Fetches GET /api/patients/{patientId}/summary and renders a compact
 * analytics card with four panels:
 *   Visits | Spending | Top Medicines | Follow-ups
 *
 * A red risk-flags banner appears below the panels when the backend
 * detects any alerts (no visit, chronic-med overdue, overdue follow-up).
 *
 * Designed to sit at the top of the patient detail modal, before the
 * purchase history table.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import PrescriptionThumb from '../shared/PrescriptionThumb';
import PrescriptionLightbox from '../shared/PrescriptionLightbox';
import { formatDateOnly } from '../../lib/datetime';

// ─── Prescription History sub-component ──────────────────────────────────────

function PrescriptionHistory({ patientId }) {
  const [rxList,     setRxList]     = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [lightboxRx, setLightboxRx] = useState(null);   // which Rx is open full-size

  useEffect(() => {
    if (!patientId) return;
    setLoading(true);
    api.get(`/prescriptions/patient/${patientId}`)
      .then(res => setRxList((res.data || []).slice(0, 5)))
      .catch(() => setRxList([]))
      .finally(() => setLoading(false));
  }, [patientId]);

  // Hide the whole section for patients with no prescriptions (per spec —
  // no empty state).  While still loading we also render nothing to avoid a flash.
  if (loading || rxList.length === 0) return null;

  return (
    <div style={{ ...cardStyle, marginTop: 0 }}>
      <div style={cardTitleStyle}>Prescription History</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rxList.map(rx => (
          <div key={rx.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'rgba(255,255,255,0.55)',
            border: '1px solid rgba(255,255,255,0.70)',
            borderRadius: 'var(--radius)', padding: '8px 10px',
          }}>
            {/* Thumbnail (authenticated) — click to open the lightbox */}
            <PrescriptionThumb
              rx={rx}
              size={60}
              onClick={() => setLightboxRx(rx)}
            />

            {/* Info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>
                {formatDateOnly(rx.uploaded_at)}
              </div>
              <div style={{ fontSize: 10, marginTop: 2 }}>
                {rx.invoice_number ? (
                  <span style={{ fontFamily: 'monospace', color: 'var(--accent)' }}>
                    Invoice: {rx.invoice_number}
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-hint)' }}>Not linked to a bill</span>
                )}
              </div>
              {rx.dispensed_medicines?.length > 0 && (
                <div style={{
                  fontSize: 10, color: 'var(--text-secondary)', marginTop: 2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {rx.dispensed_medicines.slice(0, 3).join(', ')}
                  {rx.dispensed_medicines.length > 3 && '…'}
                </div>
              )}
            </div>

            {/* View Rx button — opens the in-app lightbox (not a new tab, so it
                works with the JWT-protected image endpoint and in the desktop app). */}
            <button
              onClick={() => setLightboxRx(rx)}
              style={{
                fontSize: 10, fontWeight: 600, color: 'var(--accent)',
                cursor: 'pointer', padding: '4px 10px',
                background: 'var(--accent-light)',
                border: '1px solid rgba(99,102,241,0.25)',
                borderRadius: 20, flexShrink: 0,
              }}
            >
              View Rx
            </button>
          </div>
        ))}
      </div>

      {/* Full-size lightbox */}
      {lightboxRx && (
        <PrescriptionLightbox rx={lightboxRx} onClose={() => setLightboxRx(null)} />
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function inr(n) {
  if (n == null) return '—';
  return '₹' + Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

const fmtDate = formatDateOnly;   // IST-aware (see lib/datetime.js)

// ─── Component ───────────────────────────────────────────────────────────────

export default function PatientSummaryCard({ patientId }) {
  const [summary,    setSummary]    = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [creditInfo, setCreditInfo] = useState(null);

  useEffect(() => {
    if (!patientId) return;
    setLoading(true);
    setSummary(null);
    api.get(`/patients/${patientId}/summary`)
      .then(res  => setSummary(res.data))
      .catch(()  => setSummary(null))   // fail silently; rest of modal still works
      .finally(() => setLoading(false));
  }, [patientId]);

  // Fetch credit account to show the outstanding-balance banner
  useEffect(() => {
    if (!patientId) return;
    setCreditInfo(null);
    api.get(`/credit/patient/${patientId}`)
      .then(res => setCreditInfo(res.data))
      .catch(() => setCreditInfo(null));
  }, [patientId]);

  if (loading) {
    return (
      <div style={cardStyle}>
        <div style={cardTitleStyle}>Patient Summary</div>
        <div style={{ color: 'var(--text-hint)', fontSize: 12, padding: '8px 0' }}>
          Loading summary…
        </div>
      </div>
    );
  }

  if (!summary) return null;

  const { visit_stats: vs, top_medicines, follow_ups: fu, risk_flags } = summary;

  return (<>
    <div style={cardStyle}>
      <div style={cardTitleStyle}>Patient Summary</div>

      {/* ── 4-panel grid ── */}
      <div style={gridStyle}>

        {/* Panel 1 — Visits */}
        <div style={panelStyle}>
          <div style={panelAccentLabel}>Visits</div>
          <div style={bigNumStyle}>{vs.total_visits}</div>
          <div style={dimStyle}>total visits</div>
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
            Last:{' '}
            <strong>
              {vs.days_since_last_visit != null ? `${vs.days_since_last_visit}d ago` : '—'}
            </strong>
          </div>
          {vs.avg_days_between_visits != null && (
            <div style={{ fontSize: 10, color: 'var(--text-hint)', marginTop: 2 }}>
              avg every {vs.avg_days_between_visits}d
            </div>
          )}
        </div>

        {/* Panel 2 — Spending */}
        <div style={panelStyle}>
          <div style={panelAccentLabel}>Spending</div>
          <div style={{ ...bigNumStyle, fontSize: 15 }}>{inr(vs.total_spent)}</div>
          <div style={dimStyle}>total spent</div>
          {vs.avg_per_visit != null && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
              Avg: <strong>{inr(vs.avg_per_visit)}</strong>
            </div>
          )}
        </div>

        {/* Panel 3 — Top Medicines */}
        <div style={panelStyle}>
          <div style={panelAccentLabel}>Top Medicines</div>
          {top_medicines.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
              None yet
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 }}>
              {top_medicines.slice(0, 3).map((med, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                  <div style={{
                    fontSize: 11, color: 'var(--text)', fontWeight: 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    flex: 1,
                  }}>
                    {med.name}
                  </div>
                  <span style={countBadgeStyle}>×{med.times_purchased}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Panel 4 — Follow-ups */}
        <div style={panelStyle}>
          <div style={panelAccentLabel}>Follow-ups</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 4, alignItems: 'flex-end' }}>
            {/* Pending count — yellow if > 0 */}
            <div style={{ textAlign: 'center' }}>
              <div style={{
                fontSize: 20, fontWeight: 700, lineHeight: 1,
                color: fu.pending > 0 ? 'var(--warn)' : 'var(--text-hint)',
              }}>
                {fu.pending}
              </div>
              <div style={{ fontSize: 9, color: 'var(--text-hint)', marginTop: 1 }}>pending</div>
            </div>
            <div style={{ width: 1, height: 28, background: 'var(--border)', marginBottom: 4 }} />
            {/* Completed count — always green */}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1, color: 'var(--ok)' }}>
                {fu.completed}
              </div>
              <div style={{ fontSize: 9, color: 'var(--text-hint)', marginTop: 1 }}>done</div>
            </div>
          </div>
          {fu.response_rate != null && (
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 6 }}>
              {Math.round(fu.response_rate * 100)}% response rate
            </div>
          )}
          {fu.next_due && (
            <div style={{ fontSize: 10, color: 'var(--info)', marginTop: 2 }}>
              Next: {fmtDate(fu.next_due)}
            </div>
          )}
        </div>

      </div>

      {/* ── Risk flags banner (only shown when there are flags) ── */}
      {risk_flags.length > 0 && (
        <div style={riskBannerStyle}>
          <span style={{ fontSize: 13, flexShrink: 0, marginTop: 1 }}>⚠</span>
          <div style={{ flex: 1 }}>
            {risk_flags.map((flag, i) => (
              <div key={i} style={{ lineHeight: 1.6 }}>{flag}</div>
            ))}
          </div>
        </div>
      )}
    </div>

    {/* ── Outstanding Credit Banner ─────────────────────────────────────────── */}
    {creditInfo && Number(creditInfo.account?.outstanding) > 0 && (() => {
      // Find the earliest due date across open (PENDING/PARTIAL/OVERDUE) transactions
      const openTxs = (creditInfo.transactions || []).filter(tx =>
        tx.balance > 0 && tx.due_date
      );
      openTxs.sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
      const earliestDue = openTxs[0]?.due_date;
      const isOverdue   = openTxs.some(tx => tx.status === 'OVERDUE');

      return (
        <div style={{
          display:      'flex',
          alignItems:   'center',
          gap:          10,
          background:   isOverdue ? 'var(--danger-bg)' : 'rgba(245,158,11,0.10)',
          border:       `1px solid ${isOverdue ? 'rgba(225,29,72,0.28)' : 'rgba(217,119,6,0.30)'}`,
          borderRadius: 'var(--radius)',
          padding:      '9px 14px',
          marginBottom: 18,
          fontSize:     13,
          fontWeight:   600,
          color:        isOverdue ? 'var(--danger)' : 'var(--warn)',
        }}>
          <span style={{ fontSize: 15, flexShrink: 0 }}>⚠</span>
          <span>
            Outstanding Credit: {inr(creditInfo.account.outstanding)}
            {earliestDue && (
              <span style={{ fontWeight: 400, marginLeft: 6 }}>
                · Due: {fmtDate(earliestDue)}
              </span>
            )}
            {isOverdue && (
              <span style={{
                marginLeft: 8, fontSize: 10, fontWeight: 700,
                background: 'var(--danger)', color: '#fff',
                borderRadius: 10, padding: '1px 7px',
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                Overdue
              </span>
            )}
          </span>
        </div>
      );
    })()}

    {/* Prescription History — shown below the summary card if any prescriptions exist */}
    <PrescriptionHistory patientId={patientId} />
  </>);
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const cardStyle = {
  background:          'rgba(255,255,255,0.45)',
  backdropFilter:      'blur(14px)',
  WebkitBackdropFilter:'blur(14px)',
  border:              '1px solid var(--glass-border)',
  borderRadius:        'var(--radius-lg)',
  padding:             '14px 16px',
  marginBottom:        18,
};

const cardTitleStyle = {
  fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.09em', color: 'var(--text-hint)', marginBottom: 10,
};

const gridStyle = {
  display: 'grid',
  /* 4 equal columns; on very narrow containers they wrap to 2×2 */
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap: 8,
  marginBottom: 10,
};

const panelStyle = {
  background:   'rgba(255,255,255,0.60)',
  border:       '1px solid rgba(255,255,255,0.70)',
  borderRadius: 'var(--radius)',
  padding:      '9px 10px',
  minWidth:     0,     /* allow text-overflow to work inside grid cells */
};

const panelAccentLabel = {
  fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.07em', color: 'var(--accent)', marginBottom: 4,
};

const bigNumStyle = {
  fontSize: 22, fontWeight: 700, color: 'var(--text)', lineHeight: 1.1,
};

const dimStyle = {
  fontSize: 10, color: 'var(--text-hint)',
};

const countBadgeStyle = {
  fontSize: 10, fontWeight: 700,
  color:      'var(--accent)',
  background: 'var(--accent-light)',
  borderRadius: 10,
  padding:    '1px 6px',
  flexShrink: 0,
};

const riskBannerStyle = {
  display:      'flex',
  alignItems:   'flex-start',
  gap:          8,
  background:   'var(--danger-bg)',
  border:       '1px solid rgba(225,29,72,0.22)',
  borderRadius: 'var(--radius)',
  padding:      '9px 12px',
  fontSize:     12,
  color:        'var(--danger)',
  fontWeight:   500,
  marginTop:    2,
};
