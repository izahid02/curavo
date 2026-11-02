/** Small formatting helpers (written out: not every phone has full Intl support). */

/** 123456.5 -> "₹1,23,456.50"; whole rupees drop the paise when `short`. */
export function inr(n, { short = false } = {}) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const neg = v < 0;
  const [whole, paise] = Math.abs(v).toFixed(2).split('.');
  let grouped = whole;
  if (whole.length > 3) {
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${rest},${last3}`;
  }
  const tail = short && paise === '00' ? '' : `.${paise}`;
  return `${neg ? '-' : ''}\u20B9${grouped}${tail}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The PC sends times in UTC; some without the trailing Z. */
export function parseUtc(iso) {
  if (!iso) return null;
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "2027-03-31" -> "Mar 2027" (medicine expiry is printed by month). */
export function expiryMonth(ymd) {
  if (!ymd) return '—';
  const [y, m] = ymd.split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/** "2026-11-02" -> "2 Nov" */
export function dayMonth(ymd) {
  if (!ymd) return '—';
  const [, m, d] = ymd.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

export function clock(date) {
  if (!date) return '—';
  let h = date.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${String(date.getMinutes()).padStart(2, '0')} ${ampm}`;
}

export function ago(date) {
  if (!date) return '—';
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}, ${clock(date)}`;
}

/** Stock count for a strip medicine: 94 tablets of 10 -> "9 strips + 4". */
export function stockQty(q, perStrip) {
  if (!perStrip) return `${q}`;
  const strips = Math.floor(q / perStrip);
  const loose = q % perStrip;
  return `${strips} strip${strips === 1 ? '' : 's'}${loose ? ` + ${loose}` : ''}`;
}
