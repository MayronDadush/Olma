'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const eff = require('../src/jobs/efficiency-watch');
const flags = require('../src/domain/flags');

let pool; let teardown; let userId;

test.before(async () => {
  ({ pool, teardown } = await freshDb());
  const u = await makeUser(pool, '+972500000900', { firstName: 'Eff' });
  userId = u.id;
  // The alert phone needs a user row parked at a daytime hour, or the shared
  // `alertHourOpen` falls back to Asia/Jerusalem and the send tests pass or
  // fail depending on what time the suite runs. That exact hour-dependence
  // took the suite red eleven hours a day once, and again in credit-watch.
  const op = await makeUser(pool, '+972526269826', { firstName: 'Op' });
  await pool.query(`UPDATE users SET timezone = 'Etc/UTC' WHERE id = $1`, [op.id]);
});
test.after(async () => { if (teardown) await teardown(); });

// day 0 = today, 1 = yesterday, ...
async function seedDay(back, { messages, inTokens, cacheTokens, cost, systemCost = 0 }) {
  for (let i = 0; i < messages; i++) {
    await pool.query(
      `INSERT INTO audit_log (actor_id, event, detail, created_at)
       VALUES ($1, 'message.received', '{}'::jsonb, (current_date - $2::int) + interval '12 hours')`,
      [userId, back]);
  }
  if (inTokens) {
    await pool.query(
      `INSERT INTO usage_ledger (user_id, date, model, input_tokens, cache_read_tokens, cost_usd)
       VALUES ($1, current_date - $2::int, 'test/model', $3, $4, $5)`,
      [userId, back, inTokens - cacheTokens, cacheTokens, cost]);
  }
  if (systemCost) {
    await pool.query(
      `INSERT INTO usage_system_ledger (agent_id, date, model, cost_usd)
       VALUES ('main', current_date - $1::int, 'test/model', $2)`, [back, systemCost]);
  }
}

// The date the sweep should be judging, asked of Postgres rather than of
// Node's clock, so the two can never disagree about when midnight was.
async function yesterday() {
  const { rows } = await pool.query(`SELECT (current_date - 1)::text AS d`);
  return rows[0].d;
}

test('a steady week reports its ratios and crosses nothing', async () => {
  for (let d = 8; d >= 1; d--) {
    await seedDay(d, { messages: 40, inTokens: 2_000_000, cacheTokens: 1_400_000, cost: 0.2 });
  }
  // The day in progress is deliberately absurd: 10x the tokens and a dead
  // cache. It is not a small version of a finished day — a morning is nearly
  // all digests — and judging it against seven complete days measures the hour.
  await seedDay(0, { messages: 40, inTokens: 20_000_000, cacheTokens: 200_000, cost: 4 });

  const out = await eff.run(pool, { llm: null, send: null });
  assert.equal(out.date, await yesterday(),
    'the day under test is the last COMPLETE one, never the one still running');
  assert.equal(out.crossed, 0);
  // Reported even when healthy. A watch that is silent when nothing is wrong
  // is indistinguishable from a watch that stopped running — the failure this
  // repo has now recorded four times.
  assert.ok(out.ratios.cost_per_message > 0);
  assert.equal(Math.round(out.ratios.cache_hit_rate * 100), 70);
  assert.equal(out.ratios.input_tokens_per_message, 50_000,
    'reading 500,000 here means the partial day was measured');
});


test('the ratio is per message, so a busy day is not an expensive one', () => {
  // The whole reason nothing here is an absolute threshold: this day costs 5x
  // the baseline day in dollars and is exactly as efficient. An alarm that
  // fired on it would be an alarm that punishes usage.
  const steady = { date: 'a', messages: 40, cost_per_message: 0.005, input_tokens_per_message: 50_000, cache_hit_rate: 0.7, system_cost_share: 0.1 };
  const busy = { ...steady, date: 'b', messages: 200 };
  assert.deepEqual(eff.crossings([steady, steady, busy], busy), []);
});

