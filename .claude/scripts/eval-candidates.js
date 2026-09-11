#!/usr/bin/env node
'use strict';
// The source material for a new eval scenario, gathered deterministically.
//
// `src/evals/scenarios.js` states the standard: "every one is a real incident
// that already happened to a real user... a doctrine change with no scenario
// behind it is a bet, not a fix." This script finds the raw material; the
// drafting is judgment and stays with the skill that calls it
// (.claude/skills/eval-from-incident/). No model here on purpose.
//
// ---------------------------------------------------------------------------
// MEASURED, AND ONE READING REJECTED (2026-09-11)
//
// The first cut tried to decide which incidents are REPLAYABLE as a
// conversation, from the text: an entry quoting Hebrew inside quote marks and
// naming one of the real users. Measured against all 146 entries it flagged
// 42, and reading those 42 by hand, 17 were replayable and 25 were not — a
// 60% false-positive rate. It happily proposed "A rollback cannot reach the
// filesystem", "Behavioral evals: nightly scripted conversations" and "The
// carryover detector checked the wrong half of the pair", because the
// narrative of an infrastructure failure quotes the user messages that
// exposed it just as readily as a model failure does.
//
// 60% is worse than every reading `check-rule-citations.js` threw away, and a
// list where three of five rows are wrong is one nobody reads twice. So the
// classifier is gone: what stays is the DATE, which 144 of 146 headings carry
// (99%), and the two that do not are named in the output rather than dropped.
// Narrowing by when something happened is honest and exact; deciding whether
// it is replayable needs the entry read, which is the skill's job.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const INCIDENTS = path.join(ROOT, 'olma2', 'docs', 'incidents.md');
const SCENARIOS = path.join(ROOT, 'olma2', 'src', 'evals', 'scenarios.js');
const DATE_RE = /\b20\d\d-\d\d-\d\d\b/;

function entries(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = /^###\s+(.*?)\s*$/.exec(line);
    if (m) { cur = { title: m[1], lines: [] }; out.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  for (const e of out) {
    e.body = e.lines.join('\n');
    // The NEWEST date in a heading dates the entry: both "(fixed 2026-09-07)"
    // and "(2026-08-22, fixed 2026-09-03)" appear in the file.
    const all = e.title.match(new RegExp(DATE_RE, 'g'));
    e.date = all ? all.slice().sort().pop() : null;
    delete e.lines;
  }
  return out;
}

// `id:` and not `message_id:`/`user_id:`. The first cut matched any key ENDING
// in id and returned `3EB0EVAL0001` — the fake WhatsApp message id in the
// reply-target fixture — as a scenario. The self-test asserted a count and
// uniqueness, and both were happily true of the wrong list, so the shape of an
// id is asserted too: a scenario id is a kebab-case slug and always has been.
const ID_RE = /(?<![A-Za-z0-9_])id:\s*'([^']+)'/g;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function scenarioIds(text) {
  return [...text.matchAll(ID_RE)].map((m) => m[1]);
}

// What each of the three row sources can actually give a drafter. Measured by
// reading the writers, because two of the three deliberately keep no text and
// a skill that asked them for one would get an empty list and read it as a
// quiet week:
//
//   onboarding_reviews  findings + evidence per person per stage. Draftable.
//   hebrew_flaws        a COUNT per day in product_metrics_daily and nothing
//                       else — jobs/metrics.js counts flawsIn hits and never
//                       stores the message. Names a day, never a sentence.
//   reply_leak          an audit row with the kind and a redacted 40-char
//                       fragment. brokerd/server.js: "The TEXT never comes
//                       here and is never stored" — a frame marker can BE a
//                       live credential. Names a turn, never its words.
//
// The two that are not draftable still print, because "nothing to draft from"
// and "nothing happened" are different answers and the second one is the lie.
const SOURCES = [
  {
    id: 'onboarding_reviews',
    draftable: true,
    what: 'findings + evidence per person per stage',
    sql: `SELECT user_id, stage, worst, findings, window_start
            FROM onboarding_reviews
           WHERE window_end > now() - $1::interval
           ORDER BY window_start DESC LIMIT 40`,
  },
  {
    id: 'hebrew_flaws',
    draftable: false,
    what: 'a count per day only — the flawed message is never stored (jobs/metrics.js)',
    sql: `SELECT date, value FROM product_metrics_daily
           WHERE metric = 'hebrew_flaws' AND value > 0
             AND date > (now() - $1::interval)::date
           ORDER BY date DESC`,
  },
  {
    id: 'reply_leak',
    draftable: false,
    what: 'kind + a redacted fragment — the text is deliberately never stored (brokerd/server.js)',
    sql: null,
  },
];

