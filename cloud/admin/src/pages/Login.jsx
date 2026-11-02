import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../api';
import logo from '../logo.svg';
import { ErrorNote } from '../ui';

export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const { token } = await api('/login', { method: 'POST', body: { username, password } });
      setToken(token);
      navigate('/');
    } catch (e2) {
      setErr(e2.message);
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, position: 'relative', zIndex: 1 }}>
      <form onSubmit={submit} className="card" style={{ width: '100%', maxWidth: 380, padding: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
          <img src={logo} width="44" height="44" alt="" />
          <div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>Curavo Control</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>ARZ Solutions only</div>
          </div>
        </div>
        <ErrorNote>{err}</ErrorNote>
        <label className="lbl" htmlFor="u">Username</label>
        <input id="u" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" style={{ marginBottom: 12 }} />
        <label className="lbl" htmlFor="p">Password</label>
        <input id="p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" style={{ marginBottom: 18 }} />
        <button className="btn-primary" type="submit" disabled={busy} style={{ width: '100%', padding: '11px 18px', fontSize: 14.5 }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
