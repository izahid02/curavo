/**
 * PrescriptionUpload — compact widget inside the Billing page.
 *
 * A PRESCRIPTION IS OFTEN MORE THAN ONE PAGE.  A doctor's pad runs to two or
 * three sheets routinely, and the old widget held exactly one file, so page
 * two had nowhere to go.  This holds a list of PAGES, in order.
 *
 * Nothing about the backend changed for this: the prescriptions table already
 * stores one row per image and already allows many rows against the same
 * patient and the same invoice.  Each page is uploaded as its own row, with
 * its position recorded in the row's notes ("Page 2 of 3").
 *
 * Lifecycle:
 *   1. Collapsed: a small row with a [+] button.
 *   2. Expanded: drag-and-drop zone + browse/scanner buttons (both multi-select).
 *   3. Pages chosen: a strip of numbered thumbnails, each removable, plus
 *      "+ Add page" for the next sheet.
 *
 * This component does NOT upload anything.  It holds the chosen File objects
 * and reports them to the parent via onFilesSelected().  The parent
 * (Billing.jsx) uploads after the invoice is saved, so the invoice_id exists.
 *
 * Props:
 *   patientId       — required for the upload endpoint; null = no patient yet
 *   onFilesSelected — called with the File array (empty array to clear)
 *   disabled        — true when no patient is selected (greys out the widget)
 */
import { useRef, useState } from 'react';

/** Format bytes as "1.2 MB" or "234 KB" */
function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_BYTES    = 10 * 1024 * 1024;
/** Generous but finite: a prescription is a few sheets, not a scanned book. */
const MAX_PAGES    = 10;

