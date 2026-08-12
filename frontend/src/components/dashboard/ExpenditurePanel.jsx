/**
 * ExpenditurePanel — slide-in history of every rupee that left the pharmacy.
 *
 * Opened by clicking either expenditure card on the Dashboard.  It shows the
 * SAME `breakdown` array the card totalled, so the panel and the card can never
 * disagree — there is no second calculation anywhere.
 *
 * Two shapes, chosen by the `grouped` prop:
 *   grouped = false → a flat list, newest first        (today's card)
 *   grouped = true  → collapsible sections per day     (monthly card)
 *
 * Rendered with createPortal into document.body.  This is not optional: every
 * dashboard card sets backdrop-filter, and a non-`none` backdrop-filter creates
 * a new stacking context, so a fixed-position child would be clipped and
 * painted underneath its neighbours no matter what z-index we gave it.
 * (See the dropdown note in CLAUDE.md section 5 — same trap, same fix.)
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Indian grouping WITH paise — the panel shows exact figures (₹1,500.00). */
function formatMoney(amount) {
  return '₹' + Number(amount ?? 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Rounded Indian grouping for the day-header totals (₹1,500). */
function formatShort(amount) {
  return '₹' + Number(amount ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

/**
 * "2026-07-30" → "30 July 2026".
 * The backend already resolved this to an IST calendar date, so we must NOT
 * push it through a timezone conversion again — splitting the plain string
 * keeps it exactly as the backend intended.
 */
function formatDayHeading(isoDay) {
  const [y, m, d] = isoDay.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Row appearance per entry type
// ---------------------------------------------------------------------------

const TYPE_META = {
  SUPPLIER_PAYMENT: { label: 'SUPPLIER', badge: 'badge-info',    icon: '🏪' },
  CREDIT_PAYMENT:   { label: 'CREDIT',   badge: 'badge-accent',  icon: '💳' },
  EXPENSE:          { label: 'EXPENSE',  badge: 'badge-warn',    icon: '📋' },
  SALARY:           { label: 'SALARY',   badge: 'badge-ok',      icon: '👤' },
};

const FALLBACK_META = { label: 'OTHER', badge: 'badge-neutral', icon: '•' };

// ---------------------------------------------------------------------------
// One transaction row
// ---------------------------------------------------------------------------

function EntryRow({ entry }) {
  const meta = TYPE_META[entry.type] ?? FALLBACK_META;

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '12px 0',
      borderBottom: '1px solid rgba(0,0,0,0.05)',
    }}>
      {/* Time — fixed width so every row's text starts on the same line */}
      <span style={{
        fontSize: 11, color: '#9ca3af', minWidth: 62, flexShrink: 0,
        paddingTop: 2, fontVariantNumeric: 'tabular-nums',
      }}>
        {entry.time || '—'}
      </span>

      {/* Description block */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          marginBottom: 3, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#1e1b4b' }}>
            {meta.icon} {entry.description}
          </span>
          <span className={`badge ${meta.badge}`}>{meta.label}</span>
        </div>

        {entry.paid_to && (
          <div style={{
            fontSize: 12, color: '#6b7280',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {entry.paid_to}
          </div>
        )}

        {entry.payment_mode && (
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
            {entry.payment_mode}
          </div>
        )}
      </div>

      {/* Amount */}
      <span style={{
        fontSize: 13, fontWeight: 700, color: '#1e1b4b',
        flexShrink: 0, paddingTop: 2, fontVariantNumeric: 'tabular-nums',
      }}>
        {formatMoney(entry.amount)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A collapsible day section (monthly view only)
// ---------------------------------------------------------------------------

function DayGroup({ day, entries, expanded, onToggle }) {
  const dayTotal = entries.reduce((sum, e) => sum + Number(e.amount ?? 0), 0);

  return (
    <div style={{ marginBottom: 6 }}>
      {/* Header — the whole strip is the toggle */}
      <div
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 12px',
          background: 'rgba(99,102,241,0.06)',
          borderRadius: 8,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span style={{
          fontSize: 11, color: '#6366f1', fontWeight: 700,
          transition: 'transform 0.15s',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          display: 'inline-block',
        }}>
          ▶
        </span>

        <span style={{ fontSize: 12, fontWeight: 600, color: '#1e1b4b', flex: 1 }}>
          {formatDayHeading(day)}
        </span>

        <span style={{ fontSize: 11, color: '#9ca3af' }}>
          {entries.length} item{entries.length !== 1 ? 's' : ''}
        </span>

        <span style={{ fontSize: 13, fontWeight: 700, color: '#6366f1' }}>
          {formatShort(dayTotal)}
        </span>
      </div>

      {expanded && (
        <div style={{ padding: '0 12px' }}>
          {entries.map((entry, i) => (
            <EntryRow key={`${entry.timestamp}-${i}`} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export default function ExpenditurePanel({ open, onClose, title, period, grouped }) {
  // Which day sections are open.  `null` means "not initialised yet" so the
  // default (today expanded) is applied once, and afterwards the user's own
  // clicks are never overwritten by a re-render.
  const [openDays, setOpenDays] = useState(null);

  const entries = period?.breakdown ?? [];

  // Group entries by their IST calendar date, newest day first.  The backend
  // already sorted the whole list newest-first, so insertion order into the Map
  // gives us the day order for free and each day's rows stay newest-first too.
  const dayGroups = useMemo(() => {
    if (!grouped) return [];
    const map = new Map();
    for (const entry of entries) {
      if (!map.has(entry.date)) map.set(entry.date, []);
      map.get(entry.date).push(entry);
    }
    return Array.from(map.entries()).map(([day, rows]) => ({ day, rows }));
  }, [entries, grouped]);

  // Default: today expanded, every other day collapsed.
  useEffect(() => {
    if (!open || !grouped || openDays !== null || dayGroups.length === 0) return;
    const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    // If today has no spend, fall back to the most recent day that does — an
    // all-collapsed panel looks broken.
    const initial = dayGroups.some(g => g.day === todayISO) ? todayISO : dayGroups[0].day;
    setOpenDays(new Set([initial]));
  }, [open, grouped, dayGroups, openDays]);

  // Reset the expand/collapse state when the panel closes, so reopening it
  // starts from the sensible default again.
  useEffect(() => {
    if (!open) setOpenDays(null);
  }, [open]);

  // Escape closes the panel, and the background must not scroll behind it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const toggleDay = (day) => {
    setOpenDays((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(day)) next.delete(day); else next.add(day);
      return next;
    });
  };

  return createPortal(
    <div
      // Clicking the dimmed backdrop closes; clicks inside the panel do not
      // bubble out to here (see stopPropagation below).
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 3000,
        background: 'rgba(30,27,75,0.28)',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        display: 'flex', justifyContent: 'flex-end',
        animation: 'fadeIn 0.2s ease',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(460px, 100%)',
          height: '100%',
          display: 'flex', flexDirection: 'column',
          background: 'rgba(255,255,255,0.94)',
          backdropFilter: 'blur(28px)',
          WebkitBackdropFilter: 'blur(28px)',
          borderLeft: '1px solid rgba(255,255,255,0.75)',
          boxShadow: '-8px 0 40px rgba(30,27,75,0.14)',
          animation: 'slideInRight 0.25s ease',
        }}
      >
        {/* ── Header ────────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '18px 20px',
          borderBottom: '1px solid rgba(0,0,0,0.06)',
          flexShrink: 0,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#1e1b4b' }}>
              {title}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              {entries.length} transaction{entries.length !== 1 ? 's' : ''}
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 30, height: 30, borderRadius: 8, flexShrink: 0,
              border: '1px solid rgba(0,0,0,0.08)',
              background: 'rgba(255,255,255,0.7)',
              color: '#6b7280', fontSize: 16, lineHeight: 1,
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>

        {/* ── Scrolling body ────────────────────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
          {entries.length === 0 ? (
            <div style={{
              textAlign: 'center', color: '#9ca3af',
              fontSize: 13, padding: '48px 20px',
            }}>
              <div style={{ fontSize: 30, marginBottom: 10, opacity: 0.5 }}>💸</div>
              No money went out in this period.
            </div>
          ) : grouped ? (
            dayGroups.map(({ day, rows }) => (
              <DayGroup
                key={day}
                day={day}
                entries={rows}
                expanded={openDays?.has(day) ?? false}
                onToggle={() => toggleDay(day)}
              />
            ))
          ) : (
            entries.map((entry, i) => (
              <EntryRow key={`${entry.timestamp}-${i}`} entry={entry} />
            ))
          )}
        </div>

        {/* ── Footer totals ─────────────────────────────────────────── */}
        <div style={{
          padding: '14px 20px',
          borderTop: '1px solid rgba(0,0,0,0.08)',
          background: 'rgba(99,102,241,0.05)',
          flexShrink: 0,
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 8,
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#6b7280' }}>Total</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#1e1b4b' }}>
              {formatMoney(period?.total)}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, fontSize: 11, flexWrap: 'wrap' }}>
            <span className="badge badge-ok">Cash {formatShort(period?.cash)}</span>
            <span className="badge badge-info">UPI {formatShort(period?.upi)}</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
