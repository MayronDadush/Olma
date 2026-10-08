'use strict';
// Jev in SHADOW beside the two judgements about a fact that code cannot make.
// The same rung as jobs/twin-shadow.js: Jev answers on real rows, the answer is
// written down beside what the code knew, and NOTHING reads it to decide
// anything. No refusal, no expiry, no merge, no change to what a tool returns.
//
// Why these two. The write gate in domain/facts.js (2026-10-08) refuses what a
// pattern can see. It cannot see that "הולכת לניתוח" is an event rather than a
// trait (no date in the words, importance 3, on a card for ever), or that
// "לסבתא שלי יש מכשיר שמיעה" and "לסבתא יש מכשיר שמיעה וצריך אוזניות" are one
// fact (task-similarity caught 1 of 4 such pairs). Both are closed questions,
// which is all Jev answers.
//   lifespan  event | lasting | other
//   twin      which of their OTHER facts is the same one, or none
//
// Why a sweep and not inside rememberFact: the door runs inside a tool call
// with a person waiting, and a shadow that adds a vendor to that path is a rung
// 2 risk bought for a rung 1 answer.
//
// What leaves the box: the words of one new fact and the person's other facts,
// to OpenRouter — a larger step than task titles (facts hold health and
// family). Hence OFF by default (`jev_shadow_facts`), read every tick, and
// never profile-page answers (their key says they are a standing answer) nor
// the eval user nor is_test accounts. Turning it on is the owner's decision.
//
// Same failure rules as twin-shadow: an outage writes nothing and stops the
// tick, a failure about THIS input is one error row, every call is on the
// ledger at the price OpenRouter stated.
const flags = require('../domain/flags');
const sim = require('../domain/task-similarity');
const jev = require('../adapters/jev');
const { recordUsage, isOutage, AGENT_ID } = require('./twin-shadow');

const FLAG = 'jev_shadow_facts';
const WINDOW_HOURS = 24;
const PER_TICK = 10;
const TICK_BUDGET_MS = 60_000;
const MAX_LIST = 60;
const LIFE = ['event', 'lasting', 'other'];

async function candidates(client, limit) {
  const { rows } = await client.query(
    `SELECT f.id, f.user_id AS owner_id, f.fact, f.learned_at, (f.expires_at IS NOT NULL) AS dated
       FROM user_facts f JOIN users u ON u.id = f.user_id
      WHERE f.active AND f.prompt_key IS NULL AND NOT u.is_eval AND NOT u.is_test
        AND f.learned_at > now() - ($1::int * interval '1 hour')
        AND NOT EXISTS (SELECT 1 FROM fact_shadow s WHERE s.fact_id = f.id)
      ORDER BY f.learned_at, f.id
      LIMIT $2`, [WINDOW_HOURS, limit]);
  return rows;
}

// Their other facts as they stood when this one was written: earlier, still
// active now, and not already over. Rebuilt from timestamps, so one forgotten
// since is missing, which errs toward "no twin".
async function othersAt(client, fact) {
  const { rows } = await client.query(
    `SELECT id, fact FROM user_facts
      WHERE user_id = $1 AND id <> $2 AND active AND learned_at < $3
        AND (expires_at IS NULL OR expires_at > $3)
      ORDER BY learned_at DESC, id DESC
      LIMIT $4`, [fact.owner_id, fact.id, fact.learned_at, MAX_LIST]);
  return rows;
}

function codeVerdict(text, list) {
  let twin = null;
  let best = null;
  for (const row of list) {
    const v = sim.compare(text, row.fact);
    const score = sim.textScore(text, row.fact);
    if (!best || score > best.score) best = { id: row.id, score };
    if (v.same && (!twin || v.text > twin.score)) twin = { id: row.id, score: v.text };
  }
  return { twin, best };
}

