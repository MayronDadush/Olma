'use strict';
// Notifications to the installed app (domain/push.js, owner 2026-10-08).
// Push replaces WhatsApp for a coordination row only when the flag covers the
// person, they subscribed from the app, the app confirmed it within 14 days,
// the kind is one the page answers whole, and a push service accepted it.
// Everything else — and every failure — is WhatsApp, in the same tick.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-push-'));
process.env.OLMA_ENC_KEY_PATH = path.join(TMP, 'enc-key');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const webPush = require('../src/adapters/web-push');
const push = require('../src/domain/push');
const flags = require('../src/domain/flags');
const meetings = require('../src/domain/meetings');
const connections = require('../src/domain/connections');
const { enqueue } = require('../src/outbox/enqueue');
const { drainOnce } = require('../src/outbox/worker');

// ---- the wire format, against the RFC's own example -------------------------

test('encrypt reproduces RFC 8291 §5 byte for byte', () => {
  const body = webPush.encrypt(Buffer.from('When I grow up, I want to be a watermelon'), {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, { asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', salt: 'DGv6ra1nlYgDCS1FRnbzlw' });
  assert.equal(body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('the VAPID header is an ES256 token for the push service origin, signed by our key', () => {
  const keys = webPush.generateVapidKeys();
  const h = webPush.vapidHeader('https://fcm.googleapis.com/fcm/send/abc', { ...keys, subject: 'https://allma.world' }, 1_700_000_000_000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  assert.ok(m, h);
  assert.equal(m[4], keys.publicKey);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'https://allma.world');
  assert.ok(claims.exp - 1_700_000_000 <= 24 * 3600);
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
});

test('send answers what the push service said, and never throws', async () => {
  const sub = browserSubscription('https://fcm.googleapis.com/fcm/send/x');
  const keys = { ...webPush.generateVapidKeys(), subject: 'https://allma.world' };
  const seen = [];
  const fake = (status) => async (url, init) => { seen.push(init.headers); return { status, text: async () => 'nope' }; };
  assert.deepEqual(await webPush.send(sub, { a: 1 }, keys, { fetchImpl: fake(201) }), { ok: true, status: 201 });
  assert.equal((await webPush.send(sub, { a: 1 }, keys, { fetchImpl: fake(410) })).gone, true);
  assert.equal((await webPush.send(sub, { a: 1 }, keys, { fetchImpl: fake(500) })).gone, false);
  const thrown = await webPush.send(sub, { a: 1 }, keys, { fetchImpl: async () => { throw new Error('net'); } });
  assert.equal(thrown.ok, false);
  assert.equal(seen[0]['Content-Encoding'], 'aes128gcm');
});

// A real browser-shaped subscription: a P-256 key and a 16-byte secret.
function browserSubscription(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}

// ---- who the server will ever POST to ---------------------------------------

test('only a push service is an endpoint', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/a', 'https://web.push.apple.com/QK',
    'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=1']) {
    assert.equal(push.endpointOk(ok), true, ok);
  }
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x',
    'https://127.0.0.1/x', 'https://u:p@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', '', null, 'x'.repeat(2000)]) {
    assert.equal(push.endpointOk(bad), false, String(bad));
  }
});

// ---- which rows may go as a notification ------------------------------------

test('only a row the page answers whole is pushable', () => {
  const p = { meetingId: 5, title: 'פוקר', byName: 'Ann', slot: 'שלישי 20:00' };
  const k = (kind, extra = {}) => push.templateFor({ kind }, { ...p, ...extra });
  assert.equal(k('meeting_invite'), 'push_meeting_invite');
  assert.equal(k('meeting_invite', { groupSubject: 'פחם' }), 'push_meeting_invite_group');
  assert.equal(k('meeting_invite', { groupSubject: 'פחם', askedItYourself: true }), null);
  assert.equal(k('meeting_invite', { pausedNotice: true }), null);
  assert.equal(k('meeting_slot_proposed'), 'push_meeting_slot_proposed');
  assert.equal(k('meeting_slot_proposed', { tableChanged: true }), 'push_meeting_table');
  assert.equal(k('meeting_slot_proposed', { fits: 'אחרי 20' }), null, 'a question only a turn asks');
  assert.equal(k('meeting_slot_proposed', { reasons: ['חם בצהריים'] }), null, 'somebody\'s reason is relayed by a turn');
  assert.equal(k('meeting_slot_proposed', { removedOptions: [{ slot: 'x' }] }), null, 'a time taken off rides the next turn');
  assert.equal(k('meeting_confirmed', { calendarRole: 'invitee' }), 'push_meeting_confirmed');
  for (const role of ['organiser', 'solo', 'none', undefined]) {
    assert.equal(k('meeting_confirmed', { calendarRole: role }), null, `the turn makes or offers the event (${role})`);
  }
  assert.equal(k('meeting_confirmed', { calendarRole: 'invitee', settledWithoutYou: true }), null);
  assert.equal(k('meeting_confirmed', { calendarRole: 'invitee', askExactTime: true }), null);
  assert.equal(k('meeting_cancelled', { calendarCleanup: 'self' }), null);
  assert.equal(k('meeting_cancelled', { calendarCleanup: 'auto' }), 'push_meeting_cancelled');
  assert.equal(k('meeting_time_set', { calendarRole: 'solo' }), null);
  assert.equal(k('meeting_time_set', { calendarRole: 'organiser', calendarUpdated: false }), null);
  assert.equal(k('meeting_time_set', { moved: true }), 'push_meeting_time_moved');
  assert.equal(k('meeting_reopened'), null);
  assert.equal(k('meeting_exact_time_ask'), null);
  assert.equal(k('digest'), null);
  assert.equal(push.templateFor({ kind: 'meeting_invite' }, { title: 'x' }), null, 'no meeting, no page to open');
});

test('the notification is the title, one fixed line, and the coordination\'s page', () => {
  const n = push.notificationFor({ kind: 'meeting_slot_proposed', locale: 'he', timezone: 'Asia/Jerusalem' },
    { meetingId: 7, title: 'פאדל', byName: 'Ann', slot: 'שלישי 20:00' }, {});
  assert.deepEqual(n, { title: 'פאדל', body: 'זמן חדש על השולחן: שלישי 20:00. מתאים לך?', url: '/me#meeting=7', tag: 'meeting-7' });
  const en = push.notificationFor({ kind: 'meeting_invite', locale: 'en', timezone: 'Asia/Jerusalem' },
    { meetingId: 7, title: 'Padel', byName: 'Ann' }, {});
  assert.equal(en.url, '/me#meeting=7');
  assert.doesNotMatch(en.body, /[֐-׿]/, 'an English reader gets the English line');
});

test('the reader\'s own clock rides beside the proposer\'s words', () => {
  const n = push.notificationFor({ kind: 'meeting_slot_proposed', locale: 'he', timezone: 'America/New_York' },
    { meetingId: 7, title: 'פאדל', slot: 'יום שלישי 6.10 20:00', startsAtUtc: '2026-10-06T17:00:00Z', authorTz: 'Asia/Jerusalem' }, {});
  assert.match(n.body, /יום שלישי 6\.10 20:00 \(.+: 13:00\)/);
});

// ---- the database half, and the worker -------------------------------------

let db, ann, ben, meetingId;
before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972509500001', { firstName: 'Ann' });
  ben = await makeUser(db.pool, '+972509500002', { firstName: 'Ben' });
  await withTx(db.pool, async (c) => {
    const req = await connections.requestConnection(c, ann.id, ben.phone, {});
    await connections.respondToConnection(c, ben.id, req.data.connection.id, 'approve');
  });
  const m = (await withTx(db.pool, (c) => meetings.startMeeting(c, ann.id, 'פאדל', [ben.id]))).data.meeting;
  meetingId = Number(m.id);
  // Whatever the start queued is not what these tests are about.
  await db.pool.query(`UPDATE outbox SET hold_reason = 'cancelled', sent_at = now() WHERE sent_at IS NULL`);
});
after(async () => { if (db) await db.teardown(); push.resetCache(); });

