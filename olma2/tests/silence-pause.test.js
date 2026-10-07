'use strict';
// Somebody silent for days is paused on a clock (owner, 2026-10-07). Saar, on
// `daily_once_phones`, last wrote on 2026-10-05 and got a 20:00 message every
// evening that carried nothing: the once-a-day rule drops every check-in, so no
// rung of the ladder ever reached him, `checkin_misses` stayed 0, and the
// ladder's own pause could never come. The clock measures silence from his
// side, and pauses faster when he holds nothing (2 days) than when he holds a
// task (5). The one thing that still reaches him: one message per coordination
// somebody opens with him.
//
// Every moment is pinned (rules/testing.md): the sweep takes `now`, and every
// stamp is written relative to it.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const silence = require('../src/domain/silence-pause');
const pause = require('../src/domain/pause');
const turn = require('../src/domain/turn');
const flags = require('../src/domain/flags');
const { drainOnce } = require('../src/outbox/worker');
const { enqueue } = require('../src/outbox/enqueue');
const { sweepDigests } = require('../src/jobs/sweeps');
const { instructionFor } = require('../src/channels/openclaw');

const TZ = 'Asia/Jerusalem';
const DAY = 86_400_000;
// Wednesday 2026-10-07, 20:00 in Jerusalem — Saar's evening slot.
const NOW = new Date('2026-10-07T17:00:00Z');
const ago = (days) => new Date(NOW.getTime() - days * DAY);
const live = { checkChannels: async () => ({ status: 'live', detail: null, channels: [] }) };

let db;
let n = 0;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });
beforeEach(async () => {
  await db.pool.query('DELETE FROM outbox');
  await db.pool.query(`UPDATE users SET paused_at = now(), paused_reason = 'quiet_ladder' WHERE paused_at IS NULL`);
});

// A person onboarded long ago whose last word was `days` ago.
async function person({ days, holds = false, name = 'Saar' } = {}) {
  n += 1;
  const u = await makeUser(db.pool, `+97250077${String(n).padStart(4, '0')}`, { firstName: name });
  await db.pool.query(
    `UPDATE users SET timezone = $2, onboarded_at = $3, last_inbound_at = $4 WHERE id = $1`,
    [u.id, TZ, ago(30), ago(days)]);
  if (holds) await db.pool.query(`INSERT INTO tasks (owner_id, title) VALUES ($1, 'לקנות חלב')`, [u.id]);
  return u;
}

const sweep = () => withTx(db.pool, (c) => silence.sweep(c, NOW));
const pausedRow = async (id) => (await db.pool.query(
  `SELECT paused_at, paused_reason FROM users WHERE id = $1`, [id])).rows[0];

