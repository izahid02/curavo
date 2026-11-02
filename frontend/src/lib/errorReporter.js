/**
 * Screen crashes -> the ARZ control panel.
 *
 * Any JavaScript error the page does not catch (a bug in a screen, a promise
 * nobody handled) is sent to POST /api/diagnostics/client-error.  The shop's
 * own backend queues it and the cloud helper passes it on to ARZ
 * (backend/app/services/error_reports.py) - so a broken screen is seen at ARZ
 * even if nobody phones.
 *
 * Safe by design: reporting can never throw, never shows anything, and stops
 * after 20 reports per page load (a crash inside a loop must not flood).
 * Goes through lib/api.js like every other call (so it reaches the backend
 * in the desktop build too); the endpoint needs no login and never answers
 * 401, so the sign-out logic there is never triggered.
 */
import { api } from './api';

const MAX_PER_LOAD = 20;
let sent = 0;
const seen = new Set();

function report(kind, message, stack) {
  try {
    if (sent >= MAX_PER_LOAD) return;
    const key = `${kind}|${message}`;
    if (seen.has(key)) return;           // same error again on this page load
    seen.add(key);
    sent += 1;
    api.post('/diagnostics/client-error', {
      kind: String(kind || 'Error').slice(0, 120),
      message: String(message || '').slice(0, 2000),
      stack: String(stack || '').slice(0, 20000),
      route: window.location.pathname.slice(0, 200),
    }).catch(() => {});
  } catch {
    /* never let error reporting cause an error */
  }
}

export function installErrorReporter() {
  window.addEventListener('error', (e) => {
    // Resource load failures (an <img> 404) have no .error - not a crash.
    if (!e.error) return;
    report(e.error.name, e.error.message || e.message, e.error.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    // A failed API call that a screen forgot to catch is noise here: the
    // server side already records real server crashes.
    if (r && r.isAxiosError) return;
    report(r?.name || 'UnhandledRejection', r?.message || String(r), r?.stack);
  });
}
