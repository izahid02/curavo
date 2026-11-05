/**
 * "Owner app on phone" - account menu (Owner/Administrator only).
 *
 * Lists the phones connected to this shop and connects a new one:
 *   1. "Connect a phone" asks the backend for a one-time code (10 minutes)
 *   2. it is shown as a QR code; the owner scans it with the Curavo Owner app
 *   3. this window asks the backend every 2 seconds whether a phone has
 *      scanned it - the BACKEND checks the phone's proof and connects it
 *
 * All the security lives on the server (backend/app/services/owner_app.py);
 * this screen only shows what it says.  The QR holds a one-time secret, so it
 * is shown only while this window is open and disappears once used.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { api } from './api';
import { useLicence } from './licence.jsx';

const POLL_MS = 2000;

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function OwnerAppModal({ onClose }) {
  const { restricted, openLicence } = useLicence();
  const [info, setInfo] = useState(null);         // GET /owner-app/devices
  const [pairing, setPairing] = useState(null);   // {pairing_id, expires_at, qr}
  const [qrImg, setQrImg] = useState('');
  const [phase, setPhase] = useState('list');     // list | showing | done | failed
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const pollRef = useRef(null);

  const load = useCallback(() => (
    api.get('/owner-app/devices').then(({ data }) => setInfo(data))
      .catch(() => setError('Could not load the connected phones.'))
  ), []);

  useEffect(() => { load(); }, [load]);

  // Stop polling whenever we leave the QR screen or close the window.
  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => stopPolling, []);

  // Countdown shown under the QR code.
  useEffect(() => {
    if (phase !== 'showing' || !pairing) return undefined;
    const tick = () => setSecondsLeft(Math.max(0, Math.round((new Date(pairing.expires_at) - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [phase, pairing]);

  async function startPairing() {
    setBusy(true); setError(''); setMessage('');
    try {
      const { data } = await api.post('/owner-app/pairings');
      setPairing(data);
      setQrImg(await QRCode.toDataURL(data.qr, { errorCorrectionLevel: 'M', margin: 1, width: 260 }));
      setPhase('showing');
      stopPolling();
      pollRef.current = setInterval(() => checkPairing(data.pairing_id), POLL_MS);
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not make a code. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function checkPairing(id) {
    try {
      const { data } = await api.get(`/owner-app/pairings/${id}`);
      if (data.status === 'OPEN') return;
      stopPolling();
      setQrImg('');                                   // the code is spent - hide it
      if (data.status === 'DONE') {
        setPhase('done');
        setMessage(`${data.device_name || 'The phone'} is connected. Today's figures reach it within a minute.`);
        load();
      } else {
        setPhase('failed');
        setError(data.status === 'EXPIRED'
          ? 'The code expired before a phone scanned it.'
          : (data.reason || 'The phone could not be connected.'));
      }
    } catch {
      /* a missed poll is fine - the next one tries again */
    }
  }

  function backToList() {
    stopPolling();
    setPairing(null); setQrImg(''); setPhase('list'); setError(''); setMessage('');
  }

  async function removePhone(d) {
    setBusy(true); setError('');
    try {
      await api.delete(`/owner-app/devices/${d.device_id}`);
      setConfirmRemove(null);
      setMessage(`${d.name} was disconnected. It can no longer see this shop.`);
      load();
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not remove the phone.');
    } finally {
      setBusy(false);
    }
  }

  const devices = info?.devices || [];
  const full = info && devices.length >= info.max_phones;

  return createPortal(
    <div style={backdrop} onMouseDown={() => { stopPolling(); onClose(); }}>
      <div style={card} onMouseDown={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="owner-app-title">
        <h2 id="owner-app-title" style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>
          Owner app on phone
        </h2>
        <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          See today&apos;s sales, stock, expiry and patient credit on your phone.
          Only the phones listed here can read this shop&apos;s figures - not even
          ARZ Solutions can.
        </p>

        {!info ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{error || 'Loading…'}</p>
        ) : !info.cloud_enabled ? (
          <Note tone="warn">
            The owner app needs the Curavo cloud, which is not switched on for this PC yet.
            ARZ Solutions will switch it on during setup.
          </Note>
        ) : phase === 'showing' ? (
          <div style={{ textAlign: 'center' }}>
            <ol style={{ textAlign: 'left', fontSize: 13, color: 'var(--text)', lineHeight: 1.7, margin: '0 0 12px', paddingLeft: 20 }}>
              <li>Open the <b>Curavo Owner</b> app on your phone.</li>
              <li>Tap <b>Connect to my shop</b> and point the camera at this code.</li>
              <li>Keep this window open until it says connected.</li>
            </ol>
            {qrImg && (
              <img src={qrImg} alt="Code for the Curavo Owner app" width={260} height={260}
                style={{ background: '#fff', borderRadius: 12, padding: 8, maxWidth: '100%' }} />
            )}
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
              Waiting for your phone… code valid for {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 6 }}>
              Do not share a photo of this code - anyone who scans it in time could connect.
            </div>
            <button className="btn-secondary" style={{ marginTop: 14 }} onClick={backToList}>Cancel</button>
          </div>
        ) : (
          <>
            {message && <Note tone="ok">{message}</Note>}
            {error && <Note tone="danger">{error}</Note>}

            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
              color: 'var(--text-hint)', margin: '4px 0 8px' }}>
              Connected phones ({devices.length} of {info.max_phones})
            </div>
            {devices.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '10px 0 14px' }}>
                No phone connected yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                {devices.map((d) => (
                  <div key={d.device_id} style={{ display: 'flex', alignItems: 'center', gap: 10,
                    background: 'rgba(99,102,241,0.06)', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text)' }}>{d.name}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>Connected {fmtWhen(d.added_at)}</div>
                    </div>
                    {confirmRemove === d.device_id ? (
                      <>
                        <button className="btn-danger" disabled={busy} onClick={() => removePhone(d)}
                          style={{ padding: '6px 10px', fontSize: 12 }}>Remove</button>
                        <button className="btn-secondary" onClick={() => setConfirmRemove(null)}
                          style={{ padding: '6px 10px', fontSize: 12 }}>Keep</button>
                      </>
                    ) : (
                      <button className="btn-secondary" onClick={() => setConfirmRemove(d.device_id)}
                        style={{ padding: '6px 10px', fontSize: 12 }}>Remove…</button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {info.last_summary_at && devices.length > 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginBottom: 12 }}>
                Figures last sent to the phones {fmtWhen(info.last_summary_at)} (every 5 minutes while this PC is on).
              </div>
            )}

            {restricted ? (
              <Note tone="warn">
                The subscription has ended, so new phones cannot be connected and the app is paused.{' '}
                <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }}
                  onClick={() => { onClose(); openLicence(); }}>Renew</button>
              </Note>
            ) : full ? (
              <Note tone="info">At most {info.max_phones} phones can be connected. Remove one to add another.</Note>
            ) : (
              <>
                <Note tone="info">
                  <b>Easiest:</b> on the phone, open the Curavo Owner app and sign in with your Curavo account.
                  This PC then asks you to <b>Allow</b> it. Or connect with a code:
                </Note>
                <button className="btn-primary" disabled={busy} onClick={startPairing} style={{ width: '100%' }}>
                  {busy ? 'Making a code…' : (phase === 'failed' ? 'Try again' : 'Connect with a QR code')}
                </button>
              </>
            )}
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn-secondary" onClick={() => { stopPolling(); onClose(); }}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Note({ tone, children }) {
  const c = {
    ok: ['var(--ok-bg)', 'var(--ok)'], warn: ['var(--warn-bg)', 'var(--warn)'],
    danger: ['var(--danger-bg)', 'var(--danger)'], info: ['var(--info-bg)', 'var(--info)'],
  }[tone];
  return (
    <div style={{ background: c[0], color: c[1], borderRadius: 10, padding: '10px 12px',
      fontSize: 12.5, lineHeight: 1.5, marginBottom: 12 }}>{children}</div>
  );
}

