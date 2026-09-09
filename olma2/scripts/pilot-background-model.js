#!/usr/bin/env node
// Background-model pilot — the counterpart to scripts/run-evals.js, for the
// OTHER half of the model bill.
//
// `run-evals --model` and `model-pilot.js` both drive the AGENT turn: the
// gateway, ~59 tools, a real workspace. Nothing measured the background path,
// which is a different animal entirely — direct `llm.complete` calls with no
// tools, whose whole contract is "return one JSON object my validator
// accepts". Five jobs ride it (fact-extraction, planning, live-updates,
// voice-calls, efficiency-watch) and every one of them is written to fail
// SOFT: a reply that does not parse is caught, logged and skipped. So a
// background model that cannot hold JSON does not break anything visibly —
// it just quietly stops the memory, the plans and the summaries from being
// written, which is the hardest possible failure to notice.
//
// Usage:
//   node scripts/pilot-background-model.js --model nex-agi/nex-n2.5-mini:free
//   node scripts/pilot-background-model.js            # the live flag, as a baseline
//
// Safety properties, each deliberate:
//
// - **Nothing is routed anywhere.** The model is passed per call. The
//   `background_llm` flag is untouched; switching it is a separate act.
// - **No real person's words leave the box.** Every scenario runs on a FIXTURE
//   written for this file, through the real prompt builders. That is not
//   squeamishness: a candidate model is a new vendor, and sending twenty real
//   conversations to one to find out whether its JSON parses is a decision
//   that belongs to the owner, not to a benchmark. The efficiency brief is the
//   exception only because it is numbers by construction.
// - **It writes nothing.** No ledger row, no issue, no plan. A pilot that
//   recorded its own usage would land in `usage_system_ledger` and move the
//   very ratios the efficiency watch reads.
//
// Judge it the way docs/model-experiments.md prescribes, in this order: hard
// checks (does the real validator accept the reply), then quality (Hebrew, and
// whether it found what was in front of it), then latency and price. A free
// model that returns prose instead of JSON costs more than a paid one, because
// what it costs is the feature.
'use strict';
const { createPool } = require('../src/db/pool');
const llm = require('../src/adapters/llm');
const factExtraction = require('../src/jobs/fact-extraction');
const planning = require('../src/jobs/planning');
const efficiency = require('../src/jobs/efficiency-watch');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

// Each scenario carries the maxTokens its REAL job passes, because that is
// the number the model has to succeed inside. This comment was true of only
// one of the three when it was written: fact-extraction and planning passed
// NO cap at all, so their real ceiling was the adapter's `maxTokens || 2048`
// default and the harness measured them at 2000 and 1500 against it. The
// constant is imported now rather than copied, so the harness cannot drift
// from the jobs again. `--budget <n>` multiplies them
// all, which exists to answer one specific question and no other: when a
// reasoning model returns nothing, is it unable to do the task or did it
// spend the answer on thinking? Those are different findings and only the
// second is fixable from our side (by raising the job's own cap, which costs
// latency on every call). Never report a `--budget` run as the model's score
// at production settings.
const BUDGET = Number(process.argv[process.argv.indexOf('--budget') + 1]) || 1;

const TZ = 'Asia/Jerusalem';
// Pinned, not `Date.now()`: two scenarios put "now" in the prompt and score
// what the model does with a relative moment, and a run whose answer depends
// on the hour it happened at is not a measurement.
const NOW = Date.parse('2026-09-09T09:00:00+03:00');
const DAY = 86_400_000;

// ── the fixtures ─────────────────────────────────────────────────────────────
// Written to look like the real thing and to contain KNOWN answers, so a
// scenario can score more than "it did not crash". Every one of them is
// invented; any resemblance to a real user is the point and not a leak.

const CONVERSATION = [
  { role: 'user', text: 'היי, קוראים לי תמר. אני עובדת בבית חולים בחיפה, אחות במיון',
    at: NOW - 3 * 3600_000 },
  { role: 'assistant', text: 'נעים מאוד תמר 🙂', at: NOW - 3 * 3600_000 + 30_000 },
  { role: 'user', text: 'תזכירי לי מחר בבוקר להתקשר לביטוח לאומי, זה דחוף',
    at: NOW - 2 * 3600_000 },
  { role: 'user', text: 'אני לא זמינה בשישי בכלל, יש לי משמרות לילה כל סוף השבוע',
    at: NOW - 90 * 60_000 },
];

const EXISTING_FACTS = [
  { id: 41, category: 'work', fact: 'עובדת במשמרות' },
];

const OPEN_TASKS = [
  { id: 900, title: 'לחדש רישיון נהיגה', parent_id: null, due_at: null, age_days: 12 },
  { id: 901, title: 'לקבוע תור לרופא שיניים', parent_id: null,
    due_at: new Date(NOW + DAY).toISOString(), age_days: 3 },
];