test('a quiet day cannot trigger anything, however strange its numbers look', () => {
  const steady = { date: 'a', messages: 40, cost_per_message: 0.005, input_tokens_per_message: 50_000, cache_hit_rate: 0.7, system_cost_share: 0.1 };
  const quiet = { date: 'b', messages: 3, cost_per_message: 0.9, input_tokens_per_message: 9_000_000, cache_hit_rate: 0.01, system_cost_share: 0.99 };
  assert.deepEqual(eff.crossings([steady, steady, quiet], quiet), [],
    'three messages can produce any ratio at all; firing on them is how a watchdog becomes noise');
});

test('one outlier day cannot move the baseline — the median is why', () => {
  const norm = (d) => ({ date: d, messages: 40, cost_per_message: 0.005, input_tokens_per_message: 50_000, cache_hit_rate: 0.7, system_cost_share: 0.1 });
  const spike = { ...norm('spike'), cost_per_message: 5, input_tokens_per_message: 5_000_000 };
  const today = { ...norm('today'), cost_per_message: 0.011, input_tokens_per_message: 110_000 };
  const hist = [norm('a'), norm('b'), spike, norm('c'), today];
  const crossed = eff.crossings(hist, today);
  // With a MEAN baseline the spike would have dragged normal up to ~$1 and
  // today's genuine 2.2x regression would read as a 99% improvement.
  assert.deepEqual(crossed.map((c) => c.key).sort(), ['cost_per_message', 'input_tokens_per_message']);
});

test('no history is not a crossing', () => {
  const today = { date: 'x', messages: 40, cost_per_message: 9, input_tokens_per_message: 9e6, cache_hit_rate: 0.01, system_cost_share: 0.9 };
  assert.deepEqual(eff.crossings([today], today), [],
    'a system with no past has nothing to be surprised by, and inventing a threshold makes week one pure noise');
});

test('a real regression is filed, messaged once, and re-armed by recovery', async () => {
  const sent = [];
  const deps = {
    llm: null, // the advice is optional; the numbers are the part that is true
    send: async (phone, text) => { sent.push({ phone, text }); return { ok: true }; },
    alertHourOpen: async () => true,
    promptChars: 39_146,
  };
  // Yesterday: same traffic, 3.5x the input tokens, a collapsed cache AND 4.5x
  // the cost per message — the exact shape measured live between 2026-08-28 and
  // 2026-09-03, except that this one actually cost money. That last clause is
  // the difference between this test and the one below it.
  await pool.query(`DELETE FROM usage_ledger WHERE date = current_date - 1`);
  await pool.query(`DELETE FROM audit_log WHERE event = 'message.received' AND created_at::date = current_date - 1`);
  await seedDay(1, { messages: 40, inTokens: 7_000_000, cacheTokens: 1_750_000, cost: 0.9 });

  const out = await eff.run(pool, deps);
  assert.ok(out.crossed >= 2, `expected several crossings, got ${JSON.stringify(out.ratios)}`);
  assert.equal(out.alerted, out.crossed,
    'when money moved, the ratios that explain it ride along in the same alert');
  assert.equal(out.notified, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /יעילות/);
  // Said every time, because after the third of these it would otherwise be
  // assumed. This job's whole boundary is that it changed nothing.
  assert.match(sent[0].text, /לא שיניתי כלום/);
  assert.ok(out.filed >= 2);

  const { rows: issues } = await pool.query(
    `SELECT title FROM issues WHERE title LIKE 'efficiency:%' ORDER BY title`);
  assert.ok(issues.length >= 2);
  for (const i of issues) {
    // fileViolations-style dedup keys on the title, so a ratio in there would
    // file a brand-new issue every day the number moved — the guard fighting
    // itself, which this repo has already paid for once.
    assert.ok(!/\d/.test(i.title), `no number in a dedup key: ${i.title}`);
  }

  // Same condition, next tick: silent. A daily "still expensive" is how
  // somebody learns to swipe these away before the one that matters.
  const again = await eff.run(pool, deps);
  assert.equal(again.newConditions, 0);
  assert.equal(sent.length, 1, 'announced once per condition, not once per tick');
  assert.equal(again.filed, 0, 'and the issue is not re-filed either');

  // Recovery drops the stored set, so the same regression next month is news.
  await pool.query(`UPDATE usage_ledger SET input_tokens = 600000, cache_read_tokens = 1400000, cost_usd = 0.2
                     WHERE date = current_date - 1`);
  const healthy = await eff.run(pool, deps);
  assert.equal(healthy.crossed, 0);
  assert.deepEqual(await flags.getFlag(pool, eff.ALERTED_FLAG), []);
});

