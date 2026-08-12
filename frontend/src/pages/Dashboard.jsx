/**
 * Dashboard — wired to real data from GET /api/dashboard/summary.
 *
 * Shows 8 stat cards laid out as 2 rows of 4 (see .stats-grid in global.css),
 * a recent-invoices panel, and a top-products panel.
 * All amounts are formatted in the Indian numbering system (₹1,24,500).
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { getUser } from '../lib/auth';
import ExpenditurePanel from '../components/dashboard/ExpenditurePanel';

// ---------------------------------------------------------------------------
// Indian number format helper
// ---------------------------------------------------------------------------

function formatINR(amount) {
  if (amount === null || amount === undefined) return '—';
  return '₹' + Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// ---------------------------------------------------------------------------
// Time-based greeting
// ---------------------------------------------------------------------------

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function todayLabel() {
  return new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function currentMonthName() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: 'long' });
}

// ---------------------------------------------------------------------------
// Skeleton pulse card
// ---------------------------------------------------------------------------

/**
 * Every stat card is at least this tall.  All 8 share it so the two rows line
 * up perfectly even though the expenditure cards carry extra content (the
 * category pills) and the patients card carries a new/returning footer.
 */
const CARD_MIN_HEIGHT = 140;

function SkeletonCard() {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.52)',
      backdropFilter: 'blur(20px)',
      border: '1px solid rgba(255,255,255,0.75)',
      borderRadius: 14,
      padding: '18px 20px',
      minHeight: CARD_MIN_HEIGHT,
      animation: 'pulse 1.5s ease-in-out infinite',
    }}>
      <div style={{ height: 10, width: '55%', background: '#e5e7eb', borderRadius: 6, marginBottom: 14 }} />
      <div style={{ height: 28, width: '70%', background: '#e5e7eb', borderRadius: 6, marginBottom: 10 }} />
      <div style={{ height: 10, width: '40%', background: '#e5e7eb', borderRadius: 6 }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payment badge colors
// ---------------------------------------------------------------------------

const PAYMENT_BADGE = {
  CASH: 'badge-ok',
  UPI:  'badge-info',
  CARD: 'badge-accent',
};

// ---------------------------------------------------------------------------
// Stat card definition
// ---------------------------------------------------------------------------

/**
 * The three spend categories shown as pills under each expenditure card.
 * Supplier lumps together money paid at the door and money paid off an older
 * debt — from the owner's point of view both are "paid the distributor", and
 * two near-identical pills would only add noise.  The panel still lists them
 * separately with their own badges.
 */
function spendPills(period) {
  if (!period) return [];
  const supplier = Number(period.supplier_payments ?? 0) + Number(period.credit_payments ?? 0);
  return [
    { icon: '🏪', label: 'Supplier', amount: supplier,                    color: '#0284c7' },
    { icon: '📋', label: 'Expenses', amount: Number(period.expenses ?? 0), color: '#d97706' },
    { icon: '👤', label: 'Salary',   amount: Number(period.salary ?? 0),   color: '#059669' },
  ].filter(p => p.amount > 0);   // hide categories with nothing in them
}

/**
 * The 8 stat cards, in the order they appear in the 4-column grid:
 *
 *   Row 1 │ Today's Sales · Monthly Sales · Inventory Value · Total Patients
 *   Row 2 │ Expiry Alerts · Low Stock · Today's Expenditure · Month Expenditure
 *
 * Order matters — the grid fills left-to-right, so moving an entry in this
 * array moves the card on screen.  Keep the count at 8 or the second row will
 * be ragged.
 *
 * A card may optionally carry a `footer`: JSX pinned to the bottom of the card
 * (see the `marginTop: 'auto'` wrapper in the render below).  Pinning rather
 * than simply appending is what keeps the headline number of all 8 cards on
 * the same baseline.
 */
function buildCards(data, navigate, spend, openPanel) {
  const month = currentMonthName();
  // Older backends (before patients_today was added) would leave this
  // undefined; falling back to zeros keeps the card rendering instead of
  // crashing the whole dashboard on a property read.
  const patients = data.patients_today ?? { total: 0, new_patients: 0, returning: 0 };

  return [
    {
      label: "Today's Sales",
      value: formatINR(data.today_sales),
      sub: "Today's revenue",
      subColor: '#6366f1',
      gradient: 'linear-gradient(90deg, #6366f1, #8b5cf6)',
      icon: (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
        </svg>
      ),
    },
    {
      label: 'Monthly Sales',
      value: formatINR(data.monthly_sales),
      sub: `${month} total`,
      subColor: '#0ea5e9',
      gradient: 'linear-gradient(90deg, #0ea5e9, #38bdf8)',
      icon: (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
      ),
    },
    {
      label: 'Inventory Value',
      value: formatINR(data.inventory_value),
      sub: 'Stock on hand',
      subColor: '#10b981',
      gradient: 'linear-gradient(90deg, #10b981, #34d399)',
      icon: (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
        </svg>
      ),
    },
    // ── Footfall: how many patients came in today ──────────────────────
    // The headline is DISTINCT patients billed today; the footer splits them
    // into first-timers and repeat customers.  Walk-in sales (no patient
    // record attached) are not counted — see the backend comment.
    {
      label: 'Total Patients',
      value: patients.total,
      sub: 'Patients seen today',
      subColor: '#8b5cf6',
      gradient: 'linear-gradient(90deg, #8b5cf6, #a78bfa)',
      footer: (
        <div style={{
          paddingTop: 12,
          borderTop: '1px solid rgba(0,0,0,0.06)',
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 12,
        }}>
          <div>
            <span style={{ color: '#94a3b8' }}>New </span>
            <span style={{ fontWeight: 700, color: '#6366f1' }}>{patients.new_patients}</span>
          </div>
          <div>
            <span style={{ color: '#94a3b8' }}>Returning </span>
            <span style={{ fontWeight: 700, color: '#10b981' }}>{patients.returning}</span>
          </div>
        </div>
      ),
      icon: (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
        </svg>
      ),
    },
    {
      label: 'Expiry Alerts',
      value: data.expiry_alerts_count,
      // 60 days is EXPIRY_ALERT_HORIZON_DAYS in inventory_service.py — the
      // single constant the sidebar badge, this card and the Expiry Alerts
      // page all count off.  If that changes, change this label too.
      sub: 'Within 60 days',
      subColor: '#f43f5e',
      gradient: 'linear-gradient(90deg, #f43f5e, #fb7185)',
      clickable: data.expiry_alerts_count > 0,
      onClick: () => navigate('/expiry-alerts'),
      icon: (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      ),
    },
    {
      label: 'Low Stock',
      value: data.low_stock_count,
      sub: 'Below minimum',
      subColor: '#f59e0b',
      gradient: 'linear-gradient(90deg, #f59e0b, #fbbf24)',
      clickable: data.low_stock_count > 0,
      onClick: () => navigate('/inventory'),
      icon: (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      ),
    },
    // ── Money OUT, today ───────────────────────────────────────────────
    // Always clickable, even at ₹0 — "nothing went out today" is a useful
    // thing to be able to confirm, and a dead card would look broken.
    {
      label: "Today's Expenditure",
      value: formatINR(spend?.today?.total ?? 0),
      sub: 'Money out today',
      subColor: '#d97706',
      gradient: 'linear-gradient(90deg, #d97706, #fbbf24)',
      clickable: !!spend,
      onClick: spend ? () => openPanel('today') : undefined,
      pills: spendPills(spend?.today),
      icon: (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1v22"/>
          <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
        </svg>
      ),
    },
    // ── Money OUT, this month ──────────────────────────────────────────
    {
      label: `${month} Expenditure`,
      value: formatINR(spend?.month?.total ?? 0),
      sub: "This month's total",
      subColor: '#8b5cf6',
      gradient: 'linear-gradient(90deg, #8b5cf6, #c084fc)',
      clickable: !!spend,
      onClick: spend ? () => openPanel('month') : undefined,
      pills: spendPills(spend?.month),
      icon: (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const navigate = useNavigate();
  const user     = getUser();
  const firstName = user?.full_name?.split(' ')[0] ?? 'there';

  const [data,              setData]          = useState(null);
  const [loading,           setLoading]       = useState(true);
  const [error,             setError]         = useState('');
  const [followUpCount,     setFollowUpCount] = useState(null);
  const [creditSummary,     setCreditSummary] = useState(null);
  // Supplier credit = money the pharmacy OWES (opposite direction to the above)
  const [supplierCredit,    setSupplierCredit] = useState(null);
  // Expenditure = money that has already LEFT the pharmacy (today + this month)
  const [spend,             setSpend]         = useState(null);
  // Which expenditure panel is open: null | 'today' | 'month'
  const [spendPanel,        setSpendPanel]    = useState(null);

  useEffect(() => {
    api.get('/dashboard/summary')
      .then(({ data: d }) => { setData(d); setLoading(false); })
      .catch(() => { setError('Could not load dashboard data. Is the server running?'); setLoading(false); });
  }, []);

  // Load pending follow-up count independently
  useEffect(() => {
    api.get('/followup/pending')
      .then(({ data: rows }) => setFollowUpCount(rows.length))
      .catch(() => setFollowUpCount(0));
  }, []);

  // Load credit overdue summary independently
  useEffect(() => {
    api.get('/credit/summary')
      .then(({ data: d }) => setCreditSummary(d))
      .catch(() => setCreditSummary(null));
  }, []);

  // Load SUPPLIER credit (money we owe) independently — Feature 1.
  // Kept as its own request so a failure here never blanks the dashboard.
  useEffect(() => {
    api.get('/supplier-credit/due-soon')
      .then(({ data: d }) => setSupplierCredit(d))
      .catch(() => setSupplierCredit(null));
  }, []);

  // Load expenditure (money out) independently — its own request so a failure
  // here leaves the rest of the dashboard intact.
  useEffect(() => {
    api.get('/dashboard/expenditure-summary')
      .then(({ data: d }) => setSpend(d))
      .catch(() => setSpend(null));
  }, []);

  const cards = data ? buildCards(data, navigate, spend, setSpendPanel) : [];

  return (
    <div>
      {/* ── Heading ───────────────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1e1b4b', marginBottom: 2 }}>
          Dashboard
        </h1>
        <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 2 }}>
          {greeting()}, {firstName}
        </p>
        <p style={{ fontSize: 12, color: '#9ca3af' }}>{todayLabel()}</p>
      </div>

      {/* ── Error banner ──────────────────────────────────────────── */}
      {error && (
        <div style={{
          background: 'rgba(244,63,94,0.08)',
          border: '1px solid rgba(244,63,94,0.2)',
          color: '#e11d48',
          borderRadius: 10,
          padding: '10px 16px',
          fontSize: 13,
          marginBottom: 18,
        }}>
          {error}
        </div>
      )}

      {/* ── Stat cards — 2 rows of 4 (grid lives in global.css) ───── */}
      <div className="stats-grid">
        {loading
          ? Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)
          : cards.map((card) => (
            <div
              key={card.label}
              className="fade-up"
              onClick={card.onClick}
              style={{
                background: 'rgba(255,255,255,0.52)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid rgba(255,255,255,0.75)',
                borderRadius: 14,
                padding: '18px 20px',
                boxShadow: '0 4px 20px rgba(99,102,241,0.06)',
                position: 'relative',
                overflow: 'hidden',
                cursor: card.clickable ? 'pointer' : 'default',
                transition: 'transform 0.15s, box-shadow 0.15s',
                // height 100% makes every card fill its grid row, so the two
                // rows are flush even when one card has more content than the
                // rest.  The flex column below is what lets the footer/pills
                // block push itself to the bottom with marginTop: 'auto'.
                height: '100%',
                minHeight: CARD_MIN_HEIGHT,
                display: 'flex',
                flexDirection: 'column',
              }}
              onMouseEnter={(e) => {
                if (card.clickable) {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 8px 28px rgba(99,102,241,0.12)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = '';
                e.currentTarget.style.boxShadow = '0 4px 20px rgba(99,102,241,0.06)';
              }}
            >
              {/* Top colour bar */}
              <div style={{
                position: 'absolute', top: 0, left: 0, right: 0, height: 3,
                background: card.gradient, borderRadius: '14px 14px 0 0',
              }} />

              {/* Background glyph */}
              <div style={{
                position: 'absolute', top: 10, right: 10,
                opacity: 0.08, pointerEvents: 'none', color: card.subColor,
              }}>
                {card.icon}
              </div>

              <div style={{
                fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em',
                color: '#9ca3af', marginBottom: 8, marginTop: 6,
              }}>
                {card.label}
                {card.clickable && (
                  <span style={{ marginLeft: 6, fontSize: 9, opacity: 0.6 }}>↗</span>
                )}
              </div>

              <div style={{ fontSize: 26, fontWeight: 700, color: '#1e1b4b' }}>
                {card.value}
              </div>

              <div style={{ fontSize: 11, color: card.subColor, marginTop: 4 }}>
                {card.sub}
              </div>

              {/* Bottom block — the new/returning split on the Patients card.
                  marginTop:'auto' pins it to the bottom of the flex column so
                  the headline numbers stay aligned across all 8 cards. */}
              {card.footer && (
                <div style={{ marginTop: 'auto', paddingTop: 8 }}>
                  {card.footer}
                </div>
              )}

              {/* Category breakdown pills (expenditure cards only).
                  Pinned to the bottom for the same reason as the footer above.
                  They wrap rather than shrink, so a long figure like
                  ₹1,25,000 never gets clipped on a narrow grid column. */}
              {card.pills?.length > 0 && (
                <div style={{
                  display: 'flex', flexWrap: 'wrap', gap: 5,
                  marginTop: 'auto', paddingTop: 9,
                }}>
                  {card.pills.map((pill) => (
                    <span
                      key={pill.label}
                      title={`${pill.label}: ${formatINR(pill.amount)}`}
                      style={{
                        fontSize: 10, fontWeight: 600,
                        padding: '2px 7px', borderRadius: 6,
                        background: 'rgba(0,0,0,0.04)',
                        color: pill.color,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {pill.icon} {pill.label} {formatINR(pill.amount)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))
        }
      </div>

      {/* ── Expenditure history panel (slide-in from the right) ────── */}
      {/*
        Both cards share ONE panel; `spendPanel` decides which period it shows.
        The monthly view groups by day, today's view is a flat list.
      */}
      <ExpenditurePanel
        open={spendPanel !== null}
        onClose={() => setSpendPanel(null)}
        title={spendPanel === 'month'
          ? `${currentMonthName()} Expenditure`
          : "Today's Expenditure"}
        period={spendPanel === 'month' ? spend?.month : spend?.today}
        grouped={spendPanel === 'month'}
      />

      {/* ── Follow-Up Alert Widget ────────────────────────────────── */}
      {followUpCount !== null && followUpCount > 0 && (
        <div
          onClick={() => navigate('/follow-ups')}
          className="fade-up"
          style={{
            display: 'flex', alignItems: 'center', gap: 16,
            background: 'rgba(255,255,255,0.52)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.75)',
            borderTop: '3px solid #f59e0b',
            borderRadius: 14,
            padding: '14px 20px',
            marginBottom: 20,
            cursor: 'pointer',
            boxShadow: '0 4px 20px rgba(245,158,11,0.10)',
            transition: 'transform 0.15s, box-shadow 0.15s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = '0 8px 28px rgba(245,158,11,0.18)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.transform = '';
            e.currentTarget.style.boxShadow = '0 4px 20px rgba(245,158,11,0.10)';
          }}
        >
          {/* Icon */}
          <div style={{
            width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
            background: 'rgba(245,158,11,0.12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20,
          }}>
            📋
          </div>

          {/* Text */}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1e1b4b' }}>
              {followUpCount} follow-up{followUpCount !== 1 ? 's' : ''} due today
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              Patients waiting for a check-in call or message
            </div>
          </div>

          {/* Arrow */}
          <div style={{ fontSize: 18, color: '#f59e0b', fontWeight: 700, flexShrink: 0 }}>
            →
          </div>
        </div>
      )}

      {/* ── Credit Overdue Alert Widget ────────────────────────────── */}
      {creditSummary !== null && creditSummary.overdue_amount > 0 && (
        <div
          onClick={() => navigate('/credit?tab=overdue')}
          className="fade-up"
          style={{
            display: 'flex', alignItems: 'center', gap: 16,
            background: 'rgba(255,255,255,0.52)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.75)',
            borderTop: '3px solid #e11d48',
            borderRadius: 14,
            padding: '14px 20px',
            marginBottom: 20,
            cursor: 'pointer',
            boxShadow: '0 4px 20px rgba(225,29,72,0.08)',
            transition: 'transform 0.15s, box-shadow 0.15s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = '0 8px 28px rgba(225,29,72,0.14)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.transform = '';
            e.currentTarget.style.boxShadow = '0 4px 20px rgba(225,29,72,0.08)';
          }}
        >
          <div style={{
            width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
            background: 'rgba(225,29,72,0.10)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20,
          }}>
            💳
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1e1b4b' }}>
              Credit overdue: {'₹' + Number(creditSummary.overdue_amount).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              {' · '}{creditSummary.overdue_count} patient{creditSummary.overdue_count !== 1 ? 's' : ''}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              Past-due credit accounts need attention
            </div>
          </div>
          <div style={{ fontSize: 18, color: '#e11d48', fontWeight: 700, flexShrink: 0 }}>→</div>
        </div>
      )}

      {/* ── Supplier Credit Widget (Feature 1) ─────────────────────── */}
      {/*
        Only shown when we actually owe someone money.  The card turns red for
        overdue payments and amber for ones merely coming due, because "you are
        late" and "plan ahead" need to look different at a glance.
      */}
      {supplierCredit !== null && Number(supplierCredit.total_outstanding) > 0 && (() => {
        const overdue    = supplierCredit.overdue ?? [];
        const upcoming   = supplierCredit.upcoming ?? [];
        const isOverdue  = overdue.length > 0;
        const accent     = isOverdue ? '#e11d48' : '#d97706';
        const glow       = isOverdue ? 'rgba(225,29,72,'   : 'rgba(217,119,6,';

        // Lead with the single most urgent line: the oldest overdue payment,
        // or failing that the next one falling due.
        const lead = isOverdue ? overdue[0] : upcoming[0];
        let detail = 'All supplier payments are up to date';
        if (lead) {
          const amt = '₹' + Number(lead.amount_due).toLocaleString('en-IN', { maximumFractionDigits: 0 });
          detail = isOverdue
            ? `${amt} overdue to ${lead.supplier_name}`
            : `${amt} due in ${lead.days_until_due} day${lead.days_until_due === 1 ? '' : 's'} to ${lead.supplier_name}`;
        }

        return (
          <div
            onClick={() => navigate('/suppliers?tab=credit')}
            className="fade-up"
            style={{
              display: 'flex', alignItems: 'center', gap: 16,
              background: 'rgba(255,255,255,0.52)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              border: '1px solid rgba(255,255,255,0.75)',
              borderTop: `3px solid ${accent}`,
              borderRadius: 14,
              padding: '14px 20px',
              marginBottom: 20,
              cursor: 'pointer',
              boxShadow: `0 4px 20px ${glow}0.08)`,
              transition: 'transform 0.15s, box-shadow 0.15s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = `0 8px 28px ${glow}0.14)`;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.transform = '';
              e.currentTarget.style.boxShadow = `0 4px 20px ${glow}0.08)`;
            }}
          >
            <div style={{
              width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
              background: `${glow}0.10)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 20,
            }}>
              🏪
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#1e1b4b' }}>
                Supplier Credit: {formatINR(supplierCredit.total_outstanding)} outstanding
              </div>
              <div style={{ fontSize: 12, color: isOverdue ? '#e11d48' : '#6b7280', marginTop: 2 }}>
                {isOverdue ? '❌ ' : upcoming.length > 0 ? '⚠ ' : ''}{detail}
              </div>
            </div>
            <div style={{ fontSize: 18, color: accent, fontWeight: 700, flexShrink: 0 }}>→</div>
          </div>
        );
      })()}

      {/* ── This Month's Expenses Widget ───────────────────────────── */}
      {data && data.monthly_expenses > 0 && (
        <div
          onClick={() => navigate('/expenditure')}
          className="fade-up"
          style={{
            display: 'flex', alignItems: 'center', gap: 16,
            background: 'rgba(255,255,255,0.52)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.75)',
            borderTop: '3px solid #6366f1',
            borderRadius: 14,
            padding: '14px 20px',
            marginBottom: 20,
            cursor: 'pointer',
            boxShadow: '0 4px 20px rgba(99,102,241,0.08)',
            transition: 'transform 0.15s, box-shadow 0.15s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = '0 8px 28px rgba(99,102,241,0.14)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.transform = '';
            e.currentTarget.style.boxShadow = '0 4px 20px rgba(99,102,241,0.08)';
          }}
        >
          <div style={{
            width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
            background: 'rgba(99,102,241,0.10)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20,
          }}>
            💸
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1e1b4b' }}>
              This month's expenses: {formatINR(data.monthly_expenses)}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              {data.top_expense_categories?.length
                ? 'Top: ' + data.top_expense_categories
                    .map(c => `${c.category} (${formatINR(c.amount)})`)
                    .join(' · ')
                : 'Salaries, rent, utilities and more'}
            </div>
          </div>
          <div style={{ fontSize: 18, color: '#6366f1', fontWeight: 700, flexShrink: 0 }}>→</div>
        </div>
      )}

      {/* ── Two-column panel row ───────────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: 16,
      }}>

        {/* Recent Invoices */}
        <div style={{
          background: 'rgba(255,255,255,0.52)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.75)',
          borderRadius: 14,
          padding: '18px 20px',
          boxShadow: '0 4px 20px rgba(99,102,241,0.06)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#1e1b4b' }}>
              Recent Invoices
            </span>
            <span
              onClick={() => navigate('/invoices')}
              style={{ fontSize: 11, color: '#6366f1', cursor: 'pointer', fontWeight: 500 }}
            >
              View all →
            </span>
          </div>

          {loading ? (
            [1, 2, 3].map((i) => (
              <div key={i} style={{ height: 36, background: '#e5e7eb', borderRadius: 6, marginBottom: 8, animation: 'pulse 1.5s ease-in-out infinite' }} />
            ))
          ) : data?.recent_invoices?.length === 0 ? (
            <p style={{ fontSize: 13, color: '#9ca3af' }}>No invoices today yet</p>
          ) : (
            data?.recent_invoices?.map((inv) => (
              <div key={inv.invoice_number} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 0',
                borderBottom: '1px solid rgba(0,0,0,0.04)',
              }}>
                <span style={{ fontSize: 11, color: '#6366f1', fontWeight: 600, minWidth: 110 }}>
                  {inv.invoice_number}
                </span>
                <span style={{ fontSize: 12, color: '#374151', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {inv.patient_name}
                </span>
                <span className={`badge ${PAYMENT_BADGE[inv.payment_method] ?? 'badge-neutral'}`}>
                  {inv.payment_method ?? '—'}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#1e1b4b', minWidth: 70, textAlign: 'right' }}>
                  {formatINR(inv.total_amount)}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Top Products This Month */}
        <div style={{
          background: 'rgba(255,255,255,0.52)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.75)',
          borderRadius: 14,
          padding: '18px 20px',
          boxShadow: '0 4px 20px rgba(99,102,241,0.06)',
        }}>
          <div style={{ marginBottom: 14 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#1e1b4b' }}>
              Top Products This Month
            </span>
          </div>

          {loading ? (
            [1, 2, 3].map((i) => (
              <div key={i} style={{ height: 36, background: '#e5e7eb', borderRadius: 6, marginBottom: 8, animation: 'pulse 1.5s ease-in-out infinite' }} />
            ))
          ) : data?.top_products?.length === 0 ? (
            <p style={{ fontSize: 13, color: '#9ca3af' }}>No sales this month yet</p>
          ) : (
            data?.top_products?.map((prod, idx) => (
              <div key={prod.product_name} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 0',
                borderBottom: '1px solid rgba(0,0,0,0.04)',
              }}>
                <span style={{
                  fontSize: 11, fontWeight: 700, color: '#fff',
                  background: idx === 0 ? '#6366f1' : idx === 1 ? '#0ea5e9' : '#10b981',
                  borderRadius: '50%', width: 20, height: 20,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {idx + 1}
                </span>
                <span style={{ fontSize: 12, color: '#374151', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {prod.product_name}
                </span>
                <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 50, textAlign: 'right' }}>
                  {prod.units_sold} units
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#1e1b4b', minWidth: 70, textAlign: 'right' }}>
                  {formatINR(prod.revenue)}
                </span>
              </div>
            ))
          )}
        </div>

      </div>
    </div>
  );
}
