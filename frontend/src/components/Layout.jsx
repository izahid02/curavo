import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { clearAuth, getUser, saveToken } from '../lib/auth';
import { api, setAuthToken } from '../lib/api';
import { usePharmacy } from '../lib/pharmacy.jsx';
import { clearBrandingCache, loadBrandingImage } from '../lib/branding';
import Icon from './shared/Icon';
import { LicenceBanner, LicencePill, LicenceProvider, useLicence } from '../lib/licence.jsx';
import { UpdateBanner } from '../lib/updater.jsx';
import { OwnerAppModal } from '../lib/ownerApp.jsx';
import { CuravoAccountModal } from '../lib/curavoAccount.jsx';
/** Roles allowed to open Pharmacy Settings.  Must match _SETTINGS_ADMIN_ROLES
 *  in backend/app/routers/settings.py — the backend enforces it either way. */
const PHARMACY_SETTINGS_ROLES = ['Owner', 'Administrator'];

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
  '/register':      'H1 & MTP Register',
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
  '/register':      'Schedule H1 and MTP kit sales — kept for three years',
  '/marketing':     'Campaigns and messaging',
  '/suppliers':     'Supplier management',
  '/expenditure':   'Expenses, salaries and daily cash register',
  '/reports':       'Sales, inventory and profit reports',
};

/** Section label inside the sidebar nav.
 *
 *  The generous 16px gap above each label is what separates one group of nav
 *  items from the next — but five labels × 16px is 80px of the sidebar, which is
 *  what pushed the last nav item off a short screen.  So it scales with the
 *  viewport height the same way .nav-item's padding does (see global.css): the
 *  full 16px of breathing room on a tall monitor, tightening to 6px on a small
 *  laptop rather than costing anyone the Reports link. */
