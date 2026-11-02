import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { code, Empty, ErrorNote, when } from '../ui';

const LABEL = {
  queue_licence: 'Sent a licence key', reset_device: 'Reset the device link', disable: 'Disabled shop',
  enable: 'Enabled shop', notes: 'Edited notes', clear_conflict: 'Cleared two-PC flag',
  download_backup: 'Downloaded a backup', resolve_error: 'Marked error fixed', reopen_error: 'Reopened error',
  change_password: 'Changed panel password',
};

export default function Activity() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('/audit').then(setRows).catch((e) => setErr(e.message)); }, []);
  return (
    <>
      <header>
        <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em' }}>Activity</h1>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Everything done in this control panel, newest first</div>
      </header>
      <ErrorNote>{err}</ErrorNote>
      <div className="card" style={{ padding: 6 }}>
        {rows && rows.length === 0 ? <div style={{ padding: 14 }}><Empty>Nothing yet.</Empty></div> : (
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Shop</th><th>Detail</th></tr></thead>
            <tbody>
              {(rows || []).map((a, i) => (
                <tr key={i} onClick={() => a.shop_code && navigate(`/shops/${a.shop_code}`)} style={{ cursor: a.shop_code ? 'pointer' : 'default' }}>
                  <td style={{ whiteSpace: 'nowrap' }}>{when(a.at)}</td>
                  <td>{a.admin}</td>
                  <td>{LABEL[a.action] || a.action}</td>
                  <td>{a.shop_name || code(a.shop_code) || '—'}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{a.detail || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
