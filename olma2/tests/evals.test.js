'use strict';
// The eval harness's own tests. Real agent turns only exist on the server, so
// runTurn and the judge are injected — what is tested here is everything
// AROUND the model: reset safety, hard-check plumbing, status derivation, the
// two-consecutive-nights alert rule, persistence, and the isolation that lets
// a fake-phoned eval user exist inside a live system without leaking noise.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const harness = require('../src/evals/harness');
const { SCENARIOS } = require('../src/evals/scenarios');
const evalsJob = require('../src/jobs/evals');
const tasksDomain = require('../src/domain/tasks');
const { decide } = require('../src/outbox/gate');

let db, evalUser, realUser;
before(async () => {
  db = await freshDb();
  evalUser = await makeUser(db.pool, harness.EVAL_PHONE, { firstName: 'בדיקה' });
  await db.pool.query(
    `UPDATE users SET is_eval = true, timezone = 'Asia/Jerusalem', onboarded_at = now() WHERE id = $1`,
    [evalUser.id]);
  realUser = await makeUser(db.pool, '+972597000001', { firstName: 'אמיתי' });
});
after(async () => { await db.teardown(); });

// A fake turn runner: returns scripted replies/toolCalls and can run a side
// effect against the DB — standing in for what the real agent's tools do.
function fakeTurns(script) {
  let i = 0;
  return async () => {
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step.effect) await withTx(db.pool, (c) => step.effect(c));
    return { reply: step.reply || 'בסדר', toolCalls: step.toolCalls || ['turn_start'], model: 'x/test-model' };
  };
}

// Stubs for deps.complete — the judge's raw model reply, as llm.complete
// would return it.
const judgePass = async () => ({ ok: true, text: '{"verdict":"pass","problems":[]}' });

// scenario ids referenced below must exist — a renamed scenario should fail
// here, not silently test nothing.
const byId = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

test('scenario definitions are complete and unique', () => {
  assert.ok(SCENARIOS.length >= 8);
  for (const s of SCENARIOS) {
    assert.ok(s.id && s.turns.length && typeof s.hard === 'function' && s.rubric, s.id);
  }
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length);
});

test('resetEvalUser wipes the fixture and refuses a real person', async () => {
  await withTx(db.pool, async (c) => {
    await tasksDomain.addTask(c, evalUser.id, { title: 'שריד מריצה קודמת', source: 'chat' });
    await c.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [evalUser.id]);
    await harness.resetEvalUser(c, evalUser.id);
    const { rows: t } = await c.query(`SELECT count(*)::int AS n FROM tasks WHERE owner_id = $1`, [evalUser.id]);
    assert.equal(t[0].n, 0);
    const { rows: u } = await c.query(`SELECT paused_at FROM users WHERE id = $1`, [evalUser.id]);
    assert.equal(u[0].paused_at, null);

    // The only thing between this DELETE cascade and a real person's data:
    await assert.rejects(() => harness.resetEvalUser(c, realUser.id), /not an eval user/);
  });
});

test('a hard-check failure is RED and the judge is not even consulted', async () => {
  let judgeCalled = false;
  const r = await harness.runScenario(db.pool, evalUser, byId['stop-service'], {
    runTurn: fakeTurns([
      { reply: 'בטוח?' },
      { reply: 'בסדר, בהצלחה 💙' }, // the real incident: warm words, no tool
    ]),
    complete: async () => { judgeCalled = true; return { ok: true, text: '{}' }; },
  });
  assert.equal(r.status, 'red');
  assert.ok(r.hardFailures.some((f) => /pause_olma/.test(f.name)));
  assert.equal(judgeCalled, false, 'a broken behaviour is red regardless of how nice the text was');
});

test('runScenario with an injected judge: pass → green, concern → yellow', async () => {
  const mk = () => fakeTurns([
    { reply: 'בטוח?' },
    {
      reply: 'עצרתי. כלום לא נמחק.',
      toolCalls: ['turn_start', 'pause_olma'],
      effect: (c) => c.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [evalUser.id]),
    },
  ]);
  const g = await harness.runScenario(db.pool, evalUser, byId['stop-service'], {
    runTurn: mk(), complete: async () => ({ ok: true, text: '{"verdict":"pass","problems":[]}' }),
  });
  assert.equal(g.status, 'green');

  const y = await harness.runScenario(db.pool, evalUser, byId['stop-service'], {
    runTurn: mk(),
    complete: async () => ({ ok: true, text: '{"verdict":"pass","problems":[{"rule":"פנייה","quote":"x"}]}' }),
  });
  assert.equal(y.status, 'yellow', 'problems present → concern even if the judge said pass');
});

