import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { clearAuth, getUser } from '../lib/auth';
import { api, setAuthToken } from '../lib/api';
const PAGE_TITLES = {
  '/':              'Dashboard',
  '/billing':       'Billing & POS',
  '/invoices':      'Invoice History',
  '/inventory':     'Medicines',
  '/expiry-alerts': 'Expiry Alerts',
  '/purchasing':    'Purchasing',
  '/patients':      'Patients',
  '/suppliers':     'Suppliers',
  '/expenditure':   'Expenditure & Payroll',
  '/reports':       'Reports',
  '/follow-ups':    'Follow-Ups',
  '/marketing':     'Marketing',
  '/credit':        'Credit Management',
};

/**
 * A short one-line description shown under each page title in the header.
 * Dashboard is special-cased below so it can greet the user by name.
 */
const PAGE_SUBTITLES = {
  '/billing':       'Create and manage patient invoices',
  '/invoices':      'View and search past invoices',
  '/inventory':     'Manage your medicine inventory',
  '/purchasing':    'Purchase orders and stock receiving',
  '/expiry-alerts': 'Medicines expiring soon',
  '/patients':      'Patient records and history',
  '/follow-ups':    'Patient follow-up management',
  '/credit':        'Credit accounts and payments',
  '/marketing':     'Campaigns and messaging',
  '/suppliers':     'Supplier management',
  '/expenditure':   'Expenses, salaries and daily cash register',
  '/reports':       'Sales, inventory and profit reports',
};

/** Section label inside the sidebar nav. */
function NavSection({ label }) {
  return (
    <div style={{
      fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
      letterSpacing: '0.08em', color: '#94a3b8', padding: '16px 12px 4px',
      margin: 0,
    }}>
      {label}
    </div>
  );
}

/**
 * Error boundary around the account menu.  React error boundaries catch any
 * exception thrown while rendering their children and show a fallback UI
 * INSTEAD of letting the error bubble up and unmount the entire app (which is
 * what turns the whole screen blank).  So if anything in the avatar / account
 * area ever throws, the rest of the ERP keeps working and the user still has a
 * way to sign out.
 */
class AccountMenuBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <button
          className="btn-secondary"
          onClick={() => { window.location.href = '/login'; }}
        >
          Sign Out
        </button>
      );
    }
    return this.props.children;
  }
}