// ── the scenarios ────────────────────────────────────────────────────────────
// Each returns { prompt, maxTokens, score(text) }. `score` gets the raw reply
// and returns { hard: [...failures], notes: [...] } — hard failures are the
// ones that would make the real job discard the answer.

const SCENARIOS = [
  {
    id: 'fact-extraction',
    // The biggest consumer and the one with teeth: what it returns becomes
    // rows in `facts` and `tasks`, i.e. things Olma later says out loud.
    why: 'writes facts and tasks; a wrong date here becomes a reminder at the wrong hour',
    maxTokens: llm.BACKGROUND_MAX_TOKENS,
    build: () => factExtraction.buildInstruction(
      factExtraction.renderTranscript(CONVERSATION, TZ),
      EXISTING_FACTS, OPEN_TASKS, {}, [], { now: NOW, tz: TZ }
    ),
    score(text) {
      const hard = []; const notes = [];
      const p = llm.parseJsonObject(text);
      if (!p) return { hard: ['reply is not one JSON object — the job discards it'], notes };
      if (!Array.isArray(p.facts)) hard.push('facts is not an array');
      if (!Array.isArray(p.tasks)) hard.push('tasks is not an array');
      if (hard.length) return { hard, notes };

      // It was told her name in the first line, and the profile passed in has
      // none — so `name` is the field it is being asked to fill.
      const first = p.name && typeof p.name === 'object' ? String(p.name.first || '') : '';
      if (first !== 'תמר') hard.push(`name.first should be "תמר", got ${JSON.stringify(p.name)}`);

      // Two facts are in front of it: she is a nurse in Haifa, and she is
      // unavailable on Fridays. #41 is already known and must NOT come back.
      const factText = p.facts.map((f) => String(f && f.fact || '')).join(' | ');
      if (!/אחות|מיון|בית חולים/.test(factText)) notes.push('missed her job');
      if (!/שישי|סוף שבוע|משמרו?ת לילה/.test(factText)) notes.push('missed the Friday constraint');
      if (/עובדת במשמרות$/.test(factText)) notes.push('re-recorded known fact #41');

      // One task, and its moment is "מחר בבוקר" from a line stamped ~2h ago.
      // Scored through the REAL guard, not by eye: `usableDue` is what decides
      // whether the date survives into the row.
      if (!p.tasks.length) hard.push('found no task — "תזכירי לי מחר בבוקר" is one');
      for (const t of p.tasks) {
        if (t.due_at == null) { notes.push('task saved with no date (the safe failure)'); continue; }
        // Returns the raw STRING it accepted, or undefined — refusing a bare
        // local time with no offset is most of what it is for.
        const due = factExtraction.usableDue(t.due_at);
        if (!due) { hard.push(`due_at "${t.due_at}" is refused by usableDue`); continue; }
        const dayGap = Math.round((Date.parse(due) - NOW) / DAY);
        if (dayGap !== 1) notes.push(`due_at resolved ${dayGap} days out, expected 1`);
      }
      return { hard, notes };
    },
  },
  {
    id: 'planning',
    why: 'the overnight plan the assistant reads before speaking to them',
    maxTokens: llm.BACKGROUND_MAX_TOKENS,
    build: () => planning.buildBrief({
      user: { timezone: TZ, first_name: 'תמר' },
      tasks: OPEN_TASKS,
      reminders: [{ title: 'להתקשר לביטוח לאומי', remind_at: new Date(NOW + DAY).toISOString() }],
      events: [{ title: 'משמרת לילה', start: new Date(NOW + 2 * DAY).toISOString() }],
      facts: [{ fact: 'אחות במיון בחיפה' }],
      now: NOW,
    }),
    score(text) {
      const hard = []; const notes = [];
      const p = llm.parseJsonObject(text);
      if (!p) return { hard: ['reply is not one JSON object — the job discards it'], notes };
      // The real gate. `null` here means the plan is thrown away and the day
      // has none, which is the silent failure this whole script exists for.
      const plan = planning.validatePlan(p, OPEN_TASKS.map((t) => t.id));
      if (!plan) return { hard: ['validatePlan rejected it — no usable headline'], notes };
      if (!/[֐-׿]/.test(plan.headline)) hard.push('headline is not in Hebrew');
      if (plan.bullets.length > planning.MAX_BULLETS) hard.push('more bullets than the ceiling');
      // Padding is the measured failure of this prompt: six of the first seven
      // real plans came back at exactly the ceiling.
      if (plan.bullets.length === planning.MAX_BULLETS) notes.push('wrote exactly the ceiling — padding');
      if (!plan.taskFocus.length) notes.push('focused on no task, though two are open');
      // "never address anyone and never use their name" is in the prompt.
      if (/תמר/.test([plan.headline, ...plan.bullets].join(' '))) hard.push('used her name — the prompt forbids it');
      return { hard, notes };
    },
  },
  {
    id: 'efficiency-advice',
    // The only scenario built from real production numbers, because this
    // prompt carries no user content by construction — the same property that
    // makes it safe to send is why it is worth measuring on real figures.
    why: 'free-text advice an operator reads; the failure mode is a confident wrong cause',
    maxTokens: 2000,
    build: () => efficiency.briefFor(
      [{ key: 'cache_hit_rate', label: 'מטמון', now: 0.21, baseline: 0.70, times: 3.3,
         worse: 'lower', kind: 'trend',
         trend: { recentDays: 3, priorDays: 4,
                  series: [0.73, 0.64, 0.71, 0.46, 0.30, 0.31, 0.21].map((v, i) => ({ date: `d${i}`, value: v })) } }],
      { date: '2026-09-08', messages: 52, evalCost: 4.005, cache_hit_rate: 0.21 },
      { models: [{ model: 'deepseek/deepseek-v4-flash', inTokens: 2.6e6, cacheRate: 0.21, cost: 0.9136 }],
        users: [{ userId: 3, cost: 0.5, inTokens: 1.2e6 }] },
      39_146
    ),
    score(text) {
      const hard = []; const notes = [];
      const t = String(text || '').trim();
      if (!t) return { hard: ['empty reply'], notes };
      if (!/[֐-׿]/.test(t)) hard.push('answered in the wrong language — Hebrew was asked for');
      if (t.split('\n').filter((l) => l.trim()).length > 6) notes.push('longer than the 4 lines asked for');
      // The founding failure of this prompt, twice over: a six-day slide
      // explained by a same-day event, and "shorten the system prompt" for a
      // fall whose cached region WAS the system prompt.
      if (/פרומפט|prompt/i.test(t) && /קצר|לקצר|shorten/i.test(t)) {
        notes.push('proposed shortening the prompt — the 2026-09-04 wrong answer');
      }
      if (/היום|אתמול|שינוי של יום/.test(t) && !/מגמה|הדרגתי|לאורך/.test(t)) {
        notes.push('read a multi-day slide as a same-day event');
      }
      return { hard, notes };
    },
  },
];