test('an unparseable judge is an ERROR, never a silent green', async () => {
  const r = await harness.runScenario(db.pool, evalUser, byId['stop-service'], {
    runTurn: fakeTurns([
      { reply: 'בטוח?' },
      {
        reply: 'עצרתי.',
        toolCalls: ['turn_start', 'pause_olma'],
        effect: (c) => c.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [evalUser.id]),
      },
    ]),
    complete: async () => ({ ok: true, text: 'אין לי מושג, אבל נשמע בסדר!' }),
  });
  assert.equal(r.status, 'error');
});

test('a turn that dies mid-scenario is an ERROR result, not a thrown sweep', async () => {
  const r = await harness.runScenario(db.pool, evalUser, byId['goal-capture'], {
    runTurn: async () => { throw new Error('openclaw agent timed out after 240000ms'); },
  });
  assert.equal(r.status, 'error');
  assert.match(r.error, /timed out/);
});

test('the shared turn_start-first check catches a batched opening', async () => {
  const r = await harness.runScenario(db.pool, evalUser, byId['general-knowledge'], {
    runTurn: fakeTurns([{ reply: 'קצר.', toolCalls: ['list_my_tasks', 'turn_start'] }]),
    complete: judgePass,
  });
  assert.equal(r.status, 'red');
  assert.ok(r.hardFailures.some((f) => /turn_start first/.test(f.name)));
});

test('scenario hard checks read the DB the tools actually wrote', async () => {
  // brain-dump: the fake "agent" saves 4 tasks through the real domain, in
  // one bulk call — exactly what the doctrine demands.
  const r = await harness.runScenario(db.pool, evalUser, byId['brain-dump-bulk'], {
    runTurn: fakeTurns([{
      reply: 'רשמתי הכל.',
      toolCalls: ['turn_start', 'add_tasks_bulk'],
      effect: (c) => tasksDomain.addTasksBulk(c, evalUser.id,
        [{ title: 'תור לרופא שיניים' }, { title: 'ארנונה' }, { title: 'מתנה לאמא' }, { title: 'ביטוח רכב' }],
        { source: 'chat' }),
    }]),
    complete: judgePass,
  });
  assert.equal(r.status, 'green', JSON.stringify(r.hardFailures));

  // ...and the loop-of-add_task antipattern is red even with 4 tasks saved.
  const loop = await harness.runScenario(db.pool, evalUser, byId['brain-dump-bulk'], {
    runTurn: fakeTurns([{
      reply: 'רשמתי.',
      toolCalls: ['turn_start', 'add_task', 'add_task', 'add_task', 'add_task'],
      effect: (c) => tasksDomain.addTasksBulk(c, evalUser.id,
        [{ title: 'א' }, { title: 'ב' }, { title: 'ג' }, { title: 'ד' }], { source: 'chat' }),
    }]),
    complete: judgePass,
  });
  assert.equal(loop.status, 'red');
});

test('runEvalSuite persists a run + per-scenario rows and tallies them', async () => {
  const two = [byId['general-knowledge'], byId['not-chatgpt-essay']];
  const summary = await evalsJob.runEvalSuite(db.pool, {
    trigger: 'manual', scenarios: two,
    deps: { runTurn: fakeTurns([{ reply: 'זה לא התחום שלי — אבל את המשימות שלך אשמח לסדר.' }]), complete: judgePass },
  });
  assert.equal(summary.tally.green, 2);
  const { rows } = await db.pool.query(
    `SELECT status, count(*)::int AS n FROM eval_results WHERE run_id = $1 GROUP BY status`, [summary.runId]);
  assert.deepEqual(rows, [{ status: 'green', n: 2 }]);
  const { rows: run } = await db.pool.query(`SELECT * FROM eval_runs WHERE id = $1`, [summary.runId]);
  assert.ok(run[0].finished_at);
  assert.equal(run[0].agent_model, 'x/test-model');
});

