/**
 * PrescriptionThumb — a small, AUTHENTICATED prescription thumbnail.
 *
 * Loads the image via useAuthedImage (blob + JWT), so it actually renders
 * instead of showing a broken-image icon (a plain <img src="/api/…"> would
 * 401 because the browser can't attach the Bearer token — see useAuthedImage).
 *
 * PDFs have no thumbnail, so we show a 📄 icon instead.
 *
 * Props:
 *   rx       — prescription object with { id, mime_type }
 *   size     — square side length in px (default 44)
 *   radius   — border radius in px (default 6)
 *   onClick  — optional; when given, the thumb becomes a button (cursor + hover)
 *   alt      — image alt text
 */
import { useAuthedImage } from '../../hooks/useAuthedImage';

export default function PrescriptionThumb({ rx, size = 44, radius = 6, onClick, alt = 'Prescription' }) {
  const isPdf = rx?.mime_type === 'application/pdf';
  // Skip the network fetch entirely for PDFs (they have no image to show).
  const { url, loading, error } = useAuthedImage(
    rx ? `/prescriptions/${rx.id}/image` : null,
    { skip: isPdf },
  );

  const box = {
    width: size, height: size, flexShrink: 0,
    borderRadius: radius, overflow: 'hidden',
    border: '1px solid var(--glass-border)',
    background: 'rgba(255,255,255,0.60)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: onClick ? 'pointer' : 'default',
    transition: 'box-shadow 0.15s, transform 0.15s',
  };

  return (
    <div
      style={box}
      onClick={onClick}
      title={onClick ? 'Click to view full size' : undefined}
      onMouseEnter={onClick ? (e => { e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-light)'; }) : undefined}
      onMouseLeave={onClick ? (e => { e.currentTarget.style.boxShadow = 'none'; }) : undefined}
    >
      {isPdf ? (
        <span style={{ fontSize: Math.round(size * 0.42) }}>📄</span>
      ) : loading ? (
        <span style={{ fontSize: 10, color: 'var(--text-hint)' }}>…</span>
      ) : error || !url ? (
        <span style={{ fontSize: Math.round(size * 0.4) }}>🖼️</span>
      ) : (
        <img
          src={url}
          alt={alt}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}
    </div>
  );
}
