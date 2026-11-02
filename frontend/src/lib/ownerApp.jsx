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
              <button className="btn-primary" disabled={busy} onClick={startPairing} style={{ width: '100%' }}>
                {busy ? 'Making a code…' : (phase === 'failed' ? 'Try again' : 'Connect a phone')}
              </button>
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
