/**
 * datetime.js — one place for all date/time display in the app.
 *
 * WHY THIS EXISTS (read before touching):
 * The backend runs on SQLite and stamps rows with CURRENT_TIMESTAMP, which is
 * **UTC** and comes back to us as a NAIVE string with no timezone marker, e.g.
 *   "2026-07-23T20:07:25"   (that instant is really 24 Jul 01:37 IST)
 *
 * Plain `new Date("2026-07-23T20:07:25")` treats a marker-less string as the
 * BROWSER's local time, not UTC. So a sale made just after midnight IST (which
 * is still "yesterday" in UTC) showed up a day behind. The pharmacy is in
 * India, so every date the owner sees must be in IST (UTC+5:30) regardless of
 * what timezone the PC clock happens to be set to.
 *
 * The fix has two halves, both handled here so no page has to think about it:
 *   1. PARSE  — if a timestamp has no timezone, we append "Z" so it is read as
 *               UTC (its true meaning), not local time.
 *   2. DISPLAY — every formatter passes `timeZone: 'Asia/Kolkata'`, so the
 *               output is always IST no matter where the code runs.
 *
 * Always import from here. Never call `new Date(...).toLocaleString(...)`
 * directly on a backend timestamp again.
 */

const IST_TZ = 'Asia/Kolkata';

/**
 * Turn a backend value into a correct Date instant.
 * - `null`/empty  → null (callers show a dash)
 * - date-only "YYYY-MM-DD" → left as a calendar date (no UTC shift wanted)
 * - datetime with no timezone → interpreted as UTC (append "Z")
 * - anything already carrying a timezone → used as-is
 */
export function parseBackendDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

  let s = String(value).trim();
  // SQLite prints "YYYY-MM-DD HH:MM:SS"; JS wants the "T" separator.
  s = s.replace(' ', 'T');

  const hasTime = s.includes('T');
  // A timezone marker is a trailing "Z" or a "+05:30" / "-0700" style offset.
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(s);
  if (hasTime && !hasTz) s += 'Z';   // naive → treat as UTC

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Full date + time in IST, e.g. "24 July 2026, 01:37 AM".
 * Use for timestamps (invoice created_at, receipt time, message sent-at).
 */
export function formatDateTime(value) {
  const d = parseBackendDate(value);
  if (!d) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: IST_TZ,
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/**
 * Short date only in IST, e.g. "24 Jul 2026".
 * Use for due dates, expiry, list rows — anywhere the time-of-day is noise.
 */
export function formatDateOnly(value) {
  const d = parseBackendDate(value);
  if (!d) return '—';
  return d.toLocaleDateString('en-IN', {
    timeZone: IST_TZ,
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

/** Compact date+time for dense tables, e.g. "24 Jul 2026, 01:37 AM". */
export function formatDateTimeShort(value) {
  const d = parseBackendDate(value);
  if (!d) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: IST_TZ,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Today's date in IST as "YYYY-MM-DD".
 * Use for the "Today" filter, date-picker defaults, and any comparison that
 * asks "is this today?". `en-CA` formats as ISO YYYY-MM-DD.
 */
export function getTodayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: IST_TZ });
}
