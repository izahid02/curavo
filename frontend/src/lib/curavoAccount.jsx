/**
 * "Sign in with your Curavo account" - the shop owner's account on curavo.in
 * (decided 4 Nov 2026).  Two places use it:
 *
 *   <AccountSignInButton/>  on the login screen, once this PC is linked
 *   <CuravoAccountModal/>   account menu -> "Curavo account": link this PC,
 *                           or see which account it is linked to
 *
 * Both follow the same steps: the backend asks the Curavo cloud for a short
 * code, we open curavo.in/link?code=... in the computer's browser, the owner
 * signs in there and presses Allow, and this screen - asking every 2 seconds -
 * carries on by itself.  The rules live in backend/app/routers/account_link.py.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import { openExternal } from './openExternal';

const POLL_MS = 2000;

/**
 * Runs one code from start to finish.
 *   startPath  POST here -> {code, url, expires_at}
 *   pollPath   (code) => GET path; {status: PENDING|APPROVED|REFUSED|EXPIRED|USED, ...}
 */
function useCodeFlow(startPath, pollPath, onApproved) {
  const [state, setState] = useState({ phase: 'idle' });
  const timer = useRef(null);
  const stop = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  useEffect(() => stop, []);

  async function start() {
    stop();
    setState({ phase: 'starting' });
    try {
      const { data } = await api.post(startPath);
      setState({ phase: 'waiting', code: data.code, url: data.url, expiresAt: data.expires_at });
      openExternal(data.url);
      timer.current = setInterval(async () => {
        try {
          const { data: r } = await api.get(pollPath(data.code));
          if (r.status === 'PENDING') return;
          stop();
          if (r.status === 'APPROVED') { setState({ phase: 'done' }); onApproved(r); return; }
          setState({ phase: 'error', message: {
            REFUSED: 'It was not allowed on curavo.in.',
            EXPIRED: 'The code expired before it was allowed. Try again.',
            USED: 'That code was already used. Try again.',
          }[r.status] || 'Something went wrong. Try again.' });
        } catch { /* one missed poll is fine */ }
      }, POLL_MS);
    } catch (err) {
      setState({ phase: 'error', message: err.response?.data?.detail || 'Could not reach Curavo. Check the internet.' });
    }
  }
  function cancel() { stop(); setState({ phase: 'idle' }); }
  return { state, start, cancel };
}

