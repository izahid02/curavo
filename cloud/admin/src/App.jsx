/**
 * Curavo Control - ARZ Solutions' view of every Curavo shop.
 * Routes: /login, / (overview), /shops, /shops/:code, /errors, /activity
 */
import React, { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, getToken, setToken } from './api';
import logo from './logo.svg';
import { ErrorNote, Modal } from './ui';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Shops from './pages/Shops';
import ShopDetail from './pages/ShopDetail';
import Errors from './pages/Errors';
import Activity from './pages/Activity';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/*" element={<RequireLogin />} />
    </Routes>
  );
}

/** Checked on every navigation (not once when App first rendered). */
function RequireLogin() {
  return getToken() ? <Shell /> : <Navigate to="/login" replace />;
}

const ICONS = {
  overview: <path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z" />,
  shops: <><path d="M3 9l1.5-5h15L21 9" /><path d="M3 9h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M9 21v-6h6v6" /></>,
  errors: <><path d="M12 3l9.5 16.5h-19z" /><path d="M12 10v4M12 17.5v.5" /></>,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
};

function Icon({ name }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

function Shell() {
  const navigate = useNavigate();
  const [me, setMe] = useState(null);
  const [openErrors, setOpenErrors] = useState(0);
  const [pw, setPw] = useState(false);

  useEffect(() => {
    api('/me').then(setMe).catch(() => {});
    const load = () => api('/overview').then((o) => setOpenErrors(o.errors_open)).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  function signOut() {
    setToken(null);
    navigate('/login');
  }

  const nav = (to, label, icon, count) => (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => `panel-nav${isActive ? ' active' : ''}`}>
      <Icon name={icon} />{label}
      {count ? <span className="count">{count}</span> : null}
    </NavLink>
  );

  return (
    <div className="panel-shell">
      <aside className="panel-side">
        <div className="side-brand" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 6px 16px' }}>
          <img src={logo} width="36" height="36" alt="" />
          <div>
            <div style={{ fontWeight: 600, fontSize: 16, lineHeight: 1.1 }}>Curavo</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Control · ARZ</div>
          </div>
        </div>
        {nav('/', 'Overview', 'overview')}
        {nav('/shops', 'Shops', 'shops')}
        {nav('/errors', 'Errors', 'errors', openErrors)}
        {nav('/activity', 'Activity', 'activity')}
        <div className="side-user" style={{ marginTop: 'auto', padding: '12px 8px 0', borderTop: '1px solid rgba(0,0,0,0.06)', fontSize: 13 }}>
          <div style={{ fontWeight: 600 }}>{me?.username || '…'}</div>
          <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
            <a href="#" onClick={(e) => { e.preventDefault(); setPw(true); }} style={{ color: 'var(--accent)' }}>Password</a>
            <a href="#" onClick={(e) => { e.preventDefault(); signOut(); }} style={{ color: 'var(--danger)' }}>Sign out</a>
          </div>
        </div>
      </aside>
      <main className="panel-main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/shops" element={<Shops />} />
          <Route path="/shops/:code" element={<ShopDetail onChanged={() => api('/overview').then((o) => setOpenErrors(o.errors_open)).catch(() => {})} />} />
          <Route path="/errors" element={<Errors onChanged={(n) => setOpenErrors(n)} />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {pw && <PasswordModal onClose={() => setPw(false)} />}
    </div>
  );
}

function PasswordModal({ onClose }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  async function save() {
    setErr('');
    if (next.length < 10) return setErr('Use at least 10 characters.');
    try {
      await api('/change-password', { method: 'POST', body: { current: cur, new: next } });
      setDone(true);
    } catch (e) { setErr(e.message); }
  }
  return (
    <Modal title="Change password" onClose={onClose} width={400}>
      {done ? <p style={{ color: 'var(--ok)', marginBottom: 14 }}>Password changed.</p> : (
        <>
          <ErrorNote>{err}</ErrorNote>
          <label className="lbl">Current password</label>
          <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} style={{ marginBottom: 12 }} />
          <label className="lbl">New password (10+ characters)</label>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} style={{ marginBottom: 16 }} />
        </>
      )}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button className="btn-secondary" onClick={onClose}>Close</button>
        {!done && <button className="btn-primary" onClick={save}>Save</button>}
      </div>
    </Modal>
  );
}
