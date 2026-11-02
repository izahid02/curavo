/**
 * App updates, as the counter sees them.
 *
 *   <UpdateBanner role=... />   mounted in Layout.  Invisible until a new
 *                               version has been DOWNLOADED and VERIFIED.
 *
 * What happens (desktop app only - in a browser this does nothing):
 *   1. Two minutes after start-up, then every 6 hours, ask our own backend
 *      where the Curavo cloud is (GET /api/cloud/update-info).  Cloud switched
 *      off = stop here.
 *   2. Ask the desktop shell (Rust, src-tauri/src/main.rs) to check that
 *      address.  The cloud decides what this shop may have (pilot shops first).
 *   3. If there is a newer version, download it quietly.  The shell refuses it
 *      unless ARZ's update signature matches.
 *   4. Show: "Curavo 0.3.0 is ready - it installs when you close Curavo."
 *      Owner/Administrator also get "Install now" (Curavo closes for about a
 *      minute and reopens).  NOTHING ever installs in the middle of a bill.
 *
 * Every failure is silent here - an update that cannot be fetched today is
 * simply tried again in 6 hours.  The cloud sees which version each shop runs.
 */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';

const FIRST_CHECK_MS = 2 * 60 * 1000;
const EVERY_MS = 6 * 60 * 60 * 1000;
const INSTALL_ROLES = ['Owner', 'Administrator'];

const isTauri = () =>
  typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

async function invoke(cmd, args) {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke(cmd, args);
}

export function UpdateBanner({ role }) {
  const [ready, setReady] = useState(null);      // {version, notes, critical}
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isTauri()) return undefined;
    let busy = false;
    async function look() {
      if (busy || ready) return;
      busy = true;
      try {
        const { data } = await api.get('/cloud/update-info');
        if (!data.enabled) return;
        const info = await invoke('update_check', { endpoint: data.endpoint, shopCode: data.shop_code });
        if (!info) return;
        await invoke('update_download');
        setReady(info);
      } catch {
        /* offline, cloud down, bad signature: try again later */
      } finally {
        busy = false;
      }
    }
    const first = setTimeout(look, FIRST_CHECK_MS);
    const every = setInterval(look, EVERY_MS);
    return () => { clearTimeout(first); clearInterval(every); };
  }, [ready]);

  if (!ready) return null;
  const canInstall = INSTALL_ROLES.includes(role);

  async function installNow() {
    setError('');
    try {
      await invoke('update_install_now');   // Curavo closes; the installer takes over
    } catch (e) {
      setError(String(e || 'Could not start the update.'));
    }
  }

  return (
    <>
      <div role="status" style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        margin: '0 4px 14px', padding: '10px 14px', borderRadius: 12, fontSize: 13,
        background: ready.critical ? 'var(--warn-bg)' : 'var(--accent-light)',
        border: `1px solid ${ready.critical ? 'rgba(217,119,6,0.25)' : 'var(--accent-border)'}`,
        color: 'var(--text)', flexShrink: 0,
      }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: ready.critical ? 'var(--warn)' : 'var(--accent)' }} />
        <span style={{ flex: 1, minWidth: 220 }}>
          <b style={{ fontWeight: 600 }}>
            {ready.critical ? `Important update: Curavo ${ready.version}.` : `Curavo ${ready.version} is ready.`}
          </b>{' '}
          It installs when you close Curavo{ready.critical ? ' - please close it today, after billing.' : '.'}
          {error && <span style={{ color: 'var(--danger)', marginLeft: 6 }}>{error}</span>}
        </span>
        {canInstall && (
          <button className="btn-secondary" onClick={() => setConfirm(true)}
            style={{ padding: '6px 14px', fontSize: 13, whiteSpace: 'nowrap' }}>
            Install now
          </button>
        )}
      </div>

      {confirm && createPortal(
        <div onMouseDown={() => setConfirm(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(30,27,75,0.35)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1500, padding: 16,
        }}>
          <div role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()} style={{
            width: '100%', maxWidth: 420, background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(24px)',
            border: '1px solid var(--glass-border)', borderRadius: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.2)', padding: 24,
          }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 10 }}>Install Curavo {ready.version} now?</h2>
            <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 8 }}>
              Curavo will close for about a minute and open again on the new version.
              <b> Finish the bill you are working on first</b> - anything not yet saved is lost.
            </p>
            {ready.notes && (
              <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                background: 'rgba(255,255,255,0.6)', borderRadius: 10, padding: '8px 12px', marginBottom: 8 }}>
                {ready.notes}
              </p>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn-secondary" onClick={() => setConfirm(false)}>Later</button>
              <button className="btn-primary" onClick={installNow}>Install and restart</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
