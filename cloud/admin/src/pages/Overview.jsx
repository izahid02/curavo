/**
 * The first screen: is every shop alive, backed up, paid - and what broke.
 */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { BackupPill, bytes, code, Empty, ErrorNote, LicencePill, OnlineDot, SectionTitle, timeAgo } from '../ui';

export default function Overview() {
  const navigate = useNavigate();
  const [o, setO] = useState(null);
  const [errors, setErrors] = useState([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    const load = () => {
      api('/overview').then(setO).catch((e) => setErr(e.message));
      api('/errors?status=open').then((r) => setErrors(r.slice(0, 6))).catch(() => {});
    };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const attention = o ? [
    ...o.conflicts.map((s) => ({ s, tone: 'danger', text: 'Two PCs are using this shop code', pill: <span className="badge badge-danger">Two PCs</span> })),
    ...o.backups_attention.map((s) => ({ s, tone: 'warn', text: s.last_backup_at ? `Last cloud backup ${timeAgo(s.last_backup_at)}` : 'Has never backed up to the cloud', pill: <BackupPill status={s.backup_status} /> })),
    ...o.licences_attention.map((s) => ({ s, tone: 'info', text: s.licence_state === 'EXPIRED' ? 'Subscription ended - reports paused' : `Subscription: ${s.licence_days_left} days left`, pill: <LicencePill state={s.licence_state} daysLeft={s.licence_days_left} /> })),
  ] : [];

  return (
    <>
      <header>
        <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
          {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
        <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em' }}>Every Curavo shop</h1>
      </header>
      <ErrorNote>{err}</ErrorNote>

      <div className="grid-4">
        <Stat label="Shops" value={o?.shops} sub={o ? `${o.licences.ACTIVE} paid · ${o.licences.TRIAL} on trial` : ''} strip="linear-gradient(90deg,#6366f1,#8b5cf6)" />
        <Stat label="Online now" value={o?.online} sub="checked in within 35 min" strip="linear-gradient(90deg,#0ea5e9,#6366f1)" />
        <Stat label="Backed up today" value={o ? `${o.backups_ok}/${o.shops}` : null} sub={o ? `${bytes(o.storage_bytes)} stored` : ''} strip="linear-gradient(90deg,#10b981,#14b8a6)" />
        <Stat label="Open errors" value={o?.errors_open} sub={o ? `${o.errors_24h} seen in the last 24 h` : ''} strip="linear-gradient(90deg,#f43f5e,#f59e0b)" />
      </div>

      <div className="grid-2">
        <section className="card">
          <SectionTitle>Needs attention</SectionTitle>
          {o && attention.length === 0 && <Empty>Nothing - every shop is online, backed up and paid.</Empty>}
          {attention.map(({ s, tone, text, pill }, i) => (
            <div key={i} className="attention" onClick={() => navigate(`/shops/${s.shop_code}`)}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: `var(--${tone})`, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{s.shop_name || code(s.shop_code)}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{text}</div>
              </div>
              {pill}
            </div>
          ))}
        </section>

        <section className="card">
          <SectionTitle right={<a href="/errors" onClick={(e) => { e.preventDefault(); navigate('/errors'); }} style={{ fontSize: 13, color: 'var(--accent)' }}>All errors</a>}>
            Latest errors
          </SectionTitle>
          {errors.length === 0 && <Empty>No open errors.</Empty>}
          {errors.map((e) => (
            <div key={e.id} className="attention" onClick={() => navigate(`/shops/${e.shop_code}`)}>
              <OnlineDot online={false} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {e.kind}: {e.message || '(no message)'}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                  {e.shop_name || code(e.shop_code)} · {e.route || e.source} · {timeAgo(e.last_seen)}
                </div>
              </div>
              <span className={`badge ${e.regressed ? 'badge-danger' : 'badge-neutral'}`}>{e.regressed ? 'Came back' : `${e.count}×`}</span>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}

function Stat({ label, value, sub, strip }) {
  return (
    <div className="card stat" style={{ '--strip': strip }}>
      <div className="label">{label}</div>
      <div className="value">{value ?? '—'}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}
