#!/usr/bin/env node
// Jev pilot — measuring a DECISION model against the judgements this repo
// already makes in code.
//
// Jev (Typesafe, `typesafe/jev-1.13` on OpenRouter) is not a chat model. It
// reads text and answers only closed questions — a choice from a list, a score
// on a scale, a yes/no probability — and cannot write a word. So it can never
// replace a call that returns prose (every direct model call in olma2 does),
// and the only place it could earn one is a judgement the CODE makes badly.
// This repo has exactly one such judgement with an answer key: "is this the
// same task in other words" (domain/task-similarity.js), tuned on 86 pairs the
// owner labelled by hand on 2026-09-18 and missing eight rewordings on
// purpose. That is step 2, and it is the reason this file exists.
//
// Everything else here is measured because it was cheap to ask on the same
// call, and because the numbers decide whether a second PR exists at all
// (docs/model-experiments.md, run #81). Hebrew is the whole question: the
// vendor says English is the primary training language and "other languages
// are handled but not equally well", and nobody has measured Hebrew.
//
// Usage:
//   node scripts/pilot-jev.js                      # every step; needs OLMA_DB_URL for 3-6
//   node scripts/pilot-jev.js --skip-db            # steps 0-2 only, no database
//   node scripts/pilot-jev.js --limit 200          # titles read for steps 3-4 (default 200)
//   node scripts/pilot-jev.js --group <user_id>    # step 6, topic grouping on one open list
//   node scripts/pilot-jev.js --only 0,1,2         # a subset of steps
//   node scripts/pilot-jev.js --model typesafe/jev-1.13   # the model id (default)
//
// Safety properties, each deliberate and each the same as
// scripts/pilot-background-model.js:
//
// - **Nothing is routed anywhere.** No flag is read or written; no code under
//   src/ knows this script exists.
// - **It writes nothing.** No ledger row (a pilot that recorded its own usage
//   would move the very ratios the efficiency watch reads), no fact, no task,
//   no issue. Every SQL statement here is a SELECT.
// - **What leaves the box is what the owner allowed on 2026-09-24**: task
//   TITLES and fact TEXT, never a conversation, never a name of a contact,
//   never a number. Nothing here prints a user id.
//
// The endpoint is OpenRouter's `/api/alpha/decisions` — alpha, and its
// reference pages returned 404 the day this was written — so step 0 prints the
// raw body of the first answer: it is the first time anybody here has seen
// one, and every parser below is written to tolerate a shape that differs.
'use strict';
const sim = require('../src/domain/task-similarity');
const taskCategory = require('../src/domain/task-category');
const taskKind = require('../src/domain/task-kind');
const { CORPUS, KNOWN_MISSES, KNOWN_OVER_MERGES } = require('../tests/fixtures/task-similarity-corpus');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}
const flag = (name) => process.argv.includes(`--${name}`);

const MODEL = arg('model') || 'typesafe/jev-1.13';
const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const LIMIT = Number(arg('limit')) || 200;
const SKIP_DB = flag('skip-db');
const GROUP_USER = arg('group');
const ONLY = arg('only') ? new Set(arg('only').split(',').map((s) => s.trim())) : null;
const PRICE_PER_MTOK = 0.042; // $ per million input tokens; output is free (docs.typesafe.ai/models)
const BATCH = 20; // items per call — the lab answers ~100 questions in one request

const runs = (step) => !ONLY || ONLY.has(String(step));

// ── the one network call ─────────────────────────────────────────────────────
const CALLS = []; // { step, ms, inputTokens, model, status }

