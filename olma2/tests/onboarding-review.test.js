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
  deployedDuringWindow: false, calendarOffered: false, sends: [], audit: [],
  ...over,
});

// One review per tick is deliberate (the transcript read is the expensive
// part), and this file leaves several reviewable people behind it in one
// database — so a test that wants ITS person reviewed runs the sweep until it
// has nothing left to do, which is what a few minutes of real ticks are.
//
// Every DB-backed test here goes through this, and every assertion about what
// came back is filtered to its OWN person. Both halves are load-bearing and
// both were learned the same way, twice. A bare `sweepOnboardingReview` reviews
// whoever the sweep decides is next across the whole table, and an unfiltered
// assertion is a claim about who ELSE was due at that instant — which is not a
// fact any one test owns, because the tests above place their people relative
// to the REAL clock while the ones below pin `now` to a literal. The gap
// between those two clocks walks with the calendar, so a test that reads its
// neighbours' rows is green for a while and then red, on bytes nobody touched:
// it cost a production deploy on 2026-09-06 at 19:04 UTC, and it took the whole
// suite down again overnight on 2026-09-10. CLAUDE.md, "never let a test depend
// on the hour it runs".
async function drain(now, deps) {
  const out = [];
  for (let i = 0; i < 25; i++) {
    const { reviewed } = await withTx(db.pool, (c) => job.sweepOnboardingReview(c, { ...deps, now }));
    if (!reviewed.length) break;
    out.push(...reviewed);
  }
  return out;
}

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

// ---- the four checks added after his second day ----------------------------

test('"מחר" about a moment that has already rung is a plain untruth', () => {
  // 09:47 on the 6th: "מחר ב-7:00 בגדים לאימון, 11:30 אבא, 19:00 מלי".
  // Every one of those was that same day, and 07:00 had gone two hours before.
  const { findings } = review(base({
    outbound: [{ at: '2026-09-06T06:47:23Z', text: 'מחר ב-7:00 בגדים לאימון, 11:30 אבא, 19:00 מלי' }],
    reminders: [
      { id: 1, remindAt: '2026-09-06T04:00:00Z' },   // 07:00 local, already passed
      { id: 2, remindAt: '2026-09-06T08:30:00Z' },   // 11:30 local, still ahead
    ],
  }));
  const hits = findings.filter((f) => f.id === 'wrong_day_word');
  assert.equal(hits.length, 2);
  const passed = hits.find((f) => f.detail.said === '07:00');
  assert.equal(passed.severity, 'bad', 'it had already rung');
  assert.equal(passed.detail.meant, '2026-09-07');
  assert.equal(passed.detail.actually, '2026-09-06');
  assert.equal(hits.find((f) => f.detail.said === '11:30').severity, 'warn', 'still ahead of them');
});

test('"מחר" the night before is simply correct', () => {
  // 22:56 on the 5th, about 11:30 on the 6th — the message that started all of
  // this, and the one this check must never flag.
  const { findings } = review(base({
    outbound: [{ at: '2026-09-05T19:56:20Z', text: 'מחר (ראשון) ב-11:30 אזכיר לך לדבר עם אבא' }],
    reminders: [{ id: 1, remindAt: '2026-09-06T08:30:00Z' }],
  }));
  assert.equal(findings.find((f) => f.id === 'wrong_day_word'), undefined);
});

test('"היום" about today passes, and a day word beside an unscheduled hour is not judged', () => {
  assert.equal(review(base({
    outbound: [{ at: '2026-09-06T05:01:54Z', text: 'יש לי בשבילך משימות היום, תזכורות ב-11:30 ו-19:00' }],
    reminders: [{ id: 1, remindAt: '2026-09-06T08:30:00Z' }, { id: 2, remindAt: '2026-09-06T16:00:00Z' }],
  })).findings.find((f) => f.id === 'wrong_day_word'), undefined);

  assert.equal(review(base({
    outbound: [{ at: '2026-09-06T05:00:00Z', text: 'מחר ב-14:00 יש משחק' }],
    reminders: [{ id: 1, remindAt: '2026-09-06T08:30:00Z' }],
  })).findings.find((f) => f.id === 'wrong_day_word'), undefined, 'nothing is scheduled for 14:00');
});

