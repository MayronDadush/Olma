'use strict';
// The intro video (domain/intro-video.js): who is queued, what the gate lets
// through, which clip each person gets, and what the statistics count.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { decide } = require('../src/outbox/gate');
const { drainOnce } = require('../src/outbox/worker');
const intro = require('../src/domain/intro-video');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// A Wednesday noon UTC: inside the default window, and nobody's quiet day.
function wednesdayNoon() {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() - 3 + 7) % 7));
  at.setUTCHours(12, 0, 0, 0);
  return at;
}

async function served(phone, extra = {}) {
  const u = await makeUser(db.pool, phone, extra);
  await db.pool.query(`UPDATE users SET status = 'active', onboarded_at = now() WHERE id = $1`, [u.id]);
  return u;
}

test('the clip follows the locale, and anything not Hebrew gets English', () => {
  assert.equal(intro.fileFor('v2', 'he'), 'v2-he.mp4');
  assert.equal(intro.fileFor('v2', 'he-IL'), 'v2-he.mp4');
  assert.equal(intro.fileFor('v2', 'en'), 'v2-en.mp4');
  assert.equal(intro.fileFor('v2', null), 'v2-en.mp4');
  assert.equal(intro.fileFor('v2', 'ru'), 'v2-en.mp4');
  assert.equal(intro.fileFor('nope', 'he'), null);
});

