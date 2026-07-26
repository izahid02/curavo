/**
 * PrescriptionLightbox — full-screen viewer for a single prescription.
 *
 * Opens as a dark overlay with the image centered.  Clicking outside the
 * image (on the dark backdrop) closes it.  This is used instead of opening
 * the image in a new browser tab because:
 *   1. The image endpoint is JWT-protected — a new tab has no auth header
 *      and would just show a 401.  We already have the bytes as a blob here.
 *   2. It works inside the future desktop (Electron) app, where "open in new
 *      tab" behaves differently.
 *
 * Rendered through createPortal into <body> so it is never clipped by a
 * parent's overflow:hidden (a project-wide rule for modals).
 *
 * Props:
 *   rx       — prescription object { id, mime_type, file_name, uploaded_at,
 *              invoice_number?, dispensed_medicines? }
 *   onClose  — called when the user dismisses the lightbox
 */
import { createPortal } from 'react-dom';
import { useAuthedImage } from '../../hooks/useAuthedImage';
import { parseBackendDate } from '../../lib/datetime';

function fmtDate(d) {
  const dt = parseBackendDate(d);
  if (!dt) return '';
  return dt.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric',
  });
}

export default function PrescriptionLightbox({ rx, onClose }) {
  const isPdf = rx?.mime_type === 'application/pdf';
  const { url, loading, error } = useAuthedImage(
    rx ? `/prescriptions/${rx.id}/image` : null,
  );

  if (!rx) return null;

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(15,23,42,0.82)',
        backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: 24, cursor: 'zoom-out',
      }}
    >
      {/* Top bar — meta on the left, close on the right */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 900,
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          marginBottom: 14, color: '#fff', cursor: 'default',
        }}
      >
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>📋 Prescription</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 3 }}>
            {fmtDate(rx.uploaded_at)}
            {rx.invoice_number && (
              <span style={{ marginLeft: 8, fontFamily: 'monospace' }}>· {rx.invoice_number}</span>
            )}
          </div>
          {rx.dispensed_medicines?.length > 0 && (
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
              {rx.dispensed_medicines.join(' · ')}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          title="Close (or click anywhere outside)"
          style={{
            background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)',
            color: '#fff', fontSize: 20, lineHeight: 1, cursor: 'pointer',
            borderRadius: 8, width: 36, height: 36, flexShrink: 0,
          }}
        >
          ×
        </button>
      </div>

      {/* The image / PDF itself — stopPropagation so clicking it doesn't close */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          maxWidth: '90vw', maxHeight: '78vh', cursor: 'default',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {loading ? (
          <div style={{ color: '#fff', fontSize: 14, opacity: 0.8 }}>Loading prescription…</div>
        ) : error || !url ? (
          <div style={{ color: '#fff', fontSize: 14, opacity: 0.8, textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
            Could not load this prescription file.
          </div>
        ) : isPdf ? (
          <iframe
            src={url}
            title="Prescription PDF"
            style={{
              width: '86vw', height: '78vh', border: 'none',
              borderRadius: 10, background: '#fff',
            }}
          />
        ) : (
          <img
            src={url}
            alt="Prescription full size"
            style={{
              maxWidth: '90vw', maxHeight: '78vh',
              objectFit: 'contain', borderRadius: 10,
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)', background: '#fff',
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
