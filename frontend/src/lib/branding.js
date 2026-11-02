/**
 * The shop's own images — logo and signature — uploaded in Pharmacy Settings
 * and printed on the thermal receipt and the A4 tax invoice.
 *
 * WHY: they used to be HCC_LOGO.png / HCC_SIGNATURE.png bundled inside the
 * app, which shipped one shop's signature to every installation.  Now each
 * shop's images live in its own data folder (backend: /api/settings/branding).
 *
 * The endpoint needs the login token, so a plain <img src="/api/..."> would
 * fail (it cannot send the header).  We fetch through `api` instead and hand
 * back what each caller needs:
 *   loadBrandingImage(kind) -> { url, dataUrl, width, height } or null
 *     url     : object URL for an <img> on screen
 *     dataUrl : PNG data URL for jsPDF.addImage (jsPDF cannot read WebP, so
 *               every format is redrawn to PNG through a canvas)
 * Results are cached for the session; call clearBrandingCache() after an
 * upload or removal so the next receipt shows the new image.
 */
import { api } from './api';

const cache = {};   // kind -> Promise<result | null>

export function clearBrandingCache(kind) {
  if (kind) delete cache[kind];
  else Object.keys(cache).forEach((k) => delete cache[k]);
}

export function loadBrandingImage(kind) {
  if (!cache[kind]) {
    cache[kind] = (async () => {
      try {
        const res = await api.get(`/settings/branding/${kind}`, { responseType: 'blob' });
        const url = URL.createObjectURL(res.data);
        const img = await new Promise((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = reject;
          i.src = url;
        });
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        return { url, dataUrl: c.toDataURL('image/png'), width: img.naturalWidth, height: img.naturalHeight };
      } catch {
        return null;   // 404 = nothing uploaded, which is a normal state
      }
    })();
  }
  return cache[kind];
}