async function rows(interval) {
  const url = process.env.OLMA_DB_URL || process.env.DATABASE_URL;
  if (!url) {
    // A check that declines to judge must say so (CLAUDE.md, detectors).
    console.log('\nrows: NOT ASKED — no OLMA_DB_URL in the environment.');
    console.log('  This half needs the live database, so it answers on the box and');
    console.log('  nowhere else. That is not the same as "nothing happened this week".');
    for (const s of SOURCES) {
      console.log(`    ${s.draftable ? 'draftable  ' : 'not enough '} ${s.id} — ${s.what}`);
    }
    return;
  }
  let Client;
  try { ({ Client } = require('pg')); } catch { console.log('\nrows: pg is not installed here.'); return; }
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    for (const s of SOURCES) {
      if (!s.sql) { console.log(`\n${s.id}: ${s.what}`); continue; }
      const { rows: r } = await c.query(s.sql, [interval]);
      console.log(`\n${s.id} (${s.draftable ? 'draftable' : 'NOT enough to draft from'}): ${r.length} row(s)`);
      if (!s.draftable) console.log(`  ${s.what}`);
      for (const row of r.slice(0, 12)) console.log(`  ${JSON.stringify(row).slice(0, 220)}`);
    }
  } finally { await c.end(); }
}

function selfTest() {
  const all = entries(fs.readFileSync(INCIDENTS, 'utf8'));
  const ids = scenarioIds(fs.readFileSync(SCENARIOS, 'utf8'));
  const fail = (m) => { console.error(`self-test FAILED: ${m}`); process.exit(1); };

  if (all.length < 100) fail(`only ${all.length} incident entries parsed — the heading shape changed`);
  const dated = all.filter((e) => e.date);
  if (dated.length / all.length < 0.9) {
    fail(`only ${dated.length}/${all.length} entries carry a date; the date reading is no longer safe`);
  }
  if (ids.length < 10) fail(`only ${ids.length} scenario ids parsed — the scenario shape changed`);
  if (new Set(ids).size !== ids.length) fail('duplicate scenario id in scenarios.js');
  const notSlug = ids.filter((i) => !SLUG_RE.test(i));
  if (notSlug.length) fail(`not a scenario id: ${notSlug.join(', ')} — the id reading is matching something else`);
  // The bug this reading actually had: any key ending in `id`.
  if (scenarioIds("message_id: 'NOT-A-SCENARIO'\n  id: 'real-one',").join() !== 'real-one') {
    fail('scenarioIds matched a key that merely ends in id');
  }

  // The two readings that decide the whole output, on the real heading shapes.
  const two = entries('### A (2026-08-22, fixed 2026-09-03)\nx\n### B (fixed 2026-09-07)\ny\n');
  if (two[0].date !== '2026-09-03') fail(`newest-date rule: got ${two[0].date}`);
  if (two[1].date !== '2026-09-07') fail(`single-date rule: got ${two[1].date}`);
  if (entries('### No date here\nx\n')[0].date !== null) fail('a dateless heading must report null, never today');

  // A source that cannot be drafted from must stay in the list and stay
  // labelled — dropping it is how "no rows" becomes "quiet week".
  if (SOURCES.filter((s) => !s.draftable).length !== 2) fail('the not-draftable sources went missing');

  console.log(`self-test: ${all.length} entries parsed, ${dated.length} dated, ${ids.length} scenario ids; `
    + 'newest-date, dateless and the two not-draftable sources all hold');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  const days = Number((argv.find((a) => a.startsWith('--days=')) || '--days=14').slice(7)) || 14;
  const sinceArg = (argv.find((a) => a.startsWith('--since=')) || '').slice(8);
  const since = sinceArg || new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  const all = entries(fs.readFileSync(INCIDENTS, 'utf8'));
  const ids = scenarioIds(fs.readFileSync(SCENARIOS, 'utf8'));
  const win = all.filter((e) => e.date && e.date >= since);
  const undated = all.filter((e) => !e.date);

  console.log(`incidents since ${since}: ${win.length} of ${all.length}`);
  for (const e of win) console.log(`  ${e.date}  ${e.title}`);
  if (undated.length) {
    console.log(`\n${undated.length} entr(ies) carry no date and fall in NO window — read them by hand:`);
    for (const e of undated) console.log(`  - ${e.title}`);
  }
  console.log(`\nexisting scenario ids (${ids.length}) — a draft may not reuse one:`);
  console.log(`  ${ids.join(', ')}`);

  await rows(`${days} days`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