test('escalate: money alerts, the ratios that explain it do not alert alone', () => {
  const tok = { key: 'input_tokens_per_message' };
  const cache = { key: 'cache_hit_rate' };
  const money = { key: eff.MONEY_KEY };
  assert.deepEqual(eff.escalate([tok, cache]), { alerting: [], observed: [tok, cache] });
  assert.deepEqual(eff.escalate([tok, money]), { alerting: [tok, money], observed: [] });
  // Nothing is ever dropped: every crossing comes back out of one side or the
  // other, because a suppressed crossing that vanishes is a check that went
  // quiet, which reads exactly like a check that passed.
  for (const set of [[tok], [money], [tok, cache, money], []]) {
    const { alerting, observed } = eff.escalate(set);
    assert.equal(alerting.length + observed.length, set.length);
  }
});

test('a proxy that moved without the money is context, not an alarm', async () => {
  // This is the watch's own first alert, 2026-09-04 08:41, replayed: input
  // tokens per message 4x and the cache collapsed 70% → 12.5%, while the cost
  // per message sat exactly on its baseline. Two issues were filed and the
  // owner was messaged over it, and not one cent had moved.
  const sent = [];
  const deps = {
    llm: null,
    send: async (phone, text) => { sent.push({ phone, text }); return { ok: true }; },
    alertHourOpen: async () => true,
  };
  await pool.query(`DELETE FROM usage_ledger WHERE date = current_date - 1`);
  await seedDay(1, { messages: 0, inTokens: 8_000_000, cacheTokens: 1_000_000, cost: 0.2 });

  const { rows: before } = await pool.query(`SELECT count(*)::int AS n FROM issues`);
  const out = await eff.run(pool, deps);
  assert.equal(out.crossed, 2, JSON.stringify(out.ratios));
  assert.equal(out.alerted, 0, 'no cost crossing, so nothing may alert');
  assert.deepEqual(out.observed.sort(), ['cache_hit_rate', 'input_tokens_per_message'],
    'and the crossings are still named, in the heartbeat note, rather than swallowed');
  assert.equal(sent.length, 0);
  const { rows: after } = await pool.query(`SELECT count(*)::int AS n FROM issues`);
  assert.equal(after[0].n, before[0].n, 'a filed issue is a claim that something is wrong');
  // The suppressed condition must not spend the announce stamp either, or the
  // cost crossing it was the early warning for would arrive already silenced.
  assert.deepEqual(await flags.getFlag(pool, eff.ALERTED_FLAG), []);

  // Same day, same ratios, money now moved: it alerts. Without this the fix
  // above is indistinguishable from switching the watch off.
  await pool.query(`UPDATE usage_ledger SET cost_usd = 0.9 WHERE date = current_date - 1`);
  const real = await eff.run(pool, deps);
  assert.equal(real.crossed, 3);
  assert.equal(real.alerted, 3);
  assert.equal(real.notified, true);
  assert.equal(sent.length, 1);
});