async function decide(step, state, questions, { attempt = 0 } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('no OPENROUTER_API_KEY in the environment — on the box: set -a && . /opt/olma2/.env && set +a');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const t0 = Date.now();
  let res; let body = null; let text = '';
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state, questions }),
    });
    text = await res.text();
    try { body = JSON.parse(text); } catch { body = null; }
  } catch (e) {
    clearTimeout(timer);
    const ms = Date.now() - t0;
    CALLS.push({ step, ms, inputTokens: 0, model: null, status: e.name === 'AbortError' ? 'timeout' : 'error' });
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout after 30s' : String(e.message).slice(0, 200), ms };
  }
  clearTimeout(timer);
  const ms = Date.now() - t0;
  // The vendor's own instruction for 429/529 is exponential backoff.
  if ((res.status === 429 || res.status === 529) && attempt < 4) {
    const wait = 1000 * 2 ** attempt;
    console.log(`   … ${res.status} from the endpoint, waiting ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
    return decide(step, state, questions, { attempt: attempt + 1 });
  }
  const usage = (body && body.usage) || {};
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens) || 0;
  CALLS.push({ step, ms, inputTokens, model: body && body.model, status: res.status });
  if (!res.ok || !body) {
    return { ok: false, status: res.status, error: text.slice(0, 400), ms, raw: text };
  }
  return { ok: true, status: res.status, body, answers: answersOf(body), ms, inputTokens, model: body.model, raw: text };
}

// The documented shape is `{ answers: { <id>: { type, choice|score|noul, probabilities, confidence } } }`.
// Tolerate the two other places a gateway might put it.
function answersOf(body) {
  if (!body || typeof body !== 'object') return {};
  return body.answers || (body.result && body.result.answers) || (body.data && body.data.answers) || {};
}
function noulOf(a) {
  if (!a || typeof a !== 'object') return null;
  const v = a.noul ?? a.probability ?? a.value ?? a.p;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}
function choiceOf(a) {
  if (!a || typeof a !== 'object') return { choice: null, confidence: null, probabilities: null };
  return {
    choice: a.choice ?? a.value ?? null,
    confidence: Number.isFinite(Number(a.confidence)) ? Number(a.confidence) : null,
    probabilities: a.probabilities || null,
  };
}
const pct = (v) => (v == null ? '  —' : `${String(Math.round(v * 100)).padStart(3)}%`);

// ── the questions, in one place so the same file can pre-label the next corpus ──
const Q = {
  // Step 2, pair shape. The owner's four labels, as criteria.
  pairChoice: () => ({
    type: 'choice',
    instructions: `Compare title_a and title_b, two items on one person's to-do list (Hebrew). Which describes their relationship?`,
    criteria: {
      same: 'the same task, written the same or nearly the same way',
      reworded_same: 'the same task said in different words, so keeping both would be a duplicate',
      different: 'two different tasks, even if they share words, a time of day, or a person\'s name',
      list_inside_one_task: 'two items that belong on one checklist under a single task, like two pills or two forms',
    },
  }),
  pairNoul: {
    type: 'noul',
    instructions: 'title_b is the same task as title_a, written a second time, so saving title_b would duplicate title_a.',
  },
  // Step 2, ranking shape — what a real add_task consumer would ask.
  rank: (options) => ({
    type: 'choice',
    instructions: 'new_title is a task somebody just asked to save. Which entry in open_list is the SAME task, already on their list — or none of them?',
    criteria: { ...options, none: 'none of the open tasks is the same task as new_title' },
  }),
  // Steps 3-4.
  category: {
    type: 'choice',
    instructions: 'Which heading does this to-do item belong under? Pick none unless the words make it clear.',
    criteria: {
      health: 'doctors, clinics, tests, medicine, and sport or exercise',
      family: 'children, school, parents, grandparents, partner, family occasions like a birthday or wedding',
      work: 'a job, shifts, clients, invoices, meetings at work, projects, software or product work',
      money: 'bills, rent, bank, insurance, taxes, pension, payments, credit card',
      errands: 'shopping and groceries, post and parcels, haircut, car service, travel bookings and flights',
      home: 'cleaning, laundry, repairs, furniture, garden, anything about the house itself',
      none: 'nothing in the words says which heading it is',
    },
  },
  isEvent: {
    type: 'noul',
    instructions: 'This item is an appointment or event at a moment somebody will be AT (a meeting, a shift, a class, a flight), rather than something they have to DO.',
  },
  // Step 5.
  sensitiveKind: {
    type: 'choice',
    instructions: 'This sentence was saved as a long-term fact about a person by their assistant. What kind of sensitive content, if any, does it hold?',
    criteria: {
      credential: 'a password, PIN, access code, or login detail',
      government_or_account_number: 'an ID number, passport number, bank account, card number, or similar identifier',
      money_detail: 'a specific salary, debt, balance, or other private financial figure',
      medical_detail: 'a diagnosis, medication, treatment, or condition',
      someone_elses_private_matter: 'private information about a third person that they did not share themselves',
      intimate_or_relationship: 'sexual, romantic, or intimate relationship detail',
      none: 'ordinary context about their life, work, habits, or plans',
    },
  },
  shouldNotKeep: {
    type: 'noul',
    instructions: 'A careful person would NOT want this sentence kept in an assistant\'s long-term memory about them.',
  },
  // Step 6.
  groupWith: (options) => ({
    type: 'choice',
    instructions: 'Every entry is an open task on ONE person\'s list. For the task named in the question, which OTHER task is part of the same errand or the same piece of work — or none?',
    criteria: { ...options, none: 'no other task on the list is part of the same errand' },
  }),
};

