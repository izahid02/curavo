/**
 * Formatting helpers shared by the inventory screens.
 *
 * These four functions decide how money, stock and margins READ on screen.
 * They live here — not inside Inventory.jsx — because the Medicine Batch panel
 * shows the same figures as the medicines table and the Add Stock profit card.
 * If the margin thresholds drifted apart, the same batch could show a green
 * margin in one place and an amber one in another.  One definition, one answer.
 */

/** Format a number as Indian Rupees: ₹12.50.  Blank/null reads as "—". */
export function inr(amount) {
  if (amount === null || amount === undefined || amount === '') return '—';
  return '₹' + Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Format an ISO date string ("2026-12-31") as "Dec 2026" (month + year), IST. */
export function formatMonthYear(isoDate) {
  if (!isoDate) return '—';
  return new Date(isoDate).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', month: 'short', year: 'numeric',
  });
}

/**
 * How a stock quantity should READ on screen (Fix 2).
 *
 * Stock is ALWAYS stored in individual units — that never changes.  But a
 * pharmacist looking at a shelf counts strip medicines in strips: 270 loose
 * tablets of DOLO 650 at 15 per strip is "18 strips", and the raw 270 is only
 * useful as a cross-check underneath.
 *
 * Whole strips only.  155 tablets at 10/strip is "15 strips", not "15.5" — the
 * 5 loose tablets are still counted in the unit figure below it.
 *
 * @returns { main, sub }  main = headline text, sub = smaller line under it
 *                          (sub is null for non-strip medicines)
 */
export function stockLabel(quantity, isStrip, unitsPerStrip) {
  const qty = Number(quantity) || 0;
  const per = Number(unitsPerStrip) || 0;
  // Non-strip medicine (syrup, cream…): the unit IS the pack, so show it plain.
  if (!isStrip || per <= 0) return { main: qty.toLocaleString('en-IN'), sub: null };
  return {
    main: `${Math.floor(qty / per).toLocaleString('en-IN')} strips`,
    sub:  `(${qty.toLocaleString('en-IN')} units)`,
  };
}

/** Colour band for a margin percentage: green >20%, amber 10–20%, red <10%. */
export function marginTone(pct) {
  if (pct >= 20) return { color: 'var(--ok)',     bg: 'var(--ok-bg)',     border: 'rgba(16,185,129,0.30)' };
  if (pct >= 10) return { color: 'var(--warn)',   bg: 'var(--warn-bg)',   border: 'rgba(245,158,11,0.32)' };
  return              { color: 'var(--danger)', bg: 'var(--danger-bg)', border: 'rgba(244,63,94,0.30)' };
}