test('a failed pipe leaves the condition unannounced, so the next tick retries', async () => {
  // The test above ends with the conditions stamped as announced; this one is
  // about the first announcement, so it starts from an un-announced watch.
  await flags.setFlag(pool, eff.ALERTED_FLAG, []);
  await pool.query(`DELETE FROM usage_ledger WHERE date = current_date - 1`);
  await seedDay(1, { messages: 0, inTokens: 7_000_000, cacheTokens: 1_750_000, cost: 0.9 });
  const deps = { llm: null, send: async () => ({ ok: false, error: 'gateway down' }), alertHourOpen: async () => true };
  const out = await eff.run(pool, deps);
  assert.equal(out.notifyFailed, true);
  assert.notDeepEqual(await flags.getFlag(pool, eff.ALERTED_FLAG), ['cost_per_message'],
    'stamping a send that never landed is how one outage swallows an alert permanently');

  // And at night it simply waits — unstamped, same promise. Nothing wakes the
  // owner any more (2026-09-01), and a ratio cannot be acted on at 03:00.
  const night = await eff.run(pool, { ...deps, alertHourOpen: async () => false });
  assert.equal(night.deferredToMorning, true);
  assert.equal(night.notified, false);
});

// Last, because it rewrites the whole week to make one point that a steady
// week cannot make: a median over seven identical days is unmovable, so a test
// built on one proves nothing about what the baseline is allowed to contain.
test('the partial day is kept out of the baseline, not only out of the verdict', async () => {
  await pool.query(`DELETE FROM usage_ledger`);
  await pool.query(`DELETE FROM audit_log WHERE event = 'message.received'`);
  // A week that is uneven on purpose, newest first: the seven complete days
  // before the subject run 40k,40k,40k,50k,60k,60k,200k input tokens per
  // message, so the median is 50k. It is built to break under either mistake.
  // Add one more SMALLER value — the day in progress, which at 09:00 is the
  // cheapest thing on the board every single morning — and the middle drops to
  // 40k. Drop the OLDEST instead, by fetching one row too few, and it drops to
  // 40k as well. Both turn the subject's honest 1.8x into a 2.25x crossing.
  const perMsg = [40, 40, 40, 50, 60, 60, 200];
  for (let i = 0; i < perMsg.length; i++) {
    await seedDay(i + 2, { messages: 40, inTokens: perMsg[i] * 1000 * 40, cacheTokens: 0, cost: 0.2 });
  }
  // The subject: 90k per message. 1.8x the real baseline of 50k — under the
  // 2x factor, so it must stay quiet. Against a baseline poisoned by the
  // partial day it is 2.25x, and the owner gets told about nothing.
  await seedDay(1, { messages: 40, inTokens: 90_000 * 40, cacheTokens: 0, cost: 0.2 });
  await seedDay(0, { messages: 40, inTokens: 5_000 * 40, cacheTokens: 0, cost: 0.02 });

  const out = await eff.run(pool, { llm: null, send: null });
  assert.equal(out.date, await yesterday());
  assert.equal(out.ratios.input_tokens_per_message, 90_000);
  assert.deepEqual(out.observed, [], JSON.stringify(out));
  assert.equal(out.crossed, 0,
    'the day in progress dragged the median down and turned 1.8x into a crossing');
});

test('the brief carries numbers and never a word anybody wrote', async () => {
  const today = { date: '2026-09-04', messages: 40, cost_per_message: 0.02, input_tokens_per_message: 175_000, cache_hit_rate: 0.25, system_cost_share: 0.1 };
  const crossed = [{ key: 'cache_hit_rate', label: 'x', now: 0.25, baseline: 0.7, times: 2.8, worse: 'lower' }];
  const ev = { models: [{ model: 'deepseek/deepseek-v4-flash', inTokens: 7e6, cacheRate: 0.25, cost: 0.9 }], users: [{ userId: 3, cost: 0.5, inTokens: 4e6 }] };
  const brief = eff.briefFor(crossed, today, ev, 39_146);
  assert.match(brief, /cache_hit_rate/);
  assert.match(brief, /system prompt/);
  // It is asked for a guess labelled as one. The alternative — a confident
  // cause invented to fill the slot — is worse than no recommendation, because
  // somebody would act on it.
  assert.match(brief, /labelled as one/);
  assert.match(brief, /say so instead of inventing one/);
  // No transcripts, no message text, no phone numbers ever reach the model
  // here: it sees aggregates and nothing else.
  assert.ok(!/\+972/.test(brief));
});
