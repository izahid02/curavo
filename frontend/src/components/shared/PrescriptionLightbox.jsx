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
 * A PRESCRIPTION CAN BE SEVERAL SHEETS.  When rx.pages is present the viewer
 * flips between them (buttons or ← →) instead of showing only the first.  An
 * rx without pages — anything uploaded before multi-page existed — is treated
 * as a single page, which is exactly what it is.
 *
 * Props:
 *   rx       — prescription object { id, mime_type, file_name, uploaded_at,
 *              invoice_number?, dispensed_medicines?, pages?, page_count? }
 *   onClose  — called when the user dismisses the lightbox
 */
import { useEffect, useState } from 'react';
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
  // Which sheet is on screen.  A prescription with no `pages` is one page.
  const pages = rx?.pages?.length ? rx.pages : (rx ? [rx] : []);
  const [index, setIndex] = useState(0);

  // A different prescription means start at its first page again.
  useEffect(() => { setIndex(0); }, [rx?.id]);

  // Arrow keys, because flipping three sheets with the mouse is tedious and
  // Escape closing a full-screen overlay is what everyone expects anyway.
  useEffect(() => {
    if (!rx) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') onClose?.();
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, pages.length - 1));
      if (e.key === 'ArrowLeft')  setIndex((i) => Math.max(i - 1, 0));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rx, pages.length, onClose]);

  // Clamped, so a stale index can never point past the end of a shorter
  // prescription while the effect above is catching up.
  const current = pages[Math.min(index, pages.length - 1)] || rx;
  const isPdf = current?.mime_type === 'application/pdf';
  const { url, loading, error } = useAuthedImage(
    current ? `/prescriptions/${current.id}/image` : null,
  );

  if (!rx) return null;

  const multi = pages.length > 1;

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
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            📋 Prescription
            {multi && (
              <span style={{ fontSize: 13, fontWeight: 600, opacity: 0.85, marginLeft: 8 }}>
                Page {Math.min(index, pages.length - 1) + 1} of {pages.length}
              </span>
            )}
          </div>
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

      {/* Page controls — only when there is more than one sheet. */}
      {multi && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            marginTop: 14, cursor: 'default',
          }}
        >
          <button
            onClick={() => setIndex((i) => Math.max(i - 1, 0))}
            disabled={index <= 0}
            style={pageBtnStyle(index <= 0)}
          >
            ← Previous
          </button>
          {/* Dots double as a jump-to-page control for a 3-sheet prescription. */}
          <div style={{ display: 'flex', gap: 6 }}>
            {pages.map((p, i) => (
              <button
                key={p.id}
                onClick={() => setIndex(i)}
                title={`Page ${i + 1}`}
                style={{
                  width: 9, height: 9, padding: 0, borderRadius: '50%',
                  border: 'none', cursor: 'pointer',
                  background: i === index ? '#fff' : 'rgba(255,255,255,0.35)',
                }}
              />
            ))}
          </div>
          <button
            onClick={() => setIndex((i) => Math.min(i + 1, pages.length - 1))}
            disabled={index >= pages.length - 1}
            style={pageBtnStyle(index >= pages.length - 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

function pageBtnStyle(disabled) {
  return {
    background: 'rgba(255,255,255,0.15)',
    border: '1px solid rgba(255,255,255,0.3)',
    color: '#fff', fontSize: 13, fontWeight: 600,
    padding: '7px 14px', borderRadius: 8,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
  };
}
