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
//
// Since 2026-09-15 a link also carries WHERE it lands — the front page, the
// task list, or one coordination — on its own row (migration 070), so the URL
// is only `/d/<22 characters>` instead of ninety characters with a query on
// the end. The owner asked for links that look like links, and a row can say
// "this meeting" as well as a query string could, without putting it in chat.
const crypto = require('node:crypto');
const { ok, err } = require('./results');
const actionLink = require('./action-link');
const flags = require('./flags');
const audit = require('./audit');

// A link is for the person who just asked for it, in the conversation they are
// already in.
const LINK_TTL_MINUTES = 24 * 60;
// Staying signed in IS the feature — this is a phone bookmark, not a bank. The
// idle window is what expires it; the absolute cap exists so a session cannot
// live forever by being touched once a month.
const SESSION_IDLE_DAYS = 30;
const SESSION_MAX_DAYS = 180;

const LINK_PATH = '/d';
const COOKIE = 'olma_dash';

// Links may be live for several things at once: an invite to a coordination
// and, an hour later, the task list after a long dump. Until 2026-09-15 a new
// link deleted every earlier unused one, which was right while a person only
// ever got a link by asking for one — and would have killed the invite's link
// the moment the task link went out. Five is room for a busy day; past it the
// OLDEST unused one goes, never the one just sent.
const MAX_LIVE_LINKS = 5;

// A link token has to survive being pasted into WhatsApp, so nothing a chat
// client might read as punctuation at the end of a sentence: base62, no `-`
// or `_`. 16 random bytes is 128 bits, which is 22 base62 characters — ample
// for a key that opens once and dies within a day. A SESSION id is never
// pasted anywhere and stays 32 bytes of hex.
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const LINK_TOKEN_LEN = 22;
function mintLinkToken() {
  let n = BigInt('0x' + crypto.randomBytes(16).toString('hex'));
  let out = '';
  while (n > 0n) { out = B62[Number(n % 62n)] + out; n /= 62n; }
  return out.padStart(LINK_TOKEN_LEN, '0');
}
const mint = () => crypto.randomBytes(32).toString('hex');
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

const TOKEN_RE = /^[a-f0-9]{64}$/;
// A link is the short shape, or the 64-hex shape every link had until
// 2026-09-15 — kept so a link sent the day of the deploy still opens.
const LINK_TOKEN_RE = /^(?:[A-Za-z0-9]{22}|[a-f0-9]{64})$/;
const TARGETS = new Set(['home', 'tasks', 'meeting']);