test('nothing held: two days of silence pauses them, a day and a half does not', async () => {
  const quiet = await person({ days: 2.1 });
  const recent = await person({ days: 1.5 });
  const res = await sweep();
  assert.deepEqual(res.map((r) => r.userId), [Number(quiet.id)]);
  const p = await pausedRow(quiet.id);
  assert.equal(p.paused_reason, 'quiet_ladder', 'the ladder\'s pause: nothing cancelled, their word ends it');
  assert.equal((await pausedRow(recent.id)).paused_at, null);
  const { rows: [a] } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'user.paused'`, [quiet.id]);
  assert.equal(a.detail.note, 'silence_days', 'the trail says it was the clock, not the ladder');
});

test('somebody holding an open task gets five days, not two', async () => {
  const three = await person({ days: 3, holds: true });
  const six = await person({ days: 6, holds: true });
  const res = await sweep();
  assert.deepEqual(res.map((r) => r.userId), [Number(six.id)]);
  assert.equal((await pausedRow(three.id)).paused_at, null);
});

test('a reminder they asked for in words keeps them out of it — a pause would stop it', async () => {
  const u = await person({ days: 10, holds: true });
  const { rows: [t] } = await db.pool.query(`SELECT id FROM tasks WHERE owner_id = $1`, [u.id]);
  await db.pool.query(
    `INSERT INTO task_reminders (task_id, user_id, remind_at, auto) VALUES ($1, $2, $3, false)`,
    [t.id, u.id, new Date(NOW.getTime() + DAY)]);
  assert.deepEqual(await sweep(), []);
});

test('a word in a room, an answer in a coordination, a write from their page and a resume are all signs of life', async () => {
  const page = await person({ days: 9 });
  await db.pool.query(`UPDATE users SET last_dashboard_at = $2 WHERE id = $1`, [page.id, ago(1)]);
  const resumed = await person({ days: 9 });
  await db.pool.query(
    `INSERT INTO audit_log (actor_id, event, created_at) VALUES ($1, 'user.resumed', $2)`, [resumed.id, ago(0.5)]);
  const answered = await person({ days: 9 });
  const { rows: [m] } = await db.pool.query(
    `INSERT INTO meetings (initiator_id, title, status) VALUES ($1, 'קפה', 'negotiating') RETURNING id`, [answered.id]);
  const { rows: [o] } = await db.pool.query(
    `INSERT INTO meeting_options (meeting_id, slot_text, starts_at) VALUES ($1, 'שלישי', $2) RETURNING id`,
    [m.id, new Date(NOW.getTime() + 3 * DAY)]);
  await db.pool.query(
    `INSERT INTO meeting_option_answers (option_id, user_id, answer, answered_at) VALUES ($1, $2, 'y', $3)`,
    [o.id, answered.id, ago(1)]);
  const res = (await sweep()).map((r) => r.userId);
  assert.ok(!res.includes(Number(page.id)), 'their page');
  assert.ok(!res.includes(Number(resumed.id)), 'a resume restarts the clock');
  assert.ok(!res.includes(Number(answered.id)), 'an answer');
});

test('0 turns a half off', async () => {
  await withTx(db.pool, (c) => flags.setFlag(c, 'silence_pause_days_empty', 0));
  try {
    await person({ days: 20 });
    assert.deepEqual(await sweep(), []);
  } finally {
    await withTx(db.pool, (c) => flags.setFlag(c, 'silence_pause_days_empty', 2));
  }
});

test('Saar: on once-a-day, two days silent — paused, and the empty 20:00 message is not written', async () => {
  const saar = await person({ days: 2.1 });
  await withTx(db.pool, (c) => flags.setFlag(c, 'daily_once_phones', saar.phone));
  try {
    await sweep();
    const digests = await withTx(db.pool, (c) => sweepDigests(c, NOW));
    assert.ok(!digests.some((d) => Number(d.userId) === Number(saar.id)));
    const { rows } = await db.pool.query(`SELECT 1 FROM outbox WHERE user_id = $1 AND kind = 'digest'`, [saar.id]);
    assert.equal(rows.length, 0);
  } finally {
    await withTx(db.pool, (c) => flags.setFlag(c, 'daily_once_phones', ''));
  }
});

test('a coordination a person opens with him reaches him once, at once — not held for an evening that never comes', async () => {
  const saar = await person({ days: 3 });
  const asker = await person({ days: 0, name: 'Hod' });
  await withTx(db.pool, (c) => flags.setFlag(c, 'daily_once_phones', saar.phone));
  try {
    await sweep();
    assert.equal((await pausedRow(saar.id)).paused_reason, 'quiet_ladder');
    const { rows: [m] } = await db.pool.query(
      `INSERT INTO meetings (initiator_id, title, status) VALUES ($1, 'פוקר', 'negotiating') RETURNING id`, [asker.id]);
    const put = (key, extra = {}) => withTx(db.pool, (c) => enqueue(c, {
      userId: saar.id, kind: 'meeting_invite', urgency: 'urgent',
      payload: { meetingId: Number(m.id), title: 'פוקר', byName: 'Hod', ...extra }, idempotencyKey: key,
    }));
    await put('inv:1');
    // Noon his time, so the night is not what is being tested.
    const noon = new Date('2026-10-08T09:00:00Z');
    const sent = [];
    await drainOnce(db.pool, async (r) => { sent.push(r); return { ok: true }; }, noon, live);
    const mine = sent.filter((r) => Number(r.user_id) === Number(saar.id));
    assert.equal(mine.length, 1, 'one message about it');
    assert.equal(mine[0].payload.pausedNotice, true);
    assert.match(instructionFor(mine[0]), /PAUSED/);
    assert.match(instructionFor(mine[0]), /somebody asked to meet them/);

    // Anything more about the same coordination is dropped, not held.
    await put('inv:2', { tableChanged: true });
    const later = [];
    await drainOnce(db.pool, async (r) => { later.push(r); return { ok: true }; }, noon, live);
    assert.equal(later.filter((r) => Number(r.user_id) === Number(saar.id)).length, 0);
    const { rows: [r2] } = await db.pool.query(
      `SELECT hold_reason FROM outbox WHERE idempotency_key = 'inv:2'`);
    assert.equal(r2.hold_reason, 'paused');
  } finally {
    await withTx(db.pool, (c) => flags.setFlag(c, 'daily_once_phones', ''));
  }
});

test('his first message ends it', async () => {
  const u = await person({ days: 4 });
  await sweep();
  assert.ok((await pausedRow(u.id)).paused_at);
  await withTx(db.pool, (c) => turn.openRecord(c, u, { wake: true }));
  assert.equal(await withTx(db.pool, (c) => pause.isPaused(c, u.id)), false);
});
