/**
 * The ONE place the frontend talks to the backend.
 *
 * Every API call goes through the `api` axios instance below.
 * Auth token injection and 401 handling are wired here so every
 * module gets them for free without any extra code.
 *
 * Claude Code: add new endpoint helpers here, don't scatter axios calls.
 */
import axios from 'axios';
import { clearAuth, getToken } from './auth';

/**
 * Where does the backend live?
 *
 *  - Browser (npm run dev): the app is served by Vite, which proxies '/api'
 *    to http://localhost:8000 (see vite.config.js). So a RELATIVE '/api' is
 *    correct and same-origin.
 *
 *  - Tauri desktop build: the static bundle is served by Tauri from a special
 *    origin (tauri://localhost / http://tauri.localhost). A relative '/api'
 *    would resolve to THAT origin, where nothing answers. We must call the
 *    Python sidecar at its absolute address instead. Rust injects the real
 *    port into window.__HCC_PORT__ once the backend is ready (it prefers 8000).
 */
const isTauri = () =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

function backendBaseURL() {
  if (!isTauri()) return '/api';                 // dev: Vite proxy, same origin
  const port = (typeof window !== 'undefined' && window.__HCC_PORT__) || 8000;
  return `http://127.0.0.1:${port}/api`;         // desktop: talk to the sidecar
}

export const api = axios.create({
  baseURL: backendBaseURL(),
  headers: { 'Content-Type': 'application/json' },
});

// window.__HCC_PORT__ is injected by Rust AFTER this module first loads, so
// re-resolve the base URL on every request. Cheap, and it guarantees we hit
// the right port even on the rare fallback (8001+) case.
api.interceptors.request.use((config) => {
  config.baseURL = backendBaseURL();
  return config;
});

/**
 * Attach (or remove) the Bearer token from every outgoing request.
 * Call this right after login, and again with null on logout.
 */
export function setAuthToken(token) {
  if (token) api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  else        delete api.defaults.headers.common['Authorization'];
}

// If a token is already saved from this session (e.g. the user refreshed
// the page), restore it immediately so requests don't fail.
const existingToken = getToken();
if (existingToken) {
  setAuthToken(existingToken);
}

// If the backend returns 401 (token expired or invalid), log the user out
// automatically and send them to the login page rather than showing a
// confusing error message.
// Exception: the /auth/login endpoint returns 401 for *wrong credentials*,
// which is expected. We let that fall through so Login.jsx can show the
// inline error message instead of bouncing the page.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const isLoginCall = error.config?.url === '/auth/login';
    if (error.response?.status === 401 && !isLoginCall) {
      clearAuth();
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);