// ── output helpers ───────────────────────────────────────────────────────────
function section(title) { console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`); }
function stopHere(why) {
  console.log(`\n⛔ ${why}`);
  footer();
  process.exit(1);
}

// ── step 0: does the endpoint exist for our key, and what does an answer look like ──
async function step0() {
  section('step 0 — smoke: one English noul');
  const r = await decide(0, 'Hi, I have been trying to connect my account for three days and nothing works. Please help ASAP.',
    { urgent: { type: 'noul', instructions: 'Does this message express urgency?' } });
  if (!r.ok) {
    console.log(`HTTP ${r.status}: ${r.error}`);
    if (r.status === 404) stopHere('the decisions endpoint is not exposed to this key (404). OpenRouter\'s guide names it; the model page does not exist. Nothing else here can run.');
    if (r.status === 401) stopHere('401 — the key was refused.');
    stopHere('the smoke call failed, so nothing below would be a measurement.');
  }
  console.log(`HTTP ${r.status} in ${r.ms}ms · model reported: ${r.model || '(none)'} · input tokens: ${r.inputTokens}`);
  console.log('raw body (first 600 chars, paste into the experiments entry):');
  console.log(r.raw.slice(0, 600));
  const p = noulOf(r.answers.urgent);
  console.log(`parsed urgent = ${pct(p)}`);
  if (p == null) stopHere('the body parsed, but no noul value was found where the docs say it lives — read the raw body above and fix answersOf/noulOf before measuring anything.');
}

// ── step 0b: many questions on one call, keyed by name ───────────────────────
// The lab answers 96 questions in one request. Our items are separate states,
// so the batched form is an OBJECT of named items and a question per item that
// names its key — never an array index, because Jev "is not a calculator".
async function step0b() {
  section('step 0b — the batched form: ten pairs, one call, against ten single calls');
  const pairs = CORPUS.filter(([, , l]) => l === '3' || l === '0').slice(0, 10);
  const single = [];
  for (const [a, b] of pairs) {
    const r = await decide('0b-single', { title_a: a, title_b: b }, { same: Q.pairNoul });
    single.push(r.ok ? noulOf(r.answers.same) : null);
  }
  const state = {}; const questions = {};
  pairs.forEach(([a, b], i) => {
    state[`p${i + 1}`] = { title_a: a, title_b: b };
    questions[`p${i + 1}_same`] = {
      type: 'noul',
      instructions: `In item p${i + 1}: title_b is the same task as title_a, written a second time, so saving title_b would duplicate title_a.`,
    };
  });
  const r = await decide('0b-batch', state, questions);
  if (!r.ok) { console.log(`batched call failed: HTTP ${r.status} ${r.error.slice(0, 200)}`); return { batchOk: false }; }
  let agree = 0; let both = 0;
  pairs.forEach(([a, b, label], i) => {
    const s = single[i]; const g = noulOf(r.answers[`p${i + 1}_same`]);
    if (s != null && g != null) { both++; if ((s >= 0.5) === (g >= 0.5)) agree++; }
    console.log(`  ${label}  single ${pct(s)}  batched ${pct(g)}  ${a} ⇄ ${b}`);
  });
  const singleMs = CALLS.filter((c) => c.step === '0b-single').map((c) => c.ms);
  console.log(`one batched call: ${r.ms}ms, ${r.inputTokens} input tokens · ten single calls: ${singleMs.reduce((x, y) => x + y, 0)}ms total`);
  console.log(`batched agrees with single on ${agree} of ${both} (at the 50% line)`);
  return { batchOk: true };
}

// ── step 1: does Hebrew read at all ──────────────────────────────────────────
async function step1() {
  section('step 1 — Hebrew reads at all: six invented items with known answers');
  const checks = [
    { name: 'thanks-only line', state: 'תודה רבה!! 🙏', q: { type: 'noul', instructions: 'The message is only thanks, with no request and no question in it.' }, want: (v) => v >= 0.8 },
    { name: 'thanks plus a request', state: 'תודה, ואפשר גם להזיז את הפגישה למחר?', q: { type: 'noul', instructions: 'The message is only thanks, with no request and no question in it.' }, want: (v) => v <= 0.5 },
    { name: 'an appointment is an event', state: 'פגישה עם רואה החשבון ביום שלישי ב-10', q: Q.isEvent, want: (v) => v >= 0.7 },
    { name: 'buying milk is a to-do', state: 'לקנות חלב', q: Q.isEvent, want: (v) => v <= 0.3 },
    { name: 'two unrelated titles', state: { title_a: 'לשטוף את הרכב', title_b: 'להתקשר לסבתא' }, q: Q.pairNoul, want: (v) => v <= 0.3 },
    { name: 'the identical title', state: { title_a: 'לקנות חלב', title_b: 'לקנות חלב' }, q: Q.pairNoul, want: (v) => v >= 0.8 },
  ];
  let passed = 0;
  for (const c of checks) {
    const r = await decide(1, c.state, { a: c.q });
    const v = r.ok ? noulOf(r.answers.a) : null;
    const ok = v != null && c.want(v);
    if (ok) passed++;
    console.log(`  ${ok ? '✓' : '✗'} ${pct(v)}  ${c.name}`);
  }
  console.log(`${passed} of ${checks.length}`);
  if (passed < 4 && !flag('force')) stopHere('Hebrew is at or near chance on unambiguous items; the rest would be noise. --force runs on anyway.');
}

// ── step 2: the owner's eighty labelled pairs, three shapes ──────────────────
function wantMerge(label) { return label === '3' || label === '2'; }
function isKnownMiss(a, b) { return KNOWN_MISSES.includes(a) || KNOWN_MISSES.includes(b); }

async function step2() {
  section(`step 2 — the owner's ${CORPUS.length} labelled pairs: pair-choice, pair-noul, and the ranking shape`);
  // Batched by BATCH pairs per call, two questions per pair.
  const rows = CORPUS.map(([a, b, label]) => ({ a, b, label, code: sim.compare(a, b) }));
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const state = {}; const questions = {};
    chunk.forEach((row, j) => {
      const k = `p${j + 1}`;
      state[k] = { title_a: row.a, title_b: row.b };
      questions[`${k}_kind`] = { ...Q.pairChoice(), instructions: `In item ${k}: ${Q.pairChoice().instructions}` };
      questions[`${k}_same`] = { type: 'noul', instructions: `In item ${k}: ${Q.pairNoul.instructions}` };
    });
    const r = await decide(2, state, questions);
    chunk.forEach((row, j) => {
      const k = `p${j + 1}`;
      row.noul = r.ok ? noulOf(r.answers[`${k}_same`]) : null;
      row.choice = r.ok ? choiceOf(r.answers[`${k}_kind`]) : choiceOf(null);
    });
    if (!r.ok) console.log(`  ! batch at ${i} failed: HTTP ${r.status} ${r.error.slice(0, 160)}`);
  }

  // The ranking shape: title_b as the new title, title_a hidden among seven
  // other real titles from the corpus. One call per BATCH rows, one question each.
  const pool = [...new Set(CORPUS.flatMap(([a, b]) => [a, b]))];
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const state = {}; const questions = {};
    chunk.forEach((row, j) => {
      const k = `r${j + 1}`;
      const others = pool.filter((t) => t !== row.a && t !== row.b);
      // Deterministic pick so a rerun ranks against the same list.
      const picked = [];
      for (let n = 0; picked.length < 7 && n < others.length; n++) {
        const idx = (i * 7 + j * 13 + n * 31) % others.length;
        if (!picked.includes(others[idx])) picked.push(others[idx]);
      }
      const list = [...picked];
      list.splice((i + j) % (list.length + 1), 0, row.a);
      const options = {}; const openList = {};
      list.forEach((t, n) => { options[`t${n + 1}`] = t; openList[`t${n + 1}`] = t; });
      row.rankKeyOfA = Object.keys(options).find((key) => options[key] === row.a);
      state[k] = { new_title: row.b, open_list: openList };
      questions[`${k}_dup`] = { ...Q.rank(options), instructions: `In item ${k}: ${Q.rank(options).instructions}` };
    });
    const r = await decide('2-rank', state, questions);
    chunk.forEach((row, j) => { row.rank = r.ok ? choiceOf(r.answers[`r${j + 1}_dup`]) : choiceOf(null); });
    if (!r.ok) console.log(`  ! ranking batch at ${i} failed: HTTP ${r.status} ${r.error.slice(0, 160)}`);
  }

  // ── scoring ──
  const codeAgree = rows.filter((r) => r.code.same === wantMerge(r.label)).length;
  console.log(`\ncode today (task-similarity.compare): ${codeAgree} of ${rows.length} agree, 0 merges of a '0' row by construction`);

  console.log('\nnoul sweep — predicted "same" when noul ≥ t:');
  console.log('   t     agree  merges-a-0  known-misses-caught');
  let verdictT = null;
  for (let t = 0.5; t <= 0.951; t += 0.05) {
    const pred = (r) => r.noul != null && r.noul >= t;
    const agree = rows.filter((r) => r.noul != null && pred(r) === wantMerge(r.label)).length;
    const bad = rows.filter((r) => r.label === '0' && pred(r)).length;
    const caught = rows.filter((r) => isKnownMiss(r.a, r.b) && wantMerge(r.label) && pred(r)).length;
    console.log(`  ${t.toFixed(2)}   ${String(agree).padStart(3)}      ${String(bad).padStart(3)}         ${String(caught).padStart(3)}`);
    if (bad === 0 && caught >= 1 && verdictT == null) verdictT = t;
  }

  const YES = new Set(['same', 'reworded_same']);
  console.log('\nchoice sweep — predicted "same" when choice ∈ {same, reworded_same} and confidence ≥ t:');
  console.log('   t     agree  merges-a-0  known-misses-caught  exact-4-way');
  let verdictC = null;
  const exactLabel = { 3: 'same', 2: 'reworded_same', 0: 'different' };
  for (let t = 0; t <= 0.951; t += 0.1) {
    const pred = (r) => r.choice.choice != null && YES.has(r.choice.choice) && (r.choice.confidence == null || r.choice.confidence >= t);
    const agree = rows.filter((r) => r.choice.choice != null && pred(r) === wantMerge(r.label)).length;
    const bad = rows.filter((r) => r.label === '0' && pred(r)).length;
    const caught = rows.filter((r) => isKnownMiss(r.a, r.b) && wantMerge(r.label) && pred(r)).length;
    const exact = rows.filter((r) => exactLabel[r.label] && r.choice.choice === exactLabel[r.label]).length;
    console.log(`  ${t.toFixed(2)}   ${String(agree).padStart(3)}      ${String(bad).padStart(3)}         ${String(caught).padStart(3)}            ${String(exact).padStart(3)} of ${rows.filter((r) => exactLabel[r.label]).length}`);
    if (bad === 0 && caught >= 1 && verdictC == null) verdictC = t;
  }

  console.log('\nranking shape — new_title against a list of eight that hides title_a:');
  let rankRight = 0; let rankBad = 0; let rankCaught = 0; let rankAnswered = 0;
  for (const r of rows) {
    if (r.rank.choice == null) continue;
    rankAnswered++;
    const pickedA = r.rank.choice === r.rankKeyOfA;
    const pickedNone = r.rank.choice === 'none';
    if (wantMerge(r.label) ? pickedA : pickedNone) rankRight++;
    if (r.label === '0' && !pickedNone) rankBad++;
    if (isKnownMiss(r.a, r.b) && wantMerge(r.label) && pickedA) rankCaught++;
  }
  console.log(`  right ${rankRight} of ${rankAnswered} · picked something for a '0' row ${rankBad} times · known misses found ${rankCaught}`);
  const rankMs = CALLS.filter((c) => c.step === '2-rank').map((c) => c.ms);
  if (rankMs.length) console.log(`  one ranking call (${BATCH} items): ${Math.round(rankMs.reduce((x, y) => x + y, 0) / rankMs.length)}ms average`);

  // ── the rows the heuristic was built around ──
  const show = (title, filter) => {
    console.log(`\n${title}`);
    console.log('  label code  noul  choice                 conf  rank      title_a ⇄ title_b');
    for (const r of rows.filter(filter)) {
      const rankTxt = r.rank.choice == null ? '—' : r.rank.choice === r.rankKeyOfA ? 'found A' : r.rank.choice === 'none' ? 'none' : 'OTHER';
      console.log(`  ${r.label}     ${r.code.same ? 'yes ' : 'no  '}  ${pct(r.noul)}  ${String(r.choice.choice || '—').padEnd(22)} ${pct(r.choice.confidence)}  ${rankTxt.padEnd(8)}  ${r.a} ⇄ ${r.b}`);
    }
  };
  show(`the known misses (${KNOWN_MISSES.length} titles) — the only rows a second PR would be for:`, (r) => isKnownMiss(r.a, r.b) && !r.code.same);
  show("the 24 rejected pairs ('0') — a yes on any of these is disqualifying:", (r) => r.label === '0');
  show("the 'save and ask' pairs ('1'):", (r) => r.label === '1');
  show('the known over-merges (code says yes, owner said ask):', (r) => KNOWN_OVER_MERGES.includes(r.a) || KNOWN_OVER_MERGES.includes(r.b));
  // Where the two readers part company — a sweep says how many, this says which.
  const jevYes = (r) => r.choice.choice != null && YES.has(r.choice.choice) && (r.choice.confidence ?? 0) >= 0.5;
  show('code and Jev (choice, confidence ≥ 0.50) disagree — every row, with the owner\'s label:', (r) => r.choice.choice != null && jevYes(r) !== r.code.same);

  console.log('\nVERDICT (computed):');
  console.log(verdictT != null
    ? `  noul: at t=${verdictT.toFixed(2)} Jev catches ≥1 known miss with 0 merges of a rejected row.`
    : '  noul: NO threshold catches a known miss without merging a rejected row.');
  console.log(verdictC != null
    ? `  choice: at confidence ≥ ${verdictC.toFixed(2)} Jev catches ≥1 known miss with 0 merges of a rejected row.`
    : '  choice: NO confidence floor catches a known miss without merging a rejected row.');
  console.log(rankCaught >= 1 && rankBad === 0
    ? `  ranking: found ${rankCaught} known miss(es) and picked nothing for every rejected row.`
    : `  ranking: ${rankCaught} known miss(es) found, ${rankBad} rejected row(s) matched to something.`);
}