test('yellow alerts only on the second consecutive bad night', async () => {
  const scenario = [byId['general-knowledge']];
  const deps = (judge) => ({ runTurn: fakeTurns([{ reply: 'קצר.' }]), complete: judge });
  const concernReply = async () => ({ ok: true, text: '{"verdict":"concern","problems":[{"rule":"ניסוח","quote":"קצר."}]}' });
  const passReply = async () => ({ ok: true, text: '{"verdict":"pass","problems":[]}' });

  // night 1: yellow, no alert
  const n1 = await evalsJob.runEvalSuite(db.pool, { scenarios: scenario, deps: deps(concernReply) });
  assert.equal(n1.tally.yellow, 1);
  assert.equal(n1.alerts.length, 0, 'first yellow is watched, not alerted');

  // night 2: yellow again → alert
  const n2 = await evalsJob.runEvalSuite(db.pool, { scenarios: scenario, deps: deps(concernReply) });
  assert.equal(n2.alerts.length, 1);
  assert.match(evalsJob.alertText(n2), /לילה שני ברצף/);

  // a green night resets the streak
  await evalsJob.runEvalSuite(db.pool, { scenarios: scenario, deps: deps(passReply) });
  const n4 = await evalsJob.runEvalSuite(db.pool, { scenarios: scenario, deps: deps(concernReply) });
  assert.equal(n4.alerts.length, 0, 'the green night broke the streak');

  // red alerts immediately, no streak needed
  const red = await evalsJob.runEvalSuite(db.pool, {
    scenarios: [byId['stop-service']],
    deps: { runTurn: fakeTurns([{ reply: 'ביי' }, { reply: 'בהצלחה 💙' }]), complete: passReply },
  });
  assert.equal(red.alerts.length, 1);
  assert.match(evalsJob.alertText(red), /🔴 stop-service/);
});

test('sweepEvals: window gate, once-per-night watermark, and the alert pipe', async () => {
  const night = new Date('2026-08-29T01:30:00Z').getTime(); // 04:30 IL
  const sent = [];
  const deps = {
    now: night,
    send: (phone, text) => { sent.push({ phone, text }); return { ok: true }; },
    runTurn: fakeTurns([{ reply: 'ביי' }, { reply: 'בהצלחה 💙' }]), // red: no pause_olma
    complete: judgePass,
  };
  // outside the window → skipped
  const day = await evalsJob.sweepEvals(db.pool, { ...deps, now: new Date('2026-08-29T12:00:00Z').getTime() });
  assert.equal(day.skipped, 'outside window');

  const first = await evalsJob.sweepEvals(db.pool, { ...deps });
  assert.ok(first.runId, JSON.stringify(first));
  assert.ok(first.red >= 1, 'the no-tool goodbye is red');
  assert.equal(first.alerted, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /בדיקת ההתנהגות/);

  // same night, next hourly tick → watermark blocks a second run
  const again = await evalsJob.sweepEvals(db.pool, { ...deps });
  assert.equal(again.skipped, 'already ran tonight');
});

test('the outbox gate drops an eval user row like it drops a paused one', () => {
  const row = { kind: 'checkin', urgency: 'urgent' };
  const base = {
    row, plan: 'free', blocked: false, paused: false,
    window: { start: '08:00', end: '21:00' }, tz: 'Asia/Jerusalem',
    sentToday: 0, budget: 4, now: new Date('2026-08-29T10:00:00+03:00'),
  };
  assert.equal(decide({ ...base, evalUser: true }).action, 'drop');
  assert.equal(decide({ ...base, evalUser: true }).holdReason, 'eval_user');
  assert.equal(decide(base).action, 'deliver', 'a real user at the same moment delivers');
});

test('sweeps that select users all exclude the eval user', async () => {
  // Representative pair (the full list shares the same WHERE shape): the
  // checkin ladder and reminder delivery — the two that would generate real
  // sends to a fake phone number.
  await withTx(db.pool, async (c) => {
    await c.query(`UPDATE users SET onboarded_at = now() - interval '10 days',
                          last_inbound_at = now() - interval '5 days',
                          checkin_enabled = true
                    WHERE id = $1`, [evalUser.id]);
    const checkin = require('../src/jobs/checkin');
    const out = await checkin.run(c, new Date('2026-08-29T10:00:00+03:00').getTime());
    const touched = JSON.stringify(out);
    assert.ok(!touched.includes(String(evalUser.id)), `checkin touched the eval user: ${touched}`);

    const t = await tasksDomain.addTask(c, evalUser.id, { title: 'עם תזכורת', source: 'chat' });
    await c.query(
      `INSERT INTO task_reminders (task_id, remind_at) VALUES ($1, now() - interval '1 minute')`,
      [t.data.task.id]);
    const reminders = require('../src/domain/reminders');
    const due = (await reminders.dueForSending(c, new Date())).data.due;
    assert.ok(!due.some((r) => Number(r.owner_id) === Number(evalUser.id)),
      'a due reminder on the eval user must never reach the send list');
    await harness.resetEvalUser(c, evalUser.id);
  });
});
