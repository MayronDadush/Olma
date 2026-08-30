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

  // The quote must be something Olma actually said, or verifyProblems drops it
  // (see the hallucinated-quote test below) — so this uses a real fragment.
  const y = await harness.runScenario(db.pool, evalUser, byId['stop-service'], {
    runTurn: mk(),
    complete: async () => ({ ok: true, text: '{"verdict":"pass","problems":[{"rule":"פנייה","quote":"עצרתי."}]}' }),
  });
  assert.equal(y.status, 'yellow', 'a verified problem → concern even if the judge said pass');
});

// The first nightly run recorded 5 of 9 scenarios as harness errors. Cause:
// the judge is a REASONING model and its thinking is billed against the same
// max_tokens as its answer — at 700 it spent everything on reasoning and
// returned an empty string. These pin the fix and the diagnosis.
test('an empty judge reply is named as truncation, not vague unparseability', async () => {
  const r = await harness.runScenario(db.pool, evalUser, byId['general-knowledge'], {
    runTurn: fakeTurns([{ reply: 'זה לא התחום שלי.' }]),
    complete: async () => ({ ok: true, text: '', usage: { input: 900, output: 700 } }),
  });
  assert.equal(r.status, 'error');
  assert.match(r.judge.error, /reasoning likely consumed max_tokens/);
});

test('the judge gets reasoning headroom, not the 700 that starved it', async () => {
  let asked = null;
  await harness.judgeScenario(byId['general-knowledge'], [{ message: 'x', reply: 'y' }], {
    complete: async (opts) => { asked = opts; return { ok: true, text: '{"verdict":"pass","problems":[]}' }; },
  });
  // 2500 was the first fix and the 2026-08-30 night proved it still starves
  // on real conversations — this floor pins the second raise.
  assert.ok(asked.maxTokens >= 6000, `judge maxTokens was ${asked.maxTokens}`);
});

// finishReason turns two guesses into statements: an empty reply and a
// mid-object cut both get named as max_tokens truncation when the provider
// itself said 'length'.
test('a provider-confirmed truncation is named as such, empty or cut', async () => {
  const turns = [{ message: 'x', reply: 'y' }];
  const empty = await harness.judgeScenario(byId['general-knowledge'], turns, {
    complete: async () => ({ ok: true, text: '', finishReason: 'length' }),
  });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /finish_reason=length/);

  const cut = await harness.judgeScenario(byId['general-knowledge'], turns, {
    complete: async () => ({ ok: true, text: '{"verdict":"concern","problems":[{"ru', finishReason: 'length' }),
  });
  assert.equal(cut.ok, false);
  assert.match(cut.error, /cut mid-object/);
});

// A judge failure is harness infrastructure wobbling, and an ERROR alerts the
// operator's WhatsApp at 03:50 — so one transient failure gets one retry.
// Both attempts failing is still an ERROR (never silently green), and an
// ok-after-retry carries what the first attempt said, so repeated wobble
// stays visible in eval_results instead of self-healing into invisibility.
test('the judge retries once, and a recovered run remembers the first failure', async () => {
  const turns = [{ message: 'x', reply: 'y' }];
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) return { ok: false, error: 'empty or unparseable response body (http 200)' };
    return { ok: true, text: '{"verdict":"pass","problems":[]}' };
  };
  const judged = await harness.judgeScenario(byId['general-knowledge'], turns, { complete: flaky });
  assert.equal(judged.ok, true);
  assert.equal(calls, 2);
  assert.match(judged.retriedAfter, /unparseable response body/);

  // Through runScenario: the wobble lands in the stored judge object.
  const r = await harness.runScenario(db.pool, evalUser, byId['general-knowledge'], {
    runTurn: fakeTurns([{ reply: 'קצר.' }]),
    complete: (() => { let n = 0; return async () => (++n === 1
      ? { ok: false, error: 'llm timeout' }
      : { ok: true, text: '{"verdict":"pass","problems":[]}' }); })(),
  });
  assert.equal(r.status, 'green');
  assert.match(r.judge.retriedAfter, /llm timeout/);

  // Both attempts dead → ERROR, with the failure named.
  let dead = 0;
  const judgedDead = await harness.judgeScenario(byId['general-knowledge'], turns, {
    complete: async () => { dead++; return { ok: false, error: 'llm timeout' }; },
  });
  assert.equal(judgedDead.ok, false);
  assert.equal(dead, harness.JUDGE_ATTEMPTS);
  assert.match(judgedDead.error, /llm timeout/);
});

// Measured live: with reasoning disabled the judge invented a violation and
// cited the USER's own message as the offending quote. JUDGE_SYSTEM already
// demands a verbatim quote from Olma; this is the enforcer.
test('a judge problem whose quote nobody said is dropped, not believed', async () => {
  const turns = [{ message: 'תכתוב לי עבודה על הרצל', reply: 'זה לא מה שאני עושה. רוצה שאשמור כמשימה?' }];
  const judged = await harness.judgeScenario(byId['not-chatgpt-essay'], turns, {
    complete: async () => ({
      ok: true,
      text: JSON.stringify({
        verdict: 'concern',
        problems: [
          { rule: 'כתבה חלק מהעבודה', quote: 'עבודה על הרצל' },      // the USER's words
          { rule: 'ניסוח', quote: 'רוצה שאשמור כמשימה?' },            // really Olma's
        ],
      }),
    }),
  });
  assert.equal(judged.ok, true);
  assert.equal(judged.problems.length, 1, 'only the quote Olma actually said survives');
  assert.equal(judged.unverified.length, 1);
  assert.equal(judged.unverified[0].quote, 'עבודה על הרצל');

  // ...and when EVERY problem fails its own evidence rule, the verdict is pass.
  const allFake = await harness.judgeScenario(byId['not-chatgpt-essay'], turns, {
    complete: async () => ({
      ok: true,
      text: JSON.stringify({ verdict: 'concern', problems: [{ rule: 'x', quote: 'משפט שאיש לא אמר' }] }),
    }),
  });
  assert.equal(allFake.verdict, 'pass');
  assert.equal(allFake.problems.length, 0);
});

// `bare-time-shift` went red at night and green on the re-run, and by then the
// next scenario's reset had erased the evidence. A red has to carry its own
// autopsy.
test('a red scenario captures the state that produced it', async () => {
  const r = await harness.runScenario(db.pool, evalUser, byId['bare-time-shift'], {
    runTurn: fakeTurns([{
      reply: 'רשמתי 🫡 מחר משמרת 15:00 עד 22:00.',
      toolCalls: ['turn_start', 'add_task'],
      // The failure mode we could not diagnose: it CLAIMS the save, and what
      // lands is the wrong hour.
      effect: (c) => tasksDomain.addTask(c, evalUser.id, {
        title: 'משמרת 15:00-22:00', dueAt: '2026-08-30T15:00:00Z', source: 'chat',
      }),
    }]),
    complete: judgePass,
  });
  assert.equal(r.status, 'red');
  assert.ok(r.snapshot, 'a red carries a snapshot');
  assert.equal(r.snapshot.tasks.length, 1);
  assert.match(r.snapshot.tasks[0].local, /18:00$/, 'the snapshot shows the hour that actually landed');

  // A green one carries no snapshot — no autopsy needed, no noise stored.
  const green = await harness.runScenario(db.pool, evalUser, byId['general-knowledge'], {
    runTurn: fakeTurns([{ reply: 'קצר.' }]), complete: judgePass,
  });
  assert.equal(green.status, 'green');
  assert.equal(green.snapshot, undefined);
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
