/**
 * The Curavo subscription, as the screens see it.
 *
 *   <LicenceProvider>   mounted by Layout (so only once logged in).  Fetches
 *                       GET /api/licence/status on load and once an hour (so a
 *                       shop left open overnight notices the date change).
 *   useLicence()        { status, restricted, refresh, openLicence }
 *   <LicenceBanner />   the strip above the page when something needs action
 *   <LicencePill />     the small "Trial · 23 days left" chip in the header
 *
 * All the RULES live on the server (backend/app/services/licence.py).  This
 * file only shows what the server says: it never works out dates itself, so
 * the PC's clock cannot make the screen disagree with what is actually locked.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';

const LicenceContext = createContext({
  status: null, restricted: false, refresh: () => {}, openLicence: () => {},
});

export function useLicence() {
  return useContext(LicenceContext);
}

/** Roles that may paste a key - must match _LICENCE_ADMIN_ROLES in routers/licence.py. */
const LICENCE_ADMIN_ROLES = ['Owner', 'Administrator'];

export function LicenceProvider({ role, children }) {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => (
    api.get('/licence/status').then(({ data }) => setStatus(data)).catch(() => {})
  ), []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60 * 60 * 1000);
    return () => clearInterval(t);
  }, [refresh]);

  const value = {
    status,
    restricted: !!status?.restricted,
    refresh,
    openLicence: () => setOpen(true),
  };

  return (
    <LicenceContext.Provider value={value}>
      {children}
      {open && (
        <LicenceModal
          status={status}
          canActivate={LICENCE_ADMIN_ROLES.includes(role)}
          onClose={() => setOpen(false)}
          onActivated={(s) => setStatus(s)}
        />
      )}
    </LicenceContext.Provider>
  );
}

/* Colours per state - the design-system tokens from global.css. */
const TONE = {
  TRIAL:   { fg: 'var(--info)',   bg: 'var(--info-bg)'   },
  ACTIVE:  { fg: 'var(--ok)',     bg: 'var(--ok-bg)'     },
  GRACE:   { fg: 'var(--warn)',   bg: 'var(--warn-bg)'   },
  EXPIRED: { fg: 'var(--danger)', bg: 'var(--danger-bg)' },
};

/**
 * Shown only when something needs doing: trial in its last week, a paid
 * licence in its last 15 days, grace, or restricted.  Otherwise nothing.
 */
export function LicenceBanner() {
  const { status, openLicence } = useLicence();
  if (!status) return null;
  const urgent =
    status.state === 'GRACE' || status.state === 'EXPIRED' ||
    (status.state === 'TRIAL' && status.days_left <= 7) ||
    (status.state === 'ACTIVE' && status.days_left <= 15);
  if (!urgent) return null;
  const tone = TONE[status.state];

  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      margin: '0 4px 14px', padding: '10px 14px',
      background: tone.bg, border: `1px solid ${tone.fg}33`, borderRadius: 12,
      color: 'var(--text)', fontSize: 13, flexShrink: 0,
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: tone.fg, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 220 }}>
        <b style={{ fontWeight: 600, color: tone.fg }}>{status.headline}.</b>{' '}
        {status.detail}
      </span>
      <button className="btn-secondary" onClick={openLicence}
        style={{ padding: '6px 14px', fontSize: 13, whiteSpace: 'nowrap' }}>
        {status.state === 'EXPIRED' ? 'Enter licence key' : 'Renew'}
      </button>
    </div>
  );
}