// ── the run ──────────────────────────────────────────────────────────────────
(async () => {
  const asked = arg('model');
  const pool = createPool();
  const cfg = asked
    ? { provider: 'openrouter', model: asked }
    : await llm.backgroundModel(pool);
  console.log(asked
    ? `pilot: ${asked} (the background_llm flag is untouched)`
    : `baseline: the live background_llm flag — ${cfg.model || llm.DEFAULT_MODEL}`);
  console.log(BUDGET === 1
    ? 'token budgets: each job\'s real one\n'
    : `token budgets: ${BUDGET}x the real ones — a diagnostic run, not a score\n`);

  let hardTotal = 0;
  let cost = 0;
  for (const s of SCENARIOS) {
    const prompt = s.build();
    const t0 = Date.now();
    const res = await llm.complete({
      ...cfg, user: prompt, maxTokens: Math.round(s.maxTokens * BUDGET), timeoutMs: 180_000,
    });
    const ms = Date.now() - t0;

    if (!res.ok) {
      console.log(`⚠️  ${s.id}  (${Math.round(ms / 1000)}s) — ${res.error}`);
      hardTotal++;
      continue;
    }
    // A silent fallback would otherwise be recorded as a passing pilot for a
    // model that never ran — run-evals warns about exactly this.
    if (cfg.model && res.model && !String(res.model).includes(String(cfg.model).split(':')[0])) {
      console.log(`   ! asked for ${cfg.model}, the provider answered as ${res.model}`);
    }
    if (res.finishReason === 'length') {
      console.log(`   ! truncated at max_tokens — a reasoning model can spend the whole budget thinking`);
    }
    if (Number.isFinite(res.usage && res.usage.costUsd)) cost += res.usage.costUsd;

    const { hard, notes } = s.score(res.text);
    hardTotal += hard.length;
    const icon = hard.length ? '🔴' : notes.length ? '🟡' : '🟢';
    console.log(`${icon} ${s.id}  (${Math.round(ms / 1000)}s, ${res.usage.output} out)`);
    for (const h of hard) console.log(`     ✗ ${h}`);
    for (const n of notes) console.log(`     ~ ${n}`);
  }

  console.log(`\n${hardTotal} hard failure${hardTotal === 1 ? '' : 's'} · $${cost.toFixed(6)} for the run`);
  if (hardTotal) {
    console.log('A hard failure is the real job discarding the answer — silently, by design.');
  }
  await pool.end();
  process.exit(hardTotal ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
