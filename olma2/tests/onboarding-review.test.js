'use strict';
// The review that reads a new person's first three hours back.
//
// The fixture in the last test is Yahav's real first evening (2026-09-05),
// transcribed from the gateway transcript and his rows in Postgres. It is
// here because that afternoon of hand-reconstruction is exactly what this job
// exists to stop repeating — and because a checker whose founding case it
// cannot reproduce is a checker nobody should trust.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { review, timesIn } = require('../src/domain/onboarding-review');
const job = require('../src/jobs/onboarding-review');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const TZ = 'Asia/Jerusalem';
const base = (over = {}) => ({
  user: { id: 1, timezone: TZ, timezoneConfirmed: true },
  outbound: [], inbound: [], tasks: [], reminders: [],
  facts: 1, preferences: 0, integrations: [], droppedTurns: [], toolErrors: 0,
  deployedDuringWindow: false, calendarOffered: false,
  ...over,
});

// ---- the checks, without a database ----------------------------------------

test('clock times are read the way people write them, and bare hours are not guessed at', () => {
  assert.deepEqual([...timesIn('מחר ב-19:00 להתקשר')], ['19:00']);
  assert.deepEqual([...timesIn('בין 9:05 ל-17:30')], ['09:05', '17:30']);
  assert.deepEqual([...timesIn('אזכיר לך בשבע')], [], 'a word is not a time this check can check');
  assert.deepEqual([...timesIn('2026-09-06T19:00:00')], [], 'an ISO stamp is not something she said');
});

test('saying the DUE hour while a different one is armed is the 2026-09-05 fault, and it is bad', () => {
  const { findings, worst } = review(base({
    outbound: [{ at: 'x', text: 'רשמתי לך לתזכורת מחר ב-19:00 להתקשר למלי' }],
    tasks: [{ id: 414, source: 'chat', status: 'open', dueAt: '2026-09-06T16:00:00Z' }],   // 19:00 local
    reminders: [{ id: 119, remindAt: '2026-09-06T15:00:00Z', auto: true }],                // 18:00 local
  }));
  assert.equal(worst, 'bad');
  const f = findings.find((x) => x.id === 'promised_time_not_armed');
  assert.deepEqual(f.detail.said, ['19:00']);
  assert.deepEqual(f.detail.armed, ['18:00']);
  assert.deepEqual(f.detail.matchedTheDueHourInstead, ['19:00']);
});

test('saying the hour that IS armed passes — the message beside it, the same evening', () => {
  const { findings } = review(base({
    outbound: [{ at: 'x', text: 'רשמתי ✅\n\nמחר (ראשון) ב-11:30 אזכיר לך לדבר עם אבא' }],
    tasks: [{ id: 413, source: 'chat', status: 'open', dueAt: '2026-09-06T08:30:00Z' }],
    reminders: [
      { id: 117, remindAt: '2026-09-06T07:30:00Z', auto: true, cancelledAt: '2026-09-05T19:56:16Z' },
      { id: 118, remindAt: '2026-09-06T08:30:00Z', auto: false },
    ],
  }));
  assert.equal(findings.find((f) => f.id === 'promised_time_not_armed'), undefined);
});

test('a cancelled reminder is not an armed hour', () => {
  const { findings } = review(base({
    outbound: [{ at: 'x', text: 'אזכיר לך ב-10:30' }],
    reminders: [{ id: 1, remindAt: '2026-09-06T07:30:00Z', cancelledAt: '2026-09-05T19:00:00Z' }],
  }));
  assert.equal(findings.find((f) => f.id === 'promised_time_not_armed').severity, 'warn',
    'a mismatch that is not the due-hour signature asks rather than asserts');
});

test('"an hour before" names no hour and is never held to one', () => {
  const { findings } = review(base({
    outbound: [{ at: 'x', text: 'הפגישה ב-19:00 — אזכיר לך שעה לפני' }],
    tasks: [{ id: 1, source: 'chat', status: 'open', dueAt: '2026-09-06T16:00:00Z' }],
    reminders: [{ id: 1, remindAt: '2026-09-06T15:00:00Z', auto: true }],
  }));
  assert.equal(findings.find((f) => f.id === 'promised_time_not_armed'), undefined);
});

test('a message with no reminder language is not a promise about a reminder', () => {
  const { findings, worst } = review(base({
    outbound: [{ at: 'x', text: 'הרכבת יוצאת ב-08:15' }],
  }));
  assert.equal(worst, 'clean');
  assert.equal(findings.length, 0);
});

test('a swallowed message is bad even after it was repaired', () => {
  const { findings } = review(base({ droppedTurns: [{ messageId: 'A', at: 'x' }], repairs: 1 }));
  const f = findings.find((x) => x.id === 'dropped_turn');
  assert.equal(f.severity, 'bad');
  assert.equal(f.detail.repaired, 1);
});