const backdrop = {
  position: 'fixed', inset: 0, background: 'rgba(30,27,75,0.35)',
  backdropFilter: 'blur(4px)', display: 'flex',
  alignItems: 'center', justifyContent: 'center', zIndex: 1500, padding: 16,
};
const card = {
  width: '100%', maxWidth: 440, maxHeight: '90vh', overflowY: 'auto',
  background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(24px)',
  border: '1px solid rgba(255,255,255,0.75)', borderRadius: 18,
  boxShadow: '0 20px 60px rgba(0,0,0,0.2)', padding: 24, boxSizing: 'border-box',
};


/**
 * A phone that signed in with this shop's Curavo account asks to connect.
 * Mounted once in Layout for the Owner/Administrator: asks the backend every
 * 30 seconds and, when a phone is waiting, shows Allow / Refuse with the
 * 6-digit check code - the same digits the phone shows.  If they differ,
 * something swapped the phone's key on the way: refuse.
 */
const WATCH_MS = 30000;

export function PhoneRequestWatcher() {
  const [reqs, setReqs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [later, setLater] = useState(() => new Set());   // "Not now" - asked again after it times out

  const load = useCallback(() => (
    api.get('/owner-app/phone-requests').then(({ data }) => setReqs(data.requests || [])).catch(() => {})
  ), []);

  useEffect(() => {
    load();
    const t = setInterval(load, WATCH_MS);
    return () => clearInterval(t);
  }, [load]);

  const r = reqs.find((x) => !later.has(x.request_id));
  if (done) {
    return createPortal(
      <div style={backdrop}><div style={card} role="dialog" aria-modal="true" aria-label="Phone connected">
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>Phone connected</div>
        <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginBottom: 16 }}>{done}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn-primary" onClick={() => setDone('')}>OK</button>
        </div>
      </div></div>, document.body);
  }
  if (!r) return null;

  async function answer(allow) {
    setBusy(true); setError('');
    try {
      await api.post(`/owner-app/phone-requests/${r.request_id}`, { allow });
      setReqs((list) => list.filter((x) => x.request_id !== r.request_id));
      if (allow) setDone(`"${r.name}" can now see the shop's figures. The first ones arrive within a minute.`);
    } catch (e) {
      setError(e?.response?.data?.detail || 'Could not reach the Curavo cloud. Try again.');
    } finally { setBusy(false); }
  }

  return createPortal(
    <div style={backdrop}>
      <div style={card} role="dialog" aria-modal="true" aria-labelledby="phone-req-title">
        <div id="phone-req-title" style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
          A phone wants to connect
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          <b style={{ color: 'var(--text)' }}>{r.name}</b> signed in to the Curavo Owner app
          {r.account_email ? <> as <b style={{ color: 'var(--text)' }}>{r.account_email}</b></> : ''}.
          If you allow it, it can see this shop&apos;s sales, stock and patient credit.
        </div>
        <div style={{ background: 'rgba(99,102,241,0.08)', borderRadius: 12, padding: '14px 16px', textAlign: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-hint)' }}>
            Check code
          </div>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--accent-dark)', fontVariantNumeric: 'tabular-nums' }}>
            {r.check_code}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>The phone must show exactly the same number.</div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 14 }}>
          Not your phone, or a different number? Press <b>Refuse</b>.
        </div>
        {error && <Note tone="danger">{error}</Note>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button className="btn-secondary" disabled={busy} onClick={() => setLater((s0) => new Set([...s0, r.request_id]))}>Not now</button>
          <button className="btn-danger" disabled={busy} onClick={() => answer(false)}>Refuse</button>
          <button className="btn-primary" disabled={busy} onClick={() => answer(true)}>{busy ? 'Connecting…' : 'Allow'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
