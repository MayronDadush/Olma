'use strict';
// Notifications to the installed app (owner, 2026-10-08).
//
// For somebody who turned them on from INSIDE the home-screen app, a
// coordination message the page can answer goes out as a notification
// INSTEAD of a WhatsApp turn — never as well, because the same thing twice is
// what the delivery rules forbid (rules/delivering.md, "The same thing does
// not go out twice"). The gate still decides WHEN, exactly as before: quiet
// hours, the coordination cap, the fold. This only changes HOW the row that
// the gate let through reaches them (outbox/worker.js).
//
// Most people have no app, so the one failure this must never have is a
// message taken away from somebody who will not see it (owner, the same
// message: "שלא בטעות אנשים לא יקבלו התראות על דברים"). A row goes as a
// notification only when ALL of these hold, and to WhatsApp otherwise:
//   - the `push_delivery_phones` flag covers them (off until the owner sets it);
//   - they turned it on themselves, from the installed app (`subscribe`);
//   - the app CONFIRMED that subscription within `LIVE_DAYS` (`seen`, on
//     every open) — an app deleted from the phone stops confirming, and they
//     drift back to WhatsApp on their own;
//   - the kind is one the page answers whole (`pushable`): a confirmation
//     that makes a calendar event in the turn, a reopening that offers to
//     remove one, a row carrying news a notification would drop (a time taken
//     off the table, somebody's reason) — all stay on WhatsApp;
//   - a push service ACCEPTED it. A refusal is a WhatsApp send in the same
//     tick, never a retry later.
const { ok, err } = require('./results');
const flags = require('./flags');
const audit = require('./audit');
const crypto = require('./crypto-store');
const templates = require('./message-templates');
const meetingTime = require('./meeting-time');
const { coveredBy } = require('./turn');
const webPush = require('../adapters/web-push');

const FLAG = 'push_delivery_phones';
// How recently the installed app must have confirmed a subscription for it to
// carry a message. Two weeks without opening the app is somebody who reads
// WhatsApp, and that is where the message goes.
const LIVE_DAYS = 14;
// Push services only. The endpoint is a URL the BROWSER hands us and we then
// POST to from the server, so an open list is a way to make the server call
// any address somebody types into a request (`/me/act` is a session, not a
// trust boundary). These four are every browser that can install the page.
const PUSH_HOSTS = [
  (h) => h === 'fcm.googleapis.com',                      // Chrome, Edge on Android, Samsung
  (h) => h === 'web.push.apple.com' || h.endsWith('.push.apple.com'), // Safari, iOS 16.4+
  (h) => h === 'updates.push.services.mozilla.com',       // Firefox
  (h) => h.endsWith('.notify.windows.com'),               // Edge on Windows
];
const MAX_ENDPOINT = 1024;
const VAPID_SUBJECT = process.env.OLMA_VAPID_SUBJECT || 'https://allma.world';

function endpointOk(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > MAX_ENDPOINT) return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  return PUSH_HOSTS.some((f) => f(u.hostname));
}

const B64U = /^[A-Za-z0-9_-]+={0,2}$/;
function keysOk(keys) {
  if (!keys || typeof keys !== 'object') return false;
  const { p256dh, auth } = keys;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !B64U.test(p256dh) || !B64U.test(auth)) return false;
  return Buffer.from(p256dh, 'base64url').length === 65 && Buffer.from(auth, 'base64url').length === 16;
}

// ---- the server's signing key ------------------------------------------------
// Made on first use by whichever process asks first (the dashboard serving the
// public half, or brokerd signing), and the race between them settled by the
// row's own primary key. Held per process once read.
let cached = null;
async function vapid(client) {
  if (cached) return cached;
  const read = () => client.query('SELECT public_key, private_enc FROM push_vapid WHERE id = 1');
  let { rows } = await read();
  if (!rows.length) {
    const made = webPush.generateVapidKeys();
    await client.query(
      `INSERT INTO push_vapid (id, public_key, private_enc) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`,
      [made.publicKey, crypto.encrypt(made.privateJwk)]);
    ({ rows } = await read());
  }
  const privateJwk = crypto.decrypt(rows[0].private_enc);
  // Unreadable is not "make a new one": that would strand every subscription
  // on file. It is an error the caller turns into "send it on WhatsApp".
  if (!privateJwk) throw new Error('push_vapid private key could not be decrypted');
  cached = { publicKey: rows[0].public_key, privateJwk, subject: VAPID_SUBJECT };
  return cached;
}
function resetCache() { cached = null; }

async function enabledFor(client, phone) {
  return coveredBy(await flags.getFlag(client, FLAG), phone);
}

