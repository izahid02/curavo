/**
 * Customer accounts - shop owners who signed up on curavo.in.
 *
 * Until online payments exist, this is where a subscription is set by hand
 * (HCC, pilot shops, a UPI payment): choose the plan and the paid-until
 * date, Save, and the cloud makes the licence key itself for every shop PC
 * linked to the account - it arrives on the PC's next check-in.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Empty, ErrorNote, timeAgo, when } from '../ui';

const PLANS = [['MONTHLY', 'Monthly', 1], ['HALF_YEARLY', 'Half-yearly', 6], ['YEARLY', 'Yearly', 12], ['FOUNDING', 'Founding member', 12]];
const PLAN_LABEL = Object.fromEntries(PLANS.map(([k, l]) => [k, l]));

function today() { return new Date().toISOString().slice(0, 10); }
function addMonths(ymd, n) {
  const d = new Date(ymd + 'T00:00:00');
  const day = d.getDate();
  d.setMonth(d.getMonth() + n);
  if (d.getDate() < day) d.setDate(0);           // 31 Jan + 1 month -> 28/29 Feb, not 3 Mar
  return d.toISOString().slice(0, 10);
}
function fmt(ymd) { return ymd ? new Date(ymd + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }

export default function Accounts() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);

  const load = () => api('/accounts').then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (rows || []).filter((a) => {
      const hay = [a.email, a.name, a.shop_name, a.town, a.phone, ...a.shops.map((s) => s.shop_code)].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [rows, q]);

  return (
    <>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em' }}>Accounts</h1>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Shop owners signed up on curavo.in. Set a subscription here until online payments exist.</div>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email, shop, town, code" style={{ width: 280, maxWidth: '100%' }} />
      </header>
      <ErrorNote>{err}</ErrorNote>

      <section className="card" style={{ padding: 6 }}>
        {!rows ? <div style={{ padding: 14 }}><Empty>Loading…</Empty></div>
          : shown.length === 0 ? <div style={{ padding: 14 }}><Empty>{rows.length ? 'No account matches.' : 'Nobody has signed up yet.'}</Empty></div> : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr><th>Owner</th><th>Shop</th><th>Shop PCs</th><th>Subscription</th><th>Signed up</th></tr></thead>
                <tbody>
                  {shown.map((a) => {
                    const active = a.paid_until && a.paid_until >= today();
                    return (
                      <React.Fragment key={a.id}>
                        <tr onClick={() => setOpen(open === a.id ? null : a.id)}>
                          <td>
                            <div style={{ fontWeight: 600 }}>{a.name || '—'}</div>
                            <div style={{ fontSize: 12.5, userSelect: 'all' }}>{a.email}</div>
                            <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
                              {!a.email_verified && <span className="badge badge-warn">Not confirmed</span>}
                              {a.google && <span className="badge badge-neutral">Google</span>}
                              {a.disabled && <span className="badge badge-danger">Disabled</span>}
                            </div>
                          </td>
                          <td>
                            <div>{a.shop_name || '—'}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>{[a.town, a.phone].filter(Boolean).join(' · ') || '—'}</div>
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            {a.shops.length === 0 ? <span style={{ color: 'var(--text-hint)' }}>none yet</span>
                              : a.shops.map((s) => (
                                <div key={s.shop_code}><Link to={`/shops/${s.shop_code}`}>{s.shop_name || s.shop_code}</Link></div>
                              ))}
                          </td>
                          <td>
                            {active
                              ? <><span className="badge badge-ok">Paid</span><div style={{ fontSize: 12.5, marginTop: 3 }}>{PLAN_LABEL[a.plan] || a.plan || ''} · until {fmt(a.paid_until)}</div></>
                              : a.paid_until
                                ? <><span className="badge badge-danger">Ended</span><div style={{ fontSize: 12.5, marginTop: 3 }}>{fmt(a.paid_until)}</div></>
                                : <span className="badge badge-neutral">Trial / not paid</span>}
                          </td>
                          <td title={when(a.created_at)}>{timeAgo(a.created_at)}</td>
                        </tr>
                        {open === a.id && (
                          <tr style={{ cursor: 'default' }}>
                            <td colSpan={5} style={{ background: 'rgba(255,255,255,0.45)' }}>
                              <SubscriptionEditor account={a} onSaved={(msg) => { load(); setErr(''); return msg; }} onError={setErr} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </>
  );
}

function SubscriptionEditor({ account, onSaved, onError }) {
  const [plan, setPlan] = useState(account.plan || 'YEARLY');
  const [until, setUntil] = useState(account.paid_until || '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [confirmDisable, setConfirmDisable] = useState(false);
  // "Add" counts from the later of today and the current end, so paying early never loses days.
  const base = account.paid_until && account.paid_until > today() ? account.paid_until : today();

  async function save(body) {
    setBusy(true); setDone('');
    try {
      const r = await api(`/accounts/${account.id}`, { method: 'PATCH', body });
      setDone(r.keys_sent
        ? `Saved. Licence sent to ${r.keys_sent} shop PC${r.keys_sent > 1 ? 's' : ''} - it activates on the next check-in.`
        : (account.shops.length === 0 ? 'Saved. It reaches the PC as soon as the owner links one.'
          : (!r.issuing_enabled ? 'Saved, but this server has no online licence key - no key was sent.' : 'Saved.')));
      onSaved();
    } catch (e) { onError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 280 }}>
        <div className="lbl">Subscription</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="Plan">
            {PLANS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Paid until" />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[['+1 month', 1], ['+6 months', 6], ['+1 year', 12]].map(([l, n]) => (
            <button key={l} className="btn-secondary" style={{ padding: '5px 10px', fontSize: 12.5 }}
              onClick={() => setUntil(addMonths(base, n))}>{l}</button>
          ))}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>
          "+" counts from {account.paid_until && account.paid_until > today() ? `the current end (${fmt(account.paid_until)})` : 'today'}.
        </div>
        <button className="btn-primary" disabled={busy || !until} onClick={() => save({ plan, paid_until: until })}
          style={{ alignSelf: 'flex-start' }}>{busy ? 'Saving…' : 'Save subscription'}</button>
        {done && <div style={{ fontSize: 13, color: 'var(--ok)' }}>{done}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220, fontSize: 13, color: 'var(--text-secondary)' }}>
        <div className="lbl">Account</div>
        <div>Last signed in: {account.last_login_at ? timeAgo(account.last_login_at) : 'never'}</div>
        {account.gstin && <div>GSTIN {account.gstin}</div>}
        {account.disabled ? (
          <button className="btn-secondary" disabled={busy} onClick={() => save({ disabled: false })} style={{ alignSelf: 'flex-start' }}>Enable account</button>
        ) : confirmDisable ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-danger" disabled={busy} onClick={() => { setConfirmDisable(false); save({ disabled: true }); }}>Disable and sign out everywhere</button>
            <button className="btn-secondary" onClick={() => setConfirmDisable(false)}>Keep</button>
          </div>
        ) : (
          <button className="btn-secondary" onClick={() => setConfirmDisable(true)} style={{ alignSelf: 'flex-start' }}>Disable account…</button>
        )}
      </div>
    </div>
  );
}
