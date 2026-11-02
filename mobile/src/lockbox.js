/**
 * The phone's half of the owner-app lock (the PC's half is
 * backend/app/services/owner_app.py - the two must match byte for byte).
 *
 *   key pair      X25519; the private half is made on this phone and never
 *                 leaves it (kept in the phone's secure storage)
 *   pairing proof HMAC-SHA256(secret from the QR, "curavo-pair-v1:<pub>:<id>")
 *   unlock        X25519(my private, PC's throw-away key) -> HKDF-SHA256
 *                 -> ChaCha20-Poly1305 opens the data key -> which opens the
 *                 summary
 *
 * Plain JavaScript (no React) so backend/scripts/test_owner_app.py can run it
 * with Node and prove the phone really opens what the PC locks.
 */
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { chacha20poly1305 } from '@noble/ciphers/chacha';

const SUMMARY_AAD = utf8('curavo-owner-v1');
const WRAP_INFO = utf8('curavo-owner-wrap-v1');
const PAIR_CONTEXT = 'curavo-pair-v1';

// UTF-8 by hand: not every phone's JavaScript engine has TextEncoder/Decoder.
export function utf8(str) {
  const out = [];
  for (const ch of str) {
    let c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}
export function fromUtf8(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let c, n;
    if (b < 0x80) { c = b; n = 1; }
    else if (b < 0xe0) { c = b & 31; n = 2; }
    else if (b < 0xf0) { c = b & 15; n = 3; }
    else { c = b & 7; n = 4; }
    for (let k = 1; k < n; k++) c = (c << 6) | (bytes[i + k] & 63);
    s += String.fromCodePoint(c);
    i += n;
  }
  return s;
}

// Base64 written out by hand: phones differ in whether atob/Buffer exist.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toB64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
      + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=')
      + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}
export function fromB64(s) {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let bits = 0, acc = 0, j = 0;
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; out[j++] = (acc >> bits) & 255; }
  }
  return out.slice(0, j);
}
function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * A new key pair for this phone: {privateKey, publicKey} as base64.
 * `random32` = 32 random bytes from the phone's secure generator (the app
 * passes expo-crypto's); left out (Node, in the guard test) the library's own.
 */
export function newKeyPair(random32) {
  const priv = random32 && random32.length === 32 ? Uint8Array.from(random32) : x25519.utils.randomPrivateKey();
  return { privateKey: toB64(priv), publicKey: toB64(x25519.getPublicKey(priv)) };
}

/** Proves to the shop PC that this phone really scanned its QR code. */
export function pairingProof(secretB64, publicKeyB64, pairingId) {
  return hex(hmac(sha256, fromB64(secretB64), utf8(`${PAIR_CONTEXT}:${publicKeyB64}:${pairingId}`)));
}

/**
 * Open a summary.  `locked` = {nonce, ct, wrap:{epk, nonce, ct}} as the cloud
 * hands it to this phone.  Throws if it was not locked for this phone or was
 * tampered with.
 */
export function unlockSummary(locked, deviceId, privateKeyB64) {
  const priv = fromB64(privateKeyB64);
  const pub = x25519.getPublicKey(priv);
  const epk = fromB64(locked.wrap.epk);
  const shared = x25519.getSharedSecret(priv, epk);
  const kek = hkdf(sha256, shared, undefined, concat(WRAP_INFO, epk, pub), 32);
  const dataKey = chacha20poly1305(kek, fromB64(locked.wrap.nonce), utf8(deviceId)).decrypt(fromB64(locked.wrap.ct));
  const body = chacha20poly1305(dataKey, fromB64(locked.nonce), SUMMARY_AAD).decrypt(fromB64(locked.ct));
  return JSON.parse(fromUtf8(body));
}