// What /me/data carries for the switch: nothing at all unless the flag covers
// them, so the page draws no switch for somebody it would do nothing for.
async function pageState(client, userId) {
  const { rows } = await client.query('SELECT phone FROM users WHERE id = $1', [userId]);
  if (!rows.length || !(await enabledFor(client, rows[0].phone))) return null;
  const key = (await vapid(client)).publicKey;
  return { key, liveDays: LIVE_DAYS };
}

// ---- the three things the app says -------------------------------------------
async function subscribe(client, userId, payload) {
  const sub = payload && payload.subscription;
  if (!sub || !endpointOk(sub.endpoint) || !keysOk(sub.keys)) return err('invalid', 'not a push subscription');
  const { rows } = await client.query('SELECT phone FROM users WHERE id = $1', [userId]);
  if (!rows.length || !(await enabledFor(client, rows[0].phone))) return err('forbidden', 'notifications are not on for this number');
  // Keyed on the endpoint: the same phone subscribing again is the same row,
  // and a row another account made on this phone moves to whoever is signed
  // in now — one install, one person, never two people's coordinations.
  await client.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
           last_seen_at = now(), revoked_at = NULL, revoked_reason = NULL`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth]);
  // The host only: the endpoint itself is an address that can be written to.
  await audit.record(client, userId, 'push.subscribed', { host: new URL(sub.endpoint).hostname });
  return ok({ on: true });
}

// The app, on every open while notifications are on. This is what keeps a
// subscription carrying messages; it is never a write the person made, so it
// stamps nothing on `users` (user-dashboard-write.perform would).
async function seen(client, userId, payload) {
  const endpoint = payload && payload.endpoint;
  if (!endpointOk(endpoint)) return ok({ on: false });
  const { rowCount } = await client.query(
    `UPDATE push_subscriptions SET last_seen_at = now()
      WHERE user_id = $1 AND endpoint = $2 AND revoked_at IS NULL`, [userId, endpoint]);
  return ok({ on: rowCount > 0 });
}

// The switch turned off, or the app finding its permission gone.
async function unsubscribe(client, userId, payload) {
  const endpoint = payload && payload.endpoint;
  const reason = payload && payload.reason === 'permission' ? 'permission' : 'user';
  if (!endpointOk(endpoint)) return ok({ on: false });
  const { rowCount } = await client.query(
    `UPDATE push_subscriptions SET revoked_at = now(), revoked_reason = $3
      WHERE user_id = $1 AND endpoint = $2 AND revoked_at IS NULL`, [userId, endpoint, reason]);
  if (rowCount) await audit.record(client, userId, 'push.unsubscribed', { reason });
  return ok({ on: false });
}

const ACTIONS = { pushSubscribe: subscribe, pushSeen: seen, pushOff: unsubscribe };

async function liveSubscriptions(client, userId, now = new Date()) {
  const { rows } = await client.query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions
      WHERE user_id = $1 AND revoked_at IS NULL
        AND last_seen_at > $2::timestamptz - make_interval(days => $3)
      ORDER BY last_seen_at DESC`, [userId, now, LIVE_DAYS]);
  return rows;
}

// ---- which rows, and what they say ------------------------------------------
function hasAny(list) {
  return Array.isArray(list) && list.some((x) => (typeof x === 'string' ? x.trim() : x));
}

// The template a row goes out under, or null when it must stay on WhatsApp.
// Read every branch as "is there anything the turn would DO or SAY that a
// fixed line and the page cannot?" — and when unsure, the answer is WhatsApp.
function templateFor(row, p) {
  if (!p || !Number.isInteger(Number(p.meetingId)) || Number(p.meetingId) <= 0) return null;
  // News a notification would drop: a time taken off the table rides the next
  // message (rules/reminders-and-tasks.md), a reason is somebody's words the
  // turn relays, and a time that fits what they said earlier is a question
  // only a turn asks.
  // An exact-hour question and a paused person's notice are sentences only a
  // turn says.
  if (hasAny(p.removedOptions) || hasAny(p.reasons) || p.fits || p.instruction
    || p.askExactTime || p.pausedNotice) return null;
  switch (row.kind) {
    // The person who asked the ROOM is asked something narrower ("any OTHER
    // time?"), which no fixed line says.
    case 'meeting_invite':
      if (p.askedItYourself) return null;
      return p.groupSubject ? 'push_meeting_invite_group' : 'push_meeting_invite';
    case 'meeting_slot_proposed': return p.tableChanged ? 'push_meeting_table' : 'push_meeting_slot_proposed';
    case 'meeting_nudge': return 'push_meeting_nudge';
    case 'meeting_auto_answered': return 'push_meeting_auto_answered';
    case 'meeting_answer_moved': return 'push_meeting_answer_moved';
    case 'meeting_slot_declined': return 'push_meeting_slot_declined';
    case 'meeting_opt_out': return 'push_meeting_opt_out';
    case 'meeting_no_match': return 'push_meeting_no_match';
    case 'meeting_rejoined': return 'push_meeting_rejoined';
    case 'meeting_withdrawn': return 'push_meeting_withdrawn';
    case 'meeting_expired': return 'push_meeting_expired';
    // The turn moves the event on THEIR calendar for a solo meeting, and
    // says the shared one could not be moved when it failed.
    case 'meeting_time_set':
      if (p.calendarRole === 'solo') return null;
      if ((p.calendarRole === 'organiser' || p.calendarRole === 'invitee') && !p.calendarUpdated) return null;
      return p.moved ? 'push_meeting_time_moved' : 'push_meeting_time_set';
    // 'self' is the turn offering to delete the event from their calendar.
    case 'meeting_cancelled': return p.calendarCleanup === 'self' ? null : 'push_meeting_cancelled';
    // Only an invitee: Google sends them the invitation, and the turn does
    // nothing but say so. The organiser's turn MAKES the shared event, a solo
    // or unknown role makes or offers one, somebody settled without their yes
    // is asked whether they can make it, and a late joiner is asked to join.
    case 'meeting_confirmed':
      return p.calendarRole === 'invitee' && !p.settledWithoutYou && !p.joinedLate ? 'push_meeting_confirmed' : null;
    // meeting_reopened (calendar cleanup, a numbered table), and
    // meeting_exact_time_ask (a question with no page control): WhatsApp.
    default: return null;
  }
}