test('מחרתיים is not מחר', () => {
  assert.equal(review(base({
    outbound: [{ at: '2026-09-06T05:00:00Z', text: 'מחרתיים ב-11:30' }],
    reminders: [{ id: 1, remindAt: '2026-09-06T08:30:00Z' }],
  })).findings.find((f) => f.id === 'wrong_day_word'), undefined);
});

test('a reminder that went out twice and changed nothing is reported', () => {
  // His wake-up: 07:00, then the ladder again at 10:00, by which time it could
  // not do the one job it had.
  const { findings } = review(base({
    reminders: [{ id: 121, remindAt: '2026-09-06T04:00:00Z', attempts: 2 }],
  }));
  const f = findings.find((x) => x.id === 'reminder_chased');
  assert.equal(f.severity, 'warn');
  assert.equal(f.detail.reminders[0].attempts, 2);
  // one delivery is the plan working
  assert.equal(review(base({ reminders: [{ id: 1, remindAt: 'x', attempts: 1 }] }))
    .findings.find((x) => x.id === 'reminder_chased'), undefined);
});

test('two messages nobody asked for, fifty seconds apart', () => {
  const { findings } = review(base({
    sends: [
      { at: '2026-09-06T05:01:54Z', kind: 'checkin', rung: 'onboarding_5h' },
      { at: '2026-09-06T05:02:44Z', kind: 'checkin', rung: 'onboarding_8h' },
    ],
  }));
  const f = findings.find((x) => x.id === 'proactive_pile_up');
  assert.equal(f.detail.first.rung, 'onboarding_5h');
  assert.equal(f.detail.second.rung, 'onboarding_8h');
  assert.match(f.title, /50s apart/);
});

test('a reply to something they said in between is a conversation, not a pile-up', () => {
  assert.equal(review(base({
    sends: [
      { at: '2026-09-06T05:01:54Z', kind: 'checkin', rung: 'onboarding_5h' },
      { at: '2026-09-06T05:02:44Z', kind: 'checkin', rung: 'onboarding_8h' },
    ],
    inbound: [{ at: '2026-09-06T05:02:20Z', text: 'בוקר טוב' }],
  })).findings.find((f) => f.id === 'proactive_pile_up'), undefined);

  assert.equal(review(base({
    sends: [
      { at: '2026-09-06T05:01:54Z', kind: 'checkin', rung: 'a' },
      { at: '2026-09-06T06:30:00Z', kind: 'checkin', rung: 'b' },
    ],
  })).findings.find((f) => f.id === 'proactive_pile_up'), undefined, 'an hour and a half apart is not a pile-up');
});

test('a capability refusal with nothing filed; the same refusal WITH an issue passes', () => {
  const said = [{ at: '2026-09-05T21:47:10Z', text: 'אין לי אפשרות לשלוח התראות כל 3 דקות — התזכורות שלי לא תומכות בקצב כזה.' }];
  const f = review(base({ outbound: said })).findings.find((x) => x.id === 'refusal_without_issue');
  assert.equal(f.severity, 'note');

  // the flight-prices refusal an evening earlier, which DID file issue #75
  assert.equal(review(base({
    outbound: said,
    audit: [{ event: 'issue.reported', at: '2026-09-05T21:47:40Z' }],
  })).findings.find((x) => x.id === 'refusal_without_issue'), undefined);
});

test('the verbs a confirmation actually uses, not the ones the list happened to hold', () => {
  // Miron's line, 2026-09-06 11:29, verbatim — a 👍 was on his message and
  // `hints.markPlaced` was on the same tool result. The check that exists to
  // catch this did not, because "הוספתי" was not in the word list. A detector
  // that can no longer fail is not a detector (CLAUDE.md, Recurring failure
  // shapes), and one whose founding case walks past it never was one.
  const { findings } = review(base({
    outbound: [{
      at: '2026-09-06T08:29:39Z', markPlaced: true,
      text: 'הוספתי ✅ "לדבר עם מור חן — לבקש חומרי גלם" לתזכורת עוד שעתיים (13:29), אזכיר לך שעה לפני 💪',
    }],
  }));
  const f = findings.find((x) => x.id === 'said_what_the_mark_said');
  assert.ok(f, 'the confirmation verb is recognised');
  assert.match(f.detail.line, /^הוספתי/);

  // Without a mark there is nothing being said twice, and a first line that
  // carries something of its own is not a confirmation at all.
  assert.equal(review(base({ outbound: [{ at: 'x', text: 'הוספתי ✅' }] }))
    .findings.find((x) => x.id === 'said_what_the_mark_said'), undefined);
  assert.equal(review(base({ outbound: [{ at: 'x', markPlaced: true, text: 'הוספתיים זה לא פועל' }] }))
    .findings.find((x) => x.id === 'said_what_the_mark_said'), undefined);
});

