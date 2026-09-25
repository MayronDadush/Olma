'use strict';
// Jev in SHADOW beside the duplicate-task judgement. Rung 1 of the owner's
// ladder (2026-09-24: "נתחיל בקטנה איתו ואז לאט לאט נוסיף אותו ליותר דברים"):
// Jev answers on real tasks, its answer is written down beside the code's,
// and NOTHING reads it to decide anything. No hint, no merge, no message, no
// change to what add_task returns. The only way this file can touch a person
// is the words of their task titles going to OpenRouter, which the owner
// allowed for exactly this on 2026-09-24.
//
// Why here and not inside add_task: the live tool runs under the MCP shim's
// 30s ceiling with a person waiting, and a shadow that adds ~200ms and a new
// vendor to that path is a rung-2 risk bought for a rung-1 answer. So this is
// a sweep that reads tasks AFTER they were written, rebuilds the list that was
// open at that moment, and asks both readers the same question about it.
//
// The question is the RANKING shape from run #91 (74 of 80 on the owner's
// labelled pairs): the new title against the whole open list, one choice of
// which entry is the same task, or none. The code's answer is
// task-similarity.compare against the same rows — the function add_task uses.
//
// Five things it does on purpose:
//   - OFF by default (`jev_shadow_twins`), read every tick, so the owner turns
//     it on and off from the dashboard with no deploy;
//   - the eval user and accounts marked is_test are never asked about — a
//     benchmark's tasks and a developer's are not data;
//   - one row per task, ids only (migration 091); a failure the endpoint will
//     repeat for this input (a 4xx) is written as an error row so the task is
//     asked once, while an outage (no key, timeout, 5xx, 429, 404, 401) writes
//     nothing and stops the tick, so those tasks are asked again next time;
//   - an outage is a NOTE on the heartbeat and never a throw: a thing that
//     could not be read is not a thing in trouble (rules/detectors.md);
//   - every successful call goes on usage_system_ledger at the price OpenRouter
//     stated, so the cost page shows it and a runaway is visible.
const flags = require('../domain/flags');
const sim = require('../domain/task-similarity');
const jev = require('../adapters/jev');

const FLAG = 'jev_shadow_twins';
const AGENT_ID = 'jev-shadow';
// A task is asked about within a day of being written or never: the list it is
// compared against is rebuilt from timestamps, and that gets less honest the
// longer ago the moment was.
const WINDOW_HOURS = 24;
const PER_TICK = 10;
// Stop asking once a tick has spent this long, whatever is left. The sweep
// holds one pool connection while it runs, and the next tick picks up the rest.
const TICK_BUDGET_MS = 60_000;
const MAX_LIST = 60;
// OpenRouter's stated price, used only when a response carried no cost.
const FALLBACK_USD_PER_INPUT_TOKEN = 0.042 / 1e6;

// An outage: stop, write nothing, ask again next tick. A 404 is one too — the
// endpoint is alpha, and "not there" is about the endpoint, not the task.
// Anything else from it is about THIS input, and asking again would get the
// same answer.
function isOutage(error) {
  return error === 'no_key' || error === 'timeout' || error === 'network'
    || error === 'http_401' || error === 'http_404' || error === 'http_429'
    || /^http_5\d\d$/.test(String(error));
}

async function candidates(client, limit) {
  const { rows } = await client.query(
    `SELECT t.id, t.owner_id, t.title, t.created_at
       FROM tasks t JOIN users u ON u.id = t.owner_id
      WHERE t.parent_id IS NULL AND NOT u.is_eval AND NOT u.is_test
        AND t.created_at > now() - ($1::int * interval '1 hour')
        AND NOT EXISTS (SELECT 1 FROM task_twin_shadow s WHERE s.task_id = t.id)
      ORDER BY t.created_at, t.id
      LIMIT $2`, [WINDOW_HOURS, limit]);
  return rows;
}

// What was open, at the top level, at the moment the task was written — the
// list add_task's findTwin read then (open only; it widens to done rows for
// the extraction pass alone). Rebuilt from timestamps, so a row since deleted
// outright is missing from it, which is rare and errs toward "no twin".
async function openListAt(client, task) {
  const { rows } = await client.query(
    `SELECT id, title FROM tasks
      WHERE owner_id = $1 AND parent_id IS NULL AND id <> $2
        AND created_at < $3
        AND (archived_at IS NULL OR archived_at > $3)
        AND (status = 'open' OR (completed_at IS NOT NULL AND completed_at > $3))
      ORDER BY created_at DESC, id DESC
      LIMIT $4`, [task.owner_id, task.id, task.created_at, MAX_LIST]);
  return rows;
}

// The code's answer over that list, the way findTwin picks it, plus the
// closest row by words even when that is not a merge — the band just under
// the line is where a disagreement would be worth reading.
function codeVerdict(title, list) {
  let twin = null;
  let best = null;
  for (const row of list) {
    const v = sim.compare(title, row.title);
    const score = sim.textScore(title, row.title);
    if (!best || score > best.score) best = { id: row.id, score };
    if (v.same && (!twin || v.text > twin.score)) twin = { id: row.id, reason: v.reason, score: v.text };
  }
  return { twin, best };
}

