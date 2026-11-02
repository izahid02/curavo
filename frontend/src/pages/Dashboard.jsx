/**
 * Dashboard — Curavo design (Nov 2026), wired to real data.
 *
 * Layout, top to bottom (the greeting, search and "New bill" live in the
 * header, which Layout.jsx draws for this route):
 *   1. Four stat cards   — today's sales, this month, stock value, patients today
 *   2. Needs attention   — every "go and do something" item in ONE list, built
 *                          from real data (expiry, low stock, supplier dues,
 *                          patient credit, follow-ups, missing generic names).
 *      Recent bills      — the latest invoices from the summary endpoint.
 *   3. Money out today   — the expenditure strip; opens the same slide-in
 *                          ExpenditurePanel the old cards opened.
 *
 * HONESTY RULE: every figure and line on this screen comes from the backend.
 * Nothing is decorative.  Where the design board showed a figure the app does
 * not track (e.g. "12% vs last Monday"), the card says something true instead.
 *
 * Each data source is its own request, so one failing never blanks the page.
 * All amounts use the Indian numbering system (₹1,24,500).
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import ExpenditurePanel from '../components/dashboard/ExpenditurePanel';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Whole rupees, Indian grouping: 124580 -> "₹1,24,580". */
function formatINR(amount) {
  if (amount === null || amount === undefined) return '—';
  return '₹' + Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

/** Rupees and paise, for bill amounts: 186.5 -> "₹186.50". */
function formatINR2(amount) {
  if (amount === null || amount === undefined) return '—';
  return '₹' + Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function currentMonthName() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: 'long' });
}

