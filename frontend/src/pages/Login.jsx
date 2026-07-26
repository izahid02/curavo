import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setAuthToken } from '../lib/api';
import { saveToken } from '../lib/auth';
/**
 * Login screen — full-screen glassmorphism card centered on the body gradient.
 * Submits to POST /api/auth/login, saves the JWT on success.
 */
export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);
  const navigate = useNavigate();

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', { username, password });
      saveToken(data.token.access_token, data.user);
      setAuthToken(data.token.access_token);
      navigate('/');
    } catch {
      setError('Invalid username or password');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'grid', placeItems: 'center',
      padding: 20,
    }}>
      <div style={{
        width: 420, maxWidth: '100%',
        background: 'rgba(255,255,255,0.70)',
        backdropFilter: 'blur(32px)',
        WebkitBackdropFilter: 'blur(32px)',
        border: '1px solid rgba(255,255,255,0.75)',
        borderRadius: 20,
        padding: 36,
        boxShadow: '0 20px 60px rgba(99,102,241,0.15)',
      }}>

        {/* Logo — round circle with pulse animation */}
        <div style={{
          width: 88, height: 88,
          borderRadius: '50%',
          overflow: 'hidden',
          margin: '0 auto 18px',
          border: '3px solid rgba(99,102,241,0.2)',
          boxShadow: '0 4px 20px rgba(99,102,241,0.25)',
          animation: 'pulse 2.5s ease-in-out infinite',
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <img
            src="/HCC_LOGO.png"
            alt="Health Care Centre"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </div>

        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1e1b4b', textAlign: 'center' }}>
          Health Care Centre
        </h1>
        <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', marginBottom: 28 }}>
          Pharmacy ERP — please sign in
        </p>

        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <input
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            disabled={loading}
          />
          <input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={loading}
          />

          {error && (
            <div style={{
              background: 'rgba(244,63,94,0.10)',
              border: '1px solid rgba(244,63,94,0.2)',
              color: '#e11d48',
              borderRadius: 8,
              padding: '10px 14px',
              fontSize: 13,
            }}>
              {error}
            </div>
          )}

          <button
            className="btn-primary"
            type="submit"
            disabled={loading}
            style={{
              marginTop: 4,
              width: '100%',
              padding: '11px',
              fontSize: 14,
              opacity: loading ? 0.8 : 1,
              cursor: loading ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            {loading && (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                style={{ animation: 'spin 0.7s linear infinite' }}>
                <path d="M21 12a9 9 0 11-6.219-8.56"/>
              </svg>
            )}
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p style={{ fontSize: 11, color: '#9ca3af', textAlign: 'center', marginTop: 24 }}>
          Health Care Centre © 2026
        </p>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