test('a plain "no" is not a capability refusal', () => {
  assert.equal(review(base({
    outbound: [{ at: 'x', text: 'לא, זה לא יכול להיות נכון' }],
  })).findings.find((f) => f.id === 'refusal_without_issue'), undefined);
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

  // once per person per stage, for ever — and at four hours in, the day stage
  // is not due yet, so a second tick has nothing at all to do.
  assert.deepEqual((await run()).reviewed, []);

  const { rows } = await db.pool.query(
    `SELECT stage, worst, findings, evidence FROM onboarding_reviews WHERE user_id = $1`, [u.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, '3h');
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
  // FIXED, not `now - 6 days`, and the difference is a red suite for 45 hours
  // at a time. freshDb() is per FILE, so this row outlives its own test, and
  // MAX_PER_TICK is 1 with ORDER BY first_turn_at — so the moment a real-clock
  // "six days ago" drifts inside a LATER test's pinned 48-hour window, the
  // sweep reviews this user instead of that test's, `reviewed.length` is still
  // 1, and the assertion that fails is three tests further down. Measured:
  // Yahav's test (now pinned to 2026-09-05T21:00Z) goes red for every run
  // between 2026-09-09T21:00Z and 2026-09-11T18:00Z. Anything older than 48h
  // proves "too old to bother" equally well, and a date this far back can
  // never wander into anybody's window.
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, first_turn_at = $2 WHERE id = $1`,
    [stale.id, new Date('2020-01-01T00:00:00Z')]);

  const res = await withTx(db.pool, (c) => job.sweepOnboardingReview(c, {
    now, readMessages: () => [], readSessionEvents: () => ({ text: '' }),
    readLogTails: () => [], readRelease: () => null,
  }));
  assert.deepEqual(res.reviewed.map((r) => r.userId).filter((id) => [fresh.id, stale.id].includes(id)), []);
});

// The reason the second stage exists at all. Every one of the four checks
// added after Yahav's second day fires on something that happened between 3.7
// and 13 hours in — measured, not guessed — and at three hours not one of them
// could have fired. This test is that measurement, kept: a "מחר" said at 09:47
// about a reminder that rang at 07:00 the same morning, twelve and a half
// hours after his first message.
test('the day read sees what the three-hour one structurally cannot, and does not repeat it', async () => {
  const first = Date.parse('2026-09-05T18:00:00Z');
  const u = await makeUser(db.pool, '+972626000005', { firstName: 'יהב', timezone: TZ });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, first_turn_at = $2, timezone_confirmed = true WHERE id = $1`,
    [u.id, new Date(first)]
  );
  const task = await db.pool.query(
    `INSERT INTO tasks (owner_id, title, source, due_at, created_at)
     VALUES ($1, 'בגדים לאימון', 'chat', $2, $2) RETURNING id`,
    [u.id, new Date(first + 3600_000)]);
  await db.pool.query(
    `INSERT INTO task_reminders (task_id, remind_at, auto, created_at)
     VALUES ($1, $2, true, $3)`,
    [task.rows[0].id, new Date('2026-09-06T04:00:00Z'), new Date(first + 3600_000)]);

  // 09:47 local on the 6th — 12.7 hours in. "מחר ב-7:00" about an hour that
  // had rung two hours earlier.
  const said = [
    { role: 'user', at: new Date(first + 60_000).toISOString(), text: 'בגדים לאימון מחר' },
    { role: 'assistant', at: '2026-09-06T06:47:23Z', text: 'מחר ב-7:00 בגדים לאימון' },
  ];
  const deps = {
    readMessages: () => said, readSessionEvents: () => ({ text: '' }),
    readLogTails: () => [], readRelease: () => null,
  };

  // Three hours in: the sentence has not been said yet, and nothing sees it.
  const early = await drain(first + 4 * 3600_000, deps);
  assert.deepEqual(early.filter((r) => r.userId === u.id).map((r) => r.stage), ['3h']);
  const { rows: e } = await db.pool.query(
    `SELECT findings FROM onboarding_reviews WHERE user_id = $1 AND stage = '3h'`, [u.id]);
  assert.equal(e[0].findings.find((f) => f.id === 'wrong_day_word'), undefined,
    'a three-hour window cannot see hour twelve — this is the gap, not a bug');

  // A day in, the same checks are shown the same evidence plus nine more hours
  // of it, and the fault is there.
  const late = await drain(first + 27 * 3600_000, deps);
  assert.deepEqual(late.filter((r) => r.userId === u.id).map((r) => r.stage), ['1d']);
  const { rows: d } = await db.pool.query(
    `SELECT worst, findings FROM onboarding_reviews WHERE user_id = $1 AND stage = '1d'`, [u.id]);
  const f = d[0].findings.find((x) => x.id === 'wrong_day_word');
  assert.ok(f, 'the day read sees it');
  assert.equal(f.detail.said, '07:00');
  assert.equal(d[0].worst, 'bad');

  // and neither row is written twice — asked of THIS person, like the two
  // assertions above it. Unfiltered, it also asserted that no OTHER user in
  // the file was due at this instant, and that is not a fact this test owns:
  // `fresh` two tests up is pinned to the real clock (now - 1h) while this
  // drain runs on a fixed simulated one (2026-09-06T22:00Z), so for the one
  // real hour a day when the gap between them lands inside the 3h window,
  // a stranger's legitimate review appeared here and failed the file. It cost
  // a production deploy on 2026-09-06 at 19:04 UTC, and it is the exact shape
  // CLAUDE.md warns about under "never let a test depend on the hour it runs".
  assert.deepEqual((await drain(first + 28 * 3600_000, deps))
    .filter((r) => r.userId === u.id), []);
});

