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
import Constants from 'expo-constants';
import { checkCode, newKeyPair, pairingProof, unlockSummary } from './lockbox';

const LINK_KEY = 'curavo_owner_link_v1';
const ACCOUNT_KEY = 'curavo_owner_account_v1';

// The Curavo cloud.  While developing, app.json "extra.cloudUrl" may point at
// a test server; a real build always uses the real one.
export const CLOUD_URL = (__DEV__ && Constants.expoConfig?.extra?.cloudUrl) || 'https://cloud.curavo.in';

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

async function call(base, path, { method = 'GET', body, link, account } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (link) {
    headers['X-Device-Id'] = link.deviceId;
    headers.Authorization = `Bearer ${link.token}`;
  }
  if (account) headers.Authorization = `Bearer ${account}`;
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


// ---------------------------------------------------------------------------
// Signing in with the Curavo account (instead of scanning a QR)
// ---------------------------------------------------------------------------

export async function loadAccount() {
  try { const s = await SecureStore.getItemAsync(ACCOUNT_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
async function saveAccount(acc) { await SecureStore.setItemAsync(ACCOUNT_KEY, JSON.stringify(acc)); }
export async function clearAccount() { try { await SecureStore.deleteItemAsync(ACCOUNT_KEY); } catch { /* gone */ } }

/** Email + password, the same as on curavo.in. */
export async function signInWithPassword(email, password) {
  const { data } = await call(CLOUD_URL, '/account/v1/login', { method: 'POST', body: { email: email.trim(), password } });
  const acc = { token: data.token, email: data.account?.email || email.trim(), name: data.account?.name || '' };
  await saveAccount(acc);
  return acc;
}

/** "Continue with Google": a code the owner allows on curavo.in, where Google sign-in works. */
export async function startBrowserSignIn() {
  const { data } = await call(CLOUD_URL, '/mobile/v1/sign-in-link', { method: 'POST' });
  return data;   // {code, url, poll, expires_at}
}

/** PENDING / APPROVED (signed in) / REFUSED / EXPIRED / USED. */
export async function checkBrowserSignIn(link) {
  const { data } = await call(CLOUD_URL, `/mobile/v1/sign-in-link/${encodeURIComponent(link.code)}?poll=${encodeURIComponent(link.poll)}`);
  if (data.status === 'APPROVED' && data.token) {
    const acc = { token: data.token, email: data.account?.email || '', name: data.account?.name || '' };
    await saveAccount(acc);
    return { status: 'APPROVED', account: acc };
  }
  return { status: data.status };
}

/** The shop PCs linked to this account. */
export async function myShops(acc) {
  const { data } = await call(CLOUD_URL, '/mobile/v1/my-shops', { account: acc.token });
  return data.shops || [];
}

/** Ask the shop PC to let this phone in.  The PC shows Allow / Refuse with the same check code. */
export async function connectWithAccount(acc, shop, phoneName) {
  const kp = newKeyPair(Crypto.getRandomBytes(32));
  const { data } = await call(CLOUD_URL, '/mobile/v1/connect', {
    method: 'POST', account: acc.token,
    body: { shop_code: shop.shop_code, public_key: kp.publicKey, name: phoneName },
  });
  const link = {
    cloud: CLOUD_URL, shopCode: shop.shop_code, shopName: data.shop_name || shop.shop_name,
    deviceId: data.device_id, token: data.device_token, privateKey: kp.privateKey,
    status: 'PENDING', connectedAt: new Date().toISOString(),
    checkCode: checkCode(kp.publicKey), viaAccount: true,
  };
  await saveLink(link);
  return link;
}