function rankQuestion(title, list) {
  const options = {};
  list.forEach((row, i) => { options[`t${i + 1}`] = row.title; });
  return {
    state: { new_title: title, open_list: options },
    questions: {
      dup: {
        type: 'choice',
        instructions: 'new_title is a task somebody just asked to save. Which entry in open_list is the SAME task, already on their list — or none of them?',
        criteria: { ...options, none: 'none of the open tasks is the same task as new_title' },
      },
    },
    idFor: (key) => {
      const m = /^t(\d+)$/.exec(String(key));
      const row = m && list[Number(m[1]) - 1];
      return row ? row.id : null;
    },
  };
}

async function recordUsage(client, res) {
  const cost = res.usage.costUsd != null
    ? { usd: res.usage.costUsd, estimated: false }
    : { usd: res.usage.input * FALLBACK_USD_PER_INPUT_TOKEN, estimated: true };
  await client.query(
    `INSERT INTO usage_system_ledger (agent_id, date, model, input_tokens, output_tokens, cost_usd, estimated)
     VALUES ($1, current_date, $2, $3, $4, $5, $6)
     ON CONFLICT (agent_id, date, model) DO UPDATE SET
       input_tokens = usage_system_ledger.input_tokens + $3,
       output_tokens = usage_system_ledger.output_tokens + $4,
       cost_usd = usage_system_ledger.cost_usd + $5,
       estimated = usage_system_ledger.estimated OR $6`,
    [AGENT_ID, res.model || jev.DEFAULT_MODEL, res.usage.input, res.usage.output,
      Number(cost.usd).toFixed(8), cost.estimated]);
}

async function writeRow(client, task, list, code, jevPart) {
  await client.query(
    `INSERT INTO task_twin_shadow
       (task_id, owner_id, list_size, code_twin_id, code_reason, code_score,
        code_best_id, code_best_score, jev_pick_id, jev_confidence, jev_model, jev_error, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (task_id) DO NOTHING`,
    [task.id, task.owner_id, list.length,
      code.twin ? code.twin.id : null, code.twin ? code.twin.reason : null,
      code.twin ? code.twin.score.toFixed(4) : null,
      code.best ? code.best.id : null, code.best ? code.best.score.toFixed(4) : null,
      jevPart.pickId, jevPart.confidence, jevPart.model, jevPart.error, jevPart.ms]);
}

async function sweepTwinShadow(client, { decide = jev.decide, now = () => Date.now() } = {}) {
  const on = await flags.getFlag(client, FLAG);
  if (on !== true && on !== 'true') return { off: true };
  const started = now();
  const out = { asked: 0, agreed: 0, differed: 0, noList: 0, errors: 0 };
  for (const task of await candidates(client, PER_TICK)) {
    if (now() - started > TICK_BUDGET_MS) { out.budget = true; break; }
    const list = await openListAt(client, task);
    const code = codeVerdict(task.title, list);
    if (!list.length) {
      // Nothing to be a duplicate of: no call, and the row says so.
      await writeRow(client, task, list, code, { pickId: null, confidence: null, model: null, error: null, ms: null });
      out.noList += 1;
      continue;
    }
    const q = rankQuestion(task.title, list);
    const res = await decide(q.state, q.questions);
    if (!res.ok) {
      if (isOutage(res.error)) { out.unreachable = res.error; break; }
      await writeRow(client, task, list, code, { pickId: null, confidence: null, model: null, error: res.error, ms: res.ms ?? null });
      out.errors += 1;
      continue;
    }
    await recordUsage(client, res);
    const pick = jev.choiceOf(res.answers.dup);
    const pickId = pick ? q.idFor(pick.choice) : null;
    if (pick && pick.choice !== 'none' && pickId == null) {
      // A key that names no row is the endpoint answering outside the list it
      // was given — recorded as what it is, never as "none".
      await writeRow(client, task, list, code, { pickId: null, confidence: null, model: res.model, error: 'unknown_choice', ms: res.ms });
      out.errors += 1;
      continue;
    }
    await writeRow(client, task, list, code, {
      pickId,
      confidence: pick && pick.confidence != null ? pick.confidence.toFixed(4) : null,
      model: res.model || null, error: null, ms: res.ms,
    });
    out.asked += 1;
    const codeId = code.twin ? String(code.twin.id) : null;
    if ((pickId == null ? null : String(pickId)) === codeId) out.agreed += 1;
    else out.differed += 1;
  }
  return out;
}

module.exports = {
  sweepTwinShadow, codeVerdict, rankQuestion, openListAt, candidates, isOutage,
  FLAG, AGENT_ID, WINDOW_HOURS, PER_TICK,
};