// ── steps 3-4: category and kind on real titles ──────────────────────────────
async function step34(client) {
  section(`steps 3-4 — category and event-vs-task on the newest ${LIMIT} real titles`);
  const { rows } = await client.query(
    `SELECT t.title, t.category, t.category_auto, t.kind
       FROM tasks t JOIN users u ON u.id = t.owner_id
      WHERE t.parent_id IS NULL AND NOT u.is_eval
      ORDER BY t.created_at DESC LIMIT $1`, [LIMIT]);
  for (const r of rows) {
    r.codeCat = taskCategory.classifyText(r.title);
    r.codeKind = taskKind.decideKind({ title: r.title });
  }
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const state = {}; const questions = {};
    chunk.forEach((r, j) => {
      state[`t${j + 1}`] = r.title;
      questions[`t${j + 1}_cat`] = { ...Q.category, instructions: `For item t${j + 1}: ${Q.category.instructions}` };
      questions[`t${j + 1}_event`] = { type: 'noul', instructions: `For item t${j + 1}: ${Q.isEvent.instructions}` };
    });
    const res = await decide(3, state, questions);
    chunk.forEach((r, j) => {
      r.jevCat = res.ok ? choiceOf(res.answers[`t${j + 1}_cat`]) : choiceOf(null);
      r.jevEvent = res.ok ? noulOf(res.answers[`t${j + 1}_event`]) : null;
    });
    if (!res.ok) console.log(`  ! batch at ${i} failed: HTTP ${res.status} ${res.error.slice(0, 160)}`);
  }
  const answered = rows.filter((r) => r.jevCat.choice != null);
  const codeNone = answered.filter((r) => r.codeCat == null);
  const bothSaid = answered.filter((r) => r.codeCat != null && r.jevCat.choice !== 'none');
  const agreeCode = bothSaid.filter((r) => r.codeCat === r.jevCat.choice).length;
  const stored = answered.filter((r) => r.category);
  const jevVsStored = stored.filter((r) => r.jevCat.choice === r.category).length;
  const codeVsStored = stored.filter((r) => r.codeCat === r.category).length;
  const humanish = stored.filter((r) => !r.category_auto);
  console.log(`\n${answered.length} titles answered. code guessed a heading for ${answered.length - codeNone.length}, Jev for ${answered.filter((r) => r.jevCat.choice !== 'none').length}.`);
  console.log(`where both named a heading: ${agreeCode} of ${bothSaid.length} agree.`);
  console.log(`against the stored column (${stored.length} rows; ${humanish.length} of them not auto-guessed): code ${codeVsStored}, Jev ${jevVsStored}.`);
  console.log(`against the ${humanish.length} non-auto rows only: code ${humanish.filter((r) => r.codeCat === r.category).length}, Jev ${humanish.filter((r) => r.jevCat.choice === r.category).length}.`);

  const list = (title, filter, extra) => {
    const sel = answered.filter(filter);
    console.log(`\n${title} (${sel.length}):`);
    for (const r of sel.slice(0, 40)) console.log(`  ${extra(r)}  ${r.title}`);
    if (sel.length > 40) console.log(`  … ${sel.length - 40} more`);
  };
  list('code said none, Jev is ≥90% sure of a heading — for the owner to read',
    (r) => r.codeCat == null && r.jevCat.choice !== 'none' && (r.jevCat.confidence ?? 0) >= 0.9,
    (r) => `${String(r.jevCat.choice).padEnd(8)} ${pct(r.jevCat.confidence)} stored=${r.category || '—'}`);
  list('code and Jev disagree, both ≥90% (Jev) — for the owner to read',
    (r) => r.codeCat != null && r.jevCat.choice !== 'none' && r.codeCat !== r.jevCat.choice && (r.jevCat.confidence ?? 0) >= 0.9,
    (r) => `code=${r.codeCat.padEnd(7)} jev=${String(r.jevCat.choice).padEnd(7)} ${pct(r.jevCat.confidence)} stored=${r.category || '—'}`);

  // kind
  const withKind = answered.filter((r) => r.jevEvent != null);
  const storedKind = withKind.filter((r) => r.kind === 'event' || r.kind === 'todo');
  const jevKindRight = storedKind.filter((r) => (r.jevEvent >= 0.5) === (r.kind === 'event')).length;
  const codeKindRight = storedKind.filter((r) => r.codeKind === r.kind).length;
  console.log(`\nevent-vs-task against the stored kind (${storedKind.length} rows): code ${codeKindRight}, Jev (≥50%) ${jevKindRight}.`);
  list('Jev ≥80% event where code said todo', (r) => r.jevEvent != null && r.jevEvent >= 0.8 && r.codeKind === 'todo',
    (r) => `${pct(r.jevEvent)} stored=${r.kind || '—'}`);
  list('Jev ≤20% event where code said event', (r) => r.jevEvent != null && r.jevEvent <= 0.2 && r.codeKind === 'event',
    (r) => `${pct(r.jevEvent)} stored=${r.kind || '—'}`);
}

