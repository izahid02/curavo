import { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import SplashScreen from './components/SplashScreen.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Placeholder from './pages/Placeholder.jsx';
import Inventory from './pages/Inventory.jsx';
import ExpiryAlerts from './pages/ExpiryAlerts.jsx';
import Billing from './pages/Billing.jsx';
import InvoiceHistory from './pages/InvoiceHistory.jsx';
import Patients from './pages/Patients.jsx';
import Suppliers from './pages/Suppliers.jsx';
import Reports from './pages/Reports.jsx';
import FollowUps from './pages/FollowUps.jsx';
import Marketing from './pages/Marketing.jsx';
import Credit from './pages/Credit.jsx';
import Expenditure from './pages/Expenditure.jsx';

/**
 * Detect whether we are running inside the Tauri desktop shell (as opposed to
 * a normal browser during `npm run dev`).
 *
 * We check `__TAURI_INTERNALS__` (always injected by Tauri v2) AND `__TAURI__`
 * (only present because tauri.conf.json sets withGlobalTauri:true) so the check
 * is reliable regardless of that setting.
 */
const isTauri = () =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

/**
 * The router maps URLs to pages.
 *
 * All routes inside the <ProtectedRoute> wrapper require a valid login.
 * If a visitor is not logged in, ProtectedRoute sends them to /login.
 * <Layout> wraps the app shell (sidebar + header). <Outlet> inside Layout
 * renders whichever child route matches the current URL.
 *
 * Desktop startup: when running inside Tauri the Python backend is not yet
 * listening the instant the window appears, so we show <SplashScreen/> until
 * Rust emits the "backend-ready" event. In the browser there is no sidecar to
 * wait for, so backendReady starts true and the splash is skipped entirely.
 *
 * Claude Code: register new module pages here as you build each module.
 */
export default function App() {
  // In the browser (dev) skip the splash; in Tauri wait for backend-ready.
  const [backendReady, setBackendReady] = useState(!isTauri());

  useEffect(() => {
    if (!isTauri()) return;

    // Guard against a missed event: if the port was already injected by the
    // time this effect runs, the backend is up — proceed immediately.
    if (typeof window !== 'undefined' && window.__HCC_PORT__) {
      setBackendReady(true);
      return;
    }

    let unlisten;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('backend-ready', () => setBackendReady(true)).then((fn) => {
        unlisten = fn;
      });
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  if (!backendReady) {
    return <SplashScreen />;
  }

  return (
    <Routes>
      {/* Public route — anyone can reach /login */}
      <Route path="/login" element={<Login />} />

      {/* Protected routes — must be logged in to access */}
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/"              element={<Dashboard />} />
        <Route path="/inventory"     element={<Inventory />} />
        {/* "Medicines" also answers to /medicines; both show the same page. */}
        <Route path="/medicines"     element={<Navigate to="/inventory" replace />} />
        {/* Purchasing was merged into the Medicines page — old links redirect. */}
        <Route path="/purchasing"    element={<Navigate to="/inventory" replace />} />
        <Route path="/expiry-alerts" element={<ExpiryAlerts />} />
        <Route path="/billing"       element={<Billing />} />
        <Route path="/invoices"      element={<InvoiceHistory />} />
        <Route path="/patients"      element={<Patients />} />
        <Route path="/suppliers"     element={<Suppliers />} />
        <Route path="/expenditure"   element={<Expenditure />} />
        <Route path="/reports"       element={<Reports />} />
        <Route path="/follow-ups"   element={<FollowUps />} />
        <Route path="/marketing"    element={<Marketing />} />
        <Route path="/credit"       element={<Credit />} />
      </Route>

      {/* Any unknown URL → home (which will redirect to /login if not logged in) */}
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}