const setFlag = (v) => withTx(db.pool, (c) => flags.setFlag(c, push.FLAG, v));
const BEN_SUB = browserSubscription('https://fcm.googleapis.com/fcm/send/ben-phone');
const asBrowser = (s) => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });

test('subscribing is refused unless the flag covers them, and the page is offered nothing', async () => {
  await setFlag('');
  const r = await withTx(db.pool, (c) => push.subscribe(c, ben.id, { subscription: asBrowser(BEN_SUB) }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'forbidden');
  assert.equal(await withTx(db.pool, (c) => push.pageState(c, ben.id)), null);
});

test('subscribing with the flag on stores one row per device, and refuses a bad one', async () => {
  await setFlag(ben.phone);
  const state = await withTx(db.pool, (c) => push.pageState(c, ben.id));
  assert.equal(Buffer.from(state.key, 'base64url').length, 65);
  const bad = await withTx(db.pool, (c) => push.subscribe(c, ben.id, { subscription: { endpoint: 'https://evil.example/x', keys: asBrowser(BEN_SUB).keys } }));
  assert.equal(bad.ok, false);
  for (let i = 0; i < 2; i++) {
    const r = await withTx(db.pool, (c) => push.subscribe(c, ben.id, { subscription: asBrowser(BEN_SUB) }));
    assert.equal(r.ok, true);
  }
  const { rows } = await db.pool.query('SELECT user_id FROM push_subscriptions');
  assert.equal(rows.length, 1);
  const { rows: au } = await db.pool.query(`SELECT detail FROM audit_log WHERE event = 'push.subscribed'`);
  assert.equal(JSON.stringify(au).includes('ben-phone'), false, 'the address itself is never audited');
});

// Inside everybody's daytime and on no quiet day, whenever the suite runs.
const GATE_NOW = new Date('2026-08-16T09:00:00Z');
const live = { checkChannels: async () => ({ status: 'live', detail: null, channels: [] }) };
let n = 0;
async function queueProposal(extra = {}) {
  await db.pool.query(`UPDATE outbox SET hold_reason = 'cancelled', sent_at = now() WHERE sent_at IS NULL`);
  await withTx(db.pool, (c) => enqueue(c, {
    userId: ben.id, kind: 'meeting_slot_proposed', urgency: 'urgent', idempotencyKey: `push-test:${++n}`,
    payload: { meetingId, title: 'פאדל', byName: 'Ann', slot: 'שלישי 20:00', ...extra },
  }));
}
// Fresh "the app was opened" for Ben's subscription, as of the drain's clock.
const seenAt = (when) => db.pool.query('UPDATE push_subscriptions SET last_seen_at = $1, revoked_at = NULL, revoked_reason = NULL', [when]);
function recorder() {
  const sent = [];
  return { sent, deliver: async (r) => { sent.push(r); return { ok: true }; } };
}
function pushes(status = 201) {
  const calls = [];
  return { calls, send: async (sub, payload) => { calls.push({ sub, payload }); return status < 300 ? { ok: true, status } : { ok: false, status, gone: status === 404 || status === 410, error: String(status) }; } };
}
async function drain(pushSend) {
  const rec = recorder();
  await drainOnce(db.pool, rec.deliver, GATE_NOW, { ...live, webPushSend: pushSend.send });
  const { rows } = await db.pool.query(`SELECT sent_at, payload FROM outbox WHERE idempotency_key = $1`, [`push-test:${n}`]);
  return { whatsapp: rec.sent, row: rows[0] };
}

test('a live subscription carries the row INSTEAD of WhatsApp', async () => {
  await seenAt(new Date(GATE_NOW.getTime() - 3600_000));
  await queueProposal();
  const p = pushes();
  const out = await drain(p);
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].payload.url, `/me#meeting=${meetingId}`);
  assert.equal(out.whatsapp.length, 0, 'never both');
  assert.ok(out.row.sent_at);
  assert.equal(out.row.payload.deliveredBy, 'push');
});

