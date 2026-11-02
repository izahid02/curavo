/**
 * Everything the app says to the Curavo cloud, and the phone's saved link.
 *
 * The link (cloud address, this phone's id + token, and its PRIVATE key) is
 * kept in the phone's secure storage (Android Keystore).  The private key
 * never leaves the phone: the cloud only ever hands over locked summaries,
 * and only this key opens them (src/lockbox.js).
 */
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { newKeyPair, pairingProof, unlockSummary } from './lockbox';

const LINK_KEY = 'curavo_owner_link_v1';

export class CloudError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function loadLink() {
  try {
    const s = await SecureStore.getItemAsync(LINK_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export async function saveLink(link) {
  await SecureStore.setItemAsync(LINK_KEY, JSON.stringify(link));
}

export async function clearLink() {
  try { await SecureStore.deleteItemAsync(LINK_KEY); } catch { /* already gone */ }
}

async function call(base, path, { method = 'GET', body, link } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (link) {
    headers['X-Device-Id'] = link.deviceId;
    headers.Authorization = `Bearer ${link.token}`;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let r;
  try {
    r = await fetch(base.replace(/\/+$/, '') + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal,
    });
  } catch {
    throw new CloudError('Could not reach the Curavo server. Check the phone\'s internet.', 0);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  if (r.status !== 204) {
    try { data = await r.json(); } catch { data = null; }
  }
  if (!r.ok) {
    const detail = data && typeof data.detail === 'string' ? data.detail : `The server answered ${r.status}.`;
    throw new CloudError(detail, r.status);
  }
  return { status: r.status, data };
}

/**
 * Read the QR code shown on the shop PC (account menu -> Owner app on phone).
 * Returns null for anything that is not a Curavo code.
 */
export function parseQr(text) {
  try {
    const q = JSON.parse(text);
    if (q.curavo !== 1 || !q.c || !q.s || !q.p || !q.k) return null;
    // Only an encrypted connection to the real server - except while
    // developing, when a test server on the Mac may be plain http.
    if (!/^https:\/\//i.test(q.c) && !__DEV__) return { error: 'This code points at a test server. Use a code from a shop PC.' };
    return { cloud: q.c, shopCode: q.s, shopName: q.n || '', pairingId: q.p, secret: q.k };
  } catch {
    return null;
  }
}

/** Step 2 of connecting: make this phone's key pair and claim the code. */
export async function connect(qr, phoneName) {
  const kp = newKeyPair(Crypto.getRandomBytes(32));
  const proof = pairingProof(qr.secret, kp.publicKey, qr.pairingId);
  const { data } = await call(qr.cloud, '/mobile/v1/pair', {
    method: 'POST',
    body: { shop_code: qr.shopCode, pairing_id: qr.pairingId, public_key: kp.publicKey, proof, name: phoneName },
  });
  const link = {
    cloud: qr.cloud, shopCode: qr.shopCode, shopName: data.shop_name || qr.shopName,
    deviceId: data.device_id, token: data.device_token, privateKey: kp.privateKey,
    status: 'PENDING', connectedAt: new Date().toISOString(),
  };
  await saveLink(link);
  return link;
}

/** PENDING (shop PC still checking) / ACTIVE / REMOVED, plus a reason if refused. */
export async function getStatus(link) {
  const { data } = await call(link.cloud, '/mobile/v1/status', { link });
  return data;
}

/**
 * The newest figures, opened with this phone's key.
 * Returns {summary, updatedAt} or null when the shop PC has not sent any for
 * this phone yet.
 */
export async function fetchSummary(link) {
  const { status, data } = await call(link.cloud, '/mobile/v1/summary', { link });
  if (status === 204 || !data) return null;
  let summary;
  try {
    summary = unlockSummary(data.locked, link.deviceId, link.privateKey);
  } catch {
    throw new CloudError('The figures could not be opened on this phone. Remove it on the shop PC and connect again.', -1);
  }
  return { summary, updatedAt: data.updated_at };
}

export async function sendPushToken(link, token) {
  await call(link.cloud, '/mobile/v1/push-token', { method: 'POST', body: { token }, link });
}

export async function unlink(link) {
  try { await call(link.cloud, '/mobile/v1/unlink', { method: 'POST', link }); } catch { /* forget it here anyway */ }
  await clearLink();
}
