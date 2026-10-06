'use strict';
// Olma's own pictures are rationed: two a day, three hours apart, and only the
// ones she started. A person who asks is never refused (domain/card-budget.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const cardBudget = require('../src/domain/card-budget');
const selfInitiated = require('../src/domain/self-initiated');
const repeatGuard = require('../src/domain/repeat-guard');
const { sweepDigests } = require('../src/jobs/sweeps');
const { BY_NAME } = require('../src/adapters/mcp/registry');

let db, user;
const H = 3600_000;

before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972500000931', { firstName: 'Gali' });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-budget-ws-'));
  await db.pool.query(
    `UPDATE users SET workspace_path = $2, digest_times = '09:00', digest_scope = 'summary',
       timezone = 'Asia/Jerusalem', onboarded_at = now() WHERE id = $1`, [user.id, ws]);
});
after(async () => { await db.teardown(); });

async function drawnAt(hoursAgo) {
  await db.pool.query(
    `INSERT INTO audit_log (actor_id, event, created_at) VALUES ($1, 'card.drawn', $2)`,
    [user.id, new Date(Date.now() - hoursAgo * H)]);
}
const reset = () => db.pool.query(`DELETE FROM audit_log WHERE actor_id = $1 AND event = 'card.drawn'`, [user.id]);
const sample = () => ({ sections: [{ title: 'היום', items: [{ date: 'היום', text: 'משימה', icon: 'generic' }] }] });

test('the budget: two a day, three hours apart', async () => {
  await reset();
  assert.equal((await cardBudget.check(db.pool, user.id)).ok, true);

  await drawnAt(1);
  const soon = await cardBudget.check(db.pool, user.id);
  assert.equal(soon.ok, false);
  assert.equal(soon.reason, 'too_soon');

  await reset(); await drawnAt(4);
  assert.equal((await cardBudget.check(db.pool, user.id)).ok, true, 'four hours on, a second is allowed');

  await drawnAt(3.5);
  const capped = await cardBudget.check(db.pool, user.id);
  assert.equal(capped.reason, 'daily_cap', 'two inside the day is the end of it');

  await reset(); await drawnAt(30); await drawnAt(26);
  assert.equal((await cardBudget.check(db.pool, user.id)).ok, true, 'yesterday\'s pictures do not count');
});

test('a card Olma started is refused past the budget, and one the person asked for is not', async () => {
  await reset(); repeatGuard._reset(); selfInitiated._reset(); selfInitiated._setGraceMs(0);
  const { rows: [u] } = await db.pool.query(`SELECT * FROM users WHERE id = $1`, [user.id]);
  const tool = BY_NAME.get('render_schedule_card');

  await selfInitiated.around(u.id, async () => {
    const first = await tool.handler(db.pool, u, sample(), {});
    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    const second = await tool.handler(db.pool, u, { ...sample(), subtitle: 'אחרת' }, {});
    assert.equal(second.ok, false, 'a second picture inside three hours');
    assert.equal(second.error.code, 'conflict');
  });
  const { rows } = await db.pool.query(
    `SELECT 1 FROM audit_log WHERE actor_id = $1 AND event = 'card.drawn'`, [u.id]);
  assert.equal(rows.length, 1, 'only the card that was drawn is on the ledger');

  const asked = await tool.handler(db.pool, u, { ...sample(), subtitle: 'ביקשתי' }, {});
  assert.equal(asked.ok, true, 'they asked: answering is not repeating');
  const { rows: after2 } = await db.pool.query(
    `SELECT 1 FROM audit_log WHERE actor_id = $1 AND event = 'card.drawn'`, [u.id]);
  assert.equal(after2.length, 1, 'and a card they asked for is not charged to Olma');
});

test('get_my_digest hands a block, not an order to draw, once the budget is spent', async () => {
  const tasksDomain = require('../src/domain/tasks');
  await db.pool.query(`DELETE FROM tasks WHERE owner_id = $1`, [user.id]);
  for (let i = 0; i < 4; i++) await tasksDomain.addTask(db.pool, user.id, { title: `משימה ${i + 1}` });
  const def = BY_NAME.get('get_my_digest');
  const fresh = (await db.pool.query(`SELECT * FROM users WHERE id = $1`, [user.id])).rows[0];

  await reset(); selfInitiated._reset(); selfInitiated._setGraceMs(0);
  await selfInitiated.around(user.id, async () => {
    const open = await def.handler(db.pool, fresh, { scope: 'full' });
    assert.ok(open.data.hints.card.includes('render_schedule_card'), 'budget free: draw');
    assert.equal(open.data.block, undefined);

    await drawnAt(1);
    const spent = await def.handler(db.pool, fresh, { scope: 'full' });
    assert.ok(spent.data.block, 'budget spent: the list is a block');
    assert.match(spent.data.hints.card, /do NOT call render_schedule_card/);
  });

  // The person asking is not rationed.
  const asked = await def.handler(db.pool, fresh, { scope: 'full' });
  assert.equal(asked.data.block, undefined);
  assert.ok(asked.data.hints.card.includes('render_schedule_card'));
});

test('the scheduled digest always fetches the list, except for "today"', async () => {
  const fire = new Date('2026-09-15T06:00:30Z');
  await db.pool.query(`DELETE FROM outbox WHERE user_id = $1`, [user.id]);
  await sweepDigests(db.pool, fire);
  let { rows } = await db.pool.query(`SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'digest'`, [user.id]);
  assert.equal(rows[0].payload.scope, 'full', 'a summary person still gets the list drawn or laid out');

  await db.pool.query(`DELETE FROM outbox WHERE user_id = $1`, [user.id]);
  await db.pool.query(`UPDATE users SET digest_scope = 'today' WHERE id = $1`, [user.id]);
  await sweepDigests(db.pool, fire);
  ({ rows } = await db.pool.query(`SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'digest'`, [user.id]));
  assert.equal(rows[0].payload.scope, 'today', 'a narrower question they chose stays as asked');
});
