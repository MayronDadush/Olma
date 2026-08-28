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
function makeTurnRunner({ agentId, sessionKey }) {
  let offset = 0;
  let sessionFile = null;
  return async function runTurn(message) {
    const json = await runOpenclawJson(
      ['agent', '--agent', agentId, '--session-key', sessionKey, '--message', message, '--json'],
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

// Judge one scenario's conversation against its rubric. Returns
// { ok, verdict, problems, usage } — an unparseable reply is ok:false, and the
// caller treats that as a harness ERROR, never a silent pass (llm.js's rule:
// an unparseable reply is a failed run, not an empty one).
async function judgeScenario(scenario, turns, deps = {}) {
  const complete = deps.complete || llm.complete;
  const conversation = turns
    .map((t) => `משתמש: ${t.message}\nאולמה: ${t.reply || '(אין תשובה)'}`)
    .join('\n---\n');
  const res = await complete({
    provider: 'openrouter',
    model: deps.judgeModel || JUDGE_MODEL,
    system: JUDGE_SYSTEM,
    user: `רובריקה:\n${scenario.rubric}\n\nהשיחה:\n${conversation}`,
    maxTokens: 700,
    timeoutMs: 60_000,
  });
  if (!res.ok) return { ok: false, error: res.error };
  const parsed = llm.parseJsonObject(res.text);
  if (!parsed || (parsed.verdict !== 'pass' && parsed.verdict !== 'concern')) {
    return { ok: false, error: 'judge reply unparseable' };
  }
  const problems = Array.isArray(parsed.problems) ? parsed.problems.slice(0, 5) : [];
  return {
    ok: true,
    verdict: problems.length ? 'concern' : parsed.verdict,
    problems,
    usage: res.usage,
    model: res.model,
  };
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
      || makeTurnRunner({ agentId: user.agent_id, sessionKey: `agent:${user.agent_id}:eval-${scenario.id}-${Date.now()}` });

    const turns = [];
    for (const message of scenario.turns) {
      const t = await runTurn(message);
      turns.push({ message, reply: t.reply, toolCalls: t.toolCalls || [] });
      result.model = t.model || result.model;
    }
    const ctx = { userId: user.id, turns, toolCalls: turns.flatMap((t) => t.toolCalls) };
    result.reply = turns.length ? turns[turns.length - 1].reply : null;

    const client = await pool.connect();
    let checks;
    try { checks = await scenario.hard(client, ctx); } finally { client.release(); }
    result.hardFailures = checks.filter((c) => !c.pass).map((c) => ({ name: c.name, detail: c.detail }));

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
};
