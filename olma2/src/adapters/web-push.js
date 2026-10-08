'use strict';
// Web Push, with no dependency: the message encryption of RFC 8291
// (`aes128gcm`, RFC 8188) and the VAPID signature of RFC 8292, on node:crypto
// alone. The project carries two dependencies and each was weighed against
// writing the thing (domain/live-updates.js says the same about RSS); this is
// about a hundred lines, and `encrypt` is pinned byte for byte to the RFC's
// own worked example in tests/web-push.test.js — a round trip through our own
// decryption would pass with a mistake made symmetrically on both sides, and
// every phone would then drop every message without a word.
//
// Nothing here knows about users, kinds or templates (domain/push.js does).
// `send` answers what the push service said and never throws.
const crypto = require('node:crypto');

const RECORD_SIZE = 4096;
const SEND_TIMEOUT_MS = 10_000;
// How long a push service holds a message for a phone that is off. A
// coordination update older than a day has usually been overtaken by the
// next one, and the page says where things stand now anyway.
const DEFAULT_TTL_S = 24 * 3600;
// The VAPID token's lifetime; RFC 8292 caps it at 24 hours, and some
// services refuse anything close to the cap.
const JWT_TTL_S = 12 * 3600;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// RFC 8291 §3.4 and RFC 8188 §2, one record. `asPrivate` and `salt` are
// injectable only so the test can reproduce the RFC's example; production
// draws both fresh for every message.
function encrypt(plaintext, { p256dh, auth }, { asPrivate = null, salt = null } = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('p256dh is not an uncompressed P-256 key');
  if (authSecret.length !== 16) throw new Error('auth secret is not 16 bytes');

  const ecdh = crypto.createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(fromB64u(asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const s = salt ? fromB64u(salt) : crypto.randomBytes(16);

  // HKDF by hand: each expand here wants one block, so it is one HMAC.
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(s, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  // 0x02 marks the last (and only) record; no padding.
  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  if (data.length + 16 > RECORD_SIZE) throw new Error('payload too large for one record');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  s.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// A new signing key, as the two strings domain/push.js stores: the public
// key in the uncompressed form a browser's applicationServerKey takes, and
// the private key as a JWK.
function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(pub.x), fromB64u(pub.y)])),
    privateJwk: JSON.stringify(jwk),
  };
}

// RFC 8292 §2: an ES256 JWT for the push service's origin, plus our public key.
function vapidHeader(endpoint, { publicKey, privateJwk, subject }, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + JWT_TTL_S, sub: subject }));
  const key = crypto.createPrivateKey({ key: JSON.parse(privateJwk), format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

// → { ok: true, status } | { ok: false, status, gone, error }. `gone` is the
// push service saying this address will never work again (404/410), which is
// the one answer that retires a subscription; anything else is transient.
async function send(subscription, payload, vapid, { fetchImpl = fetch, ttl = DEFAULT_TTL_S, urgency = 'normal', topic = null } = {}) {
  let body;
  let authorization;
  try {
    body = encrypt(Buffer.from(JSON.stringify(payload)), subscription);
    authorization = vapidHeader(subscription.endpoint, vapid);
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: `encrypt: ${e.message}` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: String(ttl),
      Urgency: urgency,
      Authorization: authorization,
    };
    // A topic REPLACES an undelivered message with the same one at the push
    // service, so a phone that was off gets the newest line about a
    // coordination rather than a stack of them. base64url, at most 32 chars.
    if (topic) headers.Topic = topic;
    const res = await fetchImpl(subscription.endpoint, { method: 'POST', headers, body, signal: controller.signal });
    const status = res.status;
    if (status >= 200 && status < 300) return { ok: true, status };
    const text = await res.text().catch(() => '');
    return { ok: false, status, gone: status === 404 || status === 410, error: `${status} ${text}`.trim().slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: String((e && e.message) || e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { encrypt, generateVapidKeys, vapidHeader, send, RECORD_SIZE, DEFAULT_TTL_S };
