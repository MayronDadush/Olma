'use strict';
// The two real requests this check exists for, and the ways it must stay quiet.
//
// Yahav, 2026-09-05: "תזכיר לי בבקשה מחר ב19:00" → reminder 119 armed 18:00.
// Miron, 2026-09-06: "תזכיר לי עוד שעתיים לדבר עם מור חן" → 129 armed 12:29,
// two hours after 11:29 being 13:29. The first was found by the onboarding
// review three hours in; the second was found by a person reading a
// conversation by hand, six hours late, because Miron is not a new user and
// the review only ever looked at new users' first hours.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { checkPromises, momentsAsked } = require('../src/domain/reminder-promise');

const TZ = 'Asia/Jerusalem';
const user = { id: 1, timezone: TZ };

// ---- reading the ask --------------------------------------------------------

test('a clock time is read the way people write it, with or without minutes', () => {
  const at = Date.parse('2026-09-05T18:00:00Z');
  assert.ok(momentsAsked('תזכיר לי מחר ב19:00', at, TZ).has('19:00'));
  assert.ok(momentsAsked('תזכיר לי ב-7', at, TZ).has('07:00'));
  assert.ok(momentsAsked('תזכיר לי בשעה 8', at, TZ).has('08:00'));
  // two acceptable answers, not one — a check that picked one would invent a fault
  const both = momentsAsked('תזכיר לי ב-7:00 או ב-8:00', at, TZ);
  assert.deepEqual([...both].sort(), ['07:00', '08:00']);
});

test('a relative ask is read against the moment they wrote it', () => {
  // 11:29 Jerusalem
  const at = Date.parse('2026-09-06T08:29:21Z');
  assert.ok(momentsAsked('תזכיר לי עוד שעתיים לדבר עם מור חן', at, TZ).has('13:29'));
  assert.ok(momentsAsked('תזכיר לי עוד שעה', at, TZ).has('12:29'));
  assert.ok(momentsAsked('תזכיר לי בעוד חצי שעה', at, TZ).has('11:59'));
  assert.ok(momentsAsked('תזכיר לי עוד 3 שעות', at, TZ).has('14:29'));
  assert.ok(momentsAsked('remind me in 2 hours', at, TZ).has('13:29'));
  // "עוד שעה וחצי" must not be read as the bare "עוד שעה" sitting inside it
  assert.ok(momentsAsked('תזכיר לי עוד שעה וחצי', at, TZ).has('12:59'));
});

test('a message with no moment in it asks for nothing this check can hold', () => {
  const at = Date.parse('2026-09-06T08:29:21Z');
  assert.equal(momentsAsked('תזכיר לי לקנות חלב', at, TZ).size, 0);
});

// ---- the two real faults ----------------------------------------------------

test("Yahav: he named 19:00 and 18:00 was armed", () => {
  const found = checkPromises({
    user,
    inbound: [{ at: '2026-09-05T18:56:00Z', text: 'תזכיר לי בבקשה מחר ב19:00, להתקשר למלי' }],
    reminders: [{
      id: 119, createdAt: '2026-09-05T18:56:12Z',
      remindAt: '2026-09-06T15:00:00Z',            // 18:00 local
    }],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'asked_hour_not_armed');
  assert.deepEqual(found[0].asked, ['19:00']);
  assert.deepEqual(found[0].armed, [{ id: 119, at: '18:00' }]);
});

test("Miron: he said 'in two hours' and an hour was armed", () => {
  const found = checkPromises({
    user,
    inbound: [{ at: '2026-09-06T08:29:21Z', text: 'משימת עבודה - תזכיר לי עוד שעתיים לדבר עם מור חן' }],
    reminders: [{
      id: 129, createdAt: '2026-09-06T08:29:28Z',
      remindAt: '2026-09-06T09:29:00Z',            // 12:29 local; he meant 13:29
    }],
  });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].asked, ['13:29']);
  assert.deepEqual(found[0].armed, [{ id: 129, at: '12:29' }]);
});

