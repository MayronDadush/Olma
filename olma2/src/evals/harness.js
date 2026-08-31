'use strict';
// The eval harness: runs scripted conversations against the DEDICATED eval
// user's real agent — real gateway, real tools, real brokerd, real DB — and
// judges the outcome in two layers.
//
//   Layer 1 (hard, RED): deterministic checks on what actually happened —
//   tool calls and DB state. A model that answered beautifully and called no
//   tool fails here, which is exactly the incident this system exists for.
//
//   Layer 2 (judge, YELLOW): a second model reads the reply text against the
//   scenario's rubric — Hebrew, gender, one-question, no-lecture. A judge
//   from a DIFFERENT family than the agent's model (Kimi vs DeepSeek), because
//   a model grading its own family is blind to their shared weaknesses.
//
// Turns run like scripts/model-pilot.js: disposable session key, no
// --deliver — nothing can ever reach WhatsApp from here. The eval user is
// marked users.is_eval; every sweep skips it and the outbox gate drops its
// rows, so the fake phone number can never generate delivery noise.
const fs = require('node:fs');
const { withTx } = require('../db/pool');
const { runOpenclawJson } = require('../channels/openclaw');
const { refreshUserCard } = require('../intake/user-card');
const llm = require('../adapters/llm');

const EVAL_PHONE = '+972599999001';
// Different family than the production agent model, on purpose.
const JUDGE_MODEL = 'moonshotai/kimi-k2.6';
const TURN_TIMEOUT_MS = 240_000; // a cold flash turn measured ~77s; leave room

async function getEvalUser(client) {
  const { rows } = await client.query(
    `SELECT id, phone, agent_id, workspace_path, timezone, identity_token
       FROM users WHERE is_eval = true AND status = 'active' ORDER BY id LIMIT 1`
  );
  return rows[0] || null;
}

// Wipe the eval user back to a blank slate. REFUSES anyone not marked
// is_eval — this function deletes data, and the only thing standing between
// it and a real person's task list is this check, so it is done here and not
// trusted to the caller.
async function resetEvalUser(client, userId) {
  const { rows } = await client.query(`SELECT is_eval FROM users WHERE id = $1`, [userId]);
  if (!rows[0] || rows[0].is_eval !== true) {
    throw new Error(`refusing to reset user ${userId}: not an eval user`);
  }
  await client.query(`DELETE FROM task_reminders r USING tasks t WHERE r.task_id = t.id AND t.owner_id = $1`, [userId]);
  await client.query(`DELETE FROM tasks WHERE owner_id = $1`, [userId]);
  await client.query(`DELETE FROM user_facts WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM user_preferences WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM user_contacts WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM user_plans WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM meeting_participants WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM meetings WHERE initiator_id = $1`, [userId]);
  await client.query(`DELETE FROM outbox WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM connections WHERE requester_id = $1 OR target_id = $1`, [userId]);
  await client.query(
    `UPDATE users SET paused_at = NULL, resume_offer_sent_at = NULL,
            checkin_misses = 0, last_checkin_at = NULL,
            last_fact_extraction_at = now()
      WHERE id = $1`, [userId]
  );
}