function pushable(row, p) {
  return templateFor(row, p) !== null;
}

function momentOf(p) {
  return { startsAt: p.startsAtUtc || p.startsAt || null, slot: p.slot, allDay: p.allDay, daypart: p.daypart };
}

// The proposer's words, with "מחר" made true on the day it goes out, and the
// reader's own clock beside it when theirs differs — the same two steps every
// private surface takes (channels/openclaw.js `withFreshSlot`, `yourTimeClause`).
function slotFor(p, readerTz) {
  if (typeof p.slot !== 'string' || !p.slot.trim()) return '';
  const slot = meetingTime.freshDayWords(p.slot, momentOf(p), p.authorTz || readerTz);
  const local = meetingTime.readerSlot(momentOf(p), readerTz, p.authorTz);
  return local ? `${slot} (${local.city}: ${local.short})` : slot;
}

// → { title, body, url, tag } or null. The title is the coordination's own
// name, which is a person's words — a notification renders text, never markup,
// so nothing in it can do more than read oddly.
function notificationFor(row, p, overrides) {
  const base = templateFor(row, p);
  if (!base) return null;
  const en = String(row.locale || '').toLowerCase().startsWith('en');
  const key = templates.keyFor(base, row.locale, { fallback: 'he' });
  const body = templates.render(key, {
    by: p.byName || '', group: p.groupSubject || '', slot: slotFor(p, row.timezone), from: p.from || '',
  }, overrides).replace(/\s+/g, ' ').trim();
  const title = String(p.title || '').trim().slice(0, 80) || (en ? 'Allma' : 'עולמה');
  const id = Number(p.meetingId);
  return { title, body, url: `/me#meeting=${id}`, tag: `meeting-${id}` };
}

// Sends one row to every live subscription of its person.
// → { ok, sent, gone, failed, error? } — `ok` when at least one push service
// accepted it. Never throws: anything unexpected is a WhatsApp send instead.
async function deliver(client, row, { overrides = null, now = new Date(), send = webPush.send } = {}) {
  const p = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) || {};
  const out = { ok: false, sent: 0, gone: 0, failed: 0 };
  try {
    const note = notificationFor(row, p, overrides || await templates.load(client));
    if (!note) return { ...out, error: 'not pushable' };
    const subs = await liveSubscriptions(client, row.user_id, now);
    if (!subs.length) return { ...out, error: 'no live subscription' };
    const keys = await vapid(client);
    for (const s of subs) {
      const res = await send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, note, keys,
        { topic: note.tag.replace(/[^A-Za-z0-9_-]/g, '') });
      if (res.ok) {
        out.sent++;
        await client.query('UPDATE push_subscriptions SET last_sent_at = $2 WHERE id = $1', [s.id, now]);
      } else if (res.gone) {
        out.gone++;
        await client.query(
          `UPDATE push_subscriptions SET revoked_at = $2, revoked_reason = 'gone' WHERE id = $1 AND revoked_at IS NULL`,
          [s.id, now]);
      } else {
        out.failed++;
        out.error = res.error;
      }
    }
    out.ok = out.sent > 0;
    return out;
  } catch (e) {
    return { ...out, error: String((e && e.message) || e).slice(0, 200) };
  }
}

module.exports = {
  FLAG, LIVE_DAYS, ACTIONS, endpointOk, keysOk, vapid, resetCache, enabledFor, pageState,
  subscribe, seen, unsubscribe, liveSubscriptions, templateFor, pushable, notificationFor, deliver,
};
