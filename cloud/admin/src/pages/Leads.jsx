/**
 * Demo bookings from the website.  Work down the list: call or WhatsApp,
 * then move each one along - Contacted, On trial, Customer, or Not interested.
 */
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Empty, ErrorNote, timeAgo, when } from '../ui';

const STATUS = [
  ['NEW', 'New', 'badge-accent'],
  ['CONTACTED', 'Contacted', 'badge-info'],
  ['TRIAL', 'On trial', 'badge-warn'],
  ['CUSTOMER', 'Customer', 'badge-ok'],
  ['NOT_INTERESTED', 'Not interested', 'badge-neutral'],
];
const LABEL = Object.fromEntries(STATUS.map(([k, l, c]) => [k, [l, c]]));

export default function Leads({ onChanged }) {
  const [filter, setFilter] = useState('NEW');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);

  const load = () => api(`/leads${filter ? `?status=${filter}` : ''}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { setD(null); load(); }, [filter]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function patch(lead, body) {
    try {
      await api(`/leads/${lead.id}`, { method: 'PATCH', body });
      load(); onChanged?.();
    } catch (e) { setErr(e.message); }
  }

  return (
    <>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em' }}>Leads</h1>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Pharmacies that booked a demo on the website.</div>
        </div>
        <div className="tabs">
          {STATUS.map(([k, l]) => (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
              {l}{d?.counts?.[k] ? ` · ${d.counts[k]}` : ''}
            </button>
          ))}
          <button className={filter === '' ? 'on' : ''} onClick={() => setFilter('')}>All</button>
        </div>
      </header>
      <ErrorNote>{err}</ErrorNote>

      <section className="card" style={{ padding: 6 }}>
        {!d ? <div style={{ padding: 14 }}><Empty>Loading…</Empty></div>
          : d.leads.length === 0 ? <div style={{ padding: 14 }}><Empty>Nobody here.</Empty></div> : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr><th>Shop</th><th>Contact</th><th>Uses now</th><th>Booked</th><th>Status</th></tr></thead>
                <tbody>
                  {d.leads.map((l) => (
                    <React.Fragment key={l.id}>
                      <tr onClick={() => setOpen(open === l.id ? null : l.id)}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{l.shop}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>{l.town || '—'}</div>
                        </td>
                        <td>
                          <div>{l.name}</div>
                          <div style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums', userSelect: 'all' }}>{l.phone}</div>
                        </td>
                        <td>{l.current_software || '—'}</td>
                        <td title={when(l.created_at)}>{timeAgo(l.created_at)}</td>
                        <td><span className={`badge ${LABEL[l.status][1]}`}>{LABEL[l.status][0]}</span></td>
                      </tr>
                      {open === l.id && (
                        <tr style={{ cursor: 'default' }}>
                          <td colSpan={5} style={{ background: 'rgba(255,255,255,0.45)' }}>
                            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220 }}>
                                <a href={`https://wa.me/91${l.phone.slice(-10)}`} target="_blank" rel="noreferrer"
                                  className="btn-primary" style={{ textDecoration: 'none', textAlign: 'center', padding: '8px 14px', borderRadius: 10 }}>
                                  Open WhatsApp chat
                                </a>
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                  {STATUS.filter(([k]) => k !== l.status).map(([k, lbl]) => (
                                    <button key={k} className="btn-secondary" style={{ padding: '5px 10px', fontSize: 12.5 }}
                                      onClick={() => patch(l, { status: k })}>{lbl}</button>
                                  ))}
                                </div>
                              </div>
                              <NoteBox lead={l} onSave={(notes) => patch(l, { notes })} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </>
  );
}

function NoteBox({ lead, onSave }) {
  const [v, setV] = useState(lead.notes);
  return (
    <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label className="lbl" htmlFor={`n-${lead.id}`}>Notes</label>
      <textarea id={`n-${lead.id}`} rows={3} value={v} onChange={(e) => setV(e.target.value)}
        placeholder="Called on Monday, wants a demo after Diwali…" />
      <button className="btn-secondary" style={{ alignSelf: 'flex-end', padding: '5px 12px', fontSize: 12.5 }}
        disabled={v === lead.notes} onClick={() => onSave(v)}>Save note</button>
    </div>
  );
}