export default function PrescriptionUpload({ patientId, onFilesSelected, disabled = false }) {
  const [expanded, setExpanded] = useState(false);
  // Each page: { file, url }.  url is an object URL for images, null for PDFs.
  const [pages,    setPages]    = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState('');

  const browseRef = useRef(null);   // hidden <input type="file"> for browse
  const scanRef   = useRef(null);   // hidden <input> with capture="environment"

  /** Tell the parent, always as a plain File array in page order. */
  function publish(next) {
    setPages(next);
    onFilesSelected(next.map((p) => p.file));
  }

  // ── Handle chosen files (from either input or drag-drop) ───────────────────
  // Takes a LIST: selecting all three sheets at once is the common case, and
  // dropping them together should behave the same as adding them one by one.
  function handleFiles(fileList) {
    setFileError('');
    const incoming = Array.from(fileList || []);
    if (incoming.length === 0) return;

    const room = MAX_PAGES - pages.length;
    if (room <= 0) {
      setFileError(`A prescription can hold ${MAX_PAGES} pages.`);
      return;
    }

    const accepted = [];
    const rejected = [];
    for (const file of incoming.slice(0, room)) {
      if (!ALLOWED_MIME.includes(file.type)) {
        rejected.push(`${file.name}: unsupported type`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        rejected.push(`${file.name}: over 10 MB`);
        continue;
      }
      accepted.push({
        file,
        url: file.type !== 'application/pdf' ? URL.createObjectURL(file) : null,
      });
    }

    if (incoming.length > room) {
      rejected.push(`only ${room} more page${room === 1 ? '' : 's'} can be added`);
    }
    // Partial success is normal — keep what was valid and say what was not,
    // rather than throwing away three good pages because the fourth was a .doc.
    if (rejected.length) setFileError(rejected.join(' · '));
    if (accepted.length === 0) return;

    publish([...pages, ...accepted]);
    setExpanded(false);
  }

  /** Remove one page.  The rest keep their order and renumber themselves. */
  function removePage(index) {
    const page = pages[index];
    if (page?.url) URL.revokeObjectURL(page.url);
    const next = pages.filter((_, i) => i !== index);
    publish(next);
    setFileError('');
    if (next.length === 0) {
      setExpanded(false);
      if (browseRef.current) browseRef.current.value = '';
      if (scanRef.current)   scanRef.current.value   = '';
    }
  }

  // ── Drag-and-drop handlers ─────────────────────────────────────────────────
  function onDragOver(e) {
    e.preventDefault();
    if (!disabled) setDragOver(true);
  }
  function onDragLeave() { setDragOver(false); }
  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    handleFiles(e.dataTransfer.files);
  }

  const totalBytes = pages.reduce((sum, p) => sum + (p.file.size || 0), 0);

  // ─── Collapsed row (nothing attached) ──────────────────────────────────────
  if (pages.length === 0 && !expanded) {
    return (
      <div style={rowStyle(disabled)}>
        <span style={{ fontSize: 13, color: disabled ? 'var(--text-hint)' : 'var(--text-secondary)' }}>
          📋 Prescription
        </span>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--text-hint)', marginLeft: 8 }}>
          {disabled ? 'Select a patient first' : 'No prescription attached'}
        </span>
        <button
          disabled={disabled}
          onClick={() => !disabled && setExpanded(true)}
          title="Attach prescription"
          style={addBtnStyle(disabled)}
        >
          +
        </button>
      </div>
    );
  }

  // ─── Pages attached ────────────────────────────────────────────────────────
  if (pages.length > 0 && !expanded) {
    return (
      <div style={{ ...rowStyle(false), flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600, flex: 1 }}>
            📋 Prescription · {pages.length} page{pages.length === 1 ? '' : 's'}
            {totalBytes ? (
              <span style={{ color: 'var(--text-hint)', fontWeight: 500, marginLeft: 6 }}>
                · {fmtSize(totalBytes)}
              </span>
            ) : null}
          </span>
          <button
            onClick={() => setExpanded(true)}
            title="Add another page"
            disabled={pages.length >= MAX_PAGES}
            style={{
              ...addBtnStyle(pages.length >= MAX_PAGES),
              width: 'auto', height: 24, borderRadius: 7,
              padding: '0 9px', fontSize: 12, fontWeight: 600, gap: 4,
            }}
          >
            + Add page
          </button>
        </div>

        {/* Page strip.  Numbered, because the ORDER is the thing that matters
            once a prescription runs to three sheets — and it scrolls rather
            than wrapping, so the row never pushes the bill down the screen. */}
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
          {pages.map((p, i) => (
            <div key={`${p.file.name}-${i}`} style={{ position: 'relative', flexShrink: 0 }}>
              <div style={thumbContainerStyle} title={p.file.name}>
                {p.url ? (
                  <img
                    src={p.url}
                    alt={`Prescription page ${i + 1}`}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 6 }}
                  />
                ) : (
                  <div style={{
                    width: '100%', height: '100%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(99,102,241,0.08)', borderRadius: 6, fontSize: 20,
                  }}>
                    📄
                  </div>
                )}
              </div>
              {/* Page number */}
              <span style={{
                position: 'absolute', bottom: 2, left: 2,
                background: 'rgba(15,23,42,0.72)', color: '#fff',
                fontSize: 9.5, fontWeight: 700, lineHeight: 1,
                padding: '2px 4px', borderRadius: 4,
              }}>
                {i + 1}
              </span>
              <button
                onClick={() => removePage(i)}
                title={`Remove page ${i + 1}`}
                style={{
                  position: 'absolute', top: -5, right: -5,
                  width: 18, height: 18, borderRadius: '50%',
                  border: '1px solid var(--glass-border)', background: '#fff',
                  color: 'var(--text-hint)', fontSize: 12, lineHeight: 1,
                  cursor: 'pointer', padding: 0,
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {fileError && (
          <div style={{ fontSize: 11, color: 'var(--danger)' }}>{fileError}</div>
        )}
      </div>
    );
  }

  // ─── Expanded: drop zone + buttons ────────────────────────────────────────
  return (
    <div style={{ ...rowStyle(false), flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
          📋 Prescription
          {pages.length > 0 && (
            <span style={{ color: 'var(--text-hint)', fontWeight: 500, marginLeft: 6 }}>
              · adding page {pages.length + 1}
            </span>
          )}
        </span>
        <button
          onClick={() => { setExpanded(false); setFileError(''); }}
          style={{ background: 'none', border: 'none', fontSize: 18, color: 'var(--text-hint)', cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => browseRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? 'var(--accent)' : 'rgba(99,102,241,0.30)'}`,
          borderRadius: 'var(--radius)',
          padding: '16px 12px',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragOver ? 'var(--accent-light)' : 'rgba(255,255,255,0.40)',
          transition: 'all 0.15s',
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          Drop pages here or click to browse
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>
          JPG · PNG · PDF · max 10 MB each · up to {MAX_PAGES} pages
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => browseRef.current?.click()} style={actionBtnStyle}>
          📁 Browse files
        </button>
        <button
          onClick={() => scanRef.current?.click()}
          title="Capture directly from scanner or camera"
          style={actionBtnStyle}
        >
          🖨 From scanner
        </button>
      </div>

      {fileError && (
        <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>
          {fileError}
        </div>
      )}

      {/* Hidden file inputs — one for browse, one for camera/scanner capture.
          Both take several files: a flatbed scanner hands over all three
          sheets at once, and so does picking them in the file dialog. */}
      <input
        ref={browseRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,application/pdf"
        style={{ display: 'none' }}
        onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
      />
      <input
        ref={scanRef}
        type="file"
        multiple
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

function rowStyle(disabled) {
  return {
    display:             'flex',
    alignItems:          'center',
    gap:                 8,
    background:          disabled ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.45)',
    backdropFilter:      'blur(12px)',
    WebkitBackdropFilter:'blur(12px)',
    border:              '1px solid var(--glass-border)',
    borderRadius:        'var(--radius)',
    padding:             '10px 12px',
    opacity:             disabled ? 0.6 : 1,
    transition:          'opacity 0.2s',
  };
}

function addBtnStyle(disabled) {
  return {
    width:        26,
    height:       26,
    borderRadius: '50%',
    border:       '1px solid rgba(99,102,241,0.35)',
    background:   'var(--accent-light)',
    color:        'var(--accent)',
    fontSize:     18,
    fontWeight:   700,
    lineHeight:   '1',
    cursor:       disabled ? 'not-allowed' : 'pointer',
    opacity:      disabled ? 0.5 : 1,
    display:      'flex',
    alignItems:   'center',
    justifyContent: 'center',
    flexShrink:   0,
  };
}

const thumbContainerStyle = {
  width:        44,
  height:       44,
  flexShrink:   0,
  borderRadius: 6,
  overflow:     'hidden',
  border:       '1px solid var(--glass-border)',
  background:   'rgba(255,255,255,0.60)',
};

const actionBtnStyle = {
  flex:         1,
  padding:      '7px 10px',
  fontSize:     12,
  fontWeight:   500,
  background:   'rgba(255,255,255,0.60)',
  border:       '1px solid var(--glass-border)',
  borderRadius: 'var(--radius)',
  cursor:       'pointer',
  color:        'var(--text-secondary)',
  transition:   'background 0.15s',
};