// ── step 5: what is in the fact store that should not be ─────────────────────
async function step5(client) {
  section('step 5 — the fact store: anything a careful person would not want kept');
  const { rows } = await client.query(
    `SELECT f.fact, f.category, f.source
       FROM user_facts f JOIN users u ON u.id = f.user_id
      WHERE f.active AND NOT u.is_eval AND (f.expires_at IS NULL OR f.expires_at > now())
      ORDER BY f.learned_at DESC`);
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const state = {}; const questions = {};
    chunk.forEach((r, j) => {
      state[`f${j + 1}`] = r.fact;
      questions[`f${j + 1}_kind`] = { ...Q.sensitiveKind, instructions: `For item f${j + 1}: ${Q.sensitiveKind.instructions}` };
      questions[`f${j + 1}_keep`] = { type: 'noul', instructions: `For item f${j + 1}: ${Q.shouldNotKeep.instructions}` };
    });
    const res = await decide(5, state, questions);
    chunk.forEach((r, j) => {
      r.kindA = res.ok ? choiceOf(res.answers[`f${j + 1}_kind`]) : choiceOf(null);
      r.noKeep = res.ok ? noulOf(res.answers[`f${j + 1}_keep`]) : null;
    });
    if (!res.ok) console.log(`  ! batch at ${i} failed: HTTP ${res.status} ${res.error.slice(0, 160)}`);
  }
  const answered = rows.filter((r) => r.kindA.choice != null);
  const counts = {};
  for (const r of answered) counts[r.kindA.choice] = (counts[r.kindA.choice] || 0) + 1;
  console.log(`${answered.length} of ${rows.length} facts answered. kinds: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  const flagged = answered.filter((r) => (r.kindA.choice !== 'none' && (r.kindA.confidence ?? 0) >= 0.9) || (r.noKeep != null && r.noKeep >= 0.9));
  console.log(`\nflagged at ≥90% on either question (${flagged.length}) — the fact text, for the owner to read; nothing is deleted:`);
  for (const r of flagged) console.log(`  ${String(r.kindA.choice).padEnd(30)} ${pct(r.kindA.confidence)}  not-keep ${pct(r.noKeep)}  [${r.category}/${r.source}]  ${r.fact}`);
  const grey = answered.filter((r) => !flagged.includes(r) && ((r.kindA.choice !== 'none' && (r.kindA.confidence ?? 0) >= 0.5) || (r.noKeep != null && r.noKeep >= 0.5)));
  console.log(`\nthe grey band, 50-90% (${grey.length}):`);
  for (const r of grey) console.log(`  ${String(r.kindA.choice).padEnd(30)} ${pct(r.kindA.confidence)}  not-keep ${pct(r.noKeep)}  [${r.category}/${r.source}]  ${r.fact}`);
}

// ── step 6: topic grouping on one open list ──────────────────────────────────
// The tier task-similarity.js parked ("needs a model reading a whole open list
// for topic"). The nine titles that killed the keyword version are appended as
// rows that must group with nothing (tests/task-suggestions.test.js).
const KILLER_TITLES = [
  'לעשות למאיה תיאום מס', 'דברים שצריך לעשות ביחד עם מאיה', 'לעשות פתיח ספק בעיריית כפר סבא',
  'לבדוק על שחיינים ששחו בעבר', 'לבדוק משימות למרוץ', 'לבדוק משימות נוספות שיש לי',
  'סדר בבית', 'לארוז תיק לבית חולים', 'להזכיר לי מחר בבוקר ב-9 עם רשימת האריזה לתיק לבית חולים',
];
async function step6(client, userId) {
  section(`step 6 — topic grouping on one open list (+ the nine killer titles)`);
  const { rows } = await client.query(
    `SELECT title FROM tasks WHERE owner_id = $1 AND status = 'open' AND archived_at IS NULL AND parent_id IS NULL
      ORDER BY created_at DESC LIMIT 60`, [userId]);
  const titles = [...rows.map((r) => r.title), ...KILLER_TITLES.filter((k) => !rows.some((r) => r.title === k))];
  if (titles.length > 60) titles.length = 60;
  const options = {}; titles.forEach((t, i) => { options[`t${i + 1}`] = t; });
  const state = { open_list: options };
  const questions = {};
  titles.forEach((t, i) => {
    const key = `t${i + 1}`;
    const others = Object.fromEntries(Object.entries(options).filter(([k]) => k !== key));
    questions[`${key}_with`] = { ...Q.groupWith(others), instructions: `For task ${key}: ${Q.groupWith(others).instructions}` };
  });
  const res = await decide(6, state, questions);
  if (!res.ok) { console.log(`failed: HTTP ${res.status} ${res.error.slice(0, 200)}`); return; }
  console.log(`${titles.length} tasks, one call, ${res.ms}ms, ${res.inputTokens} input tokens`);
  const picks = titles.map((t, i) => {
    const c = choiceOf(res.answers[`t${i + 1}_with`]);
    return { title: t, pick: c.choice && c.choice !== 'none' ? options[c.choice] : null, conf: c.confidence };
  });
  console.log('\npicks at ≥70% confidence:');
  for (const p of picks.filter((x) => x.pick && (x.conf ?? 0) >= 0.7)) {
    const killer = KILLER_TITLES.includes(p.title) || KILLER_TITLES.includes(p.pick);
    console.log(`  ${killer ? '‼' : ' '} ${pct(p.conf)}  ${p.title}  →  ${p.pick}`);
  }
  const isPacking = (t) => t.includes('לארוז תיק') || t.includes('לתיק לבית חולים');
  const killerHits = picks.filter((x) => x.pick && (x.conf ?? 0) >= 0.7
    && KILLER_TITLES.includes(x.title) && KILLER_TITLES.includes(x.pick)
    && !(isPacking(x.title) && isPacking(x.pick)));
  console.log(`\nkiller titles grouped with each other: ${killerHits.length} (the packing-list pair is excluded — it is the one honest match; anything counted here is the keyword detector's failure again)`);
}

// ── footer ───────────────────────────────────────────────────────────────────
function footer() {
  const okCalls = CALLS.filter((c) => typeof c.status === 'number' && c.status >= 200 && c.status < 300);
  const ms = okCalls.map((c) => c.ms).sort((a, b) => a - b);
  const tokens = okCalls.reduce((s, c) => s + c.inputTokens, 0);
  const models = [...new Set(okCalls.map((c) => c.model).filter(Boolean))];
  const q = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : 0);
  section('footer');
  console.log(`calls: ${CALLS.length} (${okCalls.length} ok) · input tokens: ${tokens} · cost at $${PRICE_PER_MTOK}/Mtok: $${(tokens / 1e6 * PRICE_PER_MTOK).toFixed(5)}`);
  console.log(`latency: median ${q(0.5)}ms · p95 ${q(0.95)}ms · max ${ms[ms.length - 1] || 0}ms`);
  console.log(`model reported by the endpoint: ${models.join(', ') || '(none)'} — asked for ${MODEL}`);
  if (models.some((m) => !String(m).toLowerCase().includes('jev'))) console.log('  ! a reported model does not contain "jev" — a fallback answered, and this is not a Jev result');
}

// ── the run ──────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Jev pilot · ${MODEL} via ${ENDPOINT} · ${new Date().toISOString()}`);
  console.log('nothing is routed, nothing is written; every SQL statement is a SELECT.');
  if (runs(0)) await step0();
  if (runs('0b')) await step0b();
  if (runs(1)) await step1();
  if (runs(2)) await step2();
  if (!SKIP_DB && (runs(3) || runs(4) || runs(5) || runs(6))) {
    const { createPool } = require('../src/db/pool');
    const pool = createPool();
    const client = await pool.connect();
    try {
      if (runs(3) || runs(4)) await step34(client);
      if (runs(5)) await step5(client);
      if (runs(6) && GROUP_USER) await step6(client, Number(GROUP_USER));
      else if (runs(6) && ONLY && ONLY.has('6')) console.log('\nstep 6 needs --group <user_id>');
    } finally {
      client.release();
      await pool.end();
    }
  } else if (SKIP_DB) {
    console.log('\n(--skip-db: steps 3-6 need the database and were not run)');
  }
  footer();
  process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