test('both shipped clips exist, and staging copies into the workspace and refreshes a stale copy', () => {
  for (const f of Object.values(intro.VIDEOS.v2)) {
    assert.ok(fs.statSync(path.join(__dirname, '..', 'assets', 'intro', f)).size > 10_000, f);
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-intro-'));
  try {
    const dest = intro.stageMedia('v2-he.mp4', { home });
    assert.equal(dest, path.join(home, 'workspace', 'outbox-media', 'intro', 'v2-he.mp4'));
    fs.writeFileSync(dest, 'stale');
    intro.stageMedia('v2-he.mp4', { home });
    assert.ok(fs.statSync(dest).size > 10_000, 'a copy of a different size is replaced');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the gate: paused drops, stopped-answering passes, the night holds, the budget does not', () => {
  const now = wednesdayNoon();
  const row = { kind: 'intro_video', urgency: 'urgent', payload: { video: 'v2' } };
  const base = { row, plan: 'free', window: { start: '09:00', end: '21:00' }, tz: 'UTC', sentToday: 0, budget: 4, now, quietDays: [] };
  assert.equal(decide({ ...base, paused: true }).action, 'drop');
  assert.equal(decide({ ...base, checkinMisses: 2 }).action, 'deliver', 'the owner chose to reach them');
  assert.equal(decide({ ...base, checkinMisses: 2, row: { ...row, kind: 'travel' } }).action, 'drop',
    'the exemption is this kind only');
  const night = new Date(now); night.setUTCHours(2);
  assert.equal(decide({ ...base, now: night }).holdReason, 'night');
  assert.equal(decide({ ...base, sentToday: 9 }).action, 'deliver');
  assert.equal(decide({ ...base, introductionPending: true }).holdReason, 'awaiting_introduction');
  assert.equal(decide({ ...base, pendingUser: true }).action, 'drop');
});

test('enqueue reaches the served and not the paused, the pending or the eval user, once', async () => {
  const he = await served('+972500000101', { locale: 'he' });
  const en = await served('+15550000102', { locale: 'en' });
  const paused = await served('+972500000103', { locale: 'he' });
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [paused.id]);
  const pending = await makeUser(db.pool, '+972500000104', { status: 'pending' });
  const evalU = await served('+972500000105');
  await db.pool.query(`UPDATE users SET is_eval = true WHERE id = $1`, [evalU.id]);

  const a = await withTx(db.pool, (c) => intro.audience(c));
  const first = await withTx(db.pool, (c) => intro.enqueueAll(c, 'v2'));
  const again = await withTx(db.pool, (c) => intro.enqueueAll(c, 'v2'));
  const { rows } = await db.pool.query(`SELECT user_id FROM outbox WHERE kind = 'intro_video'`);
  const ids = rows.map((r) => Number(r.user_id));
  assert.ok(ids.includes(Number(he.id)) && ids.includes(Number(en.id)));
  for (const u of [paused, pending, evalU]) assert.ok(!ids.includes(Number(u.id)));
  assert.equal(first.queued, a.eligible);
  assert.equal(again.queued, 0, 'idempotent per person per clip');
  await assert.rejects(withTx(db.pool, (c) => intro.enqueueAll(c, 'v9')));
});

test('delivery hands the worker each row with its locale, and the stats count what happened after', async () => {
  const at = wednesdayNoon();
  // Only this file's rows, and every intro row due now.
  await db.pool.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL AND kind <> 'intro_video'`);
  await db.pool.query(`UPDATE outbox SET created_at = $1::timestamptz - interval '1 minute' WHERE kind = 'intro_video'`, [at]);
  const got = [];
  await drainOnce(db.pool, async (r) => { got.push({ user: Number(r.user_id), locale: r.locale, kind: r.kind }); return { ok: true }; }, at);
  const mine = got.filter((g) => g.kind === 'intro_video');
  assert.ok(mine.length >= 2);
  assert.ok(mine.some((g) => g.locale === 'he') && mine.some((g) => g.locale === 'en'));

  // Pin the stamps so the windows are exact: one wrote after 10 minutes, one
  // after 3 hours, the rest said nothing for two days.
  const { rows } = await db.pool.query(
    `SELECT user_id FROM outbox WHERE kind = 'intro_video' AND hold_reason IS NULL ORDER BY user_id`);
  const sent = new Date(Date.now() - 48 * 3_600_000);
  await db.pool.query(`UPDATE outbox SET sent_at = $1 WHERE kind = 'intro_video' AND hold_reason IS NULL`, [sent]);
  const [quick, slow] = rows.map((r) => r.user_id);
  const wrote = (uid, minutes) => db.pool.query(
    `INSERT INTO audit_log (actor_id, event, created_at) VALUES ($1, 'message.received', $2)`,
    [uid, new Date(sent.getTime() + minutes * 60_000)]);
  // A message BEFORE the video is not a reply to it.
  await db.pool.query(`INSERT INTO audit_log (actor_id, event, created_at) VALUES ($1, 'message.received', $2)`,
    [quick, new Date(sent.getTime() - 60_000)]);
  await wrote(quick, 10);
  await wrote(slow, 180);

  const s = await withTx(db.pool, (c) => intro.stats(c, 'v2'));
  assert.equal(s.delivered, rows.length);
  assert.equal(s.repliedWithin30m, 1);
  assert.equal(s.repliedWithin24h, 2);
  assert.equal(s.ignored24h, rows.length - 2);
  assert.equal(s.tooEarlyToTell, 0);
  assert.equal(s.watched, null, 'unknown, never zero');
});

test('a tick sends at most two videos, and they wait behind anything else due', async () => {
  const at = wednesdayNoon();
  await db.pool.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
  const users = [];
  for (let i = 0; i < 4; i++) users.push(await served(`+97250000020${i}`, { locale: 'he' }));
  await withTx(db.pool, (c) => intro.enqueueAll(c, 'v2'));
  // Queued AFTER the videos, so only the ordering can put it first.
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency) VALUES ($1, 'travel', '{}', 'normal')`, [users[0].id]);
  await db.pool.query(`UPDATE outbox SET created_at = $1::timestamptz - interval '1 minute' WHERE kind = 'intro_video' AND sent_at IS NULL`, [at]);
  const order = [];
  await drainOnce(db.pool, async (r) => { order.push(r.kind); return { ok: true }; }, at);
  assert.equal(order[0], 'travel');
  assert.equal(order.filter((k) => k === 'intro_video').length, 2);
});
