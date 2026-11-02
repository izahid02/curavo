/**
 * App updates: every Curavo version uploaded, and who is offered it.
 *
 *   PILOT   only shops marked "Pilot shop" get it (they try it first)
 *   ALL     every shop gets it on its next check (within 6 hours)
 *   PAUSED  nobody gets it - for holding back a bad release
 *
 * A shop only ever moves FORWARD to the newest version it is allowed.  Shops
 * install on their own when Curavo is closed, never mid-bill.
 */
import React, { useEffect, useState } from 'react';
import { api, upload } from '../api';
import { bytes, Empty, ErrorNote, Modal, SectionTitle, when } from '../ui';

const STATUS = {
  PILOT: ['badge-info', 'Pilot shops'],
  ALL: ['badge-ok', 'Everyone'],
  PAUSED: ['badge-neutral', 'Paused'],
};

export default function Releases() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(null);

  const load = () => api('/releases').then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function setStatus(r, status) {
    setBusy(r.id); setErr('');
    try { await api(`/releases/${r.id}`, { method: 'PATCH', body: { status } }); load(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  }

  return (
    <>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em' }}>App updates</h1>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 640 }}>
            New versions go to <b>pilot shops</b> first. When they are happy, send it to <b>everyone</b>.
            Shops download it quietly and install when Curavo is closed.
          </div>
        </div>
        <button className="btn-primary" onClick={() => setAdding(true)}>Upload a version</button>
      </header>
      <ErrorNote>{err}</ErrorNote>

      {d && (
        <div className="grid-2">
          <section className="card">
            <SectionTitle>Versions shops are running</SectionTitle>
            {d.versions_in_use.length === 0 ? <Empty>No shops yet.</Empty> : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {d.versions_in_use.map(([v, n]) => (
                  <span key={v} className="badge badge-neutral" style={{ fontSize: 13, padding: '5px 12px' }}>
                    {v} · {n} shop{n === 1 ? '' : 's'}
                  </span>
                ))}
              </div>
            )}
          </section>
          <section className="card">
            <SectionTitle>Pilot shops</SectionTitle>
            <div style={{ fontSize: 30, fontWeight: 600 }}>{d.pilot_shops}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              Mark a shop as pilot from its page (Shops → the shop → Pilot shop).
            </div>
          </section>
        </div>
      )}

      <section className="card" style={{ padding: 6 }}>
        {!d ? <div style={{ padding: 14 }}><Empty>Loading…</Empty></div>
          : d.releases.length === 0 ? <div style={{ padding: 14 }}><Empty>No versions uploaded yet.</Empty></div> : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr><th>Version</th><th>Who gets it</th><th>Uploaded</th><th>Size</th><th>Shops on it</th><th /></tr></thead>
                <tbody>
                  {d.releases.map((r) => (
                    <tr key={r.id} style={{ cursor: 'default' }}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.version} {r.critical && <span className="badge badge-warn" style={{ marginLeft: 4 }}>Important</span>}</div>
                        {r.notes && <div style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 360, whiteSpace: 'pre-wrap' }}>{r.notes}</div>}
                      </td>
                      <td><span className={`badge ${STATUS[r.status][0]}`}>{STATUS[r.status][1]}</span></td>
                      <td style={{ whiteSpace: 'nowrap' }}>{when(r.created_at)}</td>
                      <td>{bytes(r.size)}</td>
                      <td>{r.shops_on_it}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {r.status !== 'ALL' && <button className="btn-primary" disabled={busy === r.id} onClick={() => setStatus(r, 'ALL')} style={{ padding: '5px 12px', fontSize: 12.5, marginLeft: 6 }}>Send to everyone</button>}
                        {r.status !== 'PILOT' && <button className="btn-secondary" disabled={busy === r.id} onClick={() => setStatus(r, 'PILOT')} style={{ padding: '5px 12px', fontSize: 12.5, marginLeft: 6 }}>Pilot only</button>}
                        {r.status !== 'PAUSED' && <button className="btn-danger" disabled={busy === r.id} onClick={() => setStatus(r, 'PAUSED')} style={{ padding: '5px 12px', fontSize: 12.5, marginLeft: 6 }}>Pause</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      {adding && <UploadModal onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
    </>
  );
}

function UploadModal({ onClose, onDone }) {
  const [exe, setExe] = useState(null);
  const [sig, setSig] = useState(null);
  const [notes, setNotes] = useState('');
  const [critical, setCritical] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function send() {
    if (!exe || !sig) return setErr('Choose both the installer (.exe) and its signature (.exe.sig).');
    setBusy(true); setErr('');
    try {
      const f = new FormData();
      f.append('installer', exe);
      f.append('signature', await sig.text());
      f.append('notes', notes);
      f.append('critical', critical ? 'true' : 'false');
      await upload('/releases', f);
      onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <Modal title="Upload a Curavo version" onClose={onClose} width={520}>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>
        From the GitHub build, download both files: <code>Curavo_X.Y.Z_x64-setup.exe</code> and
        <code> Curavo_X.Y.Z_x64-setup.exe.sig</code>. It goes to <b>pilot shops only</b> first.
      </p>
      <ErrorNote>{err}</ErrorNote>
      <label className="lbl">Installer (.exe)</label>
      <input type="file" accept=".exe" onChange={(e) => setExe(e.target.files[0] || null)} style={{ marginBottom: 12 }} />
      <label className="lbl">Signature (.exe.sig)</label>
      <input type="file" accept=".sig" onChange={(e) => setSig(e.target.files[0] || null)} style={{ marginBottom: 12 }} />
      <label className="lbl">What changed (shops see this)</label>
      <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Faster billing search; fixed the H1 register print." style={{ marginBottom: 12 }} />
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 16 }}>
        <input type="checkbox" checked={critical} onChange={(e) => setCritical(e.target.checked)} style={{ width: 'auto' }} />
        Important update (shops are asked to close Curavo today)
      </label>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={send} disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</button>
      </div>
    </Modal>
  );
}
