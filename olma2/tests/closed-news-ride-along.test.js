'use strict';
// A coordination that ends with no time is never a message of its own
// (owner, 2026-09-23). It rides the next digest — and, since 2026-09-24, also
// whatever Olma composes for that person before it ("כדרך אגב"). Said ONCE
// between the two: the worker writes `closedNews` onto the row only after the
// send confirmed, and `digest.unheardClosedMeetings` is both readers' query.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const meetings = require('../src/domain/meetings');
const connections = require('../src/domain/connections');
const digest = require('../src/domain/digest');
const { enqueue } = require('../src/outbox/enqueue');
const { drainOnce } = require('../src/outbox/worker');
const openclaw = require('../src/channels/openclaw');

let db, ann, ben, closedId;
before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972509400001', { firstName: 'Ann' });
  ben = await makeUser(db.pool, '+972509400002', { firstName: 'Ben' });
  await withTx(db.pool, async (c) => {
    const req = await connections.requestConnection(c, ann.id, ben.phone, {});
    await connections.respondToConnection(c, ben.id, req.data.connection.id, 'approve');
  });
  const m = (await withTx(db.pool, (c) => meetings.startMeeting(c, ann.id, 'פאדל', [ben.id]))).data.meeting;
  closedId = Number(m.id);
  await db.pool.query(
    `UPDATE meetings SET status = 'expired', closed_at = now() - interval '1 minute' WHERE id = $1`, [closedId]);
});
after(async () => { if (db) await db.teardown(); });

// Inside everybody's daytime and on no quiet day, whenever the suite runs.
const GATE_NOW = new Date('2026-08-16T09:00:00Z');
const live = { checkChannels: async () => ({ status: 'live', detail: null, channels: [] }) };

function recorder(result = { ok: true }) {
  const sent = [];
  return { sent, deliver: async (r) => { sent.push(r); return result; } };
}
let n = 0;
const queue = (userId, kind, payload, urgency = 'urgent') => withTx(db.pool, (c) => enqueue(c, {
  userId, kind, urgency, payload, idempotencyKey: `closed-news:${++n}`,
}));
const unheard = async (u) => (await withTx(db.pool, (c) => digest.unheardClosedMeetings(c, u.id))).map((m) => m.id);

test('a reminder never carries it — the raw pipe is the person\'s own words', async () => {
  await queue(ben.id, 'reminder', { title: 'לקנות חלב', rung: 1, auto: false });
  const rec = recorder();
  await drainOnce(db.pool, rec.deliver, GATE_NOW, live);
  assert.equal(rec.sent.length, 1);
  assert.equal(rec.sent[0].payload.closedNews, undefined);
  assert.deepEqual(await unheard(ben), [closedId], 'still unheard');
});

test('a send that failed records nothing — the news is still owed', async () => {
  await queue(ben.id, 'connection_approved', { byName: 'Ann' });
  const rec = recorder({ ok: false, error: 'boom' });
  await drainOnce(db.pool, rec.deliver, GATE_NOW, live);
  assert.deepEqual(rec.sent[0].payload.closedNews.map((m) => m.id), [closedId], 'it was offered to the model');
  assert.deepEqual(await unheard(ben), [closedId], 'but a failed send told nobody');
  await db.pool.query(`UPDATE outbox SET hold_reason = 'cancelled', sent_at = now() WHERE user_id = $1 AND sent_at IS NULL`, [ben.id]);
});

test('the next composed message carries it, once, and the digest then does not repeat it', async () => {
  await queue(ben.id, 'connection_approved', { byName: 'Ann' });
  const rec = recorder();
  await drainOnce(db.pool, rec.deliver, GATE_NOW, live);
  const row = rec.sent[0];
  assert.deepEqual(row.payload.closedNews.map((m) => [m.id, m.title, m.status]), [[closedId, 'פאדל', 'expired']]);
  const text = openclaw.instructionFor(row);
  assert.match(text, /<<<פאדל>>>/);
  assert.match(text, /ONE short clause/);
  assert.match(text, /never a separate message/);

  assert.deepEqual(await unheard(ben), [], 'told — and the stored row is what says so');
  const d = await withTx(db.pool, (c) => digest.assemble(c, ben.id, 'summary'));
  assert.deepEqual(d.data.crossUser.closedMeetings, [], 'his digest does not say it a second time');
  assert.equal(d.data.hints, undefined);
  assert.deepEqual(await unheard(ann), [closedId], 'somebody else in it has still not heard');

  await queue(ben.id, 'connection_approved', { byName: 'Ann' });
  const again = recorder();
  await drainOnce(db.pool, again.deliver, GATE_NOW, live);
  assert.equal(again.sent[0].payload.closedNews, undefined, 'the message after that says nothing about it');
});

test('a digest going out carries it itself, so nothing else is added to it', async () => {
  await queue(ann.id, 'digest', { scope: 'summary' }, 'normal');
  const rec = recorder();
  await drainOnce(db.pool, rec.deliver, GATE_NOW, live);
  assert.equal(rec.sent.length, 1);
  assert.equal(rec.sent[0].payload.closedNews, undefined);
  assert.doesNotMatch(openclaw.instructionFor(rec.sent[0]), /ended with no time found/);
  assert.deepEqual(await unheard(ann), [], 'the digest that went out is what told her');
});
