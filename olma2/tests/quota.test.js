'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const quota = require('../src/domain/quota');
const flags = require('../src/domain/flags');

let db, freeUser, paidUser;
before(async () => {
  db = await freshDb();
  freeUser = await makeUser(db.pool, '+972551000001');
  paidUser = await makeUser(db.pool, '+972551000002');
  const c = await db.pool.connect();
  try {
    await c.query(`UPDATE entitlements SET plan = 'paid' WHERE user_id = $1`, [paidUser.id]);
    await flags.setFlag(c, 'quota_daily_free', 3); // tiny limits for the test
    await flags.setFlag(c, 'quota_hourly_paid', 5);
  } finally { c.release(); }
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

test('free user blocks after daily limit, justBlocked fires exactly once', async () => {
  await withClient(async (c) => {
    const now = '2026-08-16T10:00:00Z';
    for (let i = 1; i <= 3; i++) {
      const r = await quota.countMessage(c, freeUser.id, now);
      assert.equal(r.data.blocked, false, `message ${i} should pass`);
    }
    const fourth = await quota.countMessage(c, freeUser.id, now);
    assert.equal(fourth.data.blocked, true);
    assert.equal(fourth.data.justBlocked, true);
    const fifth = await quota.countMessage(c, freeUser.id, now);
    assert.equal(fifth.data.blocked, true);
    assert.equal(fifth.data.justBlocked, false); // only ever once per window

    assert.equal(await quota.isBlocked(c, freeUser.id, now), true);
    // block lapses at next UTC day
    assert.equal(await quota.isBlocked(c, freeUser.id, '2026-08-17T00:00:01Z'), false);
  });
});

test('one block notice per window — shouldSendBlockNotice is single-shot', async () => {
  await withClient(async (c) => {
    const first = await quota.shouldSendBlockNotice(c, freeUser.id);
    assert.equal(first, true);
    const second = await quota.shouldSendBlockNotice(c, freeUser.id);
    assert.equal(second, false);
  });
});

test('paid user counts in hourly windows that reset', async () => {
  await withClient(async (c) => {
    const h1 = '2026-08-16T10:00:00Z';
    for (let i = 0; i < 5; i++) await quota.countMessage(c, paidUser.id, h1);
    const over = await quota.countMessage(c, paidUser.id, h1);
    assert.equal(over.data.blocked, true);
    assert.equal(over.data.plan, 'paid');

    // next hour: clear the lapsed block, fresh window counts again
    const h2 = '2026-08-16T11:00:00Z';
    const lapsed = await quota.lapsedBlocks(c, h2);
    assert.ok(lapsed.data.users.some((u) => u.id === paidUser.id));
    await quota.clearBlock(c, paidUser.id);
    const fresh = await quota.countMessage(c, paidUser.id, h2);
    assert.equal(fresh.data.blocked, false);
    assert.equal(fresh.data.count, 1);
  });
});

test('admin per-user override beats the plan limit', async () => {
  const vip = await makeUser(db.pool, '+972551000003');
  await withClient(async (c) => {
    await c.query(`UPDATE users SET quota_override_daily = 1 WHERE id = $1`, [vip.id]);
    const now = '2026-08-16T09:00:00Z';
    const first = await quota.countMessage(c, vip.id, now);
    assert.equal(first.data.blocked, false);
    assert.equal(first.data.limit, 1);
    const second = await quota.countMessage(c, vip.id, now);
    assert.equal(second.data.blocked, true);
  });
});

test('expired paid entitlement falls back to free limits', async () => {
  const lapsed = await makeUser(db.pool, '+972551000004');
  await withClient(async (c) => {
    await c.query(
      `UPDATE entitlements SET plan = 'paid', valid_until = now() - interval '1 day' WHERE user_id = $1`,
      [lapsed.id]
    );
    assert.equal(await quota.planFor(c, lapsed.id), 'free');
  });
});