// ---- and the ways it must stay quiet ---------------------------------------

test('the hour they asked for is the hour armed — silence', () => {
  assert.deepEqual(checkPromises({
    user,
    inbound: [{ at: '2026-09-05T18:56:00Z', text: 'תזכיר לי מחר ב-11:30 לדבר עם אבא' }],
    reminders: [{ id: 118, createdAt: '2026-09-05T18:56:16Z', remindAt: '2026-09-06T08:30:00Z' }],
  }), []);
});

test('nothing was armed at all, so there is nothing to compare — never a guess', () => {
  // Three different stories end here (a request misread, a task saved without
  // one, a question asked back) and only one is a fault. Reporting would be
  // inventing which.
  assert.deepEqual(checkPromises({
    user,
    inbound: [{ at: '2026-09-05T18:56:00Z', text: 'תזכיר לי מחר ב-19:00' }],
    reminders: [],
  }), []);
});

test('a reminder armed long after the message is answering something else', () => {
  assert.deepEqual(checkPromises({
    user,
    inbound: [{ at: '2026-09-05T18:56:00Z', text: 'תזכיר לי מחר ב-19:00' }],
    reminders: [{ id: 5, createdAt: '2026-09-05T19:40:00Z', remindAt: '2026-09-06T05:00:00Z' }],
  }), [], 'forty minutes later is a different conversation');
});

test('a cancelled reminder was still the right answer when it was given', () => {
  assert.deepEqual(checkPromises({
    user,
    inbound: [{ at: '2026-09-05T18:56:00Z', text: 'תזכיר לי מחר ב-19:00' }],
    reminders: [{
      id: 6, createdAt: '2026-09-05T18:56:10Z', remindAt: '2026-09-06T16:00:00Z',
      cancelledAt: '2026-09-05T20:00:00Z',
    }],
  }), []);
});

test('a sentence that merely mentions an hour is not an instruction', () => {
  // The exact ambiguity this check refuses to judge — and the reason it reads
  // THEIR message rather than Olma's.
  assert.deepEqual(checkPromises({
    user,
    inbound: [{ at: '2026-09-05T18:56:00Z', text: 'הפגישה מחר ב-19:00' }],
    reminders: [{ id: 7, createdAt: '2026-09-05T18:56:10Z', remindAt: '2026-09-06T15:00:00Z' }],
  }), []);
});

test('one of several armed moments matching is enough', () => {
  assert.deepEqual(checkPromises({
    user,
    inbound: [{ at: '2026-09-05T18:56:00Z', text: 'תזכיר לי ב-19:00' }],
    reminders: [
      { id: 8, createdAt: '2026-09-05T18:56:05Z', remindAt: '2026-09-06T15:00:00Z' },  // 18:00
      { id: 9, createdAt: '2026-09-05T18:56:06Z', remindAt: '2026-09-06T16:00:00Z' },  // 19:00 ✓
    ],
  }), []);
});

test('the zone is theirs, not the servers', () => {
  const found = checkPromises({
    user: { id: 3, timezone: 'Asia/Nicosia' },
    inbound: [{ at: '2026-09-06T08:29:21Z', text: 'תזכיר לי עוד שעתיים' }],
    reminders: [{ id: 129, createdAt: '2026-09-06T08:29:28Z', remindAt: '2026-09-06T09:29:00Z' }],
  });
  assert.deepEqual(found[0].asked, ['13:29'], 'Nicosia is +03:00 in September, same as Jerusalem');
});

// ---- the sweep, against a real database ------------------------------------
//
// Miron's morning replayed through the whole job: his message, his reminder
// row, and the issue the operator ends up reading. Six hours passed between
// this happening and a person noticing it by hand; this is the test that says
// it will not take six hours again.
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const job = require('../src/jobs/promise-watch');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

