'use strict';
// Jev in shadow over a new fact (jobs/fact-shadow.js). Same promises as the task
// twin shadow, because they are what make it safe to switch on: nothing asked
// while the flag is off, never the eval user, never a profile-page answer,
// ids and not words in the table, an outage asks again later, a bad answer is
// never read as an answer, every call is on the ledger — and nothing about the
// fact changes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const facts = require('../src/domain/facts');
const flags = require('../src/domain/flags');
const shadow = require('../src/jobs/fact-shadow');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const c = await db.pool.connect();
  try { return await fn(c); } finally { c.release(); }
}

async function factAt(c, userId, category, fact, hoursAgo, extra = {}) {
  const r = await facts.rememberFact(c, userId, { category, fact, ...extra });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await c.query(`UPDATE user_facts SET learned_at = now() - ($2::numeric * interval '1 hour') WHERE id = $1`,
    [r.data.fact.id, hoursAgo]);
  return r.data.fact;
}

// A stand-in for Jev: says `life` for the fact, and picks the entry whose text
// it is told to (or none), and remembers what it was asked.
function fakeJev({ life = 'event', pick = null, lifeConf = 0.9, twinConf = 0.8 } = {}) {
  const calls = [];
  const decide = async (state, questions) => {
    calls.push({ state, questions });
    const answers = { life: { type: 'choice', choice: life, confidence: lifeConf } };
    if (questions.twin) {
      const key = Object.keys(state.other_facts).find((k) => state.other_facts[k] === pick) || 'none';
      answers.twin = { type: 'choice', choice: key, confidence: twinConf };
    }
    return { ok: true, answers, model: 'typesafe/jev-1.13-test', usage: { input: 300, output: 20, costUsd: 0.0000126 }, ms: 150 };
  };
  return { decide, calls };
}

const rows = async (c) => (await c.query('SELECT * FROM fact_shadow ORDER BY fact_id')).rows;
async function reset(c) {
  await c.query('DELETE FROM fact_shadow');
  await c.query('DELETE FROM usage_system_ledger WHERE agent_id = $1', [shadow.AGENT_ID]);
  await c.query('DELETE FROM user_facts');
}

test('off is the default, and with the flag off nothing is asked or written', async () => {
  assert.equal(flags.DEFAULTS[shadow.FLAG], false);
  await withClient(async (c) => {
    await reset(c);
    const u = await makeUser(db.pool, '+972501400001', { firstName: 'Tal' });
    await factAt(c, u.id, 'health', 'הולכת לניתוח', 1);
    const j = fakeJev();
    assert.deepEqual(await shadow.sweepFactShadow(c, { decide: j.decide }), { off: true });
    assert.equal(j.calls.length, 0);
    assert.equal((await rows(c)).length, 0);
  });
});

test('an undated event is recorded beside what the code knew, and the fact is untouched', async () => {
  await withClient(async (c) => {
    await reset(c);
    await flags.setFlag(c, shadow.FLAG, true);
    const u = await makeUser(db.pool, '+972501400002', { firstName: 'Gal' });
    const old = await factAt(c, u.id, 'family', 'לסבתא יש מכשיר שמיעה', 30);
    const surgery = await factAt(c, u.id, 'health', 'הולכת לניתוח', 1, { importance: 3 });
    const before = (await c.query('SELECT * FROM user_facts WHERE id = $1', [surgery.id])).rows[0];

    const j = fakeJev({ life: 'event' });
    const out = await shadow.sweepFactShadow(c, { decide: j.decide });
    assert.equal(out.asked, 1, 'the old one is outside the window');
    const [r] = await rows(c);
    assert.equal(Number(r.fact_id), Number(surgery.id));
    assert.equal(r.jev_life, 'event');
    assert.equal(r.code_dated, false, 'the code could not see an end — the point of asking');
    assert.equal(r.list_size, 1);
    assert.equal(r.jev_twin_id, null);

    // ids and numbers, never the words
    assert.ok(!JSON.stringify(r).includes('ניתוח'));
    // and the fact is exactly as it was
    const after = (await c.query('SELECT * FROM user_facts WHERE id = $1', [surgery.id])).rows[0];
    assert.deepEqual(after, before);
    assert.ok(old.id);
    // the call is on the ledger at the price it stated
    const led = (await c.query(`SELECT * FROM usage_system_ledger WHERE agent_id = $1`, [shadow.AGENT_ID])).rows;
    assert.equal(led.length, 1);
    assert.equal(led[0].estimated, false);
  });
});