function questionFor(text, list) {
  const options = {};
  list.forEach((row, i) => { options[`f${i + 1}`] = row.fact; });
  const questions = {
    life: {
      type: 'choice',
      instructions: 'new_fact is something an assistant noted about a person. Is it tied to one particular occasion and stops being true once that has happened, or does it stay true for months or longer?',
      criteria: {
        event: 'a one-off event, appointment, trip, errand, procedure or situation tied to a particular occasion; it stops being true once it has happened',
        lasting: 'a lasting trait, habit, relationship, ability, condition or standing preference that stays true for months or longer',
        other: 'not a statement about the person at all, such as a request, an instruction or a reminder',
      },
    },
  };
  if (list.length) {
    questions.twin = {
      type: 'choice',
      instructions: 'new_fact was just noted about a person. Which entry in other_facts says the SAME thing, already on file — or none of them?',
      criteria: { ...options, none: 'none of the other facts says the same thing as new_fact' },
    };
  }
  return {
    state: { new_fact: text, ...(list.length ? { other_facts: options } : {}) },
    questions,
    idFor: (key) => {
      const m = /^f(\d+)$/.exec(String(key));
      const row = m && list[Number(m[1]) - 1];
      return row ? row.id : null;
    },
  };
}

async function writeRow(client, fact, list, code, j) {
  await client.query(
    `INSERT INTO fact_shadow
       (fact_id, owner_id, list_size, code_dated, code_twin_id, code_twin_score,
        code_best_id, code_best_score, jev_life, jev_life_conf, jev_twin_id, jev_twin_conf,
        jev_model, jev_error, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (fact_id) DO NOTHING`,
    [fact.id, fact.owner_id, list.length, fact.dated,
      code.twin ? code.twin.id : null, code.twin ? code.twin.score.toFixed(4) : null,
      code.best ? code.best.id : null, code.best ? code.best.score.toFixed(4) : null,
      j.life ?? null, j.lifeConf ?? null, j.twinId ?? null, j.twinConf ?? null,
      j.model ?? null, j.error ?? null, j.ms ?? null]);
}

const conf = (p) => (p && p.confidence != null ? p.confidence.toFixed(4) : null);

async function sweepFactShadow(client, { decide = jev.decide, now = () => Date.now() } = {}) {
  const on = await flags.getFlag(client, FLAG);
  if (on !== true && on !== 'true') return { off: true };
  const started = now();
  const out = { asked: 0, errors: 0 };
  for (const fact of await candidates(client, PER_TICK)) {
    if (now() - started > TICK_BUDGET_MS) { out.budget = true; break; }
    const list = await othersAt(client, fact);
    const code = codeVerdict(fact.fact, list);
    const q = questionFor(fact.fact, list);
    const res = await decide(q.state, q.questions);
    if (!res.ok) {
      if (isOutage(res.error)) { out.unreachable = res.error; break; }
      await writeRow(client, fact, list, code, { error: res.error, ms: res.ms });
      out.errors += 1;
      continue;
    }
    await recordUsage(client, res);
    const life = jev.choiceOf(res.answers.life);
    const twin = list.length ? jev.choiceOf(res.answers.twin) : null;
    const twinId = twin ? q.idFor(twin.choice) : null;
    // A key outside what it was given is the endpoint answering something else,
    // recorded as what it is — never read as "event", "lasting" or "none".
    if (!life || !LIFE.includes(life.choice) || (twin && twin.choice !== 'none' && twinId == null)) {
      await writeRow(client, fact, list, code, { model: res.model || null, error: 'unknown_choice', ms: res.ms });
      out.errors += 1;
      continue;
    }
    await writeRow(client, fact, list, code, {
      life: life.choice, lifeConf: conf(life), twinId, twinConf: conf(twin),
      model: res.model || null, ms: res.ms,
    });
    out.asked += 1;
  }
  return out;
}

module.exports = {
  sweepFactShadow, candidates, othersAt, codeVerdict, questionFor, FLAG, WINDOW_HOURS, PER_TICK,
  AGENT_ID,
};