test('a deploy is reported only when we could tell; null is never scored as no', () => {
  assert.equal(review(base({ deployedDuringWindow: null })).findings
    .find((f) => f.id === 'deployed_during_onboarding'), undefined);
  assert.equal(review(base({ deployedDuringWindow: false })).findings
    .find((f) => f.id === 'deployed_during_onboarding'), undefined);
  assert.equal(review(base({ deployedDuringWindow: true })).findings
    .find((f) => f.id === 'deployed_during_onboarding').severity, 'warn');
});

test('someone who barely spoke is not blamed for teaching us nothing', () => {
  const quiet = review(base({ facts: 0, preferences: 0, inbound: [{}, {}] }));
  assert.equal(quiet.findings.find((f) => f.id === 'nothing_learned'), undefined);
  const talkative = review(base({ facts: 0, preferences: 0, inbound: [{}, {}, {}, {}, {}] }));
  assert.equal(talkative.findings.find((f) => f.id === 'nothing_learned').severity, 'warn');
});

test('the calendar opening is about what they gave, not how long they have been here', () => {
  const dated = (n) => Array.from({ length: n }, (_, i) => ({ id: i, source: 'chat', status: 'open', dueAt: '2026-09-06T16:00:00Z' }));
  assert.equal(review(base({ tasks: dated(1) })).findings
    .find((f) => f.id === 'calendar_opening_missed'), undefined, 'one date is not a pattern');
  assert.ok(review(base({ tasks: dated(2) })).findings.find((f) => f.id === 'calendar_opening_missed'));
  assert.equal(review(base({ tasks: dated(3), calendarOffered: true })).findings
    .find((f) => f.id === 'calendar_opening_missed'), undefined, 'already offered');
  assert.equal(review(base({ tasks: dated(3), integrations: [{ provider: 'google_calendar', status: 'connected' }] }))
    .findings.find((f) => f.id === 'calendar_opening_missed'), undefined, 'already connected');
});

test('a check that throws is reported as itself, never as silence', () => {
  // A malformed reminder row: partsInZone gets an Invalid Date.
  const { findings } = review(base({
    outbound: [{ at: 'x', text: 'אזכיר לך ב-10:30' }],
    reminders: [{ id: 1, remindAt: 'not a time' }],
  }));
  const f = findings.find((x) => x.id === 'promised_time_not_armed') || findings.find((x) => x.id === 'check_failed');
  assert.ok(f, 'the check either judged or said it could not');
});

// ---- the sweep, against a real database ------------------------------------

