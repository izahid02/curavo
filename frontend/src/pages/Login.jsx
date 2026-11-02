import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setAuthToken } from '../lib/api';
import { saveToken } from '../lib/auth';
import { usePharmacy } from '../lib/pharmacy.jsx';
import ARZLogo from '../components/shared/ARZLogo';
/**
 * Login screen — full-screen glassmorphism card centered on the body gradient.
 * Submits to POST /api/auth/login, saves the JWT on success.
 *
 * The identifier box accepts a USERNAME OR AN EMAIL: the backend matches
 * either (see routers/auth.py), so the person at the counter types whichever
 * they remember.  The field is still named `username` on the wire — renaming
 * it would break nothing but gain nothing either.
 */
export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);
  const navigate = useNavigate();
  // The shop's own name, loaded once at app start (see lib/pharmacy.jsx).
  // It falls back to "Health Care Centre" until the request lands, so this
  // card never flashes blank.
  const { pharmacy } = usePharmacy();

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
      setError('Invalid username/email or password');
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

        {/* Curavo logo — the product's mark, with the existing pulse.
            The logo file is already a rounded indigo tile, so this box only
            adds the glow; the SHOP's own name is the heading underneath. */}
        <div style={{
          width: 80, height: 80,
          borderRadius: 22,
          margin: '0 auto 18px',
          boxShadow: '0 8px 28px rgba(99,102,241,0.35)',
          animation: 'pulse 2.5s ease-in-out infinite',
        }}>
          <img
            src="/curavo-logo.svg"
            alt="Curavo"
            style={{ width: '100%', height: '100%', display: 'block' }}
          />
        </div>

        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1e1b4b', textAlign: 'center' }}>
          {pharmacy.pharmacy_name}
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', marginBottom: 28 }}>
          Curavo — please sign in
        </p>

        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <input
            placeholder="Username or Email"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            // "username" still tells a password manager this is the identifier
            // field even though an email is equally valid here.
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

        <p style={{ fontSize: 11, color: 'var(--text-hint)', textAlign: 'center', marginTop: 24 }}>
          {pharmacy.pharmacy_name} © {new Date().getFullYear()}
        </p>

        {/* ── "Powered by" ARZ Technologies logo ──────────────────────────
            Sits below a hairline divider at the foot of the login card. */}
        <div style={{
          marginTop: '24px',
          paddingTop: '20px',
          borderTop: '1px solid rgba(0,0,0,0.06)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '10px',
        }}>
          <span style={{
            fontSize: '10px',
            fontWeight: 600,
            color: '#94a3b8',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}>
            Powered by
          </span>
          <ARZLogo size="md" />
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