// The day window is a superset of the three-hour one, so without this every
// finding the early read already reported would be filed a second time and
// every count over this table would double.
test('the day read reports what is new, not what the early one already said', async () => {
  const first = Date.parse('2026-09-05T18:00:00Z');
  const u = await makeUser(db.pool, '+972626000006', { firstName: 'כפול', timezone: TZ });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, first_turn_at = $2, timezone_confirmed = false WHERE id = $1`,
    [u.id, new Date(first)]
  );
  const deps = {
    readMessages: () => [], readSessionEvents: () => ({ text: '' }),
    readLogTails: () => [], readRelease: () => null,
  };
  await drain(first + 4 * 3600_000, deps);
  await drain(first + 27 * 3600_000, deps);

  const { rows } = await db.pool.query(
    `SELECT stage, worst, findings FROM onboarding_reviews WHERE user_id = $1 ORDER BY stage`, [u.id]);
  assert.deepEqual(rows.map((r) => r.stage), ['1d', '3h']);
  const day = rows.find((r) => r.stage === '1d');
  const early = rows.find((r) => r.stage === '3h');
  // The unconfirmed zone is still unconfirmed at the day read, and the check
  // still fires — but it is already on his record and is not filed again.
  assert.deepEqual(early.findings.map((f) => f.id), ['timezone_unconfirmed']);
  assert.deepEqual(day.findings, []);
  assert.equal(day.worst, 'clean');

  // The alert strip counts people, not rows, for exactly this reason.
  const { rows: c } = await db.pool.query(
    `SELECT count(DISTINCT user_id)::int AS n FROM onboarding_reviews WHERE acknowledged_at IS NULL`);
  assert.ok(c[0].n >= 1);
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

  // `drain`, and the assertion filtered to HIM — see the note on `drain`. This
  // test was the one place left calling the sweep once and reading the whole
  // table back. `stale`, two tests up, is `now() - 6 days`; once the real date
  // had walked far enough for that to land inside this test's own 48-hour
  // window it sorted ahead of Yahav on `first_turn_at`, took the single slot,
  // and he was never reviewed at all. Green on 2026-09-09, red on 2026-09-10,
  // same commit, and it stays red until the drift carries `stale` back out.
  const reviewed = await drain(now, {
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
  });

  assert.deepEqual(reviewed.filter((r) => r.userId === u.id).map((r) => r.stage), ['3h']);
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