function CodeWaiting({ code, url, onCancel, what }) {
  const [left, setLeft] = useState(600);
  useEffect(() => { const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000); return () => clearInterval(t); }, []);
  return (
    <div style={{ textAlign: 'center' }}>
      <p style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.6, margin: '0 0 12px' }}>
        Your browser opened <b>curavo.in</b>. Sign in there and press <b>Allow</b> to {what}.
        Check this code matches the one on that page:
      </p>
      <div style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 26, letterSpacing: '0.08em',
        fontWeight: 600, color: 'var(--accent-dark)', background: 'var(--accent-light)', borderRadius: 12,
        padding: '10px 16px', display: 'inline-block' }}>{code}</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 10 }}>
        Waiting… ({Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')})
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
        <button type="button" className="btn-secondary" onClick={() => openExternal(url)}>Open the page again</button>
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- login screen

/** Shown under the login form only on a PC linked to an account. */
export function AccountSignInButton({ onSignedIn, disabled }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    api.get('/auth/account-login/available').then(({ data }) => setAvailable(!!data.available)).catch(() => {});
  }, []);
  const flow = useCodeFlow('/auth/account-login', (c) => `/auth/account-login/${c}`, onSignedIn);
  if (!available) return null;
  const { state } = flow;
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-hint)', fontSize: 12, margin: '4px 0 14px' }}>
        <span style={{ flex: 1, height: 1, background: 'rgba(99,102,241,0.15)' }} />or<span style={{ flex: 1, height: 1, background: 'rgba(99,102,241,0.15)' }} />
      </div>
      {state.phase === 'waiting' ? (
        <CodeWaiting code={state.code} url={state.url} onCancel={flow.cancel} what="sign in on this PC" />
      ) : (
        <>
          <button type="button" className="btn-secondary" disabled={disabled || state.phase === 'starting'}
            onClick={flow.start} style={{ width: '100%', padding: 11, fontSize: 14 }}>
            {state.phase === 'starting' ? 'Opening curavo.in…' : 'Sign in with your Curavo account'}
          </button>
          {state.phase === 'error' && (
            <div style={{ color: 'var(--danger)', fontSize: 12.5, marginTop: 8, textAlign: 'center' }}>{state.message}</div>
          )}
          <div style={{ fontSize: 11.5, color: 'var(--text-hint)', textAlign: 'center', marginTop: 8 }}>
            Needs internet. Without it, use your PC username and password above.
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- account menu

export function CuravoAccountModal({ onClose }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [justLinked, setJustLinked] = useState(false);
  const load = () => api.get('/account').then(({ data }) => setInfo(data)).catch(() => setError('Could not load the account.'));
  useEffect(() => { load(); }, []);
  const flow = useCodeFlow('/account/link', (c) => `/account/link/${c}`, () => { setJustLinked(true); load(); });

  const close = () => { flow.cancel(); onClose(); };
  const { state } = flow;

  return createPortal(
    <div style={backdrop} onMouseDown={close}>
      <div style={card} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ca-title">
        <h2 id="ca-title" style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>Curavo account</h2>
        <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          The shop owner's account on curavo.in. Linking it brings the subscription to this PC by itself and lets
          the owner sign in here with it. Staff keep their own PC logins.
        </p>

        {!info ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{error || 'Loading…'}</p>
        ) : !info.cloud_enabled ? (
          <Note tone="warn">This needs the Curavo cloud, which is not switched on for this PC.</Note>
        ) : info.linked ? (
          <>
            {justLinked && <Note tone="ok">Linked. The subscription on the account reaches this PC within a minute.</Note>}
            <div style={{ background: 'rgba(99,102,241,0.06)', borderRadius: 12, padding: '12px 14px', marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{info.name || info.email}</div>
              {info.name && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{info.email}</div>}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, marginBottom: 12 }}>
              <b>Offline sign-in:</b> when there is no internet, the owner signs in with the PC username
              <b> {info.offline_user}</b> and its password.
            </div>
            {info.default_password && (
              <Note tone="danger">
                <b>{info.offline_user}</b> still has the default password. Change it now (account menu → Change Password)
                - anyone who knows the default could sign in as the owner.
              </Note>
            )}
          </>
        ) : state.phase === 'waiting' ? (
          <CodeWaiting code={state.code} url={state.url} onCancel={flow.cancel} what="link this PC to your account" />
        ) : (
          <>
            {state.phase === 'error' && <Note tone="danger">{state.message}</Note>}
            <ol style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.7, margin: '0 0 14px', paddingLeft: 20 }}>
              <li>Press the button. Your browser opens curavo.in.</li>
              <li>Sign in (or create the account) and press <b>Allow</b>.</li>
              <li>Come back here - it finishes by itself.</li>
            </ol>
            <button className="btn-primary" style={{ width: '100%' }} disabled={state.phase === 'starting'} onClick={flow.start}>
              {state.phase === 'starting' ? 'Opening curavo.in…' : 'Sign in with your Curavo account'}
            </button>
            <p style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 10, lineHeight: 1.5 }}>
              You (the user signed in now) become the owner's sign-in on this PC.
            </p>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn-secondary" onClick={close}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Note({ tone, children }) {
  const c = { ok: ['var(--ok-bg)', 'var(--ok)'], warn: ['var(--warn-bg)', 'var(--warn)'], danger: ['var(--danger-bg)', 'var(--danger)'] }[tone];
  return <div style={{ background: c[0], color: c[1], borderRadius: 10, padding: '10px 12px', fontSize: 12.5, lineHeight: 1.5, marginBottom: 12 }}>{children}</div>;
}

const backdrop = {
  position: 'fixed', inset: 0, background: 'rgba(30,27,75,0.35)', backdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1500, padding: 16,
};
const card = {
  width: '100%', maxWidth: 440, maxHeight: '90vh', overflowY: 'auto',
  background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(24px)', border: '1px solid rgba(255,255,255,0.75)',
  borderRadius: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.2)', padding: 24, boxSizing: 'border-box',
};
