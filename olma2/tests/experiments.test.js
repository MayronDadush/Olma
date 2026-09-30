'use strict';
// A/B tests on what Olma says and when (domain/experiments.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const experiments = require('../src/domain/experiments');
const dash = require('../src/domain/user-dashboard');
const write = require('../src/domain/user-dashboard-write');
const tasks = require('../src/domain/tasks');
const { renderExperiments } = require('../src/adapters/http/admin/sections/experiments');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const KEY = 'invite_card_moment';
const exposures = async (id) => Number((await db.pool.query(
  `SELECT count(*) FROM audit_log WHERE actor_id = $1 AND event = 'experiment.exposed'`, [id])).rows[0].count);

// A user in the arm asked for, made by trying numbers until the hash agrees.
async function userIn(variant, n) {
  for (let i = 0; i < 40; i++) {
    const u = await makeUser(db.pool, `+9726020${n}${String(i).padStart(3, '0')}`, { firstName: 'נועה' });
    if (experiments.variantFor(KEY, u.id) === variant) return u;
  }
  throw new Error('no user landed in ' + variant);
}

test('assignment is stable per person and splits roughly in half', () => {
  let b = 0;
  for (let id = 1; id <= 2000; id++) {
    const v = experiments.variantFor(KEY, id);
    assert.equal(v, experiments.variantFor(KEY, id));
    if (v === 'b') b++;
  }
  assert.ok(b > 900 && b < 1100, `b got ${b} of 2000`);
});

test('exposure is recorded once, and not at all once the owner locks a variant', async () => {
  const u = await makeUser(db.pool, '+972602100001');
  const v = await withTx(db.pool, (c) => experiments.expose(c, KEY, u.id));
  await withTx(db.pool, (c) => experiments.expose(c, KEY, u.id));
  assert.equal(await exposures(u.id), 1);
  assert.equal(v, experiments.variantFor(KEY, u.id));

  const other = v === 'a' ? 'b' : 'a';
  assert.equal(await withTx(db.pool, (c) => experiments.lock(c, KEY, other)), true);
  const late = await makeUser(db.pool, '+972602100002');
  assert.equal(await withTx(db.pool, (c) => experiments.expose(c, KEY, late.id)), other, 'everybody gets the locked one');
  assert.equal(await withTx(db.pool, (c) => experiments.expose(c, KEY, u.id)), other);
  assert.equal(await exposures(late.id), 0, 'an ended experiment measures nothing');
  assert.equal(await withTx(db.pool, (c) => experiments.lock(c, KEY, 'c')), false, 'no such variant');
  assert.equal(await withTx(db.pool, (c) => experiments.lock(c, 'nope', 'a')), false, 'no such experiment');
  await withTx(db.pool, (c) => experiments.lock(c, KEY, null));
  assert.equal((await withTx(db.pool, (c) => experiments.assign(c, KEY, late.id))).running, true);
});

test('variant b draws the invite card only after a good moment; a draws it always', async () => {
  const a = await userIn('a', 1);
  const b = await userIn('b', 2);
  const inviteOf = async (u) => (await withTx(db.pool, (c) => dash.load(c, u.id))).data.invite;
  assert.ok(await inviteOf(a), 'a: always');
  assert.equal(await inviteOf(b), null, 'b: nothing good has happened yet');

  const t = await withTx(db.pool, (c) => tasks.addTask(c, b.id, { title: 'לקנות חלב' }));
  await db.pool.query(`UPDATE tasks SET status = 'done', completed_at = now() - interval '3 days' WHERE id = $1`, [t.data.task.id]);
  assert.equal(await inviteOf(b), null, 'a moment older than 48 hours does not count');
  await db.pool.query(`UPDATE tasks SET completed_at = now() - interval '1 hour' WHERE id = $1`, [t.data.task.id]);
  assert.ok(await inviteOf(b), 'b: a task just done');
});

test('a tap on the card is recorded as the outcome, and counted against the right arm', async () => {
  const u = await userIn('a', 3);
  const r = await withTx(db.pool, (c) => write.perform(c, u.id, 'inviteShared', { how: 'copy' }));
  assert.equal(r.ok, true);
  const { rows } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'referral.shared'`, [u.id]);
  assert.deepEqual(rows.map((x) => x.detail), [{ how: 'copy' }]);

  // Exposed nine days ago, shared a day later: inside the 7-day window, and
  // that window has closed, so it counts.
  await withTx(db.pool, (c) => experiments.expose(c, KEY, u.id));
  await db.pool.query(`UPDATE audit_log SET created_at = now() - interval '9 days'
                        WHERE actor_id = $1 AND event = 'experiment.exposed'`, [u.id]);
  await db.pool.query(`UPDATE audit_log SET created_at = now() - interval '8 days'
                        WHERE actor_id = $1 AND event = 'referral.shared'`, [u.id]);
  const res = await withTx(db.pool, (c) => experiments.results(c, KEY));
  const arm = res.arms.find((x) => x.variant === 'a');
  assert.ok(arm.done >= 1 && arm.converted >= 1);
  assert.equal(res.verdict.call, 'early', 'a handful of people is never a result');

  const html = await withTx(db.pool, (c) => renderExperiments(c, 'tok'));
  assert.match(html, /מתי מופיע כרטיס ההזמנה/);
  assert.match(html, /עוד מוקדם/);
  assert.match(html, /action="\/experiments\/lock"/);
});

test('the verdict waits for enough people, then needs a real difference', () => {
  const arm = (converted, done) => ({ converted, done });
  assert.equal(experiments.verdict([arm(10, 20), arm(1, 20)]).call, 'early');
  assert.equal(experiments.verdict([arm(20, 100), arm(22, 100)]).call, 'no_difference');
  const v = experiments.verdict([arm(40, 100), arm(20, 100)]);
  assert.equal(v.call, 'a');
  assert.ok(v.p < 0.01, `p=${v.p}`);
  assert.equal(experiments.pValue(0, 0, 1, 1), null);
});
