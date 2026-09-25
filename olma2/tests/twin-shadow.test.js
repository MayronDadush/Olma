'use strict';
// Jev in shadow over the duplicate-task judgement (jobs/twin-shadow.js). The
// promises tested here are the ones that make it safe to switch on: it asks
// nothing while the flag is off, never about the eval user, writes ids and not
// words, survives an outage by asking again later, never reads a bad answer
// as "no twin", and puts every call on the ledger.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const tasks = require('../src/domain/tasks');
const flags = require('../src/domain/flags');
const shadow = require('../src/jobs/twin-shadow');
const jev = require('../src/adapters/jev');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const c = await db.pool.connect();
  try { return await fn(c); } finally { c.release(); }
}

// A task written `hoursAgo` hours back, through the real domain.
async function taskAt(c, userId, title, hoursAgo) {
  const r = await tasks.addTask(c, userId, { title, source: 'chat' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await c.query(`UPDATE tasks SET created_at = now() - ($2::numeric * interval '1 hour') WHERE id = $1`,
    [r.data.task.id, hoursAgo]);
  return r.data.task;
}

// A stand-in for Jev that picks the entry whose title it is told to, and
// remembers what it was asked.
function fakeJev(pickTitle, { confidence = 0.88 } = {}) {
  const calls = [];
  const decide = async (state, questions) => {
    calls.push({ state, questions });
    const key = Object.keys(state.open_list).find((k) => state.open_list[k] === pickTitle) || 'none';
    return {
      ok: true,
      answers: { dup: { type: 'choice', choice: key, confidence } },
      model: 'typesafe/jev-1.13-test',
      usage: { input: 300, output: 20, costUsd: 0.0000126 },
      ms: 180,
    };
  };
  return { decide, calls };
}

async function rows(c) {
  return (await c.query(`SELECT * FROM task_twin_shadow ORDER BY task_id`)).rows;
}

async function reset(c) {
  await c.query(`DELETE FROM task_twin_shadow`);
  await c.query(`DELETE FROM usage_system_ledger WHERE agent_id = $1`, [shadow.AGENT_ID]);
  await c.query(`DELETE FROM tasks`);
}

test('with the flag off it asks nothing and writes nothing — and off is the default', async () => {
  assert.equal(flags.DEFAULTS[shadow.FLAG], false);
  await withClient(async (c) => {
    await reset(c);
    const u = await makeUser(db.pool, '+972501300001', { firstName: 'Tal' });
    await taskAt(c, u.id, 'לקנות חלב', 2);
    await taskAt(c, u.id, 'לקנות חלב וביצים', 1);
    const jevFake = fakeJev('לקנות חלב');
    const out = await shadow.sweepTwinShadow(c, { decide: jevFake.decide });
    assert.deepEqual(out, { off: true });
    assert.equal(jevFake.calls.length, 0);
    assert.equal((await rows(c)).length, 0);
  });
});

test('a rewording the code misses is recorded beside what Jev picked, and acts on nothing', async () => {
  await withClient(async (c) => {
    await reset(c);
    await flags.setFlag(c, shadow.FLAG, true);
    const u = await makeUser(db.pool, '+972501300002', { firstName: 'Gal' });
    const first = await taskAt(c, u.id, 'לדבר עם מור חן — לבקש חומרי גלם', 3);
    const again = await taskAt(c, u.id, 'להזכיר למור חן להעביר חומרי גלם', 1);
    const before = (await c.query(`SELECT id, title, status, archived_at FROM tasks ORDER BY id`)).rows;

    const jevFake = fakeJev('לדבר עם מור חן — לבקש חומרי גלם');
    const out = await shadow.sweepTwinShadow(c, { decide: jevFake.decide });
    // The first task had nothing before it: no call for it at all.
    assert.equal(out.noList, 1);
    assert.equal(out.asked, 1);
    assert.equal(out.differed, 1, 'the code said "different" and Jev said "the same" — that is the row worth reading');
    assert.equal(jevFake.calls.length, 1);
    assert.deepEqual(Object.values(jevFake.calls[0].state.open_list), ['לדבר עם מור חן — לבקש חומרי גלם']);
    assert.equal(jevFake.calls[0].state.new_title, 'להזכיר למור חן להעביר חומרי גלם');

    const [a, b] = await rows(c);
    assert.equal(String(a.task_id), String(first.id));
    assert.equal(a.list_size, 0);
    assert.equal(a.jev_pick_id, null);
    assert.equal(String(b.task_id), String(again.id));
    assert.equal(b.list_size, 1);
    assert.equal(b.code_twin_id, null, 'word overlap cannot see לבקש and להעביר as one act');
    assert.equal(String(b.code_best_id), String(first.id));
    assert.equal(String(b.jev_pick_id), String(first.id));
    assert.equal(Number(b.jev_confidence), 0.88);
    assert.equal(b.jev_model, 'typesafe/jev-1.13-test');
    assert.equal(b.jev_error, null);

    // Nothing about either task changed.
    assert.deepEqual((await c.query(`SELECT id, title, status, archived_at FROM tasks ORDER BY id`)).rows, before);

    // The call is on the ledger at the price OpenRouter stated.
    const { rows: ledger } = await c.query(
      `SELECT model, input_tokens, cost_usd, estimated FROM usage_system_ledger WHERE agent_id = $1`, [shadow.AGENT_ID]);
    assert.equal(ledger.length, 1);
    assert.equal(Number(ledger[0].input_tokens), 300);
    assert.equal(Number(ledger[0].cost_usd), 0.0000126);
    assert.equal(ledger[0].estimated, false);

    // Asked once: the next tick finds nothing to ask about.
    const second = await shadow.sweepTwinShadow(c, { decide: jevFake.decide });
    assert.equal(second.asked, 0);
    assert.equal(jevFake.calls.length, 1);
  });
});

test('the code and Jev agreeing is counted as agreement, and "none" against "none" too', async () => {
  await withClient(async (c) => {
    await reset(c);
    await flags.setFlag(c, shadow.FLAG, true);
    const u = await makeUser(db.pool, '+972501300003', { firstName: 'Noa' });
    await taskAt(c, u.id, 'להוריד את כל השירים', 3);
    await taskAt(c, u.id, 'להוריד את כל השירים שלי', 2);
    await taskAt(c, u.id, 'לשטוף את הרכב', 1);
    const out = await shadow.sweepTwinShadow(c, { decide: fakeJev('להוריד את כל השירים').decide });
    // השירים שלי: both pick the first. לשטוף את הרכב: the fake picks the
    // first again, the code says none — so one disagreement, one agreement.
    assert.equal(out.asked, 2);
    assert.equal(out.agreed, 1);
    assert.equal(out.differed, 1);
  });
});

test('the eval user and a test account are never asked about', async () => {
  await withClient(async (c) => {
    await reset(c);
    await flags.setFlag(c, shadow.FLAG, true);
    const e = await makeUser(db.pool, '+972501300004', { firstName: 'Eval' });
    await c.query(`UPDATE users SET is_eval = true WHERE id = $1`, [e.id]);
    await taskAt(c, e.id, 'משימה של בדיקה', 2);
    await taskAt(c, e.id, 'עוד משימה של בדיקה', 1);
    const dev = await makeUser(db.pool, '+972501300008', { firstName: 'Dev' });
    await c.query(`UPDATE users SET is_test = true WHERE id = $1`, [dev.id]);
    await taskAt(c, dev.id, 'משימה של פיתוח', 2);
    await taskAt(c, dev.id, 'עוד משימה של פיתוח', 1);
    const jevFake = fakeJev('משימה של בדיקה');
    const out = await shadow.sweepTwinShadow(c, { decide: jevFake.decide });
    assert.equal(jevFake.calls.length, 0);
    assert.equal(out.asked + out.noList, 0);
    assert.equal((await rows(c)).length, 0);
  });
});

test('the list is what was open THEN: nothing written later, nothing already done', async () => {
  await withClient(async (c) => {
    await reset(c);
    await flags.setFlag(c, shadow.FLAG, true);
    const u = await makeUser(db.pool, '+972501300005', { firstName: 'Ron' });
    const done = await taskAt(c, u.id, 'לשלם ארנונה', 5);
    await c.query(`UPDATE tasks SET status = 'done', completed_at = now() - interval '4 hours' WHERE id = $1`, [done.id]);
    const stillOpen = await taskAt(c, u.id, 'לקבוע תור לרופא', 4);
    const target = await taskAt(c, u.id, 'לקבוע תור לרופא שיניים', 3);
    await taskAt(c, u.id, 'לקנות מתנה', 1);
    const list = await shadow.openListAt(c, { ...target, owner_id: u.id,
      created_at: (await c.query(`SELECT created_at FROM tasks WHERE id = $1`, [target.id])).rows[0].created_at });
    assert.deepEqual(list.map((r) => String(r.id)), [String(stillOpen.id)]);
  });
});

test('an outage writes nothing and stops the tick, so the same tasks are asked next time', async () => {
  await withClient(async (c) => {
    await reset(c);
    await flags.setFlag(c, shadow.FLAG, true);
    const u = await makeUser(db.pool, '+972501300006', { firstName: 'Dana' });
    await taskAt(c, u.id, 'לתקן את הדוד', 3);
    await taskAt(c, u.id, 'להזמין טכנאי לדוד', 2);
    await taskAt(c, u.id, 'לקנות נורות', 1);
    let asked = 0;
    const down = async () => { asked += 1; return { ok: false, error: 'timeout', ms: 15000 }; };
    const out = await shadow.sweepTwinShadow(c, { decide: down });
    assert.equal(out.unreachable, 'timeout');
    assert.equal(asked, 1, 'the first failure stops the tick — no ten timeouts in a row');
    // The first task needed no call and is recorded; the one that failed is not.
    assert.equal((await rows(c)).length, 1);
    const back = await shadow.sweepTwinShadow(c, { decide: fakeJev('לתקן את הדוד').decide });
    assert.equal(back.asked, 2);
    assert.equal((await rows(c)).length, 3);
  });
});

test('a failure about THIS input is written once as an error, and a pick outside the list is never "none"', async () => {
  await withClient(async (c) => {
    await reset(c);
    await flags.setFlag(c, shadow.FLAG, true);
    const u = await makeUser(db.pool, '+972501300007', { firstName: 'Lior' });
    await taskAt(c, u.id, 'לשלוח חשבונית', 3);
    await taskAt(c, u.id, 'לשלוח את החשבונית ללקוח', 2);
    await taskAt(c, u.id, 'לחדש דרכון', 1);
    let n = 0;
    const odd = async () => {
      n += 1;
      if (n === 1) return { ok: false, error: 'http_422', ms: 90 };
      return { ok: true, answers: { dup: { choice: 't99', confidence: 0.97 } }, model: 'm', usage: { input: 10, output: 1, costUsd: 0 }, ms: 90 };
    };
    const out = await shadow.sweepTwinShadow(c, { decide: odd });
    assert.equal(out.errors, 2);
    const r = await rows(c);
    assert.deepEqual(r.map((x) => x.jev_error), [null, 'http_422', 'unknown_choice']);
    assert.ok(r.every((x) => x.jev_pick_id === null));
    const again = await shadow.sweepTwinShadow(c, { decide: odd });
    assert.equal(again.errors, 0, 'asked once, never again');
  });
});

test('the adapter never throws: every failure is a short reason', async () => {
  const resp = (status, body) => async () => ({ ok: status < 400, status, text: async () => body });
  assert.deepEqual(await jev.decide({}, {}, { key: '' }), { ok: false, error: 'no_key' });
  assert.equal((await jev.decide({}, {}, { key: 'k', fetchImpl: resp(500, 'oops') })).error, 'http_500');
  assert.equal((await jev.decide({}, {}, { key: 'k', fetchImpl: resp(200, '<html>') })).error, 'not_json');
  assert.equal((await jev.decide({}, {}, { key: 'k', fetchImpl: resp(200, '{"model":"x"}') })).error, 'no_answers');
  assert.equal((await jev.decide({}, {}, { key: 'k', fetchImpl: async () => { throw new Error('ECONNRESET'); } })).error, 'network');
  const hang = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  assert.equal((await jev.decide({}, {}, { key: 'k', fetchImpl: hang, timeoutMs: 20 })).error, 'timeout');

  // The body run #91 actually saw, read the way the job reads it.
  const real = '{"model":"typesafe/jev-1.13-20260917","answers":{"dup":{"type":"choice","choice":"t2","confidence":0.91}},"usage":{"input_tokens":293,"output_tokens":20,"cost":0.000012306}}';
  let sent;
  const r = await jev.decide({ a: 1 }, { dup: {} }, {
    key: 'k', fetchImpl: async (url, init) => { sent = { url, init }; return { ok: true, status: 200, text: async () => real }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(jev.choiceOf(r.answers.dup), { choice: 't2', confidence: 0.91 });
  assert.deepEqual(r.usage, { input: 293, output: 20, costUsd: 0.000012306 });
  assert.equal(sent.url, jev.ENDPOINT);
  assert.equal(JSON.parse(sent.init.body).model, jev.DEFAULT_MODEL);
  assert.equal(sent.init.headers.authorization, 'Bearer k');
});

test('an outage is only what the endpoint would say again later', () => {
  for (const e of ['no_key', 'timeout', 'network', 'http_401', 'http_404', 'http_429', 'http_500', 'http_529']) {
    assert.equal(shadow.isOutage(e), true, e);
  }
  for (const e of ['http_400', 'http_422', 'not_json', 'no_answers']) {
    assert.equal(shadow.isOutage(e), false, e);
  }
});