test('a push service that refuses sends it on WhatsApp in the same tick', async () => {
  await seenAt(new Date(GATE_NOW.getTime() - 3600_000));
  await queueProposal();
  const out = await drain(pushes(500));
  assert.equal(out.whatsapp.length, 1);
  assert.ok(out.row.sent_at);
  assert.equal(out.row.payload.deliveredBy, undefined);
  const { rows } = await db.pool.query(`SELECT 1 FROM audit_log WHERE event = 'push.fell_back'`);
  assert.ok(rows.length >= 1);
});

test('a subscription the push service says is gone is retired, and WhatsApp carries the row', async () => {
  await seenAt(new Date(GATE_NOW.getTime() - 3600_000));
  await queueProposal();
  const out = await drain(pushes(410));
  assert.equal(out.whatsapp.length, 1);
  const { rows } = await db.pool.query('SELECT revoked_reason FROM push_subscriptions');
  assert.equal(rows[0].revoked_reason, 'gone');
});

test('an app not opened for more than 14 days carries nothing', async () => {
  await seenAt(new Date(GATE_NOW.getTime() - 15 * 86_400_000));
  await queueProposal();
  const p = pushes();
  const out = await drain(p);
  assert.equal(p.calls.length, 0);
  assert.equal(out.whatsapp.length, 1);
});

test('the flag turned off sends everything to WhatsApp, subscription or not', async () => {
  await seenAt(new Date(GATE_NOW.getTime() - 3600_000));
  await setFlag('');
  await queueProposal();
  const p = pushes();
  const out = await drain(p);
  assert.equal(p.calls.length, 0);
  assert.equal(out.whatsapp.length, 1);
  await setFlag(ben.phone);
});

test('a kind the turn has work in stays on WhatsApp', async () => {
  await seenAt(new Date(GATE_NOW.getTime() - 3600_000));
  await queueProposal({ fits: 'אחרי 20' });
  const p = pushes();
  const out = await drain(p);
  assert.equal(p.calls.length, 0);
  assert.equal(out.whatsapp.length, 1);
});

test('turning it off on the phone stops it at once', async () => {
  await seenAt(new Date(GATE_NOW.getTime() - 3600_000));
  await withTx(db.pool, (c) => push.unsubscribe(c, ben.id, { endpoint: BEN_SUB.endpoint }));
  assert.deepEqual(await withTx(db.pool, (c) => push.liveSubscriptions(c, ben.id, GATE_NOW)), []);
  const seen = await withTx(db.pool, (c) => push.seen(c, ben.id, { endpoint: BEN_SUB.endpoint }));
  assert.equal(seen.data.on, false, 'the app is told the server no longer holds it');
});
