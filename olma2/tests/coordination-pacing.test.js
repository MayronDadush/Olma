'use strict';
// מירון, 2026-09-22 — five messages about one padel coordination in twelve
// minutes, all of them to the man who opened it:
//
//   16:13  the invite
//   16:14  שחרון put שבת 16:00 on the table
//   16:22  יובל cannot do Wednesday
//   16:23  שחרון cannot do Wednesday either
//   16:25  שחרון put שבת 17:00 on the table
//
// The machinery that says several things once already existed — a row about a
// coordination that has not gone out yet swallows the next one — and it never
// ran, because every negotiation row is `urgent` and left inside a minute.
// Kapish's four rows only ever folded because the night was holding them.
//
// So two things, and the owner decided both: a negotiation row waits a quarter
// of an hour after anything about that coordination last REACHED that person,
// and whoever opened a coordination stops getting messages nobody else gets
// ("אין צורך שמי שפתח את התיאום יקבל הודעות מיוחדות"). The result — it died,
// nobody matched — is his alone and still arrives on its own.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const meetings = require('../src/domain/meetings');
const fanout = require('../src/domain/meeting-fanout');
const digest = require('../src/domain/digest');
const opts = meetings.options;

let db, ann, ben, cal;
before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972533100001', { firstName: 'Ann' });
  ben = await makeUser(db.pool, '+972533100002', { firstName: 'Ben' });
  cal = await makeUser(db.pool, '+972533100003', { firstName: 'Cal' });
  const c = await db.pool.connect();
  try {
    for (const [x, y] of [[ann, ben], [ann, cal], [ben, cal]]) {
      const req = await connections.requestConnection(c, x.id, y.phone, {});
      const conn = (await connections.respondToConnection(c, y.id, req.data.connection.id, 'approve')).data.connection;
      await grants.grantFeature(c, x.id, conn.id, 'meetings');
      await grants.grantFeature(c, y.id, conn.id, 'meetings');
    }
  } finally { c.release(); }
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}
const at = (h) => slotStart('', { hours: h });

// The invite is not written by `startMeeting` — `afterStart` is what tells
// everybody else, exactly as the tool and the dashboard both do.
async function trio(c, title) {
  const res = await meetings.startMeeting(c, ann.id, title, [ben.id, cal.id]);
  await fanout.afterStart(c, ann, res, [ben.id, cal.id], title);
  return Number(res.data.meeting.id);
}

// What the worker would find waiting for this person about this coordination.
async function pending(userId, meetingId) {
  const { rows } = await db.pool.query(
    `SELECT id, kind, payload, release_after FROM outbox
      WHERE user_id = $1 AND (payload->>'meetingId')::bigint = $2 AND sent_at IS NULL
      ORDER BY id`, [userId, meetingId]);
  return rows;
}

// Delivery, as the worker performs it: the stamp with no hold_reason is the
// only thing that means "this reached them", here and in the code under test.
async function deliverAll(userId, meetingId) {
  await db.pool.query(
    `UPDATE outbox SET sent_at = now() WHERE user_id = $1 AND (payload->>'meetingId')::bigint = $2
       AND sent_at IS NULL`, [userId, meetingId]);
}

const MINUTES = (a, b) => Math.round((new Date(a) - new Date(b)) / 60_000);

test('the first thing anybody hears about a coordination is not paced', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'padel');
    for (const u of [ben, cal]) {
      const [row] = await pending(u.id, m);
      assert.equal(row.kind, 'meeting_invite');
      assert.equal(row.release_after, null, 'nothing has reached them yet, so nothing to wait behind');
    }
  });
});

test('a time added after the invite REACHED them waits a quarter of an hour', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'padel paced');
    await deliverAll(ben.id, m);
    const sent = (await db.pool.query(
      `SELECT max(sent_at) AS t FROM outbox WHERE user_id = $1 AND (payload->>'meetingId')::bigint = $2`,
      [ben.id, m])).rows[0].t;

    const add = await opts.add(c, ann.id, m, 'A', at(30));
    await fanout.afterOptionAdded(c, ann, m, add);

    const [row] = await pending(ben.id, m);
    assert.equal(row.kind, 'meeting_slot_proposed');
    assert.equal(MINUTES(row.release_after, sent), 15);
  });
});

