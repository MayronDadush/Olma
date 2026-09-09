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
const scenarios = require('../src/evals/scenarios');
const { SCENARIOS } = scenarios;
const evalsJob = require('../src/jobs/evals');
const tasksDomain = require('../src/domain/tasks');
const flagsDomain = require('../src/domain/flags');
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
    await withTx(db.pool, async (c) => {
      // Every real turn is counted — by turn_start, or by brokerd's recovery
      // when the model skipped it (domain/turn.js). The fake runner bypasses
      // brokerd entirely, so it has to stand in for that here or scenarios
      // asserting the invariant (turnWasOpened) would fail on the harness
      // rather than on the behaviour they exist to test.
      await require('../src/domain/audit').record(c, evalUser.id, 'message.received', null);
      if (step.effect) await step.effect(c);
    });
    return { reply: step.reply || 'בסדר', toolCalls: step.toolCalls || ['turn_start'], model: 'x/test-model' };
  };
}

// Every makeTurnRunner here injects this. The default opener talks to the REAL
// brokerd socket, which does not exist on a laptop or in CI and DOES exist on
// the box, where `deploy.sh` runs this same suite — a unit test would send a
// live `turn_open` for the eval user to the production daemon, and hold its
// socket open besides. Only the eval run itself opens a real turn.
const noOpen = async () => {};

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

