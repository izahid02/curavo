/**
 * The control panel's ONE way to reach the cloud server (/admin/api/...).
 * The login token lives in sessionStorage: closing the tab signs ARZ out.
 */
const KEY = 'curavo_panel_token';

export const getToken = () => sessionStorage.getItem(KEY);
export const setToken = (t) => (t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY));

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/admin/api${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && path !== '/login') {
    setToken(null);
    window.location.assign('/login');
    throw new ApiError(401, 'Please sign in again.');
  }
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try { msg = (await res.json()).detail || msg; } catch { /* not JSON */ }
    throw new ApiError(res.status, typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

/** Download a file the API sends (a locked backup) under its own name. */
export async function download(path) {
  const res = await api(path, { raw: true });
  const name = (res.headers.get('content-disposition') || '').match(/filename="?([^";]+)"?/)?.[1] || 'download';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/** Send a form with files (the release upload). */
export async function upload(path, formData) {
  const res = await fetch(`/admin/api${path}`, {
    method: 'POST', body: formData,
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
  });
  if (res.status === 401) { setToken(null); window.location.assign('/login'); throw new ApiError(401, 'Please sign in again.'); }
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try { msg = (await res.json()).detail || msg; } catch { /* not JSON */ }
    throw new ApiError(res.status, typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return res.json();
}
