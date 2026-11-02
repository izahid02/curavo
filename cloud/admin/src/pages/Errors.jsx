/**
 * Every crash from every shop, grouped (the same crash 40 times = one row).
 * "Mark fixed" once a fix has shipped; if it happens again it comes back
 * flagged "Came back".
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { code, Empty, ErrorNote, StackBlock, timeAgo, when } from '../ui';

const SOURCE = { backend: 'App engine', screen: 'Screen', log: 'Logged' };

export function ErrorList({ rows, showShop = true, onChange }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);

  async function toggle(e) {
    setBusy(e.id);
    try {
      const updated = await api(`/errors/${e.id}/${e.resolved_at ? 'reopen' : 'resolve'}`, { method: 'POST' });
      onChange?.(updated);
    } finally { setBusy(null); }
  }

  if (!rows.length) return <Empty>No errors here.</Empty>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map((e) => (
        <div key={e.id} className="attention" style={{ cursor: 'default', flexDirection: 'column', alignItems: 'stretch', opacity: e.resolved_at ? 0.7 : 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: e.resolved_at ? 'var(--ok)' : e.regressed ? 'var(--danger)' : 'var(--warn)' }} />
            <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setOpen(open === e.id ? null : e.id)}>
              <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {e.kind}: {e.message || '(no message)'}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                {showShop && <>
                  <a href="#" onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); navigate(`/shops/${e.shop_code}`); }}
                    style={{ color: 'var(--accent)' }}>{e.shop_name || code(e.shop_code)}</a>{' · '}
                </>}
                {SOURCE[e.source] || e.source} · {e.route || '—'} · v{e.app_version || '?'} · last {timeAgo(e.last_seen)}
              </div>
            </div>
            {e.regressed && !e.resolved_at && <span className="badge badge-danger">Came back</span>}
            <span className="badge badge-neutral" title="How many times">{e.count}×</span>
            <button className="btn-secondary" disabled={busy === e.id} onClick={() => toggle(e)} style={{ padding: '6px 12px', fontSize: 12.5 }}>
              {e.resolved_at ? 'Reopen' : 'Mark fixed'}
            </button>
          </div>
          {open === e.id && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>
                First seen {when(e.first_seen)} · last seen {when(e.last_seen)}
                {e.resolved_at ? ` · marked fixed ${when(e.resolved_at)}` : ''}
              </div>
              {e.message && <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap' }}>{e.message}</div>}
              <StackBlock text={e.stack} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function Errors({ onChanged }) {
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');

  const load = () => api(`/errors?status=${status}`).then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { setRows(null); load(); }, [status]);   // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (rows || []).filter((e) => !t || `${e.kind} ${e.message} ${e.route} ${e.shop_name} ${e.shop_code}`.toLowerCase().includes(t));
  }, [rows, q]);

  return (
    <>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em' }}>Errors</h1>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Crashes reported by shops, grouped by kind. Click one to see where it happened.</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
          <div className="tabs">
            {[['open', 'Open'], ['resolved', 'Fixed'], ['all', 'All']].map(([k, l]) => (
              <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>
            ))}
          </div>
        </div>
      </header>
      <ErrorNote>{err}</ErrorNote>
      <section className="card">
        {rows === null ? <Empty>Loading…</Empty> : (
          <ErrorList rows={shown} onChange={() => {
            load();
            api('/overview').then((o) => onChanged?.(o.errors_open)).catch(() => {});
          }} />
        )}
      </section>
    </>
  );
}