test('the review runs once per person, three hours in, and never speaks to them', async () => {
  const now = Date.now();
  const u = await makeUser(db.pool, '+972626000001', { firstName: 'Yahav', timezone: TZ });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = now() - interval '4 hours',
                      first_turn_at = $2, timezone_confirmed = false WHERE id = $1`,
    [u.id, new Date(now - 4 * 3600_000)]
  );

  const deps = {
    now,
    readMessages: () => [],
    readSessionEvents: () => ({ text: '' }),
    readLogTails: () => [],
    readRelease: () => null,
  };
  const run = () => withTx(db.pool, (c) => job.sweepOnboardingReview(c, deps));

  const first = await run();
  assert.equal(first.reviewed.length, 1);
  assert.equal(first.reviewed[0].userId, u.id);

  // once per person, for ever
  assert.deepEqual((await run()).reviewed, []);

  const { rows } = await db.pool.query(
    `SELECT worst, findings, evidence FROM onboarding_reviews WHERE user_id = $1`, [u.id]);
  assert.equal(rows.length, 1);
  // The zone was a phone-prefix guess and nobody confirmed it — a note, and
  // the whole verdict, because nothing else went wrong in an empty transcript.
  assert.equal(rows[0].worst, 'note');
  assert.deepEqual(rows[0].findings.map((f) => f.id), ['timezone_unconfirmed']);
  // The evidence is kept so a finding can be argued with later.
  assert.ok(rows[0].evidence.windowStart);

  // and nothing was queued to the person
  const { rows: out } = await db.pool.query(`SELECT count(*)::int AS n FROM outbox WHERE user_id = $1`, [u.id]);
  assert.equal(out[0].n, 0, 'this is a report about the system, not a message to them');
});

test('too new to review, and too old to bother', async () => {
  const now = Date.now();
  const fresh = await makeUser(db.pool, '+972626000002', { firstName: 'Fresh' });
  const stale = await makeUser(db.pool, '+972626000003', { firstName: 'Stale' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, first_turn_at = $2 WHERE id = $1`,
    [fresh.id, new Date(now - 60 * 60_000)]);
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, first_turn_at = $2 WHERE id = $1`,
    [stale.id, new Date(now - 5 * 24 * 3600_000)]);

  const res = await withTx(db.pool, (c) => job.sweepOnboardingReview(c, {
    now, readMessages: () => [], readSessionEvents: () => ({ text: '' }),
    readLogTails: () => [], readRelease: () => null,
  }));
  assert.deepEqual(res.reviewed.map((r) => r.userId).filter((id) => [fresh.id, stale.id].includes(id)), []);
});

test('Yahav\'s first evening, end to end, comes back with what the hand-review found', async () => {
  const now = Date.parse('2026-09-05T21:00:00Z');
  const u = await makeUser(db.pool, '+972626000004', { firstName: 'יהב', timezone: TZ });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, first_turn_at = $2, timezone_confirmed = false WHERE id = $1`,
    [u.id, new Date('2026-09-05T17:58:38Z')]
  );
  // His real rows, times as they were stored.
  const t = async (title, source, dueAt, at) => {
    const { rows } = await db.pool.query(
      `INSERT INTO tasks (owner_id, title, source, due_at, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [u.id, title, source, dueAt, at]);
    return rows[0].id;
  };
  await t('לבדוק מחירים לטיסות ללרנקה', 'extracted', null, '2026-09-05T18:42:12Z');
  const father = await t('לדבר עם אבא שידבר עם עלי', 'chat', '2026-09-06T08:30:00Z', '2026-09-05T19:56:10Z');
  const mali = await t('להתקשר למלי להגיד תודה על המתנה', 'chat', '2026-09-06T16:00:00Z', '2026-09-05T20:03:09Z');
  const r = (taskId, remindAt, auto, cancelled) => db.pool.query(
    `INSERT INTO task_reminders (task_id, remind_at, auto, cancelled_at, created_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [taskId, remindAt, auto, cancelled, '2026-09-05T19:56:10Z']);
  await r(father, '2026-09-06T07:30:00Z', true, '2026-09-05T19:56:16Z');   // superseded
  await r(father, '2026-09-06T08:30:00Z', false, null);                    // what he asked for
  await r(mali, '2026-09-06T15:00:00Z', true, null);                       // 18:00 — the fault

  const res = await withTx(db.pool, (c) => job.sweepOnboardingReview(c, {
    now,
    readMessages: () => [
      { role: 'user', text: 'תזכיר לי בבקשה מחר ב11:30 לדבר עם אבא', at: '2026-09-05T19:55:53Z' },
      { role: 'assistant', text: 'רשמתי ✅\n\nמחר (ראשון) ב-11:30 אזכיר לך לדבר עם אבא', at: '2026-09-05T19:56:20Z' },
      { role: 'user', text: 'תודה', at: '2026-09-05T19:56:40Z' },
      { role: 'user', text: 'תזכיר לי בבקשה מחר ב19:00, להתקשר למלי', at: '2026-09-05T20:00:29Z' },
      { role: 'user', text: 'דודה שלי מניו יורק הביאה לי מתנה לברית', at: '2026-09-05T20:02:58Z' },
      { role: 'assistant', text: 'איזה יופי 🎉 מזל טוב!\n\nרשמתי לך לתזכורת מחר ב-19:00 להתקשר למלי', at: '2026-09-05T20:03:23Z' },
    ],
    readSessionEvents: () => ({
      text: 'ERROR unavailable: assistant backend not reachable (brokerd timeout)\n'.repeat(3),
    }),
    readLogTails: () => [{
      raw: JSON.stringify({
        time: '2026-09-05T20:02:20.676Z',
        message: 'visible channel turn dispatched with no queued reply payloads: '
          + `channel=whatsapp messageId=ACDCDB52 sessionKey=agent:u-${u.id}:whatsapp:direct:${u.phone} cause=completed`,
      }),
    }],
    readRelease: () => ({ at: Date.parse('2026-09-05T20:09:55Z'), sha: '766b7b4' }),
  }));

  assert.equal(res.reviewed.length, 1);
  const { rows } = await db.pool.query(
    `SELECT worst, findings FROM onboarding_reviews WHERE user_id = $1`, [u.id]);
  assert.equal(rows[0].worst, 'bad');
  const ids = rows[0].findings.map((f) => f.id);
  // The three that mattered, found without anybody reading a transcript.
  assert.ok(ids.includes('promised_time_not_armed'), '19:00 said, 18:00 armed');
  assert.ok(ids.includes('dropped_turn'), 'the 23:00 message that got nothing');
  assert.ok(ids.includes('tools_failed'), 'three tool calls against a restarting brokerd');
  assert.ok(ids.includes('deployed_during_onboarding'));
  assert.ok(ids.includes('tasks_nobody_confirmed'), 'the Larnaca task he later declined');
  assert.ok(ids.includes('calendar_opening_missed'));
  assert.ok(ids.includes('timezone_unconfirmed'));

  const promised = rows[0].findings.find((f) => f.id === 'promised_time_not_armed');
  assert.equal(promised.severity, 'bad');
  assert.deepEqual(promised.detail.said, ['19:00']);
  assert.ok(promised.detail.armed.includes('18:00'));
  // and the correct message beside it was NOT flagged
  assert.equal(rows[0].findings.filter((f) => f.id === 'promised_time_not_armed').length, 1);
});