// Is this person still IN this coordination, and is it still going on? The
// only meeting a link may land on.
async function inMeeting(client, userId, meetingId) {
  const mid = Number(meetingId);
  if (!Number.isInteger(mid) || mid <= 0) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM meeting_participants p JOIN meetings m ON m.id = p.meeting_id
      WHERE p.meeting_id = $1 AND p.user_id = $2 AND p.state <> 'opted_out'
        AND m.status IN ('negotiating', 'confirmed')`,
    [mid, userId]);
  return Boolean(rows[0]);
}

// ---- links -----------------------------------------------------------------

// Returns the RAW token exactly once; nothing can read it back afterwards.
// `target` is where the link lands; a meeting target needs `meetingId`, and
// the caller has already checked the person is in it (createLinkUrl does).
async function createLink(client, userId, { target = 'home', meetingId = null } = {}) {
  if (!TARGETS.has(target)) return err('invalid', `target must be one of ${[...TARGETS].join('|')}`);
  if (target === 'meeting' && !meetingId) return err('invalid', 'a meeting link needs a meeting');
  const { rows } = await client.query(
    `SELECT id FROM users WHERE id = $1 AND status = 'active' AND is_eval = false`,
    [userId]
  );
  if (!rows[0]) return err('not_found', 'no such active user');
  const token = mintLinkToken();
  // Room for this one: every unused link past the newest MAX-1 goes. Spent
  // and expired rows are left for purgeExpired, which is what they were
  // always left for.
  await client.query(
    `DELETE FROM magic_links WHERE token_hash IN (
       SELECT token_hash FROM magic_links
        WHERE user_id = $1 AND used_at IS NULL
        ORDER BY created_at DESC, token_hash
        OFFSET $2)`,
    [userId, MAX_LIVE_LINKS - 1]);
  await client.query(
    `INSERT INTO magic_links (token_hash, user_id, expires_at, target, meeting_id)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4, $5)`,
    [hash(token), userId, String(LINK_TTL_MINUTES), target, target === 'meeting' ? Number(meetingId) : null]
  );
  return ok({ token, expiresInMinutes: LINK_TTL_MINUTES, target });
}

// Does this link still open something? Read-only, and it does NOT spend the
// link — this is what the GET page asks before drawing its button, so that a
// dead link says so instead of showing a button that fails on press.
async function peekLink(client, token) {
  if (!LINK_TOKEN_RE.test(String(token || ''))) return err('not_found', 'malformed token');
  const { rows } = await client.query(
    `SELECT u.id AS user_id, u.first_name, u.locale, m.target, m.meeting_id
       FROM magic_links m JOIN users u ON u.id = m.user_id
      WHERE m.token_hash = $1 AND m.used_at IS NULL AND m.expires_at > now()
        AND u.status = 'active' AND u.is_eval = false`,
    [hash(token)]
  );
  if (!rows[0]) return err('not_found', 'link is spent, expired, or unknown');
  return ok({
    userId: Number(rows[0].user_id), firstName: rows[0].first_name, locale: rows[0].locale,
    ...(await landing(client, rows[0])),
  });
}

// Where a link lands, asked again at the moment it is used rather than trusted
// from the moment it was minted: somebody who left the coordination since is
// taken to their front page, not to a sheet that no longer has them in it.
async function landing(client, row) {
  const userId = Number(row.user_id);
  if (row.target === 'meeting') {
    return (await inMeeting(client, userId, row.meeting_id))
      ? { target: 'meeting', meetingId: Number(row.meeting_id) }
      : { target: 'home' };
  }
  return { target: row.target === 'tasks' ? 'tasks' : 'home' };
}

// Spend the link and open a session. Returns the RAW session id, once.
async function redeemLink(client, token) {
  if (!LINK_TOKEN_RE.test(String(token || ''))) return err('not_found', 'malformed token');
  // The UPDATE is the whole race guard: `used_at IS NULL` in the WHERE means
  // the second caller updates zero rows and gets nothing back.
  const { rows } = await client.query(
    `UPDATE magic_links SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, target, meeting_id`,
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
  return ok({ sessionId: sid, userId, ...(await landing(client, rows[0])) });
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
      RETURNING s.user_id, u.locale`,
    [hash(sid), String(SESSION_IDLE_DAYS), String(SESSION_MAX_DAYS)]
  );
  if (!rows[0]) return err('not_found', 'no session');
  return ok({ userId: rows[0].user_id, locale: rows[0].locale });
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
//
// A link may name ONE meeting, and then the page opens on it — the tab, the
// sheet, the people, the options — instead of on the front page with the
// coordination three taps away. It is the thing the retired /pick/ page did
// best (one tap from WhatsApp and you are looking at the meeting), kept. Or it
// may name the task list (`view: 'tasks'`). Only a meeting this person is
// still IN is named; anything else is silently a plain link, because a wrong
// number here should open their page, not an error.
//
// A link that names a meeting is the page offered for that meeting, however
// it came to be minted — an invite, the start of one, or the person asking —
// so it writes the same audit row offerDashboardOnce reads. Offering it again
// two options later would be the same link twice.
async function createLinkUrl(client, userId, { meetingId, view } = {}) {
  let target = view === 'tasks' ? 'tasks' : 'home';
  const mid = Number(meetingId);
  const named = await inMeeting(client, userId, mid);
  if (named) target = 'meeting';
  const made = await createLink(client, userId, { target, meetingId: named ? mid : null });
  if (!made.ok) return made;
  if (named) {
    const seen = await client.query(
      `SELECT 1 FROM audit_log WHERE actor_id = $1 AND event = 'meeting.dashboard_offered'
         AND (detail->>'meetingId')::bigint = $2 LIMIT 1`, [userId, mid]);
    if (!seen.rows[0]) await audit.record(client, userId, 'meeting.dashboard_offered', { meetingId: mid });
  }
  const base = String(await flags.getFlag(client, 'public_base_url') || '').replace(/\/$/, '');
  const url = `${base}${LINK_PATH}/${made.data.token}`;
  return ok(actionLink.withLink(url, {
    expiresInMinutes: LINK_TTL_MINUTES,
    ...(named ? { meetingId: mid } : {}),
    ...(target === 'tasks' ? { view: 'tasks' } : {}),
  }));
}

// Was a link to this destination minted for them within `days`? A throttle
// for the links Olma decides to send (a long dump, a long morning list) — it
// counts what was MINTED, not what arrived, and it is only ever used to hold
// back a second offer, never to claim the first one was read.
async function linkMintedWithin(client, userId, target, days) {
  const { rows } = await client.query(
    `SELECT 1 FROM magic_links WHERE user_id = $1 AND target = $2
        AND created_at > now() - ($3 || ' days')::interval LIMIT 1`,
    [userId, target, String(days)]);
  return Boolean(rows[0]);
}

// A link to the task list that Olma DECIDED to send — after a long dump, under
// a long morning list — at most once a week per person, whichever of the two
// asks first. `null` when one went out within the week (or none can be
// minted), so the caller simply adds nothing. Asked on request, the tool
// itself mints without this: a person asking is never throttled.
const TASKS_LINK_EVERY_DAYS = 7;
async function tasksLinkUnlessRecent(client, userId) {
  if (await linkMintedWithin(client, userId, 'tasks', TASKS_LINK_EVERY_DAYS)) return null;
  const made = await createLinkUrl(client, userId, { view: 'tasks' });
  return made.ok ? made.data : null;
}

// The part of the page's address that says where to open. The page reads it
// (openFromHash) and drops it once used.
function destinationFragment({ target, meetingId } = {}) {
  if (target === 'meeting' && Number.isInteger(Number(meetingId)) && Number(meetingId) > 0) {
    return `#meeting=${Number(meetingId)}`;
  }
  return target === 'tasks' ? '#tasks' : '';
}

module.exports = {
  createLink, createLinkUrl, peekLink, redeemLink, linkMintedWithin, destinationFragment, tasksLinkUnlessRecent,
  resolveSession, endSession, endAllSessions, purgeExpired,
  cookieHeader, clearCookieHeader, readCookie,
  LINK_PATH, COOKIE, LINK_TTL_MINUTES, SESSION_IDLE_DAYS, SESSION_MAX_DAYS, MAX_LIVE_LINKS,
  LINK_TOKEN_RE, TASKS_LINK_EVERY_DAYS,
};
