/**
 * PrescriptionUpload — compact widget inside the Billing page.
 *
 * Lifecycle:
 *   1. Collapsed: shows a small row with a [+] button.
 *   2. Expanded: shows a drag-and-drop zone + browse/scanner buttons.
 *   3. File chosen: shows thumbnail (or PDF icon) + filename + size + [×] to remove.
 *
 * This component does NOT upload the file itself.  It just holds the chosen
 * File object and reports it to the parent via onFileSelected().
 * The parent (Billing.jsx) uploads after the invoice is saved so the
 * invoice_id is known at upload time.
 *
 * Props:
 *   patientId      — required for the upload endpoint; null = patient not yet selected
 *   onFileSelected — called with the File object (or null to clear)
 *   disabled       — true when no patient is selected (greys out the widget)
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

export default function PrescriptionUpload({ patientId, onFileSelected, disabled = false }) {
  const [expanded,    setExpanded]    = useState(false);
  const [chosenFile,  setChosenFile]  = useState(null);
  const [previewUrl,  setPreviewUrl]  = useState(null);  // object URL for images
  const [dragOver,    setDragOver]    = useState(false);
  const [fileError,   setFileError]   = useState('');

  const browseRef  = useRef(null);   // hidden <input type="file"> for browse
  const scanRef    = useRef(null);   // hidden <input> with capture="environment"

  // ── Handle a chosen file (from either input or drag-drop) ──────────────────
  function handleFile(file) {
    setFileError('');
    if (!file) return;

    if (!ALLOWED_MIME.includes(file.type)) {
      setFileError('Unsupported file type. Use JPG, PNG, WebP, or PDF.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setFileError('File too large. Maximum size is 10 MB.');
      return;
    }

    // Revoke previous preview URL to avoid memory leaks
    if (previewUrl) URL.revokeObjectURL(previewUrl);

    const url = file.type !== 'application/pdf' ? URL.createObjectURL(file) : null;
    setChosenFile(file);
    setPreviewUrl(url);
    setExpanded(false);   // collapse the drop zone once a file is chosen
    onFileSelected(file);
  }

  function clearFile() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setChosenFile(null);
    setPreviewUrl(null);
    setFileError('');
    setExpanded(false);
    onFileSelected(null);
    // Reset both file inputs so the same file can be re-selected
    if (browseRef.current)  browseRef.current.value  = '';
    if (scanRef.current)    scanRef.current.value    = '';
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
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }

  // ─── Collapsed row (no file attached) ──────────────────────────────────────
  if (!chosenFile && !expanded) {
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

  // ─── File already chosen ───────────────────────────────────────────────────
  if (chosenFile) {
    return (
      <div style={rowStyle(false)}>
        {/* Thumbnail or PDF icon */}
        <div style={thumbContainerStyle}>
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Prescription preview"
              style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 6 }}
            />
          ) : (
            /* PDF — show a document icon placeholder */
            <div style={{
              width: '100%', height: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(99,102,241,0.08)', borderRadius: 6,
              fontSize: 20,
            }}>
              📄
            </div>
          )}
        </div>

        {/* File info */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>
            📋 Prescription attached
          </div>
          <div style={{
            fontSize: 11, color: 'var(--text-secondary)', marginTop: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {chosenFile.name}
            {chosenFile.size ? <span style={{ color: 'var(--text-hint)', marginLeft: 6 }}>· {fmtSize(chosenFile.size)}</span> : null}
          </div>
        </div>

        {/* Remove button */}
        <button
          onClick={clearFile}
          title="Remove prescription"
          style={{ background: 'none', border: 'none', fontSize: 18, color: 'var(--text-hint)', cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}
        >
          ×
        </button>
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
          Drop image here or click to browse
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>
          JPG · PNG · PDF · max 10 MB
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => browseRef.current?.click()}
          style={actionBtnStyle}
        >
          📁 Browse file
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

      {/* Hidden file inputs — one for browse, one for camera/scanner capture */}
      <input
        ref={browseRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        style={{ display: 'none' }}
        onChange={e => handleFile(e.target.files[0])}
      />
      <input
        ref={scanRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={e => handleFile(e.target.files[0])}
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
