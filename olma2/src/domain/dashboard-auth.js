'use strict';
// Who is looking at the personal dashboard.
//
// The tables this uses (`magic_links`, `dashboard_sessions`) have been sitting
// in 001-init.sql since the beginning with nothing reading them — the model was
// decided and never wired. It is the right one, and it is deliberately NOT the
// availability picker's: that page puts the whole credential in the URL and
// keeps it valid for a week, which is fine for a single meeting's form and
// wrong for a page that shows a person's entire life. Here the link is a
// one-time key that is exchanged for a session and then dead.
//
// Four rules, each of which is the answer to a specific way this goes wrong:
//
//  - The database never holds a usable credential. Both the link token and the
//    session cookie are stored as sha256 and compared as sha256. The schema
//    only asked for this on the link; a session cookie is the same kind of
//    bearer secret with the same consequence if read, and the same nightly
//    pg_dump carries both — so both are hashed.
//  - A link is spent by an atomic UPDATE, never by read-then-write. Two taps
//    (or a tap racing a retry) resolve to exactly one winner.
//  - **A link is spent by POST, never by GET.** WhatsApp fetches every link it
//    delivers to build a preview, and a single-use link redeemed on GET would
//    be burned by that crawler before the person ever touched it — the message
//    would arrive already expired, reliably, for everybody. So GET only shows a
//    button; pressing it is what spends the key.
//  - A session is checked against the USER on every request, not only at
//    sign-in. Blocking someone, or pausing them, must not leave a live tab.
const crypto = require('node:crypto');
const { ok, err } = require('./results');
const flags = require('./flags');

// A link is for the person who just asked for it, in the conversation they are
// already in. Long enough to walk to a laptop, short enough that a forwarded
// screenshot is worthless by the time anyone acts on it.
const LINK_TTL_MINUTES = 30;
// Staying signed in IS the feature — this is a phone bookmark, not a bank. The
// idle window is what expires it; the absolute cap exists so a session cannot
// live forever by being touched once a month.
const SESSION_IDLE_DAYS = 30;
const SESSION_MAX_DAYS = 180;

const LINK_PATH = '/d';
const COOKIE = 'olma_dash';

// 32 bytes. The link token also has to survive being pasted into WhatsApp, so
// hex rather than base64url — no characters a chat client might treat as
// punctuation at the end of a sentence.
const mint = () => crypto.randomBytes(32).toString('hex');
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

const TOKEN_RE = /^[a-f0-9]{64}$/;

// ---- links -----------------------------------------------------------------