function dayOfMonthIST() {
  return Number(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric' }));
}

/** "CASH" -> "Cash" for the mode pill; UPI stays an acronym. */
function titleCase(s) {
  if (!s) return '—';
  if (s === 'UPI') return 'UPI';
  return s.charAt(0) + s.slice(1).toLowerCase();
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------
// Shared glass surface (same recipe as .card, with the softer Curavo shadow)
// ---------------------------------------------------------------------------

const GLASS = {
  background: 'rgba(255,255,255,0.55)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  border: '1px solid rgba(255,255,255,0.85)',
  borderRadius: 18,
  boxShadow: '0 8px 28px rgba(79,70,229,0.07)',
};

/** Status colours: [text, background].  Text shades pass AA on the tint. */
const TONE = {
  amber:  ['#b45309', 'rgba(245,158,11,0.16)'],
  blue:   ['#0369a1', 'rgba(14,165,233,0.14)'],
  rose:   ['#be123c', 'rgba(244,63,94,0.13)'],
  green:  ['#047857', 'rgba(16,185,129,0.14)'],
  indigo: ['#4338ca', 'rgba(99,102,241,0.13)'],
};
const DOT = { amber: '#f59e0b', blue: '#0ea5e9', rose: '#f43f5e', green: '#10b981', indigo: '#6366f1' };

/** Bill payment mode -> pill tone. */
const MODE_TONE = { CASH: 'green', UPI: 'indigo', CARD: 'blue', CREDIT: 'amber' };

function Pill({ tone, children }) {
  const [color, bg] = TONE[tone] ?? TONE.indigo;
  return (
    <span style={{
      fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 999,
      whiteSpace: 'nowrap', color, background: bg,
    }}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

/** Line icons for the four cards (24x24 stroke paths). */
const CARD_ICON = {
  sales:    'M4 20V10M10 20V4M16 20v-7',
  month:    'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  stock:    'M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7',
  patients: 'M16 19v-1a4 4 0 00-8 0v1M12 11a3 3 0 100-6 3 3 0 000 6z',
};

function StatCard({ label, value, sub, subTone, bar, icon, iconTone, onClick, loading, delay }) {
  const [iconColor, iconBg] = TONE[iconTone];
  return (
    <button
      onClick={onClick}
      className="fade-up"
      style={{
        ...GLASS,
        animationDelay: `${delay}s`,
        position: 'relative', overflow: 'hidden', textAlign: 'left',
        padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 8,
        cursor: 'pointer', color: 'inherit', font: 'inherit',
        transition: 'transform 0.15s, box-shadow 0.15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 12px 32px rgba(79,70,229,0.12)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = GLASS.boxShadow; }}
    >
      {/* Gradient strip along the top — kept from the original design */}
      <span style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 3, background: bar }} />
      <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 34, height: 34, borderRadius: 10, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: iconColor, background: iconBg,
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={CARD_ICON[icon]} />
          </svg>
        </span>
        <span style={{ fontSize: 14, color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</span>
      </span>
      {loading ? (
        <span style={{ height: 34, width: '60%', borderRadius: 8, background: 'rgba(99,102,241,0.08)', animation: 'pulse 1.5s ease-in-out infinite' }} />
      ) : (
        <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em', color: '#1e1b4b', lineHeight: 1.15 }}>
          {value}
        </span>
      )}
      <span style={{ fontSize: 13, fontWeight: subTone === 'green' ? 600 : 500, color: subTone === 'green' ? '#047857' : 'var(--text-hint)' }}>
        {sub}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// "Needs attention" — one list for everything that wants action
// ---------------------------------------------------------------------------

/**
 * Turn the separate data sources into attention rows, most urgent first.
 * Each source is optional: a source that failed to load simply adds nothing.
 */
function buildAttention({ summary, supplier, credit, followUps, gaps }) {
  const rows = [];

  // 1. Supplier money — overdue beats coming due.
  if (supplier) {
    const overdue  = supplier.overdue ?? [];
    const upcoming = supplier.upcoming ?? [];
    if (overdue.length > 0) {
      const lead = overdue[0];
      const late = Math.abs(lead.days_until_due ?? 0);
      rows.push({
        key: 'supplier-overdue', tone: 'rose',
        title: lead.supplier_name,
        sub: `Supplier payment overdue${late ? ` by ${plural(late, 'day')}` : ''}`
           + (overdue.length > 1 ? ` · ${overdue.length - 1} more overdue` : ''),
        tag: formatINR(lead.amount_due),
        to: '/suppliers?tab=credit',
      });
    } else if (upcoming.length > 0) {
      const lead = upcoming[0];
      const d = lead.days_until_due;
      const when = d === 0 ? 'today'
        : d === 1 ? 'tomorrow'
        : lead.due_date
          ? new Date(lead.due_date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long' })
          : `in ${plural(d, 'day')}`;
      rows.push({
        key: 'supplier-due', tone: 'amber',
        title: lead.supplier_name,
        sub: `Supplier payment due ${when}`,
        tag: formatINR(lead.amount_due),
        to: '/suppliers?tab=credit',
      });
    }
  }

  // 2. Expiry — same 60-day count as the sidebar badge and the Expiry page.
  if (summary?.expiry_alerts_count > 0) {
    rows.push({
      key: 'expiry', tone: 'amber',
      title: `${plural(summary.expiry_alerts_count, 'medicine')} expiring soon`,
      sub: 'Within 60 days · check what must go back to the supplier',
      tag: 'Review',
      to: '/expiry-alerts',
    });
  }

  // 3. Low stock.
  if (summary?.low_stock_count > 0) {
    rows.push({
      key: 'low-stock', tone: 'blue',
      title: `${plural(summary.low_stock_count, 'medicine')} low on stock`,
      sub: 'Below their minimum stock level',
      tag: 'Reorder',
      to: '/inventory',
    });
  }

  // 4. Patient credit past due (money owed TO the shop).
  if (credit && Number(credit.overdue_amount) > 0) {
    rows.push({
      key: 'credit', tone: 'amber',
      title: 'Patient credit overdue',
      sub: `${plural(credit.overdue_count, 'patient')} past their due date`,
      tag: formatINR(credit.overdue_amount),
      to: '/credit?tab=overdue',
    });
  }

  // 5. Follow-ups due today.
  if (followUps > 0) {
    rows.push({
      key: 'followups', tone: 'indigo',
      title: `${plural(followUps, 'follow-up')} due today`,
      sub: 'Patients waiting for a check-in call or message',
      tag: 'Open',
      to: '/follow-ups',
    });
  }

  // 6. Medicines the Schedule H1 check cannot see (no generic name).
  if (gaps > 0) {
    rows.push({
      key: 'gaps', tone: 'rose',
      title: `${plural(gaps, 'medicine')} missing a generic name`,
      sub: 'Schedule H1 check cannot see them',
      tag: 'Fix now',
      to: '/inventory',
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const navigate = useNavigate();

  const [data,      setData]      = useState(null);   // /dashboard/summary
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [followUps, setFollowUps] = useState(0);      // due today
  const [credit,    setCredit]    = useState(null);   // patient credit (owed TO us)
  const [supplier,  setSupplier]  = useState(null);   // supplier dues (we OWE)
  const [gaps,      setGaps]      = useState(0);      // medicines with no generic name
  const [spend,     setSpend]     = useState(null);   // money out, today + month
  const [spendPanel, setSpendPanel] = useState(null); // null | 'today' | 'month'
  const [showAll,   setShowAll]   = useState(false);  // "View all" in Needs attention

  useEffect(() => {
    api.get('/dashboard/summary')
      .then(({ data: d }) => { setData(d); setLoading(false); })
      .catch(() => { setError('Could not load dashboard data. Is the server running?'); setLoading(false); });
    // Every other source is independent: a failure leaves the rest intact.
    api.get('/followup/stats').then(({ data: d }) => setFollowUps(d.due_today ?? 0)).catch(() => {});
    api.get('/credit/summary').then(({ data: d }) => setCredit(d)).catch(() => {});
    api.get('/supplier-credit/due-soon').then(({ data: d }) => setSupplier(d)).catch(() => {});
    api.get('/regulated/missing-generic').then(({ data: d }) => setGaps(Array.isArray(d) ? d.length : 0)).catch(() => {});
    api.get('/dashboard/expenditure-summary').then(({ data: d }) => setSpend(d)).catch(() => {});
  }, []);

  const pt = data?.patients_today;
  const cards = [
    {
      label: "Today's sales", value: formatINR(data?.today_sales),
      sub: 'Sales so far today', icon: 'sales', iconTone: 'indigo',
      bar: 'linear-gradient(90deg,#6366f1,#8b5cf6)', onClick: () => navigate('/invoices'),
    },
    {
      label: 'This month', value: formatINR(data?.monthly_sales),
      sub: `${plural(dayOfMonthIST(), 'day')} into ${currentMonthName()}`, icon: 'month', iconTone: 'blue',
      bar: 'linear-gradient(90deg,#0ea5e9,#6366f1)', onClick: () => navigate('/reports'),
    },
    {
      label: 'Stock value', value: formatINR(data?.inventory_value),
      sub: 'Current stock on hand', icon: 'stock', iconTone: 'green',
      bar: 'linear-gradient(90deg,#10b981,#0ea5e9)', onClick: () => navigate('/inventory'),
    },
    {
      label: 'Patients today', value: pt ? String(pt.total) : '—',
      sub: pt ? `${pt.new_patients} new · ${pt.returning} returning` : 'Billed patients today',
      subTone: pt && pt.total > 0 ? 'green' : undefined,
      icon: 'patients', iconTone: 'rose',
      bar: 'linear-gradient(90deg,#ec4899,#8b5cf6)', onClick: () => navigate('/patients'),
    },
  ];

  const attention = buildAttention({ summary: data, supplier, credit, followUps, gaps });
  const shown     = showAll ? attention : attention.slice(0, 4);

  // Money out today — supplier payments (paid at the door + settled debts),
  // expenses, salary; and what falls due to suppliers in the next 7 days.
  const today       = spend?.today;
  const supplierOut = today ? Number(today.supplier_payments) + Number(today.credit_payments) : 0;
  const duesWeek    = supplier
    ? [...(supplier.upcoming ?? []), ...(supplier.overdue ?? [])]
        .reduce((sum, r) => sum + Number(r.amount_due), 0)
    : null;

  const bills = data?.recent_invoices ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {error && (
        <div style={{
          background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)',
          color: '#be123c', borderRadius: 12, padding: '10px 16px', fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {/* ── 1. Stat cards ─────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
        {cards.map((c, i) => <StatCard key={c.label} {...c} loading={loading} delay={i * 0.05} />)}
      </div>

      {/* ── 2. Needs attention + Recent bills ─────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>

        <section className="fade-up" style={{ ...GLASS, animationDelay: '0.2s', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: '#1e1b4b' }}>Needs attention</h2>
            {attention.length > 4 && (
              <button
                onClick={() => setShowAll((v) => !v)}
                style={{ background: 'none', padding: 0, fontSize: 14, fontWeight: 500, color: 'var(--accent-dark)' }}
              >
                {showAll ? 'Show less' : `View all (${attention.length})`}
              </button>
            )}
          </div>

          {loading ? (
            [0, 1, 2].map((i) => (
              <div key={i} style={{ height: 58, borderRadius: 14, background: 'rgba(255,255,255,0.5)', animation: 'pulse 1.5s ease-in-out infinite' }} />
            ))
          ) : attention.length === 0 ? (
            <div style={{ padding: '18px 14px', borderRadius: 14, background: 'rgba(16,185,129,0.10)', color: '#047857', fontSize: 14, fontWeight: 500 }}>
              All clear — nothing needs your attention right now.
            </div>
          ) : (
            shown.map((r) => (
              <button
                key={r.key}
                onClick={() => navigate(r.to)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left',
                  padding: '12px 14px', borderRadius: 14, background: 'rgba(255,255,255,0.6)',
                  color: 'inherit', font: 'inherit', width: '100%',
                }}
              >
                <span style={{ width: 10, height: 10, borderRadius: 999, flexShrink: 0, background: DOT[r.tone] }} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: '#1e1b4b' }}>{r.title}</span>
                  <span style={{ fontSize: 13, color: 'var(--text-hint)' }}>{r.sub}</span>
                </span>
                <Pill tone={r.tone}>{r.tag}</Pill>
              </button>
            ))
          )}
        </section>

        <section className="fade-up" style={{ ...GLASS, animationDelay: '0.25s', padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: '#1e1b4b' }}>Recent bills</h2>
            <button
              onClick={() => navigate('/invoices')}
              style={{ background: 'none', padding: 0, fontSize: 14, fontWeight: 500, color: 'var(--accent-dark)' }}
            >
              Invoice history
            </button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ padding: '8px 6px' }}>Invoice</th>
                  <th style={{ padding: '8px 6px' }}>Patient</th>
                  <th style={{ padding: '8px 6px' }}>Mode</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  [0, 1, 2].map((i) => (
                    <tr key={i}><td colSpan={4} style={{ padding: '10px 6px' }}>
                      <div style={{ height: 22, borderRadius: 6, background: 'rgba(255,255,255,0.5)', animation: 'pulse 1.5s ease-in-out infinite' }} />
                    </td></tr>
                  ))
                ) : bills.length === 0 ? (
                  <tr style={{ cursor: 'default' }}>
                    <td colSpan={4} style={{ padding: '14px 6px', color: 'var(--text-hint)', fontSize: 14 }}>
                      No bills yet today — press F2 to start one.
                    </td>
                  </tr>
                ) : (
                  bills.map((b) => (
                    <tr key={b.invoice_number} onClick={() => navigate('/invoices')}>
                      <td style={{ padding: '12px 6px', fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap' }}>{b.invoice_number}</td>
                      <td style={{ padding: '12px 6px', fontSize: 14, color: 'var(--text-secondary)' }}>{b.patient_name}</td>
                      <td style={{ padding: '12px 6px' }}>
                        <Pill tone={MODE_TONE[b.payment_method] ?? 'indigo'}>{titleCase(b.payment_method)}</Pill>
                      </td>
                      <td style={{ padding: '12px 6px', textAlign: 'right', fontSize: 14, fontWeight: 600 }}>{formatINR2(b.total_amount)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* ── 3. Money out today ────────────────────────────────────── */}
      <section className="fade-up" style={{
        ...GLASS, animationDelay: '0.3s',
        padding: '20px 24px', display: 'flex', flexWrap: 'wrap', gap: 28,
        alignItems: 'center', justifyContent: 'space-between',
      }}>
        <button
          onClick={() => spend && setSpendPanel('today')}
          disabled={!spend}
          style={{ background: 'none', padding: 0, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2, color: 'inherit', font: 'inherit' }}
          title="See every payment made today"
        >
          <span style={{ fontSize: 14, color: 'var(--text-secondary)', fontWeight: 500 }}>Money out today</span>
          <span style={{ fontSize: 26, fontWeight: 600, color: '#1e1b4b' }}>{today ? formatINR2(today.total) : '—'}</span>
        </button>

        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 13, color: 'var(--text-hint)' }}>Supplier payments</span>
            <span style={{ fontSize: 17, fontWeight: 600 }}>{today ? formatINR(supplierOut) : '—'}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 13, color: 'var(--text-hint)' }}>Expenses</span>
            <span style={{ fontSize: 17, fontWeight: 600 }}>{today ? formatINR(today.expenses) : '—'}</span>
          </div>
          {today && Number(today.salary) > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, color: 'var(--text-hint)' }}>Salary</span>
              <span style={{ fontSize: 17, fontWeight: 600 }}>{formatINR(today.salary)}</span>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 13, color: 'var(--text-hint)' }}>Supplier dues this week</span>
            <span style={{ fontSize: 17, fontWeight: 600, color: duesWeek > 0 ? '#b45309' : undefined }}>
              {duesWeek === null ? '—' : formatINR(duesWeek)}
            </span>
          </div>
          {spend?.month && (
            <button
              onClick={() => setSpendPanel('month')}
              style={{ background: 'none', padding: 0, fontSize: 13, fontWeight: 500, color: 'var(--accent-dark)', alignSelf: 'center' }}
            >
              {currentMonthName()}: {formatINR(spend.month.total)} →
            </button>
          )}
        </div>
      </section>

      {/* Slide-in breakdown — same panel the old expenditure cards opened. */}
      <ExpenditurePanel
        open={spendPanel !== null}
        onClose={() => setSpendPanel(null)}
        title={spendPanel === 'month' ? `${currentMonthName()} Expenditure` : "Today's Expenditure"}
        period={spendPanel === 'month' ? spend?.month : spend?.today}
        grouped={spendPanel === 'month'}
      />
    </div>
  );
}
