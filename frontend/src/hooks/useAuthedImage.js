/**
 * useAuthedImage — load an image from an AUTHENTICATED backend endpoint.
 *
 * WHY THIS EXISTS
 * ----------------
 * Our prescription image endpoint (GET /api/prescriptions/{id}/image) is
 * protected by a JWT.  The token is sent as an "Authorization: Bearer …"
 * header on every axios request.  BUT a plain <img src="/api/…/image"> tag
 * is a normal browser request — it does NOT carry that header — so the
 * backend replies 401 and the browser shows a broken image.
 *
 * The fix: fetch the image through our axios instance (which DOES add the
 * header) as a binary "blob", then wrap that blob in a local object URL
 * (blob:…).  An <img> can display an object URL directly, no auth needed,
 * because the bytes are already in the browser.
 *
 * This also works cleanly in the future desktop (Electron) build, where
 * relative "/api/…" image URLs would not resolve at all.
 *
 * Object URLs hold memory until revoked, so we revoke the previous one
 * whenever the path changes and on unmount.
 *
 * Usage:
 *   const { url, loading, error } = useAuthedImage(`/prescriptions/${id}/image`);
 *   {url && <img src={url} />}
 *
 * @param {string|null} path  API path (relative to axios baseURL '/api'),
 *                            or null/'' to load nothing.
 * @param {object}      opts  { skip } — pass skip:true to defer loading
 *                            (e.g. for PDFs you don't want to fetch).
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export function useAuthedImage(path, { skip = false } = {}) {
  const [url, setUrl]         = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(false);

  useEffect(() => {
    // Nothing to load — reset state.
    if (!path || skip) {
      setUrl(null);
      setLoading(false);
      setError(false);
      return;
    }

    let objectUrl = null;   // the blob: URL we create (must be revoked later)
    let cancelled = false;  // guard against setState after unmount

    setLoading(true);
    setError(false);

    api.get(path, { responseType: 'blob' })
      .then(res => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // Cleanup: runs on unmount OR before the effect re-runs (path change).
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, skip]);

  return { url, loading, error };
}