// Tool names out of a gateway transcript slice, in order of appearance.
// The transcript is append-only JSONL; reading from the previous offset gives
// exactly this turn's calls — the same trick usage attribution relies on.
function toolCallsInSlice(text) {
  const out = [];
  const re = /"name"\s*:\s*"olma__([a-z_0-9]+)"/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

// Production turn runner: one per scenario run, stateful so multi-turn
// scenarios keep one session (one conversation, like the real incident) and
// each turn reports only its own tool calls.
function makeTurnRunner({ agentId, sessionKey, model }, deps = {}) {
  const run = deps.runOpenclawJson || runOpenclawJson;
  let offset = 0;
  let sessionFile = null;
  return async function runTurn(message) {
    const json = await run(
      ['agent', '--agent', agentId, '--session-key', sessionKey, '--message', message, '--json',
        // A per-call override, exactly as scripts/model-pilot.js uses it: it
        // moves THIS disposable session onto a candidate model and changes
        // nothing about what real users are routed to. Omitted → the live
        // default, which is what a nightly baseline must measure.
        ...(model ? ['--model', model] : [])],
      TURN_TIMEOUT_MS
    );
    const meta = json.result && json.result.meta && json.result.meta.agentMeta;
    const payload = json.result && json.result.payloads && json.result.payloads[0];
    sessionFile = (meta && meta.sessionFile) || sessionFile;
    let toolCalls = [];
    if (sessionFile) {
      try {
        const full = fs.readFileSync(sessionFile, 'utf8');
        toolCalls = toolCallsInSlice(full.slice(offset));
        offset = full.length;
      } catch { /* transcript unreadable — hard checks on DB still stand */ }
    }
    return {
      reply: payload ? payload.text : '',
      model: meta ? `${meta.provider || '?'}/${meta.model || '?'}` : null,
      toolCalls,
    };
  };
}

const JUDGE_SYSTEM = [
  'אתה שופט איכות של תשובות עוזרת אישית בוואטסאפ בשם אולמה.',
  'תקבל שיחה (הודעות המשתמש ותשובות אולמה) ורובריקה לבדיקה.',
  'שפוט אך ורק לפי הרובריקה. אל תמציא בעיות שאינן שם, ואל תעלים בעיה שכן.',
  'החזר JSON בלבד, בלי טקסט נוסף, בצורה:',
  '{"verdict":"pass"|"concern","problems":[{"rule":"<הכלל שהופר>","quote":"<ציטוט מדויק מהתשובה>"}]}',
  'verdict הוא "concern" רק אם יש לפחות בעיה אחת עם ציטוט. ציטוט חייב להופיע מילה במילה בתשובת אולמה.',
].join('\n');

// The judge is a REASONING model, and its thinking is billed against the same
// max_tokens as its answer. At 700 the first night's run spent all 700 on
// reasoning and returned an EMPTY content string — five of nine scenarios
// recorded as harness errors, including ones whose replies were plainly good.
// Raised to 2500 after measuring the failing case at 980 output tokens — and
// the night of 2026-08-30 proved 2500 STILL starves it on longer
// conversations (two scenarios: all 2500 spent reasoning, no content), while
// the night before that recorded five "unparseable" replies that were almost
// certainly JSON cut mid-object by the same cap. And 6000 failed too, on the
// live stop-service conversation, three attempts out of three.
//
// The number finally came from a measurement instead of another guess. Probed
// against that exact conversation: reasoning_tokens 4568, and the ANSWER it
// was reasoning towards is 33 characters — `{"verdict":"pass","problems":[]}`.
// Essentially the whole budget is thinking, its length varies with the
// conversation, and 6000 leaves under a quarter of it as headroom. 12000 is
// ~2.5x the measured think, and the ~1.5 cents that costs at Kimi's $2.3/Mtok
// output buys a judgement that exists.
//
// Reasoning stays ON deliberately. Disabling it was measured too and made the
// judge WORSE, not just cheaper: on the same conversation it invented a
// violation and cited the USER's own message as the offending quote.
const JUDGE_MAX_TOKENS = 12000;

// What a truncated judge is retried with. Retrying truncation at the SAME cap
// is the one error class where an identical attempt provably cannot come out
// differently — it asks the same model the same question with the same budget
// and hopes it thinks less. That is what shipped first, and the live run paid
// for three 6000-token thinks to be cut at 6000 three times.
const JUDGE_TRUNCATION_MAX_TOKENS = 24_000;

// Retries before a judge failure becomes a scenario ERROR. A judge failure is
// harness infrastructure wobbling, not the agent misbehaving — and an ERROR
// alerts the operator's WhatsApp at ~03:50. The doctrine "a harness failure is
// ERROR, never silently green" still holds: every attempt failing IS an error,
// and an ok-after-retry carries `retriedAfter` in the stored result so
// repeated wobble stays visible instead of self-healing into invisibility.
//
// Three, not two, and with a pause between them — both numbers measured
// rather than picked. OpenRouter answers a slow non-streaming request by
// sending runs of whitespace as keep-alive padding while the model thinks,
// then the JSON; the failure is that body arriving as padding ONLY, which
// `res.json()` cannot parse. Probed directly on the box: 12/12 identical
// calls succeeded in isolation, yet two scenarios failed BOTH attempts during
// a real suite run — so it is load-correlated, not random, and two
// back-to-back attempts land inside the same bad moment. The gap is what
// makes the third attempt a genuinely different sample.
const JUDGE_ATTEMPTS = 3;
const JUDGE_RETRY_DELAY_MS = 2000;

// The judge thinks for thousands of tokens before answering, and how long that
// takes is set by upstream load, not by the cap: the same prompt measured
// 49.8s at max_tokens 12000 and 12.5s at 24000, minutes apart. Against that,
// the 60s this used to allow was not a deadline, it was a coin toss — and
// losing it looked like a provider failure rather than our own timeout (see
// abortedMidBody in adapters/llm.js). Nobody is waiting on a nightly judgement,
// so the number that matters is "comfortably above the slow tail", not "fast".
const JUDGE_TIMEOUT_MS = 180_000;

// A quote must appear verbatim in something OLMA said. JUDGE_SYSTEM already
// demands it, and the reasoning-off probe showed exactly why the demand needs
// an enforcer: it quoted the user's message back as evidence against Olma. A
// rule the writer states and the reader never checks is worse than no rule.
// Whitespace is normalised (the model re-wraps), nothing else.
function normaliseForQuote(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function verifyProblems(problems, turns) {
  const said = turns.map((t) => normaliseForQuote(t.reply)).join(' \u0000 ');
  const kept = [];
  const dropped = [];
  for (const p of problems) {
    const q = normaliseForQuote(p && p.quote);
    // A problem with no quote at all cannot be checked and cannot be acted
    // on — the rubric requires one, so it is not evidence.
    if (q && said.includes(q)) kept.push(p);
    else dropped.push({ rule: (p && p.rule) || '', quote: (p && p.quote) || '' });
  }
  return { kept, dropped };
}

// Judge one scenario's conversation against its rubric. Returns
// { ok, verdict, problems, usage } — an unparseable reply is ok:false, and the
// caller treats that as a harness ERROR, never a silent pass (llm.js's rule:
// an unparseable reply is a failed run, not an empty one).
async function judgeScenario(scenario, turns, deps = {}) {
  const complete = deps.complete || llm.complete;
  const conversation = turns
    .map((t) => `משתמש: ${t.message}\nאולמה: ${t.reply || '(אין תשובה)'}`)
    .join('\n---\n');
  const attempts = deps.judgeAttempts || JUDGE_ATTEMPTS;
  const delayMs = deps.judgeRetryDelayMs === undefined ? JUDGE_RETRY_DELAY_MS : deps.judgeRetryDelayMs;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let firstError = null;
  let lastError = 'judge never ran';
  // Two failure classes, two different retries. Transport wobble (OpenRouter's
  // whitespace keep-alive padding arriving alone) is fixed by waiting and
  // asking again — the delay is the whole remedy. Truncation is not wobble at
  // all: the budget was the cause, so the retry has to raise it or it is just
  // buying the same failure again.
  let maxTokens = deps.judgeMaxTokens || JUDGE_MAX_TOKENS;
  for (let i = 0; i < attempts; i++) {
    if (i > 0 && delayMs) await sleep(delayMs);
    const out = await judgeOnce(scenario, conversation, turns, complete, { ...deps, judgeMaxTokens: maxTokens });
    if (out.ok) {
      if (firstError) out.retriedAfter = firstError;
      return out;
    }
    if (out.truncated) maxTokens = Math.max(maxTokens, deps.judgeTruncationMaxTokens || JUDGE_TRUNCATION_MAX_TOKENS);
    lastError = out.error;
    if (firstError === null) firstError = out.error;
  }
  return { ok: false, error: lastError, attempts };
}

// A single judge attempt — judgeScenario owns the retry around it.
async function judgeOnce(scenario, conversation, turns, complete, deps) {
  const res = await complete({
    provider: 'openrouter',
    model: deps.judgeModel || JUDGE_MODEL,
    system: JUDGE_SYSTEM,
    user: `רובריקה:\n${scenario.rubric}\n\nהשיחה:\n${conversation}`,
    maxTokens: deps.judgeMaxTokens || JUDGE_MAX_TOKENS,
    timeoutMs: JUDGE_TIMEOUT_MS,
  });
  if (!res.ok) return { ok: false, error: res.error };
  const truncated = res.finishReason === 'length';
  // Named separately from "unparseable": an empty body from a reasoning model
  // means the token budget ran out before the answer, and the fix is the cap,
  // not the prompt. The first version said only "unparseable" and cost a
  // morning of guessing. finishReason removes the "likely" — when the
  // provider says 'length', truncation is a fact, not an inference.
  if (!String(res.text || '').trim()) {
    return {
      ok: false,
      truncated,
      error: truncated
        ? 'judge hit max_tokens before emitting any content (finish_reason=length)'
        : 'judge returned no content — reasoning likely consumed max_tokens',
    };
  }
  const parsed = llm.parseJsonObject(res.text);
  if (!parsed || (parsed.verdict !== 'pass' && parsed.verdict !== 'concern')) {
    return {
      ok: false,
      truncated,
      error: truncated
        ? 'judge JSON cut mid-object by max_tokens (finish_reason=length)'
        : 'judge reply unparseable',
    };
  }
  const raw = Array.isArray(parsed.problems) ? parsed.problems.slice(0, 5) : [];
  const { kept, dropped } = verifyProblems(raw, turns);
  return {
    ok: true,
    // Only verified problems can make a scenario yellow. Every problem
    // dropped means the judge failed its own evidence rule.
    verdict: kept.length ? 'concern' : 'pass',
    problems: kept,
    unverified: dropped,
    usage: res.usage,
    model: res.model,
  };
}

// What the eval user's record looked like when a check failed. The first
// nightly run recorded `bare-time-shift: a task exists at 15:00 in HER
// timezone — failed` and nothing else; by morning the next scenario's reset
// had wiped the evidence, so there was no way to tell "saved nothing" from
// "saved the wrong hour" without re-running and hoping to reproduce (it did
// not — the model got it right the second time). A red nobody can diagnose
// the next morning is the same dead end as an issue list nobody reads.
// Small and bounded: this rides in the result row.
// Each section is collected independently, and that is the point rather than
// a style choice. These used to share one try/catch in sequence, so the
// contacts query naming a column that does not exist (`name`; it is
// `display_name`) threw and took everything AFTER it with it — contacts and
// paused were missing from every snapshot ever recorded, and the one scenario
// that is entirely about contacts lost exactly the evidence it exists to
// keep. A diagnostic that fails whole is worse than one that fails in part:
// it turns "here is what the DB looked like" into "error", which is the
// shape of every failure this suite has had to chase twice.
const SNAPSHOT_SECTIONS = [
  ['tasks', `SELECT id, title, due_at,
                    to_char(due_at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') AS local
               FROM tasks WHERE owner_id = $1 ORDER BY id LIMIT 10`],
  ['facts', `SELECT category, fact FROM user_facts
              WHERE user_id = $1 AND active = true LIMIT 10`],
  ['contacts', `SELECT display_name, phone FROM user_contacts
                 WHERE user_id = $1 LIMIT 10`],
  // task_reminders has no user_id — it hangs off the task. Writing one here
  // was the first thing this rewrite got wrong, which is the same mistake
  // the section above exists because of.
  ['reminders', `SELECT r.id, r.task_id, r.remind_at, r.repeat_rule, r.sent_at,
                        to_char(r.remind_at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') AS local
                   FROM task_reminders r JOIN tasks t ON t.id = r.task_id
                  WHERE t.owner_id = $1 AND r.cancelled_at IS NULL
                  ORDER BY r.id LIMIT 10`],
  ['paused', `SELECT paused_at IS NOT NULL AS paused FROM users WHERE id = $1`],
];

async function stateSnapshot(client, userId) {
  const snap = {};
  for (const [key, sql] of SNAPSHOT_SECTIONS) {
    try {
      const { rows } = await client.query(sql, [userId]);
      snap[key] = key === 'paused' ? Boolean(rows[0] && rows[0].paused) : rows;
    } catch (e) {
      // Named per section, so the next schema drift says WHICH part went
      // missing instead of blanking the whole record.
      snap[`${key}_error`] = String(e.message).slice(0, 200);
    }
  }
  return snap;
}

// Run ONE scenario end to end: reset → seed → card refresh → turns → hard
// checks → judge. Returns a result row (not yet persisted). Never throws for
// a scenario-level failure — a broken turn is a result with status 'error',
// so one dead scenario cannot silence the seven behind it (the drainOnce
// lesson, applied here from day one).
async function runScenario(pool, user, scenario, deps = {}) {
  const started = Date.now();
  const result = { scenario: scenario.id, status: 'error', hardFailures: [], judge: null, reply: null };
  try {
    await withTx(pool, async (c) => {
      await resetEvalUser(c, user.id);
      if (scenario.seed) await scenario.seed(c, user.id);
    });
    // Outside the transaction — the card must reflect committed seed state
    // (the planning-pass lesson: a card rendered inside the tx cannot see it).
    await refreshUserCard(pool, user.id);

    const runTurn = deps.runTurn
      || makeTurnRunner({
        agentId: user.agent_id,
        sessionKey: `agent:${user.agent_id}:eval-${scenario.id}-${Date.now()}`,
        model: deps.agentModel,
      });

    const turns = [];
    for (const message of scenario.turns) {
      const t = await runTurn(message);
      turns.push({ message, reply: t.reply, toolCalls: t.toolCalls || [] });
      result.model = t.model || result.model;
    }
    // startedAt scopes any check that reads an append-only table: resetEvalUser
    // clears the user's DATA but deliberately not their audit trail, so
    // "an audit row exists" would otherwise be satisfiable by an earlier
    // scenario in the same run.
    const ctx = {
      userId: user.id, turns, toolCalls: turns.flatMap((t) => t.toolCalls),
      startedAt: new Date(started).toISOString(),
    };
    result.reply = turns.length ? turns[turns.length - 1].reply : null;

    const client = await pool.connect();
    let checks;
    try {
      checks = await scenario.hard(client, ctx);
      result.hardFailures = checks.filter((c) => !c.pass).map((c) => ({ name: c.name, detail: c.detail }));
      // Only on failure: a green scenario needs no autopsy, and the snapshot
      // is read on the SAME connection, before the next scenario's reset.
      if (result.hardFailures.length) result.snapshot = await stateSnapshot(client, user.id);
    } finally { client.release(); }

    if (result.hardFailures.length) {
      result.status = 'red';
    } else if (deps.skipJudge) {
      result.status = 'green';
      result.judge = { skipped: true };
    } else {
      const judged = await judgeScenario(scenario, turns, deps);
      if (!judged.ok) {
        result.status = 'error';
        result.judge = { error: judged.error };
      } else {
        result.status = judged.verdict === 'concern' ? 'yellow' : 'green';
        result.judge = { verdict: judged.verdict, problems: judged.problems };
        // A first attempt that failed rides along in the result — repeated
        // wobble must stay diagnosable, not self-heal into invisibility.
        if (judged.retriedAfter) result.judge.retriedAfter = judged.retriedAfter;
        // Kept visible rather than swallowed: a judge that keeps citing
        // quotes nobody said is itself the finding.
        if (judged.unverified && judged.unverified.length) result.judge.unverified = judged.unverified;
        if (judged.usage) {
          await withTx(pool, (c) => llm.recordUsage(c, user.id, judged.model || JUDGE_MODEL, judged.usage))
            .catch(() => { /* usage lags one run; the eval result matters more */ });
        }
      }
    }
  } catch (e) {
    result.status = 'error';
    result.error = String(e.message).slice(0, 300);
  }
  result.durationMs = Date.now() - started;
  return result;
}

module.exports = {
  EVAL_PHONE, JUDGE_MODEL, TURN_TIMEOUT_MS,
  getEvalUser, resetEvalUser, runScenario, judgeScenario,
  makeTurnRunner, toolCallsInSlice, JUDGE_SYSTEM,
  verifyProblems, stateSnapshot, JUDGE_MAX_TOKENS, JUDGE_TRUNCATION_MAX_TOKENS,
  JUDGE_ATTEMPTS, JUDGE_TIMEOUT_MS,
  JUDGE_RETRY_DELAY_MS,
};
