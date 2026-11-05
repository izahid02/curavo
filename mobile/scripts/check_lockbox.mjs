// Used by backend/scripts/test_owner_app.py and test_phone_connect.py: run the PHONE's code on what the
// PC produced.  Input (JSON file): {mode, ...}; prints a JSON result.
import { readFileSync } from 'node:fs';
import { checkCode, newKeyPair, pairingProof, unlockSummary } from '../src/lockbox.js';

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let out;
if (job.mode === 'keypair') out = newKeyPair();
else if (job.mode === 'check') out = { code: checkCode(job.public_key) };
else if (job.mode === 'proof') out = { proof: pairingProof(job.secret, job.public_key, job.pairing_id) };
else if (job.mode === 'unlock') {
  try { out = { ok: true, summary: unlockSummary(job.locked, job.device_id, job.private_key) }; }
  catch (e) { out = { ok: false, error: String(e && e.message || e) }; }
}
process.stdout.write(JSON.stringify(out));
