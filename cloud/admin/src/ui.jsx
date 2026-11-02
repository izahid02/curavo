/** Small shared pieces of the control panel. */
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

export function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function when(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function day(isoDate) {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function bytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const code = (c) => (c && c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c || '');

const BACKUP = { OK: ['ok', 'Backed up'], LATE: ['warn', 'Late'], MISSING: ['danger', 'Missing'], NONE: ['danger', 'None yet'] };
const LICENCE = { TRIAL: 'info', ACTIVE: 'ok', GRACE: 'warn', EXPIRED: 'danger' };

export function BackupPill({ status }) {
  const [tone, label] = BACKUP[status] || ['neutral', status || '—'];
  return <span className={`badge badge-${tone}`}>{label}</span>;
}

export function LicencePill({ state, daysLeft }) {
  if (!state) return <span className="badge badge-neutral">—</span>;
  const label = { TRIAL: 'Trial', ACTIVE: 'Paid', GRACE: 'Grace', EXPIRED: 'Expired' }[state] || state;
  const extra = state !== 'EXPIRED' && daysLeft != null ? ` · ${daysLeft}d` : '';
  return <span className={`badge badge-${LICENCE[state] || 'neutral'}`}>{label}{extra}</span>;
}

export function OnlineDot({ online }) {
  return (
    <span title={online ? 'Online' : 'Offline'} style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
      background: online ? 'var(--ok)' : 'rgba(0,0,0,0.2)',
      boxShadow: online ? '0 0 0 3px rgba(5,150,105,0.15)' : 'none',
    }} />
  );
}

export function SectionTitle({ children, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 12 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>{children}</h2>
      {right}
    </div>
  );
}

export function Empty({ children }) {
  return <p style={{ color: 'var(--text-hint)', fontSize: 13, padding: '8px 2px' }}>{children}</p>;
}

export function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <div style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 10, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
      {children}
    </div>
  );
}

export function Modal({ title, onClose, children, width = 480 }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div onMouseDown={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(30,27,75,0.35)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
    }}>
      <div role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()} style={{
        width: '100%', maxWidth: width, maxHeight: '88vh', overflowY: 'auto',
        background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(24px)',
        border: '1px solid var(--glass-border)', borderRadius: 18,
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)', padding: 24,
      }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 14 }}>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function StackBlock({ text }) {
  return (
    <pre style={{
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11.5, lineHeight: 1.5,
      background: 'rgba(30,27,75,0.04)', border: '1px solid rgba(0,0,0,0.06)', borderRadius: 10,
      padding: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto',
      color: 'var(--text)', marginTop: 8,
    }}>{text || 'No stack trace.'}</pre>
  );
}
