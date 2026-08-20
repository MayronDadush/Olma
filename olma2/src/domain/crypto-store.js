'use strict';
// Encryption for third-party credentials at rest.
//
// A user hands Olma a token that can read — and sometimes write — their real
// Google Calendar. That must not sit in the database in plaintext: a nightly
// pg_dump, a backup copy, or a dashboard bug would otherwise expose every
// connected account at once. AES-256-GCM gives tamper detection too, so a
// modified ciphertext fails loudly rather than yielding garbage we might then
// send to Google.
//
// The key lives outside the DB in a root-only file, so possessing the database
// alone is not enough. Reused from v1 (`/opt/olma/.enc-key`) on purpose: the
// one real v1 calendar connection stays decryptable, so it can be restored
// without asking that person to reconnect.
const crypto = require('node:crypto');
const fs = require('node:fs');

const KEY_PATH = process.env.OLMA_ENC_KEY_PATH || '/opt/olma/.enc-key';

// brokerd is long-lived, so the key is read once and held. (v1 re-read it on
// every call only because it was a fresh process per turn.)
let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  if (!fs.existsSync(KEY_PATH)) {
    // Generating on first use keeps a fresh environment (a test box, a new
    // deploy) working without a manual setup step. 0600 from birth.
    const key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_PATH, key.toString('base64'), { mode: 0o600 });
    cachedKey = key;
    return key;
  }
  const key = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('encryption key is malformed (expected 32 bytes)');
  cachedKey = key;
  return key;
}

// Version prefix so the key can ever be rotated: a reader can tell which
// scheme produced a blob instead of guessing from its shape. v1's bare
// iv.tag.ct triple had no room for that, and adding it later would have meant
// re-encrypting every row blind.
const VERSION = 'v1';

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

// Returns null rather than throwing on anything malformed. A single unreadable
// row must degrade to "this connection is broken, reconnect" — not to an
// uncaught throw that turns every call into an opaque internal error.
function decrypt(blob) {
  try {
    const parts = String(blob).split('.');
    // v1-format blobs (iv.tag.ct, no version tag) are still readable, so
    // credentials written by the old system survive the port.
    const [ivB64, tagB64, dataB64] = parts.length === 4 ? parts.slice(1) : parts;
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt, KEY_PATH };