// Four days in the week before 2026-09-06 ran the eval user past the 50-a-day
// free cap, and 2026-09-06 reached 105. Over the line `turn_start` answers
// `send_block_notice` instead of `proceed`, so every scenario after the
// crossing measured the block rather than the model — and the reds read as
// model failures. The reset is what has to make that impossible.
test('resetEvalUser clears the quota, or the run measures the block notice', async () => {
  const quota = require('../src/domain/quota');
  await withTx(db.pool, async (c) => {
    const limit = Number(await flagsDomain.getFlag(c, 'quota_daily_free'));
    for (let i = 0; i < limit + 2; i++) await quota.countMessage(c, evalUser.id);
    const blocked = await quota.countMessage(c, evalUser.id);
    assert.equal(blocked.data.blocked, true, 'past the cap the person is blocked — the precondition of the bug');
    const { rows: b } = await c.query(`SELECT quota_blocked_until FROM users WHERE id = $1`, [evalUser.id]);
    assert.ok(b[0].quota_blocked_until, 'and the block is stamped on the row, which outlives the counter');

    await harness.resetEvalUser(c, evalUser.id);
    const after = await quota.countMessage(c, evalUser.id);
    assert.equal(after.data.blocked, false, 'a reset user starts the next scenario able to be answered');
    const { rows: b2 } = await c.query(`SELECT quota_blocked_until FROM users WHERE id = $1`, [evalUser.id]);
    assert.equal(b2[0].quota_blocked_until, null, 'the stamp goes too — clearing the counter alone leaves the block');
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM quota_counters WHERE user_id = $1`, [evalUser.id]);
    assert.equal(rows[0].n, 1, 'only the count this very call just made');
  });
});

// יהב, 2026-09-07 11:21 — the reply the gateway actually sent him, verbatim.
const YAHAV_REPLY = 'I see they replied "בוצע" to a reminder message about the two 10:00 tasks. Let me look at what tasks are still done-worthy.\n\n'
  + 'The reply was to a reminder about "לשלוח הודעה לרשויות על הקורס מוגנות" and "להביא דואר". I already completed those plus the 11:00 task.\n\n'
  + 'סגרתי את השליחה לרשויות, הדואר, והבקשה מהכולם ✅ נשאר הכדור ב-12:00 לתזכורת בהמשך.';

test('replyLanguage: working notes or another language in the reply are red; links, names and NO_REPLY are not', () => {
  const turns = (...replies) => ({ turns: replies.map((reply) => ({ message: 'x', reply, toolCalls: [] })) });
  const yahav = scenarios.replyLanguage(turns(YAHAV_REPLY));
  assert.equal(yahav.pass, false, 'the founding case passed');
  assert.match(yahav.detail, /working notes/);
  assert.match(yahav.detail, /turn 1/);
  // an all-English answer to a Hebrew speaker, even with no narration opener
  assert.equal(scenarios.replyLanguage(turns('Sure, your meeting is on Wednesday at five and I set a reminder.')).pass, false);
  // pre-tool narration shapes seen the same day
  assert.equal(scenarios.replyLanguage(turns('Let me ask which they want.')).pass, false);
  // and the things that must NOT trip it: a link, a product name, an English
  // word inside a Hebrew sentence, a silent turn, an empty one
  assert.equal(scenarios.replyLanguage(turns(
    'הנה הלוח האישי שלך: https://allma.world/d/' + 'a'.repeat(64),
    'רשמתי ✅ הפגישה ב-Zoom ביום רביעי ב-17:00, ואזכיר לך שעה לפני.',
    'המייל חזר ✅ (mayrondadush@gmail.com, קריאה בלבד).',
    'NO_REPLY', '',
  )).pass, true);
  // the failing turn is named, not the first turn
  const late = scenarios.replyLanguage(turns('בסדר 👍', YAHAV_REPLY));
  assert.match(late.detail, /turn 2/);
});

test('herOwnVoice: a masculine self-reference or model markup is red; her feminine forms, other people\'s verbs and quotes are not', () => {
  const turns = (...replies) => ({ turns: replies.map((reply) => ({ message: 'x', reply, toolCalls: [] })) });
  // the real slips, as read off three days of her messages (2026-09-06..08)
  for (const slip of [
    'אני מבין. כבר אמרתי לשרה 🤝',
    'מצטער, יובל — שיחות קוליות עדיין לא זמינות בשבילך לצערי.',
    'אני מניח שאתה בישראל, אז קבעתי שהשעות כאן זה הזמן שלך.',
    'גאי, קיבלתי את התמונה אבל אני לא יכול לראות אותה — מה יש בה?',
    'תודה, פתח תקווה — סומן. עכשיו אני יודע מתי נוח לכתוב לך',
  ]) {
    const r = scenarios.herOwnVoice(turns(slip));
    assert.equal(r.pass, false, slip);
    assert.match(r.detail, /masculine/);
  }
  // the sixth check-in Dana got (2026-09-08): the model's frame, delivered
  const leak = scenarios.herOwnVoice(turns('<｜DSML｜tool_calls>\n<｜DSML｜invoke name="olma__set_my_name">'));
  assert.equal(leak.pass, false);
  assert.match(leak.detail, /markup/);
  assert.equal(scenarios.herOwnVoice(turns('הטוקן שלך olma_tok_0123456789abcdef0123456789abcdef')).pass, false);
  // and what must NOT trip it: her own feminine forms, the same verbs about
  // somebody else, forms that do not change, a quote of the person's words,
  // a silent turn
  assert.equal(scenarios.herOwnVoice(turns(
    'אני מבינה, אני לא יכולה לראות תמונות כרגע — מה יש בה?',
    'אתה יודע מה, הוא יכול מחר ואת מבינה את זה.',
    'אני רואה שיש לך פגישה מחר, אני מקווה שזה מסתדר ואני רוצה לעזור.',
    'כתבת "אני יכול מחר" — רשמתי ✅',
    'NO_REPLY', '',
  )).pass, true);
  // the failing turn is named, not the first turn
  assert.match(scenarios.herOwnVoice(turns('בסדר 👍', 'אני מצטער על הבלבול')).detail, /turn 2/);
});

test('every scenario is red on a masculine self-reference, whatever it is about', async () => {
  const r = await harness.runScenario(db.pool, evalUser, byId['stop-service'], {
    runTurn: fakeTurns([{ reply: 'אני מבין. עצרתי הכול, ולא מחקתי כלום.' }]),
    complete: judgePass, openTurn: noOpen,
  });
  assert.equal(r.status, 'red');
  assert.ok(r.hardFailures.some((f) => /her own voice/.test(f.name)), JSON.stringify(r.hardFailures));
});

test('every scenario is red on a narrated reply, whatever it is about', async () => {
  const r = await harness.runScenario(db.pool, evalUser, byId['hebrew-gender-feminine'], {
    runTurn: fakeTurns([{ reply: YAHAV_REPLY }]),
    complete: judgePass, openTurn: noOpen,
  });
  assert.equal(r.status, 'red');
  assert.ok(r.hardFailures.some((f) => /in their language/.test(f.name)), JSON.stringify(r.hardFailures));
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

// Measured on the live stop-service conversation: reasoning_tokens 4568 for a
// 33-character answer. The budget is spent almost entirely on thinking, and
// its size varies per conversation — so a retry at the SAME cap is the one
// case where an identical attempt cannot come out differently. The first
// version retried identically and paid for the same 6000-token think to be cut
// at 6000 three times over.
test('a truncated judge is retried with a bigger budget, not the same one', async () => {
  const turns = [{ message: 'x', reply: 'y' }];
  const asked = [];
  const judged = await harness.judgeScenario(byId['general-knowledge'], turns, {
    complete: async ({ maxTokens }) => {
      asked.push(maxTokens);
      return asked.length === 1
        ? { ok: true, text: '{"verdict":"pa', finishReason: 'length' }
        : { ok: true, text: '{"verdict":"pass","problems":[]}', finishReason: 'stop' };
    },
    judgeRetryDelayMs: 0,
  });
  assert.equal(judged.ok, true, 'the escalated attempt is what rescues the judgement');
  assert.equal(asked[0], harness.JUDGE_MAX_TOKENS);
  assert.ok(asked[1] > asked[0], 'the second attempt must not repeat the budget that just ran out');
  assert.equal(asked[1], harness.JUDGE_TRUNCATION_MAX_TOKENS);

  // Transport wobble is a different failure with a different remedy: waiting.
  // Raising the cap there would buy nothing, so the budget stays put.
  const wobble = [];
  await harness.judgeScenario(byId['general-knowledge'], turns, {
    complete: async ({ maxTokens }) => {
      wobble.push(maxTokens);
      return wobble.length === 1
        ? { ok: false, error: 'empty or unparseable response body (http 200)' }
        : { ok: true, text: '{"verdict":"pass","problems":[]}' };
    },
    judgeRetryDelayMs: 0,
  });
  assert.deepEqual(wobble, [harness.JUDGE_MAX_TOKENS, harness.JUDGE_MAX_TOKENS]);
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
  const judged = await harness.judgeScenario(byId['general-knowledge'], turns,
    { complete: flaky, judgeRetryDelayMs: 0 });
  assert.equal(judged.ok, true);
  assert.equal(calls, 2);
  assert.match(judged.retriedAfter, /unparseable response body/);

  // The gap between attempts is the point: the truncated-body failure is
  // load-correlated, so two back-to-back calls sample the same bad moment.
  const waits = [];
  await harness.judgeScenario(byId['general-knowledge'], turns, {
    complete: (() => { let n = 0; return async () => (++n < harness.JUDGE_ATTEMPTS
      ? { ok: false, error: 'empty or unparseable response body (http 200)' }
      : { ok: true, text: '{"verdict":"pass","problems":[]}' }); })(),
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.deepEqual(waits, Array(harness.JUDGE_ATTEMPTS - 1).fill(harness.JUDGE_RETRY_DELAY_MS));
  assert.ok(harness.JUDGE_RETRY_DELAY_MS > 0, 'a retry with no gap re-samples the same moment');

  // Through runScenario: the wobble lands in the stored judge object.
  const r = await harness.runScenario(db.pool, evalUser, byId['general-knowledge'], {
    runTurn: fakeTurns([{ reply: 'קצר.' }]),
    complete: (() => { let n = 0; return async () => (++n === 1
      ? { ok: false, error: 'llm timeout' }
      : { ok: true, text: '{"verdict":"pass","problems":[]}' }); })(),
  });
  assert.equal(r.status, 'green');
  assert.match(r.judge.retriedAfter, /llm timeout/);

  // Every attempt dead → ERROR, with the failure named.
  let dead = 0;
  const judgedDead = await harness.judgeScenario(byId['general-knowledge'], turns, {
    complete: async () => { dead++; return { ok: false, error: 'llm timeout' }; },
    judgeRetryDelayMs: 0,
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

// The cheaper-model pilot: --model drives the suite on a candidate. Two
// things must hold — the override reaches the gateway call, and a pilot's
// results can never be mistaken for production's.
test('makeTurnRunner passes --model only when a candidate was named', async () => {
  const calls = [];
  const fakeRun = async (args) => { calls.push(args); return { result: { meta: {}, payloads: [] } }; };
  const withModel = harness.makeTurnRunner(
    { agentId: 'u-15', sessionKey: 'k', model: 'openrouter/qwen/qwen3.7-flash' },
    { runOpenclawJson: fakeRun, openTurn: noOpen });
  const baseline = harness.makeTurnRunner({ agentId: 'u-15', sessionKey: 'k' },
    { runOpenclawJson: fakeRun, openTurn: noOpen });
  await withModel('שלום');
  await baseline('שלום');
  assert.deepEqual(calls[0].slice(-2), ['--model', 'openrouter/qwen/qwen3.7-flash']);
  assert.ok(!calls[1].includes('--model'), 'a baseline run must measure the LIVE default, never an override');
  // never --deliver, on either path: a pilot cannot reach WhatsApp
  assert.ok(!calls.flat().includes('--deliver'));
});

// 2026.8.1 moved transcripts into the agent's sqlite and meta.sessionFile now
// carries the session KEY — not a path. The first nightly run after the
// upgrade (run #24) scored nine false REDs, "turn opened with no tool at
// all", while the agent was calling tools correctly; the alarm fired at
// 03:50 for a harness artifact. This pins the sqlite fallback.
test('makeTurnRunner reads tool calls from the sqlite store when sessionFile is a session key', async () => {
  const fakeRun = async () => ({
    result: {
      meta: { agentMeta: { sessionFile: 'agent:u-15:eval:not-a-file', provider: 'openrouter', model: 'm' } },
      payloads: [{ text: 'שלום' }],
    },
  });
  const slices = [];
  const events = [
    { text: '{"name":"olma__turn_start"}\n{"name":"olma__list_my_tasks"}', offset: 7 },
    { text: '{"name":"olma__turn_start"}', offset: 11 },
  ];
  const runTurn = harness.makeTurnRunner({ agentId: 'u-15', sessionKey: 'k' }, {
    runOpenclawJson: fakeRun,
    openTurn: noOpen,
    readSessionEventsSlice: (agentId, key, fromSeq) => {
      slices.push([agentId, key, fromSeq]);
      return events.shift();
    },
  });
  const t1 = await runTurn('היי');
  assert.deepEqual(t1.toolCalls, ['turn_start', 'list_my_tasks']);
  const t2 = await runTurn('עוד משהו');
  assert.deepEqual(t2.toolCalls, ['turn_start'], 'each turn reports only its own calls');
  // the seq watermark advances turn to turn, same trick as the file offset
  assert.deepEqual(slices, [['u-15', 'k', 0], ['u-15', 'k', 7]]);
});

test('a pilot run is excluded from the two-consecutive-nights rule', async () => {
  const mkRun = async (trigger) => {
    const { rows } = await db.pool.query(
      `INSERT INTO eval_runs (trigger, scenarios) VALUES ($1, 1) RETURNING id`, [trigger]);
    return Number(rows[0].id);
  };
  const record = async (runId, status) => db.pool.query(
    `INSERT INTO eval_results (run_id, scenario, status, hard_failures)
     VALUES ($1, 'general-knowledge', $2, '[]'::jsonb)`, [runId, status]);

  const nightly = await mkRun('nightly');
  await record(nightly, 'green');
  const pilot = await mkRun(evalsJob.PILOT_TRIGGER);
  await record(pilot, 'yellow');          // a candidate model wobbled
  const tonight = await mkRun('nightly');

  const prev = await withTx(db.pool, (c) =>
    evalsJob.previousStatus(c, 'general-knowledge', tonight));
  assert.equal(prev, 'green',
    "the pilot's yellow must not become tonight's 'second night in a row'");
});

// stop-service swapped `turnStartFirst` for `turnWasOpened` (the model
// provably will not open the turn itself; brokerd now does). A replacement
// check that cannot fail is decoration, not detection — so this proves it
// still goes red when the invariant is actually broken.
test('turnWasOpened is red when a turn really was not opened', async () => {
  const silentTurns = (_n) => { let i = 0; return async () => ({
    reply: i++ === 0 ? 'בטוח?' : 'עצרתי.',
    toolCalls: ['turn_start', 'pause_olma'],
    model: 'x/test-model',
  }); };
  const r = await harness.runScenario(db.pool, evalUser, byId['stop-service'], {
    // No message.received rows written at all — the invariant is violated.
    runTurn: silentTurns(),
    complete: judgePass,
  });
  assert.equal(r.status, 'red');
  assert.ok(r.hardFailures.some((f) => /every turn was opened/.test(f.name)),
    `expected the invariant check to fail, got: ${JSON.stringify(r.hardFailures)}`);
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

  // 04:30 is not an hour to tell anyone a scenario went red. The alert is
  // queued, not sent — nothing reaches the phone yet.
  assert.equal(first.alerted, false);
  assert.equal(first.alertQueued, true);
  assert.equal(sent.length, 0, 'nobody is woken at 04:30 by a red scenario');

  // same night, next hourly tick → watermark blocks a second run
  const again = await evalsJob.sweepEvals(db.pool, { ...deps });
  assert.equal(again.skipped, 'already ran tonight');
  assert.equal(sent.length, 0, 'and the queued alert is still not forced out at night');

  // ...morning. The first tick inside civil hours delivers it, on the same
  // raw pipe as before — the channel was never the problem, the hour was.
  const morning = new Date('2026-08-29T06:30:00Z').getTime(); // 09:30 IL
  const out = await evalsJob.sweepEvals(db.pool, { ...deps, now: morning });
  assert.equal(out.skipped, 'outside window', 'the suite does not re-run to deliver');
  assert.equal(out.alerted, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /בדיקת ההתנהגות/);

  // Delivered once, and the flag is cleared — a later tick must not repeat it.
  await evalsJob.sweepEvals(db.pool, { ...deps, now: morning + 3600_000 });
  assert.equal(sent.length, 1, 'an alert delivered is an alert finished');
});

// The half that makes this safe to defer: a pipe that fails must NOT consume
// the alert. Losing it silently would be strictly worse than waking someone.
test('a failed send leaves the alert pending for the next tick', async () => {
  const morning = new Date('2026-08-29T06:30:00Z').getTime();
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, evalsJob.PENDING_ALERT_FLAG,
    JSON.stringify({ text: 'red', phone: '+972500000000', runId: 1, date: '2026-08-28' })));

  let attempts = 0;
  const dead = { now: morning, send: () => { attempts++; return { ok: false }; } };
  const held = await evalsJob.flushPendingAlert(db.pool, dead, morning);
  assert.equal(held.held, 'send failed');
  assert.equal(attempts, 1);
  assert.ok(await withTx(db.pool, (c) => flagsDomain.getFlag(c, evalsJob.PENDING_ALERT_FLAG)),
    'still pending — a dropped alarm is worse than a late one');

  const sent = [];
  const ok = await evalsJob.flushPendingAlert(db.pool,
    { now: morning, send: (p, t) => { sent.push(t); return { ok: true }; } }, morning);
  assert.equal(ok.alerted, true);
  // Queued on the 28th, delivered on the 29th: it says so rather than reading
  // as last night's.
  assert.match(sent[0], /מהריצה של 2026-08-28/);
  assert.equal(await withTx(db.pool, (c) => flagsDomain.getFlag(c, evalsJob.PENDING_ALERT_FLAG)) || '', '');
});

test('alertHoursOpen follows the operator zone, not the server clock', () => {
  // 06:30 UTC is 09:30 in Israel — open. 01:30 UTC is 04:30 there — not.
  assert.equal(evalsJob.alertHoursOpen(new Date('2026-08-29T06:30:00Z').getTime()), true);
  assert.equal(evalsJob.alertHoursOpen(new Date('2026-08-29T01:30:00Z').getTime()), false);
  // 19:30 UTC is 22:30 in Israel — a red scenario is not worth a late night
  // either, so it waits for the morning.
  assert.equal(evalsJob.alertHoursOpen(new Date('2026-08-29T19:30:00Z').getTime()), false);
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

// Phase B moves the opening out of the model's hands and into the prompt, per
// person, by the `turn_context_phones` flag. The eval user is covered by that
// flag like anyone else the day it says `all` — and on that day `turn_start
// first in every turn` would be asserting the OLD doctrine against a model
// correctly following the new one. So the check follows the flag.
test('the opening check follows the doctrine the user is actually running', async () => {
  const turnCtx = require('../src/domain/turn');
  const wrote = () => fakeTurns([{ reply: 'קצר.', toolCalls: ['turn_start'] }]);

  // Uncovered (today): turn_start first is required, and its absence is red.
  const plain = await harness.runScenario(db.pool, evalUser, byId['general-knowledge'], {
    runTurn: wrote(), complete: judgePass,
  });
  assert.equal(plain.status, 'green', JSON.stringify(plain.hardFailures));

  await withTx(db.pool, (c) => flagsDomain.setFlag(c, turnCtx.CONTEXT_FLAG, evalUser.phone));
  try {
    // Covered: the same turn is now RED, because the call was wasted — the
    // opening was already in the prompt.
    const spent = await harness.runScenario(db.pool, evalUser, byId['general-knowledge'], {
      runTurn: wrote(), complete: judgePass,
    });
    assert.equal(spent.status, 'red', JSON.stringify(spent));
    assert.ok(spent.hardFailures.some((f) => /no turn_start spent/.test(f.name)),
      `expected the wasted-call check to fail, got: ${JSON.stringify(spent.hardFailures)}`);

    // ...and a turn that reads its opening out of the prompt is green.
    const clean = await harness.runScenario(db.pool, evalUser, byId['general-knowledge'], {
      runTurn: fakeTurns([{ reply: 'קצר.', toolCalls: [] }]), complete: judgePass,
    });
    assert.equal(clean.status, 'green', JSON.stringify(clean.hardFailures));

    // The invariant still bites when nothing opened the turn at all — the
    // replacement check must not be a check that cannot fail.
    const unopened = await harness.runScenario(db.pool, evalUser, byId['general-knowledge'], {
      runTurn: async () => ({ reply: 'קצר.', toolCalls: [], model: 'x/test-model' }),
      complete: judgePass,
    });
    assert.equal(unopened.status, 'red');
    assert.ok(unopened.hardFailures.some((f) => /every turn was opened/.test(f.name)),
      JSON.stringify(unopened.hardFailures));
  } finally {
    await withTx(db.pool, (c) => flagsDomain.setFlag(c, turnCtx.CONTEXT_FLAG, ''));
  }
});

// `turnWasOpened` counts audit rows at or after the scenario's start mark, and
// that mark used to be `Date.now()` — milliseconds, against a `created_at`
// column in microseconds. Two fast scenarios in the same millisecond meant the
// first one's turn counted as the second one's, so a turn nothing opened went
// green. The mark comes from the database now.
test("a scenario is scoped by the database clock, not this process's milliseconds", async () => {
  let seen = null;
  const probe = {
    id: 'probe-scope',
    turns: ['שלום'],
    hard: async (client, ctx) => { seen = ctx.startedAt; return scenarios.turnOpening(client, ctx); },
  };
  const rowAt = await withTx(db.pool, async (c) => {
    await require('../src/domain/audit').record(c, evalUser.id, 'message.received', null);
    const { rows } = await c.query(
      `SELECT max(created_at)::text AS t FROM audit_log WHERE actor_id = $1`, [evalUser.id]);
    return rows[0].t;
  });

  const r = await harness.runScenario(db.pool, evalUser, probe, {
    runTurn: async () => ({ reply: 'קצר.', toolCalls: [], model: 'x/test-model' }),
    complete: judgePass,
  });

  // Postgres prints the fraction with trailing zeros trimmed — `.09107` is a
  // microsecond value too, and matching six digits failed the deploy the
  // first time the clock ended in a zero (2026-09-06). This proves the mark is
  // the database's text and not a millisecond count; the strict-after check
  // below is what proves the precision.
  assert.match(String(seen), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00$/,
    "the mark is a database timestamp, not this process's milliseconds");
  const { rows } = await db.pool.query(`SELECT ($1::timestamptz > $2::timestamptz) AS after`, [seen, rowAt]);
  assert.equal(rows[0].after, true, 'the mark must sit strictly after a row committed before the scenario');
  assert.equal(r.status, 'red', JSON.stringify(r.hardFailures));
  assert.ok(r.hardFailures.some((f) => /every turn was opened/.test(f.name)), JSON.stringify(r.hardFailures));
});

// The bug the assertion above cannot see, because it needs a whole process.
// Unref'ing the socket AND the timer left a pending promise with nothing
// holding the event loop, so Node exited 0 in the middle of an eval run — no
// output, no error, `eval_runs.finished_at` NULL, and systemd reporting
// success. Two runs died that way on 2026-09-06 before anyone noticed, and it
// would have taken the nightly with it.
//
// It has to be a UNIX socket and a child with no stdio. Over TCP the connect
// holds a `GetAddrInfoReqWrap` that keeps the loop alive on its own, and
// stdio pipes do the same, so both hide the bug completely — the first
// version of this test passed against the broken code.
test('a turn waiting on brokerd keeps the process alive — it does not exit 0 mid-run', async () => {
  const net = require('node:net');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawn } = require('node:child_process');

  // Every handle here is unref'd or torn down by hand. This file runs as a
  // `node --test` child, and a child that cannot exit hangs the whole suite
  // with no output at all — awaiting `server.close()` is exactly that risk.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-turnopen-'));
  const sock = path.join(dir, 's');
  const accepted = [];
  const server = net.createServer((c) => { accepted.push(c); });  // answer nothing: the deadline ends it
  server.unref();
  await new Promise((r) => server.listen(sock, r));
  const harnessPath = require.resolve('../src/evals/harness');

  try {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', `
        const h = require(${JSON.stringify(harnessPath)});
        h.openTurnForEval('u-15', { sock: ${JSON.stringify(sock)} }).then(() => process.exit(7));
      `], { stdio: 'ignore' });
      const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 15_000);
      kill.unref();
      child.on('exit', (c) => { clearTimeout(kill); resolve(c); });
    });
    assert.equal(code, 7,
      'the child exited before the opener finished — an unref\'d socket lets the loop drain, silently');
  } finally {
    for (const c of accepted) { try { c.destroy(); } catch { /* gone */ } }
    server.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

// The harness opens its own turns over brokerd's socket, exactly as the
// gateway hook does for a real message — without that, a covered eval user
// gets no context block and the whole suite silently measures the fallback.
test('the harness opens each turn through brokerd, with no message id to react to', async () => {
  const written = [];
  const life = { destroyed: 0, unrefs: 0 };
  const fakeSocket = () => {
    const h = {};
    const s = {
      on(ev, fn) { h[ev] = fn; return s; },
      write(x) { written.push(x); setTimeout(() => h.data && h.data('{"ok":true}\n'), 0); },
      end() {}, destroy() { life.destroyed++; }, unref() { life.unrefs++; },
    };
    setTimeout(() => h.connect && h.connect(), 0);
    return s;
  };
  await harness.openTurnForEval('u-15', { connect: fakeSocket });
  assert.equal(written.length, 1);
  const msg = JSON.parse(written[0]);
  assert.equal(msg.method, 'turn_open');
  assert.deepEqual(msg.params, { agentId: 'u-15', kind: 'text' });
  assert.equal(msg.params.messageId, undefined, 'no message id: nothing to put a 👀 on');

  // The handle is closed and unref'd on the way out. `end()` alone leaves the
  // socket waiting on the far side, and on the box — where deploy.sh runs this
  // suite and the socket really answers — that held the test child open and
  // wedged the whole run twice.
  assert.equal(life.destroyed, 1, 'the socket is destroyed, not merely ended');
  assert.equal(life.unrefs, 0, 'and NOT unref\'d — the socket is what keeps the process alive while it waits');

  // brokerd down is not an eval failure — the turn falls back to turn_start.
  const dead = () => { const h = {}; const s = { on(ev, fn) { h[ev] = fn; return s; }, write() {}, end() {}, destroy() {} }; setTimeout(() => h.error && h.error(new Error('ECONNREFUSED')), 0); return s; };
  await harness.openTurnForEval('u-15', { connect: dead });

  // and the turn runner calls it before every turn
  const opened = [];
  const runTurn = harness.makeTurnRunner({ agentId: 'u-15', sessionKey: 'k' }, {
    openTurn: async (a) => { opened.push(a); },
    runOpenclawJson: async () => ({ result: { payloads: [{ text: 'ok' }], meta: {} } }),
    readSessionEventsSlice: () => null,
  });
  await runTurn('שלום');
  await runTurn('עוד משהו');
  assert.deepEqual(opened, ['u-15', 'u-15']);
});