// Returns the RAW token exactly once; nothing can read it back afterwards.
async function createLink(client, userId) {
  const { rows } = await client.query(
    `SELECT id FROM users WHERE id = $1 AND status = 'active' AND is_eval = false`,
    [userId]
  );
  if (!rows[0]) return err('not_found', 'no such active user');
  const token = mint();
  // One live link per person: minting a second one kills the first. A person
  // who asks again is telling you the earlier link did not work for them, and
  // leaving it alive only widens the window on a key nobody is going to use.
  await client.query(
    `DELETE FROM magic_links WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  await client.query(
    `INSERT INTO magic_links (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [hash(token), userId, String(LINK_TTL_MINUTES)]
  );
  return ok({ token, expiresInMinutes: LINK_TTL_MINUTES });
}

// Does this link still open something? Read-only, and it does NOT spend the
// link — this is what the GET page asks before drawing its button, so that a
// dead link says so instead of showing a button that fails on press.
async function peekLink(client, token) {
  if (!TOKEN_RE.test(String(token || ''))) return err('not_found', 'malformed token');
  const { rows } = await client.query(
    `SELECT u.first_name
       FROM magic_links m JOIN users u ON u.id = m.user_id
      WHERE m.token_hash = $1 AND m.used_at IS NULL AND m.expires_at > now()
        AND u.status = 'active' AND u.is_eval = false`,
    [hash(token)]
  );
  if (!rows[0]) return err('not_found', 'link is spent, expired, or unknown');
  return ok({ firstName: rows[0].first_name });
}

// Spend the link and open a session. Returns the RAW session id, once.
async function redeemLink(client, token) {
  if (!TOKEN_RE.test(String(token || ''))) return err('not_found', 'malformed token');
  // The UPDATE is the whole race guard: `used_at IS NULL` in the WHERE means
  // the second caller updates zero rows and gets nothing back.
  const { rows } = await client.query(
    `UPDATE magic_links SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [hash(token)]
  );
  if (!rows[0]) return err('not_found', 'link is spent, expired, or unknown');
  const userId = rows[0].user_id;
  const live = await client.query(
    `SELECT id FROM users WHERE id = $1 AND status = 'active' AND is_eval = false`,
    [userId]
  );
  // The link was minted for an active user and is being spent by one who is
  // not. Burning it anyway is deliberate: the row above is already committed
  // to `used_at`, and a key that survives a refusal is a key worth retrying.
  if (!live.rows[0]) return err('forbidden', 'this account cannot open the dashboard');
  const sid = mint();
  await client.query(
    `INSERT INTO dashboard_sessions (id, user_id) VALUES ($1, $2)`, [hash(sid), userId]);
  return ok({ sessionId: sid, userId });
}

// ---- sessions --------------------------------------------------------------

// Who is this cookie, if anyone. Touches `last_seen_at`, so an active tab keeps
// itself alive and an abandoned one ages out on its own.
async function resolveSession(client, sid) {
  if (!TOKEN_RE.test(String(sid || ''))) return err('not_found', 'no session');
  const { rows } = await client.query(
    `UPDATE dashboard_sessions s SET last_seen_at = now()
       FROM users u
      WHERE s.id = $1 AND u.id = s.user_id
        AND s.last_seen_at > now() - ($2 || ' days')::interval
        AND s.created_at   > now() - ($3 || ' days')::interval
        AND u.status = 'active' AND u.is_eval = false
      RETURNING s.user_id`,
    [hash(sid), String(SESSION_IDLE_DAYS), String(SESSION_MAX_DAYS)]
  );
  if (!rows[0]) return err('not_found', 'no session');
  return ok({ userId: rows[0].user_id });
}

async function endSession(client, sid) {
  if (!TOKEN_RE.test(String(sid || ''))) return ok({ ended: 0 });
  const r = await client.query(`DELETE FROM dashboard_sessions WHERE id = $1`, [hash(sid)]);
  return ok({ ended: r.rowCount });
}

// Every session this person has, everywhere. This is what "התנתק מכל המכשירים"
// calls, and what deprovisioning would call if the ON DELETE CASCADE did not
// already cover it.
async function endAllSessions(client, userId) {
  const r = await client.query(`DELETE FROM dashboard_sessions WHERE user_id = $1`, [userId]);
  return ok({ ended: r.rowCount });
}

// Rows nobody can use any more. Called from the retention sweep, not on a
// timer of its own — an expired row is inert, this is hygiene.
async function purgeExpired(client) {
  const links = await client.query(
    `DELETE FROM magic_links WHERE expires_at < now() - interval '1 day' OR used_at < now() - interval '1 day'`);
  const sessions = await client.query(
    `DELETE FROM dashboard_sessions
      WHERE last_seen_at < now() - ($1 || ' days')::interval
         OR created_at   < now() - ($2 || ' days')::interval`,
    [String(SESSION_IDLE_DAYS), String(SESSION_MAX_DAYS)]
  );
  return ok({ links: links.rowCount, sessions: sessions.rowCount });
}

// ---- cookie ----------------------------------------------------------------

// Secure because the only host this is served on is HTTPS behind Caddy; Lax
// because sign-in arrives as a top-level navigation from WhatsApp and Strict
// would drop the cookie on exactly that hop.
function cookieHeader(sid) {
  return `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_IDLE_DAYS * 86400}`;
}
function clearCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
function readCookie(header) {
  const m = String(header || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})(?:;|$)'));
  return m ? m[1] : null;
}

// The link as a person receives it. Separate from `createLink` because the
// URL needs a flag read and the domain function does not — the same split
// availability.js makes, and for the same reason: one place decides what the
// public host is.
async function createLinkUrl(client, userId) {
  const made = await createLink(client, userId);
  if (!made.ok) return made;
  const base = String(await flags.getFlag(client, 'public_base_url') || '').replace(/\/$/, '');
  return ok({ url: `${base}${LINK_PATH}/${made.data.token}`, expiresInMinutes: LINK_TTL_MINUTES });
}

module.exports = {
  createLink, createLinkUrl, peekLink, redeemLink,
  resolveSession, endSession, endAllSessions, purgeExpired,
  cookieHeader, clearCookieHeader, readCookie,
  LINK_PATH, COOKIE, LINK_TTL_MINUTES, SESSION_IDLE_DAYS, SESSION_MAX_DAYS,
};
