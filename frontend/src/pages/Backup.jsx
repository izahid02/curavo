/**
 * Backup page — the owner's view of every database snapshot on this PC.
 *
 * Two kinds of backup appear in one table:
 *   AUTOMATIC — taken every time the app opens, before any migration runs.
 *               The app keeps the newest 7 and deletes older ones itself.
 *   MANUAL    — taken when the owner presses "Backup Now".  NEVER deleted
 *               automatically; only a person can remove one.
 *
 * The page deliberately shows the folder path in plain text.  If the app will
 * not start at all, the owner cannot reach this screen — they need to know
 * where the files live so they (or whoever is helping them) can copy one back
 * by hand.  That path is the single most useful thing on this page in a real
 * emergency, so it is not hidden behind a tooltip.
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** "1.2 MB" / "512 KB" — a size a non-technical owner can read at a glance. */
function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * "12 Aug 2026, 8:59 pm" — local time on the shop PC.
 *
 * These timestamps come from the file's modification time, which is already
 * local, so unlike the rest of the app there is no UTC→IST conversion to do
 * here.  The owner is looking for "the one from before lunch".
 */
function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Backup() {
  const [data,     setData]     = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [creating, setCreating] = useState(false);
  const [error,    setError]    = useState('');
  const [notice,   setNotice]   = useState('');
  const [confirm,  setConfirm]  = useState(null);   // filename pending delete

  const fetchBackups = useCallback(async () => {
    try {
      const res = await api.get('/backup/list');
      setData(res.data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not load backups.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchBackups(); }, [fetchBackups]);

  async function createBackup() {
    setCreating(true);
    setNotice('');
    setError('');
    try {
      const res = await api.post('/backup/create');
      setNotice(`Backup created: ${res.data.filename} (${formatSize(res.data.size_bytes)})`);
      await fetchBackups();
    } catch (err) {
      setError(err.response?.data?.detail || 'Backup failed.');
    } finally {
      setCreating(false);
    }
  }

  async function deleteBackup(filename) {
    setConfirm(null);
    try {
      await api.delete(`/backup/${filename}`);
      setNotice(`Deleted ${filename}.`);
      await fetchBackups();
    } catch (err) {
      setError(err.response?.data?.detail || 'Delete failed.');
    }
  }

  /**
   * Download a backup through the axios instance rather than a plain <a href>.
   *
   * The endpoint requires the JWT, and a bare link cannot carry the
   * Authorization header — it would come back 401.  So we fetch the bytes as a
   * blob and hand them to a temporary object URL instead.
   */
  async function downloadBackup(filename) {
    try {
      const res = await api.get(`/backup/download/${filename}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.response?.data?.detail || 'Download failed.');
    }
  }

  const backups = data?.backups || [];

  return (
    <div>
      {/* ── Page heading ──────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1e1b4b', marginBottom: 2 }}>Backup</h1>
          <p style={{ fontSize: 14, color: 'var(--text-hint)' }}>
            {loading ? 'Loading…'
              : `${backups.length} backup${backups.length !== 1 ? 's' : ''} · ${formatSize(data?.total_bytes || 0)}`}
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={createBackup}
          disabled={creating}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {creating ? 'Backing up…' : 'Backup Now'}
        </button>
      </div>

      {/* ── Messages ──────────────────────────────────────────────── */}
      {notice && (
        <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--ok)', color: 'var(--ok)', fontSize: 13, fontWeight: 600 }}>
          {notice}
        </div>
      )}
      {error && (
        <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--danger)', color: 'var(--danger)', fontSize: 13, fontWeight: 600 }}>
          {error}
        </div>
      )}

      {/* ── Where the files are ───────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 16, animation: 'fadeUp 0.4s ease' }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-hint)', marginBottom: 6 }}>
          Backup folder on this PC
        </div>
        <div style={{ fontFamily: 'monospace', fontSize: 12.5, color: 'var(--text)', wordBreak: 'break-all' }}>
          {data?.backup_dir || '—'}
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 10, lineHeight: 1.6 }}>
          A backup is taken automatically every time the app opens — before any
          database change — and the newest 7 are kept. Backups you take yourself
          are kept until you delete them.
          <strong style={{ color: 'var(--warn)' }}>
            {' '}These files sit on the same disk as the database, so copy one to a
            pen drive regularly.
          </strong>{' '}
          If this PC fails, a backup stored only on this PC fails with it.
        </p>
      </div>

      {/* ── Backup list ───────────────────────────────────────────── */}
      <div className="card" style={{ animation: 'fadeUp 0.45s ease' }}>
        {loading ? (
          <p style={{ color: 'var(--text-hint)', fontSize: 14 }}>Loading backups…</p>
        ) : backups.length === 0 ? (
          <p style={{ color: 'var(--text-hint)', fontSize: 14 }}>
            No backups yet. One is created automatically the next time the app starts.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['When', 'Type', 'File', 'Size', ''].map((h, i) => (
                    <th key={h || i} style={{
                      textAlign: i === 3 ? 'right' : 'left',
                      fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
                      color: 'var(--text-hint)', fontWeight: 700,
                      padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.6)',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.filename} style={{ borderBottom: '1px solid rgba(255,255,255,0.4)' }}>
                    <td style={{ padding: '10px', fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap' }}>
                      {formatWhen(b.created_at)}
                    </td>
                    <td style={{ padding: '10px' }}>
                      <span className={b.kind === 'manual' ? 'badge-accent' : 'badge-neutral'}>
                        {b.kind === 'manual' ? 'Manual' : 'Automatic'}
                      </span>
                    </td>
                    <td style={{ padding: '10px', fontSize: 12, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                      {b.filename}
                    </td>
                    <td style={{ padding: '10px', fontSize: 13, color: 'var(--text-secondary)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {formatSize(b.size_bytes)}
                    </td>
                    <td style={{ padding: '10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn-secondary"
                        onClick={() => downloadBackup(b.filename)}
                        style={{ fontSize: 12, padding: '5px 10px', marginRight: 6 }}
                      >
                        Download
                      </button>
                      <button
                        className="btn-danger"
                        onClick={() => setConfirm(b.filename)}
                        style={{ fontSize: 12, padding: '5px 10px' }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Delete confirmation (portal — see CLAUDE.md §5) ───────── */}
      {confirm && createPortal(
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(30,27,75,0.35)',
            backdropFilter: 'blur(4px)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={() => setConfirm(null)}
        >
          <div
            className="card"
            style={{ maxWidth: 420, width: '90%', background: 'var(--glass-strong)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>
              Delete this backup?
            </h3>
            <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 18 }}>
              <span style={{ fontFamily: 'monospace' }}>{confirm}</span> will be
              permanently removed from this PC. This does not affect your current
              data — only the saved copy.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="btn-danger" onClick={() => deleteBackup(confirm)}>Delete</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
