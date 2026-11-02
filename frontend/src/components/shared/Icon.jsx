/**
 * Icon — Curavo's small set of line icons.
 *
 * WHY: the app used emoji (🏪 📋 💳) as icons.  Emoji look different on every
 * Windows/Mac/Android version, cannot take the theme's colours, and read as
 * casual next to money figures.  These are plain stroke drawings, so they:
 *   - always look the same,
 *   - take their colour from the surrounding text (stroke="currentColor"),
 *   - scale cleanly to any size.
 *
 * Usage:  <Icon name="store" size={18} style={{ color: '#0369a1' }} />
 * Add a new icon by adding one entry to PATHS (a 24x24 SVG path).
 */
const PATHS = {
  store:     'M3 9l1.5-5h15L21 9M3 9h18M3 9v11h18V9M9 20v-6h6v6',
  clipboard: 'M9 3h6v3H9zM7 4.5H5V21h14V4.5h-2M9 11h6M9 15h4',
  user:      'M16 19v-1a4 4 0 00-8 0v1M12 11a3 3 0 100-6 3 3 0 000 6z',
  card:      'M3 6h18v12H3zM3 10h18M7 15h3',
  wallet:    'M4 7h15a1 1 0 011 1v10a1 1 0 01-1 1H4zM4 7V5h12v2M16 13h1',
  alert:     'M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  xCircle:   'M12 21a9 9 0 110-18 9 9 0 010 18zM15 9l-6 6M9 9l6 6',
};

export default function Icon({ name, size = 18, strokeWidth = 1.8, style }) {
  const d = PATHS[name];
  if (!d) return null;   // unknown name: draw nothing rather than crash a page
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'inline-block', verticalAlign: '-0.15em', flexShrink: 0, ...style }}
    >
      <path d={d} />
    </svg>
  );
}
