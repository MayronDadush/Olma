'use strict';
// A task shared with a number not on Olma: one message, ever, and the share
// follows their approval (intake/share-invite.js; owner, 2026-09-30).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const connections = require('../src/domain/connections');
const experiments = require('../src/domain/experiments');
const shareInvite = require('../src/intake/share-invite');

let db, broker, dana;
before(async () => {
  db = await freshDb();
  broker = createBrokerServer({ pool: db.pool });
  dana = await makeUser(db.pool, '+972631000001', { firstName: 'דנה' });
});
after(async () => { await db.teardown(); });

async function call(user, name, args) {
  const res = await broker.dispatch({
    id: 1, method: 'tool_call',
    params: { name, args: { olma_identity: user.identity_token, ...args } },
  });
  assert.ok(res.ok, `${name} transport failed`);
  return res.text;
}
async function taskOf(user, title) {
  const added = await call(user, 'add_task', { title });
  return Number(/"id":"?(\d+)/.exec(added)[1]);
}
const introsTo = async (phone) => (await db.pool.query(
  `SELECT o.* FROM outbox o JOIN users u ON u.id = o.user_id
    WHERE u.phone = $1 AND o.kind = 'connection_intro' ORDER BY o.id`, [phone])).rows;

test('a stranger gets ONE message naming the sharer and the task, in the variant they were dealt', async () => {
  const phone = '+972631000100';
  const taskId = await taskOf(dana, 'לקנות *מתנה* לנועה');
  const text = await call(dana, 'share_task_with', { task_id: taskId, phone });
  assert.match(text, /"invited":true/);
  const rows = await introsTo(phone);
  assert.equal(rows.length, 1);
  const pending = (await db.pool.query(`SELECT id, status FROM users WHERE phone = $1`, [phone])).rows[0];
  assert.equal(pending.status, 'pending');
  const variant = experiments.variantFor('task_share_intro', pending.id);
  const msg = rows[0].payload.text;
  assert.equal(msg, shareInvite.messageFor(variant,
    { inviterName: 'דנה', inviterPhone: dana.phone, task: 'לקנות מתנה לנועה', phone }, {}));
  assert.match(msg, /\*לקנות מתנה לנועה\*/, 'their markup is stripped, ours wraps it');
  assert.match(msg, /ולא אכתוב שוב/);
  const exposed = (await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'experiment.exposed'`, [pending.id])).rows;
  assert.deepEqual(exposed.map((r) => r.detail.variant), [variant]);

  // A second task, and a second sharer: still that one message.
  const again = await call(dana, 'share_task_with', { task_id: await taskOf(dana, 'עוד משהו'), phone });
  assert.match(again, /already_invited/);
  const eli = await makeUser(db.pool, '+972631000002', { firstName: 'אלי' });
  assert.match(await call(eli, 'share_task_with', { task_id: await taskOf(eli, 'שלי'), phone }), /already_invited/);
  assert.equal((await introsTo(phone)).length, 1);
});

test('the eval bot never writes to a stranger', async () => {
  const bot = await makeUser(db.pool, '+972631000009', { firstName: 'Eval', isEval: true });
  await db.pool.query(`UPDATE users SET is_eval = true WHERE id = $1`, [bot.id]);
  const text = await call(bot, 'share_task_with', { task_id: await taskOf(bot, 'x'), phone: '+972631000900' });
  assert.match(text, /not_connected/);
  assert.equal((await introsTo('+972631000900')).length, 0);
});

test('a real user who is simply not connected keeps the old answer, and nothing is sent', async () => {
  const other = await makeUser(db.pool, '+972631000003', { firstName: 'רועי' });
  const text = await call(dana, 'share_task_with', { task_id: await taskOf(dana, 'משהו'), phone: other.phone });
  assert.match(text, /not_connected/);
  assert.equal((await introsTo(other.phone)).length, 0);
});

test('a sharer reaches at most three new numbers a day', async () => {
  const gil = await makeUser(db.pool, '+972631000004', { firstName: 'גיל' });
  const out = [];
  for (let i = 0; i < 4; i++) {
    out.push(await call(gil, 'share_task_with', { task_id: await taskOf(gil, `משימה ${i}`), phone: `+97263100020${i}` }));
  }
  assert.equal(out.filter((t) => /"invited":true/.test(t)).length, shareInvite.DAILY_CAP);
  assert.match(out[3], /daily_cap/);
  assert.equal((await introsTo('+972631000203')).length, 0);
});

test('when they join and approve, the task is offered to them without anybody asking again', async () => {
  const phone = '+972631000300';
  const taskId = await taskOf(dana, 'לתאם טיול');
  await call(dana, 'share_task_with', { task_id: taskId, phone });
  // Joining, as provisioning does it: the pending row is taken on, and the
  // invite moves to pending_target.
  const { rows: [p] } = await db.pool.query(
    `UPDATE users SET status = 'active', agent_id = 'u-t300', first_name = 'נועה', onboarded_at = now()
      WHERE phone = $1 RETURNING id, identity_token`, [phone]);
  const conn = (await db.pool.query(
    `SELECT id FROM connections WHERE target_phone = $1 AND status = 'invited'`, [phone])).rows[0];
  await withTx(db.pool, (c) => connections.attachProvisionedTarget(c, conn.id, p.id));
  await call(p, 'respond_to_connection_request', { connection_id: Number(conn.id), decision: 'approve' });

  const offers = (await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'share_offer'`, [p.id])).rows;
  assert.equal(offers.length, 1);
  assert.equal(offers[0].payload.taskTitle, 'לתאם טיול');
  assert.equal(offers[0].payload.byName, 'דנה');

  const res = await withTx(db.pool, (c) => experiments.results(c, 'task_share_intro'));
  assert.equal(res.arms.reduce((n, a) => n + a.exposed, 0) >= 2, true);
});