test('the same fact in other words: Jev\'s pick is recorded as a twin, the code\'s answer beside it', async () => {
  await withClient(async (c) => {
    await reset(c);
    await flags.setFlag(c, shadow.FLAG, true);
    const u = await makeUser(db.pool, '+972501400003', { firstName: 'Dan' });
    const older = await factAt(c, u.id, 'family', 'האמא שלו צריכה פתרונות טבעיים לתרופות', 3);
    await factAt(c, u.id, 'family', 'לאמא יש בעיות עם תרופות כימיות', 1);
    const j = fakeJev({ life: 'lasting', pick: 'האמא שלו צריכה פתרונות טבעיים לתרופות' });
    await shadow.sweepFactShadow(c, { decide: j.decide });
    const all = await rows(c);
    assert.equal(all.length, 2);
    const second = all[1];
    assert.equal(Number(second.jev_twin_id), Number(older.id));
    assert.equal(second.jev_life, 'lasting');
    // the question the model saw holds the OTHER facts, never itself
    const asked = j.calls[1];
    assert.deepEqual(Object.values(asked.state.other_facts), ['האמא שלו צריכה פתרונות טבעיים לתרופות']);
  });
});

test('never the eval user, a test account, a profile-page answer, or an expired fact', async () => {
  await withClient(async (c) => {
    await reset(c);
    await flags.setFlag(c, shadow.FLAG, true);
    const ev = await makeUser(db.pool, '+972501400004', { firstName: 'Ev' });
    const te = await makeUser(db.pool, '+972501400005', { firstName: 'Te' });
    const real = await makeUser(db.pool, '+972501400006', { firstName: 'Real' });
    await c.query('UPDATE users SET is_eval = true WHERE id = $1', [ev.id]);
    await c.query('UPDATE users SET is_test = true WHERE id = $1', [te.id]);
    await factAt(c, ev.id, 'plans', 'טס לרומא', 1);
    await factAt(c, te.id, 'plans', 'טס לפריז', 1);
    await factAt(c, real.id, 'context', 'עיר מגורים: הוד השרון', 1, { promptKey: 'home_city', source: 'user_stated' });
    const kept = await factAt(c, real.id, 'plans', 'מתכנן טיול לוייטנאם', 1);
    const j = fakeJev();
    await shadow.sweepFactShadow(c, { decide: j.decide });
    const r = await rows(c);
    assert.deepEqual(r.map((x) => Number(x.fact_id)), [Number(kept.id)]);
  });
});

test('an outage writes nothing and stops the tick; a failure about this input is one error row', async () => {
  await withClient(async (c) => {
    await reset(c);
    await flags.setFlag(c, shadow.FLAG, true);
    const u = await makeUser(db.pool, '+972501400007', { firstName: 'Out' });
    await factAt(c, u.id, 'plans', 'פגישה אצל רופא שיניים בשבוע הבא', 2);
    await factAt(c, u.id, 'plans', 'מתכנן טיול לוייטנאם', 1);

    const calls = [];
    const down = async () => { calls.push(1); return { ok: false, error: 'timeout', ms: 15000 }; };
    const out = await shadow.sweepFactShadow(c, { decide: down });
    assert.equal(out.unreachable, 'timeout');
    assert.equal(calls.length, 1, 'stopped at the first');
    assert.equal((await rows(c)).length, 0, 'so both are asked again next time');

    const bad = async () => ({ ok: false, error: 'http_400', ms: 40 });
    const out2 = await shadow.sweepFactShadow(c, { decide: bad });
    assert.equal(out2.errors, 2);
    assert.deepEqual((await rows(c)).map((x) => x.jev_error), ['http_400', 'http_400']);

    // a choice outside what it was given is never read as an answer
    await c.query('DELETE FROM fact_shadow');
    const odd = async () => ({ ok: true, answers: { life: { choice: 'sometimes', confidence: 0.9 } }, model: 'm', usage: { input: 1, output: 1, costUsd: 0 }, ms: 1 });
    await shadow.sweepFactShadow(c, { decide: odd });
    assert.ok((await rows(c)).every((x) => x.jev_error === 'unknown_choice' && x.jev_life === null));
  });
});

test('deleting the fact or the person takes the record with it', async () => {
  await withClient(async (c) => {
    await reset(c);
    await flags.setFlag(c, shadow.FLAG, true);
    const u = await makeUser(db.pool, '+972501400008', { firstName: 'Del' });
    const f = await factAt(c, u.id, 'plans', 'מתכנן לעבור דירה', 1);
    await shadow.sweepFactShadow(c, { decide: fakeJev().decide });
    assert.equal((await rows(c)).length, 1);
    await c.query('DELETE FROM user_facts WHERE id = $1', [f.id]);
    assert.equal((await rows(c)).length, 0);
  });
});
