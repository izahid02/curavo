/**
 * One shop: its PC, subscription, cloud backups, check-ins and errors, and the
 * things ARZ can do about them (send a licence key, reset the device link,
 * disable, notes).
 */
import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, download } from '../api';
import {
  BackupPill, bytes, code, day, Empty, ErrorNote, LicencePill, Modal, OnlineDot, SectionTitle, timeAgo, when,
} from '../ui';
import { ErrorList } from './Errors';

export default function ShopDetail({ onChanged }) {
  const { code: shopCode } = useParams();
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState(null);       // 'licence' | 'reset' | 'disable'
  const [notes, setNotes] = useState('');
  const [notesSaved, setNotesSaved] = useState(false);
  const [toast, setToast] = useState('');

  const load = () => api(`/shops/${shopCode}`).then((d) => { setS(d); setNotes(d.notes || ''); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [shopCode]);      // eslint-disable-line react-hooks/exhaustive-deps

  function flash(t) { setToast(t); setTimeout(() => setToast(''), 3000); }

  async function act(path, body, message) {
    try {
      await api(`/shops/${shopCode}${path}`, { method: body === undefined ? 'POST' : 'PATCH', body });
      setModal(null);
      flash(message);
      load();
      onChanged?.();
    } catch (e) { setErr(e.message); }
  }

  async function saveNotes() {
    await api(`/shops/${shopCode}`, { method: 'PATCH', body: { notes } });
    setNotesSaved(true);
    setTimeout(() => setNotesSaved(false), 2000);
  }

  if (!s) return <><ErrorNote>{err}</ErrorNote>{!err && <Empty>Loading…</Empty>}</>;
  const h = s.last_heartbeat?.health || {};

  return (
    <>
      <div>
        <Link to="/shops" style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none' }}>← All shops</Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
          <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em' }}>{s.shop_name || '(no name yet)'}</h1>
          <span className="badge badge-accent" style={{ letterSpacing: '0.06em' }}>{code(s.shop_code)}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
            <OnlineDot online={s.online} /> {s.online ? 'Online' : `Last seen ${timeAgo(s.last_seen_at)}`}
          </span>
          {s.disabled && <span className="badge badge-neutral">Disabled</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button className="btn-primary" onClick={() => setModal('licence')}>Send licence key</button>
          <button className="btn-secondary" onClick={() => setModal('reset')}>Reset device link</button>
          {s.disabled
            ? <button className="btn-secondary" onClick={() => act('', { disabled: false }, 'Shop enabled')}>Enable shop</button>
            : <button className="btn-danger" onClick={() => setModal('disable')}>Disable shop</button>}
        </div>
      </div>

      <ErrorNote>{err}</ErrorNote>
      {toast && <div style={{ background: 'var(--ok-bg)', color: 'var(--ok)', borderRadius: 10, padding: '9px 12px', fontSize: 13, fontWeight: 600 }}>{toast}</div>}

      {s.machine_conflict_at && (
        <div className="card" style={{ borderLeft: '3px solid var(--danger)', display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 600, color: 'var(--danger)' }}>Two PCs are using this shop code</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
              A different computer checked in {timeAgo(s.machine_conflict_at)} while the usual one was still active.
              Usually a copied installation, or a second counter PC. Ask the shop; if it is not theirs, reset the device link.
            </div>
          </div>
          <button className="btn-secondary" onClick={() => act('/clear-conflict', undefined, 'Flag cleared')}>Clear flag</button>
        </div>
      )}

      <div className="grid-2">
        <section className="card">
          <SectionTitle>This PC</SectionTitle>
          <dl className="kv">
            <dt>App version</dt><dd>{s.app_version || '—'}</dd>
            <dt>Pilot shop</dt>
            <dd>
              <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontWeight: 500 }}>
                <input type="checkbox" checked={s.pilot} style={{ width: 'auto' }}
                  onChange={(e) => act('', { pilot: e.target.checked }, e.target.checked ? 'Now a pilot shop - gets new versions first' : 'No longer a pilot shop')} />
                Gets new versions first
              </label>
            </dd>
            <dt>System</dt><dd>{s.os_name || '—'}</dd>
            <dt>Last check-in</dt><dd>{when(s.last_seen_at)}</dd>
            <dt>Joined the cloud</dt><dd>{when(s.registered_at)}</dd>
            <dt>Device link</dt><dd>{s.device_linked ? 'Linked' : 'Waiting for a PC to register'}</dd>
            <dt>Database size</dt><dd>{bytes(h.db_bytes)}</dd>
            <dt>Free disk space</dt><dd style={{ color: h.disk_free_bytes != null && h.disk_free_bytes < 2 * 1024 ** 3 ? 'var(--danger)' : undefined }}>{bytes(h.disk_free_bytes)}</dd>
            <dt>Backups on the PC</dt><dd>{h.local_backups ?? '—'}{h.last_local_backup ? ` · newest ${when(h.last_local_backup)}` : ''}</dd>
            <dt>Bills today</dt><dd>{h.invoices_today ?? '—'}</dd>
            <dt>Errors not yet sent</dt><dd>{h.errors_pending ?? '—'}</dd>
          </dl>
          <CheckIns beats={s.heartbeats} />
        </section>

        <section className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <SectionTitle>Subscription</SectionTitle>
          <dl className="kv">
            <dt>State</dt><dd><LicencePill state={s.licence_state} daysLeft={s.licence_days_left} /></dd>
            <dt>{s.licence_state === 'TRIAL' ? 'Trial ends' : 'Paid until'}</dt><dd>{day(s.licence_until)}</dd>
            <dt>Key number</dt><dd>{s.licence_serial != null ? `#${s.licence_serial}` : '—'}</dd>
            <dt>Key waiting</dt><dd>{s.pending_licence_until ? `Until ${day(s.pending_licence_until)} - delivered on next check-in` : 'None'}</dd>
          </dl>
          <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', flex: 1 }}>
            <label className="lbl" htmlFor="notes">Notes (only ARZ sees these)</label>
            <textarea id="notes" rows={5} value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="Owner's name and phone, payment dates, anything to remember…" style={{ flex: 1, resize: 'vertical' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 8 }}>
              {notesSaved && <span style={{ color: 'var(--ok)', fontSize: 13 }}>Saved</span>}
              <button className="btn-secondary" onClick={saveNotes} disabled={notes === (s.notes || '')}>Save notes</button>
            </div>
          </div>
        </section>
      </div>

      <section className="card">
        <SectionTitle right={<BackupPill status={s.backup_status} />}>Cloud backups</SectionTitle>
        {s.backups.length === 0 ? <Empty>No cloud backups yet.</Empty> : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Received</th><th>Taken on the PC</th><th>Size</th><th>App version</th><th /></tr></thead>
              <tbody>
                {s.backups.map((b) => (
                  <tr key={b.id} style={{ cursor: 'default' }}>
                    <td>{when(b.uploaded_at)}</td>
                    <td>{when(b.created_at)}</td>
                    <td>{bytes(b.size)}</td>
                    <td>{b.app_version || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn-secondary" style={{ padding: '5px 12px', fontSize: 12.5 }}
                        onClick={() => download(`/shops/${s.shop_code}/backups/${b.id}`).catch((e) => setErr(e.message))}>
                        Download
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 12, lineHeight: 1.6 }}>
          Backups are locked on the shop PC; this server cannot open them. To restore, download one and unlock it on your Mac:
          <code style={{ display: 'block', marginTop: 6, fontSize: 12, background: 'rgba(30,27,75,0.05)', padding: '6px 10px', borderRadius: 8 }}>
            python3 tools/cloud/curavo_recovery.py open {s.shop_code}_….cbk --out ~/Desktop/restore
          </code>
        </p>
      </section>

      <section className="card">
        <SectionTitle>Owner app phones</SectionTitle>
        {(s.phones || []).length === 0 ? <Empty>No phone connected.</Empty> : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Phone</th><th>Status</th><th>Connected</th><th>Last opened</th><th>Notifications</th></tr></thead>
              <tbody>
                {s.phones.map((d, i) => (
                  <tr key={i} style={{ cursor: 'default' }}>
                    <td>{d.name}</td>
                    <td>{d.status === 'ACTIVE' ? 'Connected' : 'Waiting for the PC'}</td>
                    <td>{when(d.connected_at)}</td>
                    <td>{d.last_seen_at ? timeAgo(d.last_seen_at) : '—'}</td>
                    <td>{d.push ? 'On' : 'Off'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 12, lineHeight: 1.6 }}>
          Phones are connected and removed by the owner on the shop PC (account menu, Owner app on phone).
          {s.owner_summary_at && <> Figures last left for them {timeAgo(s.owner_summary_at)} - locked, so this panel cannot read them.</>}
        </p>
      </section>

      <section className="card">
        <SectionTitle>Errors at this shop</SectionTitle>
        <ErrorList rows={s.errors} showShop={false} onChange={() => { load(); onChanged?.(); }} />
      </section>

      {modal === 'licence' && <LicenceModal shop={s} onClose={() => setModal(null)} onDone={(r) => { setModal(null); flash(`Key until ${day(r.until)} queued - it reaches the shop on its next check-in`); load(); }} />}
      {modal === 'reset' && (
        <Confirm title="Reset device link?" onClose={() => setModal(null)} onYes={() => act('/reset-device', undefined, 'Device link reset')} yes="Reset">
          The next PC that starts Curavo with shop code <b>{code(s.shop_code)}</b> will take this shop over.
          Do this when a shop has a <b>new PC</b> that did not get its database restored. The old PC stops reaching the cloud.
        </Confirm>
      )}
      {modal === 'disable' && (
        <Confirm title="Disable this shop?" onClose={() => setModal(null)} onYes={() => act('', { disabled: true }, 'Shop disabled')} yes="Disable" danger>
          Its PC will no longer check in, back up or receive keys. <b>Billing on the PC keeps working.</b> You can enable it again any time.
        </Confirm>
      )}
    </>
  );
}

/** The last 24 hours in 15-minute slots: filled = the PC checked in. */
function CheckIns({ beats }) {
  const now = Date.now();
  const slots = new Array(96).fill(false);
  for (const b of beats) {
    const i = Math.floor((now - new Date(b.at).getTime()) / (15 * 60 * 1000));
    if (i >= 0 && i < 96) slots[95 - i] = true;
  }
  const n = slots.filter(Boolean).length;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-hint)', marginBottom: 6 }}>
        <span>Check-ins, last 24 hours</span><span>{n} of 96</span>
      </div>
      <div style={{ display: 'flex', gap: 2 }} aria-label={`${n} check-ins in the last 24 hours`}>
        {slots.map((on, i) => (
          <span key={i} style={{ flex: 1, height: 18, borderRadius: 3, background: on ? 'var(--ok)' : 'rgba(0,0,0,0.07)' }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
        <span>24 h ago</span><span>now</span>
      </div>
    </div>
  );
}

function LicenceModal({ shop, onClose, onDone }) {
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true); setErr('');
    try {
      onDone(await api(`/shops/${shop.shop_code}/licence`, { method: 'POST', body: { key } }));
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title="Send a licence key" onClose={onClose}>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>
        Make the key on your Mac:
        <code style={{ display: 'block', marginTop: 6, fontSize: 12, background: 'rgba(30,27,75,0.05)', padding: '6px 10px', borderRadius: 8 }}>
          python3 tools/licence/curavo_licence.py issue --code {code(shop.shop_code)} --shop "{shop.shop_name || 'Shop name'}" --months 12
        </code>
        Paste it below. The shop's PC picks it up on its next check-in (within 15 minutes) and activates it by itself.
      </p>
      <ErrorNote>{err}</ErrorNote>
      <textarea rows={4} value={key} onChange={(e) => setKey(e.target.value)} placeholder="CURAVO-…"
        style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12, wordBreak: 'break-all', marginBottom: 14 }} />
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={send} disabled={busy || !key.trim()}>{busy ? 'Sending…' : 'Queue for this shop'}</button>
      </div>
    </Modal>
  );
}

function Confirm({ title, children, onClose, onYes, yes, danger }) {
  return (
    <Modal title={title} onClose={onClose} width={420}>
      <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 18 }}>{children}</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onYes}>{yes}</button>
      </div>
    </Modal>
  );
}