/** The quiet header chip during a trial that is not yet urgent. */
export function LicencePill() {
  const { status, openLicence } = useLicence();
  if (!status || status.state !== 'TRIAL' || status.days_left <= 7) return null;
  return (
    <button onClick={openLicence} title="Licence & subscription" style={{
      height: 32, padding: '0 12px', borderRadius: 999, cursor: 'pointer',
      border: '1px solid rgba(255,255,255,0.9)', background: 'rgba(255,255,255,0.65)',
      backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
      color: 'var(--info)', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
      font: 'inherit',
    }}>
      Free trial · {status.days_left} days left
    </button>
  );
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function LicenceModal({ status, canActivate, onClose, onActivated }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(status.shop_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked - the code is selectable text, so it can still be copied by hand */
    }
  }

  async function activate() {
    if (!key.trim()) return setError('Paste the licence key first.');
    setBusy(true); setError(''); setDone('');
    try {
      const { data } = await api.post('/licence/activate', { key });
      onActivated(data);
      setKey('');
      setDone('Licence accepted.');
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not check the key. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const tone = TONE[status?.state] || TONE.TRIAL;

  return createPortal(
    <div style={backdrop} onMouseDown={onClose}>
      <div style={card} onMouseDown={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="licence-title">
        <h2 id="licence-title" style={{ margin: '0 0 14px', fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>
          Licence &amp; subscription
        </h2>

        {!status ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading…</p>
        ) : (
          <>
            {/* Current state */}
            <div style={{ background: tone.bg, borderRadius: 12, padding: '12px 14px', marginBottom: 16 }}>
              <div style={{ fontWeight: 600, color: tone.fg, fontSize: 14 }}>{status.headline}</div>
              {status.detail && (
                <div style={{ fontSize: 12.5, color: 'var(--text)', marginTop: 4, lineHeight: 1.5 }}>{status.detail}</div>
              )}
              {status.licensed_to && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
                  Licensed to <b style={{ fontWeight: 600, color: 'var(--text)' }}>{status.licensed_to}</b>
                  {' '}· until {fmtDate(status.valid_until)} · key #{status.serial}
                </div>
              )}
            </div>

            {/* Shop code */}
            <div style={label}>Your shop code</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{
                flex: 1, fontSize: 22, fontWeight: 600, letterSpacing: '0.12em',
                fontVariantNumeric: 'tabular-nums', color: 'var(--text)', userSelect: 'all',
                background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(0,0,0,0.08)',
                borderRadius: 10, padding: '8px 12px', textAlign: 'center',
              }}>
                {status.shop_code}
              </span>
              <button className="btn-secondary" onClick={copyCode} style={{ padding: '10px 14px', fontSize: 13 }}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 16 }}>
              To subscribe or renew: pay ARZ Solutions, then send them this code.
              They will send back a licence key made for this shop only.
            </div>

            {/* Key entry */}
            {canActivate ? (
              <>
                <label style={label} htmlFor="licence-key">Licence key</label>
                <textarea
                  id="licence-key"
                  value={key}
                  onChange={(e) => { setKey(e.target.value); setError(''); setDone(''); }}
                  placeholder="CURAVO-…"
                  rows={4}
                  spellCheck={false}
                  style={{
                    width: '100%', boxSizing: 'border-box', resize: 'vertical',
                    padding: '10px 12px', fontSize: 12.5, fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
                    border: '1px solid rgba(0,0,0,0.1)', borderRadius: 10,
                    background: 'rgba(255,255,255,0.7)', color: 'var(--text)', marginBottom: 8,
                    wordBreak: 'break-all',
                  }}
                />
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 8 }}>
                Only the owner or an administrator can enter a licence key.
              </div>
            )}

            {error && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 8, lineHeight: 1.5 }}>{error}</div>}
            {done && <div style={{ color: 'var(--ok)', fontSize: 12.5, marginBottom: 8 }}>{done}</div>}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="btn-secondary" onClick={onClose} disabled={busy}>Close</button>
              {canActivate && (
                <button className="btn-primary" onClick={activate} disabled={busy}>
                  {busy ? 'Checking…' : 'Activate'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The panel a page shows in place of content that is paused (a 402 from the
 * server).  Used by Reports; billing never sees it.
 */
export function LicenceLockedPanel({ what = 'This' }) {
  const { status, openLicence } = useLicence();
  return (
    <div className="card" style={{ padding: 28, textAlign: 'center', maxWidth: 520, margin: '24px auto' }}>
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
        {what} paused
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 16px' }}>
        {status?.headline ? `${status.headline}. ` : ''}
        Billing keeps working as normal. Enter a licence key to bring {what.toLowerCase()} back.
      </p>
      <button className="btn-primary" onClick={openLicence}>Enter licence key</button>
    </div>
  );
}

const backdrop = {
  position: 'fixed', inset: 0, background: 'rgba(30,27,75,0.35)',
  backdropFilter: 'blur(4px)', display: 'flex',
  alignItems: 'center', justifyContent: 'center', zIndex: 1500, padding: 16,
};
const card = {
  width: '100%', maxWidth: 460, maxHeight: '88vh', overflowY: 'auto',
  background: 'rgba(255,255,255,0.88)', backdropFilter: 'blur(24px)',
  border: '1px solid rgba(255,255,255,0.75)', borderRadius: 18,
  boxShadow: '0 20px 60px rgba(0,0,0,0.2)', padding: 24, boxSizing: 'border-box',
};
const label = {
  display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6,
};