test('everything that happens while it waits lands in that ONE message', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'padel folded');
    await deliverAll(ben.id, m);

    // Miron's afternoon, in order: a time, another time, a third time. The
    // words are neutral because `options.add` refuses a slot_description whose
    // weekday disagrees with the moment, and the weekday a fixture lands on is
    // a fact about the day the suite runs (rules/testing.md).
    for (const [slot, h] of [['A', 30], ['B', 50], ['C', 55]]) {
      const add = await opts.add(c, ann.id, m, slot, at(h));
      await fanout.afterOptionAdded(c, ann, m, add);
    }
    const rows = await pending(ben.id, m);
    assert.equal(rows.length, 1, 'three times on the table is still one message');
    assert.equal(rows[0].payload.tableChanged, true,
      'and it is about the TABLE, not about whichever slot it happens to name');
    assert.ok(rows[0].release_after, 'still waiting out the quarter hour');
  });
});

test('a message the gate DROPPED buys no quiet — it reached nobody', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'padel dropped');
    await db.pool.query(
      `UPDATE outbox SET sent_at = now(), hold_reason = 'quiet'
        WHERE user_id = $1 AND (payload->>'meetingId')::bigint = $2`, [ben.id, m]);

    const add = await opts.add(c, ann.id, m, 'A', at(30));
    await fanout.afterOptionAdded(c, ann, m, add);

    const rows = await pending(ben.id, m);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].release_after, null, 'the invite he never read cannot be the thing he just heard');
  });
});

test('a plain "no" is no longer a message of its own to whoever opened it', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'padel declined');
    const add = await opts.add(c, ann.id, m, 'A', at(50));
    await fanout.afterOptionAdded(c, ann, m, add);
    await deliverAll(ann.id, m);
    await deliverAll(ben.id, m);
    await deliverAll(cal.id, m);

    const optionId = Number(add.data.option.id);
    const res = await opts.answer(c, ben.id, m, optionId, 'n');
    await fanout.afterSlotResponse(c, ben, m, res, { accept: false });
    assert.deepEqual(await pending(ann.id, m), [],
      'the count on the table says it; a second notification does not');

    // …and the same "no" from the second person is not a second one either.
    const res2 = await opts.answer(c, cal.id, m, optionId, 'n');
    await fanout.afterSlotResponse(c, cal, m, res2, { accept: false });
    assert.deepEqual(await pending(ann.id, m), []);
  });
});

// Until 2026-09-23 "nobody matched" was the one exit that still went to the
// opener on its own. Nobody manages a coordination now, and the owner chose
// that its ending rides the next digest of whoever is left instead
// (digest.closedMeetings) — so the two people leaving make NO message at all.
test('nobody matching is not a message of its own any more — it waits for the digest', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'padel no match');
    await deliverAll(ann.id, m);

    await fanout.afterOptOut(c, ben, m, await meetings.optOut(c, ben.id, m));
    await fanout.afterOptOut(c, cal, m, await meetings.optOut(c, cal.id, m));

    assert.deepEqual(await pending(ann.id, m), [], 'no message about it on its own');
    const d = await digest.assemble(c, ann.id, 'summary');
    assert.deepEqual(d.data.crossUser.closedMeetings.map((x) => [Number(x.id), x.status]), [[Number(m), 'no_match']]);
    assert.match(d.data.hints.closedMeetings, /ONE short clause/);
  });
});

// A coordination whose time passed is said once, in the next digest that
// reaches the people still in it — and not again in the one after.
test('an expired coordination rides the next digest once, and only once', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'padel expired');
    await c.query(
      `UPDATE meetings SET status = 'expired', closed_at = now() - interval '1 minute' WHERE id = $1`, [m]);
    const ids = async (u) => (await digest.assemble(c, u.id, 'summary')).data.crossUser.closedMeetings
      .map((x) => Number(x.id)).filter((x) => x === Number(m));
    for (const u of [ann, ben, cal]) assert.deepEqual(await ids(u), [Number(m)], 'everybody in it, not only the opener');

    await c.query(
      `INSERT INTO outbox (user_id, kind, payload, idempotency_key, sent_at)
       VALUES ($1, 'digest', '{}'::jsonb, $2, now())`, [ben.id, `digest-test:${m}`]);
    assert.deepEqual(await ids(ben), [], 'his digest already carried it');
    assert.deepEqual(await ids(ann), [Number(m)], 'hers has not gone out yet');
  });
});
