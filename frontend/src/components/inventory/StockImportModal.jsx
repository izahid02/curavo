/**
 * Medicines -> "Import from Excel": the stock a shop already has when it
 * moves to Curavo (Owner/Administrator only).
 *
 *   1. Download our template, fill one row per batch.
 *   2. Choose the file -> the BACKEND checks every row and this window shows
 *      OK / warning / problem in plain words.  Nothing is saved yet.
 *   3. Import -> the backend takes a backup, then saves the rows that passed.
 *
 * All the rules (strips -> tablets, per-tablet prices, expiry, duplicates)
 * live in backend/app/services/stock_import.py; this screen only shows what
 * it says.  The file is sent again on Import, so what is saved is exactly
 * what was just checked.
 */
import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/api';

const STATUS = {
  ok:      { label: 'Ready',    bg: 'var(--ok-bg)',     fg: 'var(--ok)' },
  warning: { label: 'Check',    bg: 'var(--warn-bg)',   fg: 'var(--warn)' },
  error:   { label: 'Skipped',  bg: 'var(--danger-bg)', fg: 'var(--danger)' },
};

export default function StockImportModal({ onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [check, setCheck] = useState(null);       // {rows, counts}
  const [result, setResult] = useState(null);     // after Import
  const [busy, setBusy] = useState('');           // '' | 'template' | 'check' | 'import'
  const [error, setError] = useState('');
  const [show, setShow] = useState('all');        // all | error | warning
  const inputRef = useRef(null);

  const detail = (e, fallback) => e?.response?.data?.detail
    || (e?.response?.status === 403 ? 'Only the owner or an administrator can import stock.' : fallback);

  async function downloadTemplate() {
    setBusy('template'); setError('');
    try {
      const res = await api.get('/stock-import/template', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = 'Curavo-opening-stock.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { setError(detail(e, 'Could not download the template.')); }
    finally { setBusy(''); }
  }

  async function send(path, f) {
    const form = new FormData();
    form.append('file', f);
    return api.post(path, form, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000 });
  }

  async function choose(f) {
    if (!f) return;
    setFile(f); setCheck(null); setResult(null); setError(''); setShow('all');
    setBusy('check');
    try { setCheck((await send('/stock-import/check', f)).data); }
    catch (e) { setError(detail(e, 'Could not read the file.')); setFile(null); }
    finally { setBusy(''); if (inputRef.current) inputRef.current.value = ''; }
  }

  async function doImport() {
    setBusy('import'); setError('');
    try {
      const { data } = await send('/stock-import/import', file);
      setResult(data);
      onImported?.();
    } catch (e) { setError(detail(e, 'The import did not finish. Nothing was saved.')); }
    finally { setBusy(''); }
  }

  const rows = useMemo(() => (check?.rows || []).filter((r) => show === 'all' || r.status === show), [check, show]);
  const importable = check ? check.counts.ok + check.counts.warning : 0;

  return createPortal(
    <div style={backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div style={card} role="dialog" aria-modal="true" aria-labelledby="imp-title">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <div id="imp-title" style={{ fontSize: 19, fontWeight: 600, color: 'var(--text)' }}>Import stock from Excel</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
              The medicines and stock already on your shelves. One row per batch.
            </div>
          </div>
          <button className="btn-secondary" onClick={onClose} disabled={!!busy} style={{ padding: '6px 12px' }}>Close</button>
        </div>

        {error && <div style={note('danger')}>{error}</div>}

        {result ? (
          <div style={{ marginTop: 18 }}>
            <div style={note('ok')}>
              <b>Imported.</b> {result.medicines_added} new medicine{result.medicines_added === 1 ? '' : 's'},{' '}
              {result.batches_added} batch{result.batches_added === 1 ? '' : 'es'} of stock
              {result.skipped ? `; ${result.skipped} row${result.skipped === 1 ? '' : 's'} skipped` : ''}.
            </div>
            {result.maybe_schedule_h1 > 0 && (
              <div style={note('warn')}>
                <b>{result.maybe_schedule_h1} medicine{result.maybe_schedule_h1 === 1 ? ' looks' : 's look'} like Schedule H1.</b>{' '}
                Curavo does not mark them by itself. Check them with <b>Register check</b> on the Products tab.
              </div>
            )}
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>
              A backup was taken just before the import ({result.backup}), on the Backup page if you ever need it.
              {result.skipped ? ' Fix the skipped rows in the same file and import it again; rows already imported are refused, so nothing doubles.' : ''}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button className="btn-secondary" onClick={() => { setResult(null); setCheck(null); setFile(null); }}>Import another file</button>
              <button className="btn-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : !check ? (
          <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
            <Step n={1} title="Download the template">
              Fill the <b>Medicines</b> sheet. For strip medicines type strips and per-strip prices; Curavo works out the tablets.
              The <b>How to fill</b> sheet explains every column.
              <div><button className="btn-secondary" onClick={downloadTemplate} disabled={!!busy} style={{ marginTop: 10 }}>
                {busy === 'template' ? 'Downloading…' : 'Download the template'}</button></div>
            </Step>
            <Step n={2} title="Choose the filled file">
              Curavo checks every row first and shows what it will do. Nothing is saved until you press Import.
              <div>
                <input ref={inputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  style={{ display: 'none' }} onChange={(e) => choose(e.target.files?.[0])} />
                <button className="btn-primary" onClick={() => inputRef.current?.click()} disabled={!!busy} style={{ marginTop: 10 }}>
                  {busy === 'check' ? 'Checking the file…' : 'Choose Excel file'}</button>
              </div>
            </Step>
            <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>
              Expired stock is not imported. A medicine already in Curavo gets the new batch added; its details stay as they are.
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>
              <b style={{ color: 'var(--text)' }}>{file?.name}</b> · {check.rows.length} row{check.rows.length === 1 ? '' : 's'}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {[['all', `All ${check.rows.length}`, null],
                ['ok', `${check.counts.ok} ready`, 'ok'],
                ['warning', `${check.counts.warning} to check`, 'warning'],
                ['error', `${check.counts.error} skipped`, 'error']].map(([k, label, tone]) => (
                <button key={k} onClick={() => setShow(k)} style={{
                  border: show === k ? '1.5px solid var(--accent)' : '1px solid rgba(30,27,75,0.12)',
                  background: tone ? STATUS[tone].bg : 'rgba(255,255,255,0.7)', color: tone ? STATUS[tone].fg : 'var(--text)',
                  borderRadius: 999, padding: '5px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                  {label}
                </button>
              ))}
            </div>
            <div style={{ maxHeight: '46vh', overflowY: 'auto', border: '1px solid rgba(30,27,75,0.08)', borderRadius: 12, background: 'rgba(255,255,255,0.6)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>{['Row', 'Medicine', '', 'What happens'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-hint)',
                      padding: '8px 10px', position: 'sticky', top: 0, background: 'rgba(248,248,253,0.97)' }}>{h}</th>))}</tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={4} style={{ padding: 16, color: 'var(--text-secondary)' }}>Nothing in this list.</td></tr>
                  ) : rows.map((r) => (
                    <tr key={r.row} style={{ borderTop: '1px solid rgba(30,27,75,0.06)', verticalAlign: 'top' }}>
                      <td style={{ padding: '8px 10px', color: 'var(--text-hint)', fontVariantNumeric: 'tabular-nums' }}>{r.row}</td>
                      <td style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text)' }}>{r.name}</td>
                      <td style={{ padding: '8px 6px' }}>
                        <span style={{ background: STATUS[r.status].bg, color: STATUS[r.status].fg, borderRadius: 999, padding: '2px 9px',
                          fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{STATUS[r.status].label}</span>
                      </td>
                      <td style={{ padding: '8px 10px', color: 'var(--text-secondary)' }}>
                        {r.summary && <div>{r.summary}</div>}
                        {r.messages.map((m, i) => (
                          <div key={i} style={{ color: r.status === 'error' ? 'var(--danger)' : 'var(--warn)' }}>{m}</div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
              <button className="btn-secondary" disabled={!!busy} onClick={() => inputRef.current?.click()}>Choose another file</button>
              <input ref={inputRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={(e) => choose(e.target.files?.[0])} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {check.counts.error > 0 && importable > 0 && (
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Skipped rows can be fixed and imported later.</span>
                )}
                <button className="btn-primary" disabled={!!busy || importable === 0} onClick={doImport}>
                  {busy === 'import' ? 'Importing…' : importable === 0 ? 'Nothing to import' : `Import ${importable} row${importable === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Step({ n, title, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, background: 'rgba(99,102,241,0.06)', borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ width: 26, height: 26, flex: 'none', borderRadius: '50%', background: 'var(--accent)', color: '#fff',
        display: 'grid', placeItems: 'center', fontWeight: 600, fontSize: 13 }}>{n}</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 14, marginBottom: 2 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function note(tone) {
  const c = { ok: ['var(--ok-bg)', 'var(--ok)'], warn: ['var(--warn-bg)', 'var(--warn)'], danger: ['var(--danger-bg)', 'var(--danger)'] }[tone];
  return { background: c[0], color: c[1], borderRadius: 10, padding: '10px 12px', fontSize: 13, lineHeight: 1.5, marginTop: 14 };
}

const backdrop = {
  position: 'fixed', inset: 0, background: 'rgba(30,27,75,0.35)', backdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1500, padding: 16,
};
const card = {
  width: '100%', maxWidth: 820, maxHeight: '92vh', overflowY: 'auto',
  background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(24px)', border: '1px solid rgba(255,255,255,0.75)',
  borderRadius: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.2)', padding: 24, boxSizing: 'border-box',
};