function NavSection({ label }) {
  return (
    <div style={{
      fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
      letterSpacing: '0.08em', color: '#94a3b8',
      padding: 'clamp(6px, 1.5vh, 16px) 12px 4px',
      margin: 0,
      // Same reason as .nav-item: a column flex child will not shrink below its
      // content unless told it may, and the nav must tighten, never scroll.
      minHeight: 0,
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

  /* The shop's own name, loaded once at app start (see lib/pharmacy.jsx).
     `refresh` is called after the settings modal saves so the sidebar, the tab
     title and the receipt all pick up a rename at the same moment. */
  const { pharmacy, refresh: refreshPharmacy } = usePharmacy();

  /* Account menu / profile state */
  const [accountMenuOpen, setAccountMenuOpen]     = useState(false);
  const [showEditProfile, setShowEditProfile]     = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showPharmacySettings, setShowPharmacySettings] = useState(false);
  const [showOwnerApp, setShowOwnerApp] = useState(false);
  const [showCuravoAccount, setShowCuravoAccount] = useState(false);
  const [profile, setProfile]                     = useState(null);
  const [avatarUrl, setAvatarUrl]                 = useState(null);
  const [avatarError, setAvatarError]             = useState(null);
  const [toast, setToast]                         = useState(null);

  /* Newest backup on this PC, for the status card at the foot of the sidebar.
     null = not loaded / not allowed to see backups (the list is Owner/Admin
     only), so the card simply does not render for other roles.
     NOTE: this deliberately says "backup", not "synced" — cloud sync arrives
     in Month 2, and the card must never claim something that is not true. */
  const [lastBackup, setLastBackup]               = useState(null);

  /* The header search box (dashboard only) and its Ctrl+K shortcut. */
  const [headerSearch, setHeaderSearch]           = useState('');
  const headerSearchRef                           = useRef(null);

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
  const pageTitle = PAGE_TITLES[location.pathname] ?? pharmacy.pharmacy_name;

  /* Name to greet with — prefer the fetched profile, fall back to the token user. */
  const displayName = profile?.full_name || profile?.username
    || user?.full_name || 'User';
  const firstName   = displayName.split(' ')[0];

  /* Header bits for the dashboard greeting (Curavo design). */
  const isDashboard  = location.pathname === '/';
  const todayShort   = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const hourNow      = new Date().getHours();
  const greetingWord = hourNow < 12 ? 'Good morning' : hourNow < 17 ? 'Good afternoon' : 'Good evening';

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
        // 60 days) so the sidebar badge matches the Dashboard card and the
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

  /* Backup status: read the newest snapshot's time once, then every 10 min. */
  useEffect(() => {
    function fetchLastBackup() {
      api.get('/backup/list')
        .then(({ data }) => {
          const newest = data.backups?.[0];
          setLastBackup(newest ? { at: newest.created_at } : { at: null });
        })
        .catch(() => setLastBackup(null));   // 403 for non-admins: hide the card
    }
    fetchLastBackup();
    const timer = setInterval(fetchLastBackup, 600_000);
    return () => clearInterval(timer);
  }, []);

  /* Dashboard keyboard shortcuts: F2 = new bill, Ctrl/Cmd+K = search.
     Only on the dashboard — Billing has its own F2 (focus search) and must
     keep it. */
  useEffect(() => {
    if (location.pathname !== '/') return;
    const onKey = (e) => {
      if (e.key === 'F2') { e.preventDefault(); navigate('/billing'); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        headerSearchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [location.pathname, navigate]);

  /* Enter in the header search opens Medicines already filtered (?q=). */
  function submitHeaderSearch(e) {
    e.preventDefault();
    const q = headerSearch.trim();
    navigate(q ? `/inventory?q=${encodeURIComponent(q)}` : '/inventory');
  }

  /* "today 9:14 AM" / "yesterday 6:02 PM" / "28 Oct, 9:14 AM" */
  function backupWhen(iso) {
    const d = new Date(iso);
    const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const diffDays = Math.round((day0 - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000);
    if (diffDays === 0) return `today ${time}`;
    if (diffDays === 1) return `yesterday ${time}`;
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + `, ${time}`;
  }

  function handleSignOut() {
    clearAuth();
    setAuthToken(null);
    navigate('/login');
  }

  /* className helper for NavLink — drives .nav-item / .nav-item-active CSS. */
  const navClass = ({ isActive }) => `nav-item${isActive ? ' nav-item-active' : ''}`;

  return (
    // LicenceProvider: the Curavo subscription status, shared with the banner,
    // the header chip, the account menu and any page that gets paused (Reports).
    <LicenceProvider role={profile?.role || user?.role_name}>
    <div style={{
      display: 'flex', height: '100vh', position: 'relative', zIndex: 1,
      padding: 20, gap: 20, boxSizing: 'border-box',
    }}>

      {/* ══ SIDEBAR ══════════════════════════════════════════════════
          Exactly one viewport tall, split into three flex rows: the brand
          block, the nav, and the ARZ credit line.  Only the MIDDLE one may
          change size — see each block below.

          It stays put while the page scrolls without needing position: fixed,
          because nothing at page level scrolls: this row is 100vh and <main>
          below carries its own overflowY: auto.  Keeping the sidebar in normal
          flow means the main column's width is still worked out by the browser;
          taking it out would need a matching 220px margin on that column, one
          more thing to keep in sync for no visible gain. */}
      <aside style={{
        width: 236,
        position: 'relative', zIndex: 10,
        background: 'rgba(255,255,255,0.50)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.85)',
        borderRadius: 22,
        boxShadow: '0 10px 36px rgba(79,70,229,0.08)',
        height: '100%',
        boxSizing: 'border-box',
        padding: '6px 4px',
        display: 'flex', flexDirection: 'column',
        flexShrink: 0,
      }}>

        {/* Brand block — flexShrink: 0, so the shop's own name and logo are
            never the thing that gives way when the screen is short. */}
        <div style={{
          flexShrink: 0,
          padding: '16px 14px 12px',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '4px 0',
          }}>
            {/* The PRODUCT's mark.  The shop's own logo (uploaded in
                Pharmacy Settings) is what prints on receipts and invoices —
                that is the shop's identity, not ours. */}
            <img
              src="/curavo-logo.svg"
              alt="Curavo"
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '11px',
                boxShadow: '0 4px 12px rgba(99,102,241,0.30)',
                flexShrink: 0,
              }}
            />
            {/* Shop name. The old teal "Powered by ARZ Technologies" line that
                sat here has moved to the bottom of the sidebar, where it is
                now the real ARZ logo instead of plain text. */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '3px',
              minWidth: 0,
            }}>
              <div style={{
                fontWeight: 600,
                fontSize: '18px',
                letterSpacing: '-0.02em',
                color: 'var(--text)',
                lineHeight: 1.1,
              }}>
                Curavo
              </div>
              <div style={{
                fontWeight: 500,
                fontSize: '12px',
                color: 'var(--text-secondary)',
                lineHeight: 1.2,
                // The name is now the OWNER'S text, not a fixed string, so it
                // has to be able to be long. Ellipsis rather than nowrap-
                // overflow keeps it from pushing the sidebar wider.
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
                title={pharmacy.pharmacy_name}
              >
                {pharmacy.pharmacy_name}
              </div>
            </div>
          </div>
        </div>

        {/* Navigation — NO SCROLLBAR, EVER.
            flex: 1 makes this block absorb all the leftover height between the
            brand block above and the ARZ logo block below.  Because the ARZ
            block is a real sibling in normal flow (not absolutely positioned),
            the browser reserves its height here automatically.

            There is deliberately NO overflow property.  It used to be
            overflowY: auto, which meant that on a 768px laptop — where all
            seventeen rows (12 links + 5 section labels) do not quite fit — the
            nav grew its own scrollbar and simply hid the last item, Reports.
            A hidden nav item is a feature the user cannot find.  Instead the
            rows COMPRESS: their vertical padding is tied to the viewport height
            with clamp(), and both .nav-item and NavSection set min-height: 0 so
            flexbox may squeeze them further if even that is not enough.  Since
            nothing can then overflow this box, no scrollbar can appear and
            nothing can paint over the ARZ logo below.
            minHeight: 0 on this container is what lets it be shorter than its
            own content in the first place — without it a column flex child
            refuses to shrink and pushes the footer off the screen. */}
        <nav style={{
          padding: 'clamp(2px, 0.6vh, 12px) 10px',
          flex: 1, minHeight: 0,
          display: 'flex', flexDirection: 'column',
          // Sixteen gaps between seventeen rows adds up, so this scales with the
          // screen too: ~3px of separation on a big monitor, closing to nothing
          // on a short laptop where the nav needs every pixel.
          gap: 'clamp(0px, 0.25vh, 3px)',
        }}>

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
            Billing
          </NavLink>

          <NavLink to="/invoices" className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
            </svg>
            Invoices
          </NavLink>

          <NavLink to="/inventory" className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
            </svg>
            Inventory
          </NavLink>

          {/* "Purchasing" nav removed — stock-in now lives inside the unified
              Medicines page (Add Stock tab).  The old /purchasing route still
              redirects to /inventory for any saved bookmarks. */}

          <NavLink to="/expiry-alerts" className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            Expiry alerts
            {alertCount > 0 && (
              <span className="nav-badge">
                {alertCount}
              </span>
            )}
          </NavLink>

          <NavLink to="/patients" className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
            </svg>
            Patients
          </NavLink>

          <NavLink to="/follow-ups" className={navClass}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0114 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
            </svg>
            Follow-ups
            {(followUpDueCount + followUpPendingAction) > 0 && (
              <span className="nav-badge">
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
              <span className="nav-badge">
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

          <NavLink to="/register" className={navClass}>
            {/* Clipboard with a line — a record being kept */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M9 2h6a1 1 0 0 1 1 1v2H8V3a1 1 0 0 1 1-1z"/>
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
              <line x1="8" y1="11" x2="16" y2="11"/>
              <line x1="8" y1="15" x2="13" y2="15"/>
            </svg>
            H1 Register
          </NavLink>

          <NavLink to="/backup" className={navClass}>
            {/* Database / disk icon — stacked cylinders */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <ellipse cx="12" cy="5" rx="9" ry="3"/>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
              <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>
            </svg>
            Backup
          </NavLink>
        </nav>

        {/* ── "Powered by" ARZ Technologies logo ──────────────────────────
            Pinned to the bottom of the sidebar as the LAST flex child, in
            normal document flow. It used to be `position: absolute`, which
            took it out of flow: the nav then believed it had the full height
            of the sidebar to scroll through, so the last nav item (Reports)
            slid underneath this block and the logo itself looked clipped.
            flexShrink: 0 is the other half of the fix — it is the ONE part of
            the sidebar that must not compress, so a long nav list can never
            squeeze the logo down and cut it off.

            The whole block sits at 75% opacity: a credit line should be
            readable but never compete with the pharmacist's actual navigation.
            It comes up to full strength on hover, for anyone who wants to look
            at it properly.  Label and logo are both left-aligned to the same
            16px edge as the brand block at the top of the sidebar. */}
        {/* Backup status — pinned to the foot of the sidebar in normal flow
            (flexShrink: 0, same reasoning as the old ARZ block it replaces:
            it must never be squeezed or overlapped by the nav).
            Green when a backup exists, amber when there is none yet.  Click
            opens the Backup page.  Hidden for roles that cannot see backups. */}
        {lastBackup && (
          <NavLink
            to="/backup"
            style={{
              flexShrink: 0,
              margin: '8px 10px 10px',
              padding: '12px 14px',
              borderRadius: 14,
              background: lastBackup.at ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.14)',
              textDecoration: 'none',
              display: 'flex', flexDirection: 'column', gap: 2,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: lastBackup.at ? '#047857' : '#b45309' }}>
              ● {lastBackup.at ? 'Backup safe' : 'No backup yet'}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {lastBackup.at ? `Last backup ${backupWhen(lastBackup.at)}` : 'Open Backup to make one'}
            </span>
          </NavLink>
        )}
      </aside>

      {/* ══ MAIN AREA ════════════════════════════════════════════════ */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>

        {/* Topbar */}
        {/* Header — no bar of its own (Curavo design): it sits on the
            gradient, level with the top of the floating sidebar.
            Dashboard: date + greeting, with search and New bill.
            Every other page: title + subtitle, with the date. */}
        <header style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap',
          padding: '6px 4px 18px', gap: 12,
          flexShrink: 0,
        }}>
          <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {isDashboard ? (
              <>
                <span style={{ fontSize: 14, color: 'var(--text-secondary)', fontWeight: 500 }}>
                  {todayShort}
                </span>
                <h1 style={{ fontSize: 'clamp(22px, 2.1vw, 30px)', fontWeight: 600, color: '#1e1b4b', margin: 0, lineHeight: 1.15, letterSpacing: '-0.02em' }}>
                  {greetingWord}, {firstName}
                </h1>
              </>
            ) : (
              <>
                <h1 style={{ fontSize: 26, fontWeight: 600, color: '#1e1b4b', margin: 0, lineHeight: 1.2, letterSpacing: '-0.02em' }}>
                  {pageTitle}
                </h1>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                  {pageSubtitle}
                </p>
              </>
            )}
          </div>

          {isDashboard ? (
            <>
              {/* Search medicines — Enter opens Medicines filtered; Ctrl+K focuses */}
              <form onSubmit={submitHeaderSearch} role="search" style={{ margin: 0 }}>
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  height: 44, padding: '0 12px 0 14px', width: 'clamp(200px, 22vw, 300px)', boxSizing: 'border-box',
                  background: 'rgba(255,255,255,0.65)',
                  backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
                  border: '1px solid rgba(255,255,255,0.9)', borderRadius: 12,
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
                  </svg>
                  <input
                    ref={headerSearchRef}
                    value={headerSearch}
                    onChange={(e) => setHeaderSearch(e.target.value)}
                    placeholder="Search medicines"
                    aria-label="Search medicines"
                    style={{
                      border: 0, outline: 0, boxShadow: 'none', padding: 0,
                      font: 'inherit', fontSize: 14, flex: 1, minWidth: 0,
                      background: 'transparent', color: '#1e1b4b',
                    }}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text-hint)', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 6, padding: '0 6px', whiteSpace: 'nowrap' }}>
                    Ctrl K
                  </span>
                </label>
              </form>
              <button
                className="btn-primary"
                onClick={() => navigate('/billing')}
                style={{ height: 44, padding: '0 18px', borderRadius: 12, fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}
              >
                + New bill <span style={{ fontSize: 12, opacity: 0.85 }}>F2</span>
              </button>
            </>
          ) : (
            <span style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
              {today}
            </span>
          )}

          {/* "Free trial · 23 days left" - only during a trial that is not yet urgent */}
          <LicencePill />

          {/* Account button — opens the dropdown menu.  Wrapped in an error
              boundary so a render fault here can never blank the whole app. */}
          <AccountMenuBoundary>
          <button
            data-account-menu
            onClick={() => { setAccountMenuOpen((o) => !o); setAvatarError(null); }}
            aria-label={`Account: ${profile?.full_name || profile?.username || 'User'}`}
            title={`${profile?.full_name || profile?.username || 'User'} · ${profile?.role || user?.role_name || 'Staff'}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 44, height: 44,
              background: 'rgba(255,255,255,0.65)',
              border: '1px solid rgba(255,255,255,0.9)',
              borderRadius: '50%',
              padding: 0,
              cursor: 'pointer',
              backdropFilter: 'blur(16px)',
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

          </button>
          </AccountMenuBoundary>
        </header>

        {/* Subscription warning - only when something needs doing */}
        <LicenceBanner />

        {/* A new Curavo version, downloaded and verified (desktop app only) */}
        <UpdateBanner role={profile?.role || user?.role_name} />

        {/* Page content */}
        <main style={{
          flex: 1, overflowY: 'auto',
          position: 'relative', zIndex: 1,
          padding: '0 4px 8px',
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
            top: '76px',
            right: '24px',
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

            {/* Pharmacy Settings — renaming the shop, and changing the GSTIN
                printed on every tax invoice, is an ownership decision.  The
                backend enforces the same rule; hiding the row keeps a
                pharmacist from opening a form they cannot save. */}
            {PHARMACY_SETTINGS_ROLES.includes(profile?.role || user?.role_name) && (
              <MenuItem
                color="#1e1b4b"
                hover="rgba(99,102,241,0.06)"
                onClick={() => { setAccountMenuOpen(false); setShowPharmacySettings(true); }}
                icon={(
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.8">
                    <path d="M3 9l1.5-5h15L21 9" />
                    <path d="M3 9h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
                    <path d="M9 21v-6h6v6" />
                  </svg>
                )}
                label="Pharmacy Settings"
              />
            )}

            {/* Curavo account - the owner's sign-in on curavo.in, which brings
                the subscription to this PC.  Linking is an owner decision. */}
            {PHARMACY_SETTINGS_ROLES.includes(profile?.role || user?.role_name) && (
              <MenuItem
                color="#1e1b4b"
                hover="rgba(99,102,241,0.06)"
                onClick={() => { setAccountMenuOpen(false); setShowCuravoAccount(true); }}
                icon={(
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.8">
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
                  </svg>
                )}
                label="Curavo account"
              />
            )}

            {/* Owner app on phone - connecting a phone shows this shop's sales
                to whoever holds it, so it is an owner decision. */}
            {PHARMACY_SETTINGS_ROLES.includes(profile?.role || user?.role_name) && (
              <MenuItem
                color="#1e1b4b"
                hover="rgba(99,102,241,0.06)"
                onClick={() => { setAccountMenuOpen(false); setShowOwnerApp(true); }}
                icon={(
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.8">
                    <rect x="6" y="2" width="12" height="20" rx="2" />
                    <line x1="11" y1="18" x2="13" y2="18" />
                  </svg>
                )}
                label="Owner app on phone"
              />
            )}

            {/* Everyone can see the subscription state and the shop code;
                only the owner/admin can paste a key (checked in the modal). */}
            <LicenceMenuItem onPick={() => setAccountMenuOpen(false)} />

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

      {/* ══ PHARMACY SETTINGS MODAL ══════════════════════════════════ */}
      {showPharmacySettings && (
        <PharmacySettingsModal
          pharmacy={pharmacy}
          onClose={() => setShowPharmacySettings(false)}
          onSaved={() => {
            // Reload the shared settings so the sidebar brand, the browser tab
            // title and the next printed receipt all update together.
            refreshPharmacy();
            showToast('Pharmacy settings saved');
          }}
        />
      )}

      {/* ══ CURAVO ACCOUNT ══════════════════════════════════════════ */}
      {showCuravoAccount && <CuravoAccountModal onClose={() => setShowCuravoAccount(false)} />}

      {/* ══ OWNER APP ON PHONE ═══════════════════════════════════════ */}
      {showOwnerApp && <OwnerAppModal onClose={() => setShowOwnerApp(false)} />}

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

    </div>
    </LicenceProvider>
  );
}


/* ═══════════════════════════════════════════════════════════════════════
 * Small helper components used by the account menu / modals.
 * Kept in this file because they are only used here.
 * ═══════════════════════════════════════════════════════════════════════ */

/** "Licence & subscription" row - opens the modal owned by LicenceProvider. */
function LicenceMenuItem({ onPick }) {
  const { status, openLicence } = useLicence();
  const warn = status && (status.state === 'GRACE' || status.state === 'EXPIRED');
  return (
    <MenuItem
      color="#1e1b4b"
      hover="rgba(99,102,241,0.06)"
      onClick={() => { onPick(); openLicence(); }}
      icon={(
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.8">
          <circle cx="8" cy="15" r="4" />
          <path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2" />
        </svg>
      )}
      label={(
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Licence &amp; subscription
          {warn && <span style={{ width: 7, height: 7, borderRadius: '50%', background: status.state === 'EXPIRED' ? 'var(--danger)' : 'var(--warn)' }} />}
        </span>
      )}
    />
  );
}

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

/** What a username may contain — must match USERNAME_PATTERN in routers/auth.py. */
const USERNAME_RE = /^[A-Za-z0-9_]+$/;

/** Modal for editing the current user's username / name / email / phone. */
function EditProfileModal({ profile, onClose, onSaved }) {
  const [username, setUsername] = useState(profile?.username || '');
  const [fullName, setFullName] = useState(profile?.full_name || '');
  const [email, setEmail]       = useState(profile?.email || '');
  const [phone, setPhone]       = useState(profile?.phone || '');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  const usernameChanged = username.trim() !== (profile?.username || '');

  async function handleSave() {
    setError('');

    // Validate the username here as well as on the server, so a typo is caught
    // before a round-trip.  The rules are the server's — see routers/auth.py.
    const trimmed = username.trim();
    if (usernameChanged) {
      if (trimmed.length < 3) {
        return setError('Username must be at least 3 characters.');
      }
      if (!USERNAME_RE.test(trimmed)) {
        return setError('Username may only contain letters, numbers and underscores — no spaces.');
      }
    }

    setSaving(true);
    try {
      const body = { full_name: fullName, email, phone };
      // Only send the username when it actually changed: sending it unchanged
      // would still make the backend mint a new token for no reason.
      if (usernameChanged) body.username = trimmed;

      const res = await api.put('/auth/me/profile', body);

      // ⚠ THE JWT IDENTIFIES ITS HOLDER BY USERNAME.  The moment the name
      // changes the old token stops resolving, so the backend hands back a
      // fresh one.  Swapping it in here is what stops the very next request
      // 401-ing and bouncing the pharmacist to the login screen mid-shift.
      if (res.data.access_token) {
        const savedUser = getUser() || {};
        saveToken(res.data.access_token, { ...savedUser, username: res.data.username });
        setAuthToken(res.data.access_token);
      }

      onSaved(res.data);
      onClose();
    } catch (err) {
      // Surface the backend message (e.g. "Username already taken").
      setError(err.response?.data?.detail || 'Could not save changes. Please try again.');
      setSaving(false);
    }
  }

  return createPortal(
    <div style={modalBackdrop} onMouseDown={onClose}>
      <div style={modalCard} onMouseDown={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 18px', fontSize: 18, fontWeight: 700, color: '#1e1b4b' }}>
          Edit Profile
        </h2>

        <label style={modalLabel}>Username</label>
        <input style={{ ...modalInput, marginBottom: 4 }} value={username}
          onChange={(e) => setUsername(e.target.value)} placeholder="e.g. admin" />
        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 14 }}>
          {usernameChanged
            ? `⚠ You will sign in as "${username.trim()}" from now on — "${profile?.username}" will stop working.`
            : 'Letters, numbers and underscores. At least 3 characters.'}
        </div>

        <label style={modalLabel}>Full Name</label>
        <input style={modalInput} value={fullName}
          onChange={(e) => setFullName(e.target.value)} placeholder="Your name" />

        <label style={modalLabel}>Email</label>
        <input style={{ ...modalInput, marginBottom: 4 }} type="email" value={email}
          onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 14 }}>
          You can sign in with this email as well as your username.
        </div>

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

/**
 * Modal for the shop's own identity — name, tagline, address, contact and the
 * two legal numbers printed on every tax invoice.
 *
 * Owner / Administrator only (PHARMACY_SETTINGS_ROLES above; the backend
 * enforces the same rule, so hiding the menu item is convenience, not
 * security).
 *
 * Saving here changes what appears in the sidebar, on the login screen, on the
 * printed receipt and in the browser tab title, because all four read the same
 * shared settings (see lib/pharmacy.jsx).
 */
/**
 * One shop image (logo or signature) inside Pharmacy Settings: a preview, plus
 * Upload / Replace and Remove.  Talks to /api/settings/branding/{kind}.
 */
function BrandingImageField({ kind, label, hint }) {
  const [preview, setPreview] = useState(null);   // object URL, or null = none
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState('');

  useEffect(() => {
    let alive = true;
    loadBrandingImage(kind).then((r) => { if (alive) setPreview(r?.url ?? null); });
    return () => { alive = false; };
  }, [kind]);

  async function refresh() {
    clearBrandingCache(kind);
    const r = await loadBrandingImage(kind);
    setPreview(r?.url ?? null);
  }

  async function upload(e) {
    const file = e.target.files[0];
    e.target.value = '';                 // so the same file can be picked again
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setErr('Too large — maximum 2 MB.'); return; }
    setBusy(true); setErr('');
    try {
      const form = new FormData();
      form.append('file', file);
      await api.post(`/settings/branding/${kind}`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
      await refresh();
    } catch (ex) {
      setErr(ex.response?.data?.detail || 'Upload failed.');
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setErr('');
    try { await api.delete(`/settings/branding/${kind}`); await refresh(); }
    catch (ex) { setErr(ex.response?.data?.detail || 'Could not remove.'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ border: '1px solid rgba(0,0,0,0.08)', borderRadius: 12, padding: 10, background: 'rgba(255,255,255,0.6)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#1e1b4b' }}>{label}</span>
      <div style={{ height: 64, borderRadius: 8, background: '#fff', border: '1px dashed rgba(0,0,0,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {preview
          ? <img src={preview} alt={label} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          : <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>None uploaded</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <label className="btn-secondary" style={{ flex: 1, textAlign: 'center', padding: '6px 8px', fontSize: 12, borderRadius: 8, cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? '…' : preview ? 'Replace' : 'Upload'}
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={upload} disabled={busy} style={{ display: 'none' }} />
        </label>
        {preview && (
          <button className="btn-secondary" onClick={remove} disabled={busy} style={{ padding: '6px 8px', fontSize: 12, borderRadius: 8 }}>
            Remove
          </button>
        )}
      </div>
      <span style={{ fontSize: 10.5, color: err ? '#e11d48' : 'var(--text-hint)' }}>{err || hint}</span>
    </div>
  );
}

function PharmacySettingsModal({ pharmacy, onClose, onSaved }) {
  const [form, setForm] = useState({
    pharmacy_name:      pharmacy?.pharmacy_name || '',
    pharmacy_name_as:   pharmacy?.pharmacy_name_as || '',
    invoice_name:       pharmacy?.invoice_name || '',
    invoice_prefix:     pharmacy?.invoice_prefix || '',
    pharmacy_tagline:   pharmacy?.pharmacy_tagline || '',
    pharmacy_address:   pharmacy?.pharmacy_address || '',
    pharmacy_phone:     pharmacy?.pharmacy_phone || '',
    pharmacy_email:     pharmacy?.pharmacy_email || '',
    pharmacy_gstin:     pharmacy?.pharmacy_gstin || '',
    pharmacy_dl_number: pharmacy?.pharmacy_dl_number || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  // Invoice numbering: current prefix, whether it is locked for this year,
  // and the next number (GET /settings/invoice-numbering).
  const [numbering, setNumbering] = useState(null);

  useEffect(() => {
    api.get('/settings/invoice-numbering')
      .then(({ data }) => {
        setNumbering(data);
        // The saved prefix may still be empty on an upgraded shop - show the
        // one actually in use (read from its last invoice).
        setForm((prev) => ({ ...prev, invoice_prefix: prev.invoice_prefix || data.prefix }));
      })
      .catch(() => {});
  }, []);

  const set = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));
  // Live preview of the next number with the prefix as typed.
  const typedPrefix = (form.invoice_prefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const nextPreview = numbering
    ? numbering.next_number.replace(/^[^-]+/, typedPrefix || numbering.prefix)
    : null;

  async function handleSave() {
    if (!form.pharmacy_name.trim()) {
      return setError('Pharmacy name is required.');
    }
    setSaving(true);
    setError('');
    try {
      await api.put('/settings/pharmacy', form);
      onSaved();
      onClose();
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not save settings. Please try again.');
      setSaving(false);
    }
  }

  return createPortal(
    <div style={modalBackdrop} onMouseDown={onClose}>
      <div
        style={{ ...modalCard, maxWidth: 460, maxHeight: '88vh', overflowY: 'auto' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700, color: '#1e1b4b' }}>
          Pharmacy Settings
        </h2>
        <p style={{ margin: '0 0 18px', fontSize: 12, color: '#6b7280' }}>
          These details appear in the sidebar, on the login screen and at the top
          of every printed receipt.
        </p>

        <label style={modalLabel}>Name *</label>
        <input style={modalInput} value={form.pharmacy_name}
          onChange={(e) => set('pharmacy_name', e.target.value)}
          placeholder="e.g. Sunrise Medicos" />

        {/* Used in ASSAMESE patient messages (follow-ups, reminders).
            Blank = those messages use the name above. */}
        <label style={modalLabel}>Shop name in Assamese</label>
        <input style={modalInput} value={form.pharmacy_name_as}
          onChange={(e) => set('pharmacy_name_as', e.target.value)}
          placeholder="e.g. স্বাস্থ্য সেৱা কেন্দ্ৰ — leave blank to use the name above" />

        {/* Optional — only needed when the tax invoice must carry a different
            name from the sign (legal name for the GSTIN, "M/S …", etc.). */}
        <label style={modalLabel}>Name on invoices</label>
        <input style={modalInput} value={form.invoice_name}
          onChange={(e) => set('invoice_name', e.target.value)}
          placeholder="Leave blank to print the name above in capitals" />

        {/* Invoice number prefix — 1 to 4 capitals/digits (GST caps the whole
            number at 16 characters), locked once this year's first bill exists
            so one year never mixes two series.  The backend enforces both. */}
        <label style={modalLabel}>Invoice number prefix</label>
        <input style={{ ...modalInput, marginBottom: 4, textTransform: 'uppercase', ...(numbering?.locked ? { opacity: 0.6 } : {}) }}
          value={form.invoice_prefix}
          maxLength={numbering?.max_length ?? 4}
          disabled={numbering?.locked}
          onChange={(e) => set('invoice_prefix', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
          placeholder="e.g. SM" />
        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 14 }}>
          {nextPreview && <>Next invoice: <b style={{ color: '#1e1b4b' }}>{nextPreview}</b>. </>}
          {numbering?.locked
            ? "Locked for this year — invoices have already started. It can be changed before next year's first bill."
            : 'Up to 4 letters or digits. Locks once the first bill of the year is made.'}
        </div>

        <label style={modalLabel}>Tagline</label>
        <input style={modalInput} value={form.pharmacy_tagline}
          onChange={(e) => set('pharmacy_tagline', e.target.value)}
          placeholder="Pharmacy & Medical Store" />

        <label style={modalLabel}>Address</label>
        <textarea style={{ ...modalInput, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }}
          value={form.pharmacy_address}
          onChange={(e) => set('pharmacy_address', e.target.value)}
          placeholder="Shop address as it should print on the bill" />

        <label style={modalLabel}>Phone</label>
        <input style={modalInput} value={form.pharmacy_phone}
          onChange={(e) => set('pharmacy_phone', e.target.value)}
          placeholder="e.g. 98640 12345" />

        <label style={modalLabel}>Email</label>
        <input style={modalInput} type="email" value={form.pharmacy_email}
          onChange={(e) => set('pharmacy_email', e.target.value)}
          placeholder="shop@example.com" />

        <label style={modalLabel}>GSTIN</label>
        <input style={modalInput} value={form.pharmacy_gstin}
          onChange={(e) => set('pharmacy_gstin', e.target.value)}
          placeholder="15-character GST number" />

        <label style={modalLabel}>DL Number</label>
        <input style={{ ...modalInput, marginBottom: 4 }} value={form.pharmacy_dl_number}
          onChange={(e) => set('pharmacy_dl_number', e.target.value)}
          placeholder="Drug Licence number" />
        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 14 }}>
          GSTIN and DL number are legally required on a pharmacy bill — they
          print on the receipt whenever they are filled in.
        </div>

        {/* The shop's own images — uploaded straight away (no need to press
            Save), because they are files, not form fields. */}
        <label style={modalLabel}>Logo &amp; signature</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginBottom: 14 }}>
          <BrandingImageField kind="logo" label="Shop logo"
            hint="Square works best · PNG/JPG, max 2 MB" />
          <BrandingImageField kind="signature" label="Signature"
            hint="Sign on white paper, photograph it" />
        </div>

        {error && (
          <div style={{ color: '#e11d48', fontSize: 12, marginBottom: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Settings'}
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
