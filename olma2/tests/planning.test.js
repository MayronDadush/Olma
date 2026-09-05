'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const planning = require('../src/jobs/planning');
const tasksDomain = require('../src/domain/tasks');
const { renderCard } = require('../src/intake/user-card');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const c = await db.pool.connect();
  try { return await fn(c); } finally { c.release(); }
}

// A moment that is 06:00 in Asia/Jerusalem (UTC+3 in August) — inside the
// 05:00-07:00 planning window.
const SIX_AM_IL = Date.parse('2026-08-25T03:00:00Z');
const NOON_IL = Date.parse('2026-08-25T09:00:00Z');

async function seedPlannable(phone, extra = {}) {
  const u = await makeUser(db.pool, phone, { firstName: 'X', timezone: 'Asia/Jerusalem', ...extra });
  await db.pool.query(
    `UPDATE users SET agent_id = $2, onboarded_at = now() WHERE id = $1`,
    [u.id, `u-${u.id}`]
  );
  await withClient((c) => tasksDomain.addTask(c, u.id, { title: 'לחדש דרכון' }));
  return u;
}

function modelPlan(json) {
  return {
    ok: true,
    text: JSON.stringify(json),
    model: 'claude-haiku-4-5',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

test('due only in their own small hours, once a day, never while paused, never with nothing to plan', async () => {
  const u = await seedPlannable('+972593000001');
  await withClient(async (c) => {
    assert.ok((await planning.dueUsers(c, SIX_AM_IL)).some((x) => Number(x.id) === Number(u.id)),
      '06:00 local with an open task is due');
    assert.ok(!(await planning.dueUsers(c, NOON_IL)).some((x) => Number(x.id) === Number(u.id)),
      'noon is not planning time');

    // already planned this morning → not due again
    await c.query(`INSERT INTO user_plans (user_id, headline) VALUES ($1, 'x')`, [u.id]);
    assert.ok(!(await planning.dueUsers(c, SIX_AM_IL)).some((x) => Number(x.id) === Number(u.id)));
    await c.query(`DELETE FROM user_plans WHERE user_id = $1`, [u.id]);

    // paused → a plan is Olma leaning forward, which is what they declined
    await c.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [u.id]);
    assert.ok(!(await planning.dueUsers(c, SIX_AM_IL)).some((x) => Number(x.id) === Number(u.id)));
    await c.query(`UPDATE users SET paused_at = NULL WHERE id = $1`, [u.id]);

    // no open tasks and no calendar → the honest plan is empty; skip the call
    await c.query(`UPDATE tasks SET status = 'done' WHERE owner_id = $1`, [u.id]);
    assert.ok(!(await planning.dueUsers(c, SIX_AM_IL)).some((x) => Number(x.id) === Number(u.id)));
    await c.query(`UPDATE tasks SET status = 'open' WHERE owner_id = $1`, [u.id]);
  });
});

test('a run stores the plan, audits it, records usage, and the card renders it — as notes, not a message', async () => {
  const u = await seedPlannable('+972593000002');
  await withClient(async (c) => {
    await c.query(`UPDATE users SET timezone = 'UTC' WHERE id <> $1`, [u.id]);
    const { rows: t } = await c.query(`SELECT id FROM tasks WHERE owner_id = $1`, [u.id]);
    let briefSeen = '';
    const res = await planning.sweepPlanning(c, {
      now: SIX_AM_IL,
      complete: (a) => {
        briefSeen = a.user;
        return modelPlan({
          headline: 'יום עמוס: הדרכון דחוף',
          bullets: ['הדרכון פתוח 0 ימים — היום זה הרגע להציע תאריך'],
          task_focus: [t[0].id, 999999], // one real, one invented
        });
      },
    });
    assert.deepEqual(res.planned.map(Number), [Number(u.id)]);
    assert.match(briefSeen, /לחדש דרכון/, 'the open list is the ground truth the brief carries');
    assert.match(briefSeen, /<<</, 'their life data travels fenced, as data');

    const { rows: plan } = await c.query(`SELECT * FROM user_plans WHERE user_id = $1`, [u.id]);
    assert.equal(plan[0].headline, 'יום עמוס: הדרכון דחוף');
    const { rows: log } = await c.query(
      `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'plan.updated'`, [u.id]);
    assert.equal(log.length, 1);
    assert.deepEqual(log[0].detail.taskFocus, [Number(t[0].id)],
      'an invented task id does not survive the server');
    const { rows: ledger } = await c.query(
      `SELECT count(*)::int AS n FROM usage_ledger WHERE user_id = $1`, [u.id]);
    assert.equal(ledger[0].n, 1, 'a direct call with no transcript still lands on the bill');

    // the card shows the plan, framed as briefing notes
    const card = renderCard(
      { ...u, paused_at: null }, [], [],
      { plan: { headline: plan[0].headline, bullets: plan[0].bullets } });
    assert.match(card, /notes for YOU, not a message to send/);
    assert.match(card, /יום עמוס: הדרכון דחוף/);

    // a paused person's card must not lean forward
    const pausedCard = renderCard(
      { ...u, paused_at: new Date() }, [], [],
      { plan: { headline: plan[0].headline, bullets: plan[0].bullets } });
    assert.doesNotMatch(pausedCard, /יום עמוס/);
  });
});

test('an unparseable or empty plan is a failed run: nothing stored, still due next window', async () => {
  const u = await seedPlannable('+972593000003');
  await withClient(async (c) => {
    await c.query(`UPDATE users SET timezone = 'UTC' WHERE id <> $1`, [u.id]);
    for (const bad of [
      () => ({ ok: false, error: 'api down' }),
      () => modelPlan({ headline: '', bullets: [] }),
      () => ({ ok: true, text: 'סתם פרוזה', model: 'claude-haiku-4-5', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    ]) {
      const res = await planning.sweepPlanning(c, { now: SIX_AM_IL, complete: bad });
      assert.equal(res.planned.length, 0);
      assert.equal(res.failed.length, 1);
    }
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM user_plans WHERE user_id = $1`, [u.id]);
    assert.equal(rows[0].n, 0);
  });
});

test('validatePlan clamps everything a model could inflate', () => {
  const plan = planning.validatePlan({
    headline: '  א   רוך  '.repeat(40),
    bullets: Array.from({ length: 12 }, (_, i) => `שורה ${i} ` + 'ב'.repeat(300)),
    task_focus: [1, 2, 3, 4, 5, '2', 'seven'],
  }, [2, 3]);
  assert.ok(plan.headline.length <= 120);
  assert.equal(plan.bullets.length, planning.MAX_BULLETS);
  assert.ok(plan.bullets.every((b) => b.length <= 160));
  assert.deepEqual(plan.taskFocus, [2, 3], 'only their own open tasks, at most 3');
  assert.equal(planning.validatePlan(null, []), null);
  assert.equal(planning.validatePlan({ headline: '   ' }, []), null,
    'a blank headline is a failed plan, not an empty one');
});

test('a stale plan is not rendered — yesterday presented as today is worse than nothing', async () => {
  const u = await seedPlannable('+972593000004');
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO user_plans (user_id, headline, built_at)
       VALUES ($1, 'תוכנית של אתמול', now() - interval '30 hours')`, [u.id]);
    // refreshUserCard's freshness window is PLAN_FRESH_HOURS — verify the
    // query it uses excludes this row
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM user_plans
        WHERE user_id = $1 AND built_at > now() - ($2 || ' hours')::interval`,
      [u.id, String(planning.PLAN_FRESH_HOURS)]);
    assert.equal(rows[0].n, 0);
  });
});

test('an all-day event renders as "כל היום", never as a 03:00 tz artifact', () => {
  const brief = planning.buildBrief({
    user: { timezone: 'Asia/Jerusalem' },
    tasks: [], reminders: [], facts: [],
    events: [
      { title: 'חתונה עדן פוקר', start: '2026-08-26' },
      { title: 'פגישה', start: '2026-08-26T15:00:00+03:00' },
    ],
    now: SIX_AM_IL,
  });
  assert.match(brief, /חתונה עדן פוקר — .*\(כל היום\)/);
  assert.doesNotMatch(brief, /חתונה עדן פוקר — .*03:00/,
    'a bare date must not be formatted as a moment');
  assert.match(brief, /פגישה — .*15:00/, 'timed events keep their time');
  assert.match(brief, /הצעה/, 'the one-voice rule rides the prompt');
  // Birthdays are read off the calendar on the days they matter instead of
  // being copied into user_facts, where one sat as an undated, third-party
  // one-off holding a Top-K card slot indefinitely.
  assert.match(brief, /birthday or anniversary/);
  assert.match(brief, /offer a\n?.*reminder to send greetings/,
    'the plan suggests offering a reminder, never greeting on their behalf');
  // "up to 5" was read as "5": six of the first seven plans built in production
  // came back with exactly five bullets. The cap has to say out loud that it is
  // a ceiling, and the suggestion has to be earned rather than expected — a
  // line true for anyone on any day is the generic filler this fixes.
  assert.match(brief, /is a CEILING, not a target/);
  assert.match(brief, /At most ONE line may be a suggestion/);
  assert.match(brief, /leave it out/);
});

// ---- travel: the question that rides the plan's own calendar read ---------

test('a trip on the calendar becomes one question, asked once and never again', async () => {
  const u = await seedPlannable('+972593000041');
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status, access_level)
     VALUES ($1, 'google_calendar', 'connected', 'read_only')`, [u.id]);

  // Two mornings in the same foreign clock — a trip, not a call.
  const events = [
    { id: 'a', title: 'standup', start: '2026-09-10T08:00:00Z', end: '2026-09-10T09:00:00Z',
      timeZone: 'Europe/Berlin', allDay: false, location: null },
    { id: 'b', title: 'standup', start: '2026-09-11T08:00:00Z', end: '2026-09-11T09:00:00Z',
      timeZone: 'Europe/Berlin', allDay: false, location: null },
  ];
  const deps = {
    now: SIX_AM_IL,
    complete: async () => modelPlan({ headline: 'h', bullets: ['a'] }),
    listEvents: async () => ({ ok: true, data: { events } }),
  };
  await withClient(async (c) => {
    await planning.sweepPlanning(c, deps);
    const { rows } = await c.query(
      `SELECT payload, idempotency_key FROM outbox WHERE user_id = $1 AND kind = 'travel'`, [u.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.zone, 'Europe/Berlin');
    assert.equal(rows[0].payload.from, 'Asia/Jerusalem');

    // Twenty nights of the same trip must not become twenty questions.
    await c.query(`UPDATE user_plans SET built_at = now() - interval '2 days' WHERE user_id = $1`, [u.id]);
    await planning.sweepPlanning(c, deps);
    const again = await c.query(
      `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'travel'`, [u.id]);
    assert.equal(again.rows[0].n, 1, 'the idempotency key holds across runs');
  });
});

test('a calendar with nothing foreign in it asks nothing, and the plan is built either way', async () => {
  const u = await seedPlannable('+972593000042');
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status, access_level)
     VALUES ($1, 'google_calendar', 'connected', 'read_only')`, [u.id]);
  await withClient(async (c) => {
    const res = await planning.sweepPlanning(c, {
      now: SIX_AM_IL,
      complete: async () => modelPlan({ headline: 'h', bullets: ['a'] }),
      // One foreign meeting: a video call, and the exact false positive that
      // would make this feature noise.
      listEvents: async () => ({ ok: true, data: { events: [
        { id: 'a', title: 'call', start: '2026-09-10T08:00:00Z', end: '2026-09-10T09:00:00Z',
          timeZone: 'Europe/Berlin', allDay: false, location: null },
      ] } }),
    });
    assert.ok(res.planned.includes(u.id));
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'travel'`, [u.id]);
    assert.equal(rows[0].n, 0);
  });
});

test('a detector that throws never costs somebody their plan', async () => {
  const u = await seedPlannable('+972593000043');
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status, access_level)
     VALUES ($1, 'google_calendar', 'connected', 'read_only')`, [u.id]);
  await withClient(async (c) => {
    const res = await planning.sweepPlanning(c, {
      now: SIX_AM_IL,
      complete: async () => modelPlan({ headline: 'h', bullets: ['a'] }),
      listEvents: async () => ({ ok: true, data: { events: [] } }),
      detectTrip: () => { throw new Error('boom'); },
    });
    assert.ok(res.planned.includes(u.id), 'the plan is the job; the question is a bonus');
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'travel'`, [u.id]);
    assert.equal(rows[0].n, 0);
  });
});
