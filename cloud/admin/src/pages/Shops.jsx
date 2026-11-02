import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { BackupPill, code, Empty, ErrorNote, LicencePill, OnlineDot, timeAgo } from '../ui';

export default function Shops() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => { api('/shops').then(setRows).catch((e) => setErr(e.message)); }, []);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase().replace('-', '');
    if (!rows) return [];
    return t ? rows.filter((r) => `${r.shop_name} ${r.shop_code}`.toLowerCase().includes(t)) : rows;
  }, [rows, q]);

  return (
    <>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em' }}>Shops</h1>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{rows ? `${rows.length} installation${rows.length === 1 ? '' : 's'}` : 'Loading…'}</div>
        </div>
        <input placeholder="Search name or shop code" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
      </header>
      <ErrorNote>{err}</ErrorNote>
      <div className="card" style={{ padding: 6, overflowX: 'auto' }}>
        {rows && shown.length === 0 ? <div style={{ padding: 14 }}><Empty>No shops yet. A shop appears here the first time its Curavo checks in.</Empty></div> : (
          <table>
            <thead>
              <tr><th>Shop</th><th>Version</th><th>Last seen</th><th>Cloud backup</th><th>Subscription</th><th style={{ textAlign: 'right' }}>Open errors</th></tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.shop_code} onClick={() => navigate(`/shops/${s.shop_code}`)}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <OnlineDot online={s.online} />
                      <div>
                        <div style={{ fontWeight: 600 }}>{s.shop_name || '(no name yet)'}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-hint)', letterSpacing: '0.04em' }}>
                          {code(s.shop_code)}
                          {s.disabled && <span className="badge badge-neutral" style={{ marginLeft: 6, fontSize: 10.5 }}>Disabled</span>}
                          {s.machine_conflict_at && <span className="badge badge-danger" style={{ marginLeft: 6, fontSize: 10.5 }}>Two PCs</span>}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>{s.app_version || '—'}</td>
                  <td>{timeAgo(s.last_seen_at)}</td>
                  <td><BackupPill status={s.backup_status} /> <span style={{ fontSize: 12, color: 'var(--text-hint)', marginLeft: 4 }}>{s.last_backup_at ? timeAgo(s.last_backup_at) : ''}</span></td>
                  <td><LicencePill state={s.licence_state} daysLeft={s.licence_days_left} /></td>
                  <td style={{ textAlign: 'right' }}>
                    {s.open_errors ? <span className="badge badge-danger">{s.open_errors}</span> : <span style={{ color: 'var(--text-hint)' }}>0</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
