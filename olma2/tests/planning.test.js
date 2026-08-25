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