async function armed(pool, userId, { title, createdAt, remindAt }) {
  const t = await pool.query(
    `INSERT INTO tasks (owner_id, title, source, created_at) VALUES ($1, $2, 'chat', $3) RETURNING id`,
    [userId, title, createdAt]);
  await pool.query(
    `INSERT INTO task_reminders (task_id, remind_at, auto, created_at) VALUES ($1, $2, true, $3)`,
    [t.rows[0].id, remindAt, createdAt]);
  return t.rows[0].id;
}

test('the sweep files one issue for the wrong hour, and never a second for the same one', async () => {
  const now = Date.now();
  const u = await makeUser(db.pool, '+972526269826', { firstName: 'מירון', timezone: 'Asia/Nicosia' });
  await db.pool.query(`UPDATE users SET agent_id = 'u-' || id WHERE id = $1`, [u.id]);

  const askedAt = new Date(now - 4 * 3600_000);            // four hours ago
  await armed(db.pool, u.id, {
    title: 'לדבר עם מור חן',
    createdAt: new Date(askedAt.getTime() + 7_000),        // armed seven seconds later
    remindAt: new Date(askedAt.getTime() + 3600_000),      // an hour out; he said two
  });

  const deps = {
    now,
    readMessages: () => [
      { role: 'user', at: askedAt.toISOString(), text: 'משימת עבודה - תזכיר לי עוד שעתיים לדבר עם מור חן' },
    ],
  };

  const first = await withTx(db.pool, (c) => job.sweepPromiseWatch(c, deps));
  assert.equal(first.filed, 1);
  assert.equal(first.found.length, 1);

  const { rows } = await db.pool.query(
    `SELECT title, detail, category, source, related_entity_type, status FROM issues WHERE reporter_id = $1`,
    [u.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'bug');
  assert.equal(rows[0].source, 'agent_detected');
  assert.equal(rows[0].related_entity_type, 'task_reminder');
  assert.match(rows[0].title, /מירון/);
  assert.match(rows[0].detail, /"asked"/);

  // The window overlaps by two hours on purpose, so the same day is read
  // twice — and the title is the dedup key that makes that free.
  const second = await withTx(db.pool, (c) => job.sweepPromiseWatch(c, deps));
  assert.equal(second.found.length, 1, 'still found');
  assert.equal(second.filed, 0, 'and not filed again');
  const { rows: after } = await db.pool.query(
    `SELECT count(*)::int AS n FROM issues WHERE reporter_id = $1`, [u.id]);
  assert.equal(after[0].n, 1);
});

test('the right hour armed files nothing, and costs no transcript read', async () => {
  const now = Date.now();
  const u = await makeUser(db.pool, '+972526269827', { firstName: 'שקט', timezone: 'Asia/Jerusalem' });
  await db.pool.query(`UPDATE users SET agent_id = 'u-' || id WHERE id = $1`, [u.id]);

  const askedAt = new Date(now - 3 * 3600_000);
  await armed(db.pool, u.id, {
    title: 'להתקשר לאבא',
    createdAt: new Date(askedAt.getTime() + 5_000),
    remindAt: new Date(askedAt.getTime() + 2 * 3600_000),   // exactly what he asked for
  });

  const res = await withTx(db.pool, (c) => job.sweepPromiseWatch(c, {
    now,
    readMessages: () => [
      { role: 'user', at: askedAt.toISOString(), text: 'תזכיר לי עוד שעתיים להתקשר לאבא' },
    ],
  }));
  assert.deepEqual(res.found.filter((f) => f.userId === u.id), []);
  const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM issues WHERE reporter_id = $1`, [u.id]);
  assert.equal(rows[0].n, 0);
});

test('a person who armed nothing yesterday is never read at all', async () => {
  const now = Date.now();
  const u = await makeUser(db.pool, '+972526269828', { firstName: 'שותק', timezone: 'Asia/Jerusalem' });
  await db.pool.query(`UPDATE users SET agent_id = 'u-' || id WHERE id = $1`, [u.id]);
  let reads = 0;
  await withTx(db.pool, (c) => job.sweepPromiseWatch(c, {
    now,
    readMessages: (agentId) => { if (agentId === `u-${u.id}`) reads++; return []; },
  }));
  assert.equal(reads, 0, 'the transcript read is the cost, and it is skipped');
});

test('a transcript that cannot be read is counted, never scored as a clean day', async () => {
  const now = Date.now();
  const u = await makeUser(db.pool, '+972526269829', { firstName: 'אטום', timezone: 'Asia/Jerusalem' });
  await db.pool.query(`UPDATE users SET agent_id = 'u-' || id WHERE id = $1`, [u.id]);
  await armed(db.pool, u.id, {
    title: 'משהו', createdAt: new Date(now - 3600_000), remindAt: new Date(now + 3600_000),
  });
  const res = await withTx(db.pool, (c) => job.sweepPromiseWatch(c, {
    now,
    readMessages: (agentId) => { if (agentId === `u-${u.id}`) throw new Error('sqlite is busy'); return []; },
  }));
  assert.ok(res.unreadable >= 1, 'could-not-read is its own answer (CLAUDE.md)');
});

test('the eval account never reaches the operator issue list', async () => {
  const now = Date.now();
  const u = await makeUser(db.pool, '+972526269830', { firstName: 'eval', timezone: 'Asia/Jerusalem' });
  await db.pool.query(`UPDATE users SET agent_id = 'u-' || id, is_eval = true WHERE id = $1`, [u.id]);
  const askedAt = new Date(now - 2 * 3600_000);
  await armed(db.pool, u.id, {
    title: 'x', createdAt: new Date(askedAt.getTime() + 5_000), remindAt: new Date(askedAt.getTime() + 3600_000),
  });
  const res = await withTx(db.pool, (c) => job.sweepPromiseWatch(c, {
    now,
    readMessages: () => [{ role: 'user', at: askedAt.toISOString(), text: 'תזכיר לי עוד שעתיים' }],
  }));
  assert.deepEqual(res.found.filter((f) => f.userId === u.id), [], 'not even read');
});

// ---- the copy that describes all this ---------------------------------------

// The dashboard hint said "three hours... once per person" for a day after the
// day stage shipped, while the row directly beneath it already read "אחרי 3
// שעות" as a column value: the page contradicted itself, and nothing could
// notice, because the sentence and the behaviour live in different files with
// nothing between them. Same guard as the doctrine's, for the same reason.
test('the section hint names as many stages as the job actually runs', () => {
  const { SECTIONS } = require('../src/adapters/http/admin/sections');
  const onboardingJob = require('../src/jobs/onboarding-review');
  const s = SECTIONS.find((x) => x.id === 'onboarding');
  assert.ok(s, 'the section still exists');
  assert.equal(onboardingJob.STAGES.length, 2, 'if this changes, the hint below has to');
  assert.match(s.hint, /פעמיים/, 'the hint says how many reads there are');
  assert.match(s.hint, /שלוש שעות/);
  assert.match(s.hint, /היום הראשון/);
  assert.doesNotMatch(s.hint, /פעם אחת לכל אדם/, 'the sentence the day stage made untrue');
  // And it points at where an ESTABLISHED user is watched instead, which is
  // the gap that let Miron's 12:29 sit unseen for six hours.
  assert.match(s.hint, /promise_watch/);
});

// ── The hour in the title, against the hour that will fire ───────────────────
// The other half of "is the moment we stored the moment they meant", asked of
// the task instead of the reminder. Maya's three work shifts are the founding
// case: a perfectly well-formed instant three hours from what she said, which
// `hasOffset` cannot refuse and nothing else was looking at.
test('a title naming an hour the row does not carry is filed once, and only while it can still fire', async () => {
  const now = Date.now();
  const u = await makeUser(db.pool, '+972526269831', { firstName: 'מאיה', timezone: 'Asia/Jerusalem' });
  await db.pool.query(`UPDATE users SET agent_id = 'u-' || id WHERE id = $1`, [u.id]);

  // Her real row, replayed: the title says 16:00 and the instant is 16:00Z,
  // which is 19:00 in Jerusalem. Dated ahead so it is still actionable.
  const day = new Date(now + 3 * 24 * 3600_000).toISOString().slice(0, 10);
  const bad = await db.pool.query(
    `INSERT INTO tasks (owner_id, title, source, due_at)
     VALUES ($1, $2, 'brain_dump', $3::timestamptz) RETURNING id`,
    [u.id, 'משמרת עבודה - יום ראשון 16:00-22:00', `${day}T16:00:00+00:00`]);
  const badId = Number(bad.rows[0].id);

  // Beside it, the same shape written CORRECTLY — 16:00 Jerusalem. Nothing to
  // say about this one, and a rule that reported it would report every task.
  await db.pool.query(
    `INSERT INTO tasks (owner_id, title, source, due_at)
     VALUES ($1, $2, 'brain_dump', $3::timestamptz)`,
    [u.id, 'משמרת עבודה - יום שני 16:00-22:00', `${day}T16:00:00+03:00`]);

  const deps = { now, readMessages: () => [] };
  const first = await withTx(db.pool, (c) => job.sweepPromiseWatch(c, deps));
  assert.equal(first.statedHour, 1, 'the wrong one, and only the wrong one');
  assert.equal(first.filed, 1);

  const { rows } = await db.pool.query(
    `SELECT title, detail, related_entity_type, related_entity_id FROM issues WHERE reporter_id = $1`, [u.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].related_entity_type, 'task');
  assert.equal(Number(rows[0].related_entity_id), badId);
  assert.match(rows[0].title, /בכותרת 16:00/);
  assert.match(rows[0].title, /נשמר 19:00/);

  // Read again tomorrow: still found, never filed twice.
  const second = await withTx(db.pool, (c) => job.sweepPromiseWatch(c, deps));
  assert.equal(second.statedHour, 1);
  assert.equal(second.filed, 0);

  // Archived — it can no longer reach her, so it drops out of the pass. This
  // is why a box whose only faults are historical files nothing here.
  await db.pool.query(`UPDATE tasks SET archived_at = now() WHERE id = $1`, [badId]);
  const third = await withTx(db.pool, (c) => job.sweepPromiseWatch(c, deps));
  assert.equal(third.statedHour, 0);
});

test('statedHourMismatch: measured against the shapes that actually exist', () => {
  const { statedHourMismatch, statedHour } = require('../src/domain/stated-hour');

  // The two real faults.
  assert.deepEqual(
    statedHourMismatch({ title: 'משמרת עבודה - יום ראשון 16:00-22:00', dueLocal: '19:00' }),
    { stated: '16:00', stored: '19:00' });
  assert.deepEqual(
    statedHourMismatch({ title: 'Brunch with a friend — Tuesday Sep 1 at 10:00', dueLocal: '07:00' }),
    { stated: '10:00', stored: '07:00' });

  // A span names its START, and due_at is the start. Reading every clock in
  // the title would report this — the reason only the first one is taken.
  assert.equal(statedHourMismatch({ title: 'משמרת 16:00-22:00', dueLocal: '16:00' }), null);

  // A bare hour is not a clock. "ב-16" is a day of the month far more often
  // than an hour, and a detector that fires on ordinary input is worse than
  // none — this is the reading that was REJECTED, kept with the row shape
  // that killed it.
  assert.equal(statedHour('פגישה ב-16 לחודש'), null);
  assert.equal(statedHour('לשלם ארנונה ב-9'), null);

  // Bounded on both sides, so neither a date fragment nor a score can pass.
  assert.equal(statedHour('התוצאה הייתה 12:345'), null);
  assert.equal(statedHour('גרסה 1:2:3'), null);
  // ...and 24:00 / 61 minutes are not times.
  assert.equal(statedHour('נפגשים ב-24:00'), null);
  assert.equal(statedHour('נפגשים ב-10:61'), null);

  // Nothing to compare against is never a fault.
  assert.equal(statedHourMismatch({ title: 'לקנות חלב', dueLocal: '08:00' }), null);
  assert.equal(statedHourMismatch({ title: 'פגישה 14:00', dueLocal: null }), null);
});