export default function Layout() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const user      = getUser();
  const [alertCount, setAlertCount]               = useState(0);
  const [followUpDueCount, setFollowUpDueCount]   = useState(0);
  const [followUpPendingAction, setFollowUpPendingAction] = useState(0);
  const [creditOverdueCount, setCreditOverdueCount] = useState(0);

  /* Account menu / profile state */
  const [accountMenuOpen, setAccountMenuOpen]     = useState(false);
  const [showEditProfile, setShowEditProfile]     = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [profile, setProfile]                     = useState(null);
  const [avatarUrl, setAvatarUrl]                 = useState(null);
  const [avatarError, setAvatarError]             = useState(null);
  const [toast, setToast]                         = useState(null);

  /*
   * A blob: object URL holds a reference to an in-memory copy of the image.
   * If we replace it (or unmount) without calling URL.revokeObjectURL, that
   * memory is never freed — a leak that grows every time the photo changes.
   * We remember the current URL in a ref so we can revoke the *previous* one
   * before storing a new one, without doing side effects inside a React state
   * updater (an impure updater misbehaves under React 18 StrictMode).
   */
  const prevAvatarUrl = useRef(null);

  function setAvatarUrlSafe(newUrl) {
    if (prevAvatarUrl.current &&
        prevAvatarUrl.current.startsWith('blob:')) {
      URL.revokeObjectURL(prevAvatarUrl.current);
    }
    prevAvatarUrl.current = newUrl;
    setAvatarUrl(newUrl);
  }

  /* Revoke the last object URL when the whole layout unmounts. */
  useEffect(() => {
    return () => {
      if (prevAvatarUrl.current &&
          prevAvatarUrl.current.startsWith('blob:')) {
        URL.revokeObjectURL(prevAvatarUrl.current);
      }
    };
  }, []);

  /* Show a brief success message at the top of the screen, then auto-hide. */
  function showToast(message) {
    setToast(message);
    setTimeout(() => setToast(null), 2600);
  }

  const today     = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const pageTitle = PAGE_TITLES[location.pathname] ?? 'Health Care Centre';

  /* Name to greet with — prefer the fetched profile, fall back to the token user. */
  const displayName = profile?.full_name || profile?.username
    || user?.full_name || 'User';
  const firstName   = displayName.split(' ')[0];

  /* Dashboard greets the user; every other page has a fixed subtitle. */
  const pageSubtitle = location.pathname === '/'
    ? `Welcome back, ${firstName}`
    : (PAGE_SUBTITLES[location.pathname] ?? '');

  /*
   * Load the current user's avatar as a blob and turn it into an object URL.
   * We fetch through the api instance (so the JWT auth header is attached) —
   * a plain <img src="/api/auth/me/avatar"> would NOT send that header and
   * would fail. We revoke the previous object URL to avoid memory leaks.
   */
  async function loadAvatar() {
    try {
      const res = await api.get('/auth/me/avatar', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      setAvatarUrlSafe(url);
    } catch {
      // 404 = no avatar on file, which is a normal state — just show none.
      setAvatarUrlSafe(null);
    }
  }

  /* Fetch the full profile once on mount, then load the avatar if one exists. */
  useEffect(() => {
    api.get('/auth/me/profile')
      .then((res) => {
        setProfile(res.data);
        if (res.data.avatar_url) loadAvatar();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Upload a new profile photo, then refresh the avatar image immediately. */
  async function handleAvatarUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Reset the input right away so the SAME file can be re-selected later,
    // and so we never touch e.target after an await (the event may be reused).
    e.target.value = '';

    // ---- Client-side validation (fast feedback before the network round-trip) ----
    // Some systems report JPGs as 'image/jpg' instead of the standard
    // 'image/jpeg' — so we accept both spellings AND fall back to the file
    // extension when the browser reports an empty/unknown type.  We only allow
    // JPG/PNG/WebP, matching what the backend can store (no HEIC/HEIF).
    if (file.size > 5 * 1024 * 1024) {
      setAvatarError('Image too large. Maximum size is 5MB.');
      return;
    }

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    const allowedExts  = ['jpg', 'jpeg', 'png', 'webp'];
    const ext = file.name.split('.').pop().toLowerCase();

    if (file.type && !allowedTypes.includes(file.type) &&
        !allowedExts.includes(ext)) {
      setAvatarError('Please use a JPG, PNG, or WebP image.');
      return;
    }

    // ---- Passed validation — send to the backend ----
    setAvatarError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.post('/auth/me/avatar', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      // Re-fetch the avatar as a blob, exactly the way it loads on mount, so the
      // JWT auth header is attached and the <img> shows the new photo.
      await loadAvatar();
      setProfile((p) => (p ? { ...p, avatar_url: '/api/auth/me/avatar' } : p));
      showToast('Profile photo updated');
    } catch (err) {
      // Show the actual rejection reason from the backend (e.g. the exact MIME
      // type it received) instead of a generic message.
      const msg = err.response?.data?.detail ||
                  'Upload failed. Please try again.';
      setAvatarError(msg);
    }
  }

  /* Close the account dropdown when clicking anywhere outside it. */
  useEffect(() => {
    if (!accountMenuOpen) return;
    const handler = (e) => {
      if (!e.target.closest('[data-account-menu]')) {
        setAccountMenuOpen(false);
        setAvatarError(null);   // clear any stale upload error on close
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [accountMenuOpen]);

  /* Fetch expiry alert count once on mount for the sidebar badge. */
  useEffect(() => {
    api.get('/inventory/alerts/expiry')
      .then(({ data }) => {
        // Use the ONE canonical count (distinct products expired/expiring within
        // 90 days) so the sidebar badge matches the Dashboard card and the
        // Expiry Alerts page exactly. Previously this summed only the expired +
        // 7-day BATCH lists, which disagreed with both other places.
        setAlertCount(data.alert_product_count ?? 0);
      })
      .catch(() => {});
  }, []);

  /* Fetch follow-up counts for the sidebar badge — refreshes every 60 seconds. */
  useEffect(() => {
    function fetchFollowUpCounts() {
      api.get('/followup/stats')
        .then(({ data }) => setFollowUpDueCount(data.due_today ?? 0))
        .catch(() => {});
      api.get('/followup/responses/summary')
        .then(({ data }) => setFollowUpPendingAction(data.pending_action ?? 0))
        .catch(() => {});
    }
    fetchFollowUpCounts();
    const timer = setInterval(fetchFollowUpCounts, 60_000);
    return () => clearInterval(timer);
  }, []);

  /* Fetch credit overdue count for the sidebar badge — refreshes every 2 minutes. */
  useEffect(() => {
    function fetchCreditOverdue() {
      api.get('/credit/summary')
        .then(({ data }) => setCreditOverdueCount(data.overdue_count ?? 0))
        .catch(() => {});
    }
    fetchCreditOverdue();
    const timer = setInterval(fetchCreditOverdue, 120_000);
    return () => clearInterval(timer);
  }, []);

  function handleSignOut() {
    clearAuth();
    setAuthToken(null);
    navigate('/login');
  }

  /* className helper for NavLink — drives .nav-item / .nav-item-active CSS. */
  const navClass = ({ isActive }) => `nav-item${isActive ? ' nav-item-active' : ''}`;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', position: 'relative', zIndex: 1 }}>

      {/* ══ SIDEBAR ══════════════════════════════════════════════════ */}
      <aside style={{
        width: 220,
        position: 'relative', zIndex: 10,
        background: 'rgba(255,255,255,0.52)',
        backdropFilter: 'blur(28px)',
        WebkitBackdropFilter: 'blur(28px)',
        borderRight: '1px solid rgba(255,255,255,0.75)',
        height: '100vh',
        display: 'flex', flexDirection: 'column',
        flexShrink: 0,
      }}>

        {/* Brand block */}
        <div style={{
          padding: '20px 16px 16px',
          borderBottom: '1px solid rgba(99, 102, 241, 0.1)',
          marginBottom: '8px',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '4px 0',
          }}>
            <img
              src="/HCC_LOGO.png"
              alt="HCC Logo"
              style={{
                width: '40px',
                height: '40px',
                objectFit: 'contain',
                borderRadius: '8px',
                flexShrink: 0,
              }}
            />
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '3px',
              minWidth: 0,
            }}>
              <div style={{
                fontWeight: 700,
                fontSize: '14px',
                color: 'var(--text)',
                lineHeight: 1.2,
                whiteSpace: 'nowrap',
              }}>
                Health Care Centre
              </div>
              <div style={{
                fontSize: '9px',
                color: '#0d9488',
                fontWeight: 600,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
              }}>
                Powered by ARZ Technologies
              </div>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav style={{ padding: '12px 10px', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>

          <NavSection label="Main" />

          <NavLink to="/" end className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <rect x="3" y="3" width="7" height="7" rx="1.5"/>
              <rect x="14" y="3" width="7" height="7" rx="1.5"/>
              <rect x="3" y="14" width="7" height="7" rx="1.5"/>
              <rect x="14" y="14" width="7" height="7" rx="1.5"/>
            </svg>
            Dashboard
          </NavLink>

          <NavLink to="/billing" className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M9 7H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1-4H9m0 0a1 1 0 000 2h6a1 1 0 000-2"/>
            </svg>
            Billing &amp; POS
          </NavLink>

          <NavLink to="/invoices" className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
            </svg>
            Invoice History
          </NavLink>

          <NavSection label="Inventory" />

          <NavLink to="/inventory" className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
            </svg>
            Medicines
          </NavLink>

          {/* "Purchasing" nav removed — stock-in now lives inside the unified
              Medicines page (Add Stock tab).  The old /purchasing route still
              redirects to /inventory for any saved bookmarks. */}

          <NavLink to="/expiry-alerts" className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            Expiry Alerts
            {alertCount > 0 && (
              <span style={{
                background: '#ef4444', color: '#fff',
                fontSize: 9, fontWeight: 700,
                borderRadius: 20, padding: '1px 7px',
                marginLeft: 'auto',
              }}>
                {alertCount}
              </span>
            )}
          </NavLink>

          <NavSection label="Patients" />

          <NavLink to="/patients" className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
            </svg>
            Patients
          </NavLink>

          <NavSection label="Communication" />

          <NavLink to="/follow-ups" className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0114 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
            </svg>
            Follow-Ups
            {(followUpDueCount + followUpPendingAction) > 0 && (
              <span style={{
                background: '#ef4444', color: '#fff',
                fontSize: 9, fontWeight: 700,
                borderRadius: 20, padding: '1px 7px',
                marginLeft: 'auto',
              }}>
                {followUpDueCount + followUpPendingAction}
              </span>
            )}
          </NavLink>

          <NavLink to="/credit" className={navClass}>
            {/* Credit / wallet icon */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
              <line x1="1" y1="10" x2="23" y2="10"/>
            </svg>
            Credit
            {creditOverdueCount > 0 && (
              <span style={{
                background: '#ef4444', color: '#fff',
                fontSize: 9, fontWeight: 700,
                borderRadius: 20, padding: '1px 7px',
                marginLeft: 'auto',
              }}>
                {creditOverdueCount}
              </span>
            )}
          </NavLink>

          <NavLink to="/marketing" className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"/>
            </svg>
            Marketing
          </NavLink>

          <NavSection label="Management" />

          <NavLink to="/suppliers" className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0H5m14 0h2M5 21H3M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/>
            </svg>
            Suppliers
          </NavLink>

          <NavLink to="/expenditure" className={navClass}>
            {/* Wallet / money icon */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/>
              <path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/>
              <path d="M18 12a2 2 0 0 0 0 4h4v-4h-4z"/>
            </svg>
            Expenditure
          </NavLink>

          <NavLink to="/reports" className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="18" y1="20" x2="18" y2="10"/>
              <line x1="12" y1="20" x2="12" y2="4"/>
              <line x1="6" y1="20" x2="6" y2="14"/>
            </svg>
            Reports
          </NavLink>
        </nav>
      </aside>

      {/* ══ MAIN AREA ════════════════════════════════════════════════ */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: '100vh', minWidth: 0 }}>

        {/* Topbar */}
        <header style={{
          height: 68,
          background: 'rgba(255,255,255,0.50)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          borderBottom: '1px solid rgba(255,255,255,0.75)',
          display: 'flex', alignItems: 'center',
          padding: '0 22px', gap: 14,
          flexShrink: 0,
        }}>
          {/* Page title + subtitle with an indigo accent bar on the left */}
          <div style={{
            flex: 1,
            borderLeft: '3px solid #6366f1',
            paddingLeft: '12px',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <h1 style={{
                fontSize: '22px',
                fontWeight: 700,
                color: '#1e1b4b',
                margin: 0,
                lineHeight: 1.2,
                letterSpacing: '-0.02em',
              }}>
                {pageTitle}
              </h1>
              <p style={{
                fontSize: '12px',
                color: '#94a3b8',
                margin: 0,
                fontWeight: 400,
              }}>
                {pageSubtitle}
              </p>
            </div>
          </div>

          <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>
            {today}
          </span>

          {/* Account button — opens the dropdown menu.  Wrapped in an error
              boundary so a render fault here can never blank the whole app. */}
          <AccountMenuBoundary>
          <button
            data-account-menu
            onClick={() => { setAccountMenuOpen((o) => !o); setAvatarError(null); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              background: 'rgba(255,255,255,0.6)',
              border: '1px solid rgba(255,255,255,0.8)',
              borderRadius: '50px',
              padding: '6px 14px 6px 6px',
              cursor: 'pointer',
              backdropFilter: 'blur(8px)',
              transition: 'all 0.2s',
            }}
          >
            {/* Avatar */}
            <div style={{
              width: '32px', height: '32px', borderRadius: '50%',
              overflow: 'hidden', background: 'rgba(99,102,241,0.1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              {avatarUrl ? (
                <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.8">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
                </svg>
              )}
            </div>

            {/* Name + Role */}
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#1e1b4b', lineHeight: 1.2 }}>
                {profile?.full_name || profile?.username || 'User'}
              </div>
              <div style={{ fontSize: '10px', color: '#6366f1', fontWeight: 500 }}>
                {profile?.role || user?.role_name || 'Staff'}
              </div>
            </div>

            {/* Chevron */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          </AccountMenuBoundary>
        </header>

        {/* Page content */}
        <main style={{
          flex: 1, overflowY: 'auto',
          position: 'relative', zIndex: 1,
          padding: 24,
          background: 'transparent',
        }}>
          <Outlet />
        </main>
      </div>

      {/* ══ ACCOUNT DROPDOWN MENU (portal) ═══════════════════════════ */}
      {accountMenuOpen && createPortal(
        <AccountMenuBoundary>
        <div
          data-account-menu
          style={{
            position: 'fixed',
            top: '72px',
            right: '16px',
            width: '280px',
            background: 'rgba(255,255,255,0.95)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.8)',
            borderRadius: '16px',
            boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
            zIndex: 1000,
            overflow: 'hidden',
          }}
        >
          {/* Profile header section */}
          <div style={{
            padding: '20px',
            background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(139,92,246,0.05))',
            borderBottom: '1px solid rgba(99,102,241,0.1)',
            textAlign: 'center',
          }}>
            {/* Large avatar + camera upload button */}
            <div style={{ position: 'relative', display: 'inline-block', marginBottom: '12px' }}>
              <div style={{
                width: '72px', height: '72px', borderRadius: '50%',
                overflow: 'hidden', background: 'rgba(99,102,241,0.1)',
                border: '3px solid rgba(99,102,241,0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto',
              }}>
                {avatarUrl ? (
                  <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5">
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
                  </svg>
                )}
              </div>

              <label style={{
                position: 'absolute', bottom: 0, right: 0,
                width: '24px', height: '24px', borderRadius: '50%',
                background: '#6366f1', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', border: '2px solid white',
              }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                <input
                  type="file"
                  accept="image/jpeg,image/jpg,image/png,image/webp"
                  style={{ display: 'none' }}
                  onChange={handleAvatarUpload}
                />
              </label>
            </div>

            {avatarError && (
              <div style={{ fontSize: '11px', color: '#e11d48', marginTop: '4px' }}>
                {avatarError}
              </div>
            )}

            <div style={{ fontSize: '16px', fontWeight: 700, color: '#1e1b4b' }}>
              {profile?.full_name || profile?.username}
            </div>

            <div style={{
              display: 'inline-block', marginTop: '4px', padding: '2px 10px',
              background: 'rgba(99,102,241,0.1)', color: '#6366f1',
              borderRadius: '20px', fontSize: '11px', fontWeight: 600,
            }}>
              {profile?.role || user?.role_name || 'Staff'}
            </div>

            {profile?.email && (
              <div style={{ fontSize: '12px', color: '#64748b', marginTop: '6px' }}>
                {profile.email}
              </div>
            )}
          </div>

          {/* Menu items */}
          <div style={{ padding: '8px' }}>
            <MenuItem
              color="#1e1b4b"
              hover="rgba(99,102,241,0.06)"
              onClick={() => { setAccountMenuOpen(false); setShowEditProfile(true); }}
              icon={(
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.8">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              )}
              label="Edit Profile"
            />
            <MenuItem
              color="#1e1b4b"
              hover="rgba(99,102,241,0.06)"
              onClick={() => { setAccountMenuOpen(false); setShowChangePassword(true); }}
              icon={(
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.8">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              )}
              label="Change Password"
            />

            <div style={{ height: '1px', background: 'rgba(99,102,241,0.1)', margin: '6px 0' }} />

            <MenuItem
              color="#e11d48"
              hover="rgba(225,29,72,0.06)"
              onClick={handleSignOut}
              icon={(
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e11d48" strokeWidth="1.8">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              )}
              label="Sign Out"
            />
          </div>
        </div>
        </AccountMenuBoundary>,
        document.body,
      )}

      {/* ══ EDIT PROFILE MODAL ═══════════════════════════════════════ */}
      {showEditProfile && (
        <EditProfileModal
          profile={profile}
          onClose={() => setShowEditProfile(false)}
          onSaved={(updated) => { setProfile(updated); showToast('Profile updated'); }}
        />
      )}

      {/* ══ CHANGE PASSWORD MODAL ════════════════════════════════════ */}
      {showChangePassword && (
        <ChangePasswordModal
          onClose={() => setShowChangePassword(false)}
          onSaved={() => showToast('Password changed successfully')}
        />
      )}

      {/* ══ TOAST ════════════════════════════════════════════════════ */}
      {toast && createPortal(
        <div style={{
          position: 'fixed', top: '80px', left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(16,185,129,0.95)', color: '#fff',
          padding: '10px 20px', borderRadius: '10px', fontSize: '13px', fontWeight: 600,
          boxShadow: '0 10px 30px rgba(0,0,0,0.2)', zIndex: 2000,
        }}>
          {toast}
        </div>,
        document.body,
      )}

      {/* Preload signature so jsPDF can grab it from the DOM via canvas drawImage */}
      <img
        src="/HCC_SIGNATURE.png"
        alt="HCC Signature"
        style={{ display: 'none' }}
        onError={e => { e.target.style.display = 'none'; }}
      />
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════════
 * Small helper components used by the account menu / modals.
 * Kept in this file because they are only used here.
 * ═══════════════════════════════════════════════════════════════════════ */

/** A single hoverable row in the account dropdown menu. */
function MenuItem({ icon, label, onClick, color, hover }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: '10px',
        padding: '10px 12px', borderRadius: '8px', border: 'none',
        background: 'transparent', cursor: 'pointer',
        fontSize: '13px', color, transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = hover; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon}
      {label}
    </button>
  );
}

/* Shared modal styles (glassmorphism) — rendered via a portal so the fixed
 * backdrop is never clipped by a scrolling/overflow parent (Phase 1 lesson). */
const modalBackdrop = {
  position: 'fixed', inset: 0, background: 'rgba(30,27,75,0.35)',
  backdropFilter: 'blur(4px)', display: 'flex',
  alignItems: 'center', justifyContent: 'center', zIndex: 1500, padding: 16,
};
const modalCard = {
  width: '100%', maxWidth: 400,
  background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(24px)',
  border: '1px solid rgba(255,255,255,0.75)', borderRadius: 18,
  boxShadow: '0 20px 60px rgba(0,0,0,0.2)', padding: 24,
};
const modalLabel = {
  display: 'block', fontSize: 12, fontWeight: 600,
  color: '#6b7280', marginBottom: 6,
};
const modalInput = {
  width: '100%', padding: '10px 12px', fontSize: 14,
  border: '1px solid rgba(0,0,0,0.1)', borderRadius: 10,
  background: 'rgba(255,255,255,0.7)', color: '#1e1b4b',
  boxSizing: 'border-box', marginBottom: 14,
};

/** Modal for editing the current user's name / email / phone. */
function EditProfileModal({ profile, onClose, onSaved }) {
  const [fullName, setFullName] = useState(profile?.full_name || '');
  const [email, setEmail]       = useState(profile?.email || '');
  const [phone, setPhone]       = useState(profile?.phone || '');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const res = await api.put('/auth/me/profile', {
        full_name: fullName,
        email,
        phone,
      });
      onSaved(res.data);
      onClose();
    } catch {
      setError('Could not save changes. Please try again.');
      setSaving(false);
    }
  }

  return createPortal(
    <div style={modalBackdrop} onMouseDown={onClose}>
      <div style={modalCard} onMouseDown={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 18px', fontSize: 18, fontWeight: 700, color: '#1e1b4b' }}>
          Edit Profile
        </h2>

        <label style={modalLabel}>Full Name</label>
        <input style={modalInput} value={fullName}
          onChange={(e) => setFullName(e.target.value)} placeholder="Your name" />

        <label style={modalLabel}>Email</label>
        <input style={modalInput} type="email" value={email}
          onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />

        <label style={modalLabel}>Phone</label>
        <input style={modalInput} value={phone}
          onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" />

        {error && (
          <div style={{ color: '#e11d48', fontSize: 12, marginBottom: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Modal for changing the current user's password. */
function ChangePasswordModal({ onClose, onSaved }) {
  const [current, setCurrent]   = useState('');
  const [next, setNext]         = useState('');
  const [confirm, setConfirm]   = useState('');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  async function handleSave() {
    // Client-side validation first — fast feedback, matches backend rules.
    if (next.length < 6) {
      setError('New password must be at least 6 characters.');
      return;
    }
    if (next !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.put('/auth/me/password', {
        current_password: current,
        new_password: next,
      });
      onSaved();
      onClose();
    } catch (err) {
      // Surface the backend message (e.g. "Current password is incorrect").
      setError(err.response?.data?.detail || 'Could not change password.');
      setSaving(false);
    }
  }

  return createPortal(
    <div style={modalBackdrop} onMouseDown={onClose}>
      <div style={modalCard} onMouseDown={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 18px', fontSize: 18, fontWeight: 700, color: '#1e1b4b' }}>
          Change Password
        </h2>

        <label style={modalLabel}>Current Password</label>
        <input style={modalInput} type="password" value={current}
          onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" />

        <label style={modalLabel}>New Password</label>
        <input style={modalInput} type="password" value={next}
          onChange={(e) => setNext(e.target.value)} placeholder="At least 6 characters" />

        <label style={modalLabel}>Confirm New Password</label>
        <input style={modalInput} type="password" value={confirm}
          onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter new password" />

        {error && (
          <div style={{ color: '#e11d48', fontSize: 12, marginBottom: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Update Password'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
