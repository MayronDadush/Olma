'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const watch = require('../src/jobs/credit-watch');
const flagsDomain = require('../src/domain/flags');
const { enqueue } = require('../src/outbox/enqueue');
const { withTx } = require('../src/db/pool');

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972594000001', { firstName: 'X' });
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const c = await db.pool.connect();
  try { return await fn(c); } finally { c.release(); }
}

function recorder(ok = true) {
  const sent = [];
  return { sent, send: (phone, text) => { sent.push({ phone, text }); return { ok }; } };
}

test('the first credit error raises exactly one alarm per outage — on the raw pipe number', async () => {
  await withClient(async (c) => {
    const rec = recorder();
    // quiet system → no alarm
    assert.equal((await watch.checkCreditAlert(c, rec)).alerted, false);
    assert.equal(rec.sent.length, 0);

    await withTx(db.pool, (cc) => enqueue(cc, {
      userId: user.id, kind: 'checkin', idempotencyKey: 'cw:1',
    }));
    await c.query(
      `UPDATE outbox SET last_error = 'GatewayClientRequestError: ... Your credit balance is too low to access the Anthropic API ...'
        WHERE idempotency_key = 'cw:1'`);

    const first = await watch.checkCreditAlert(c, rec);
    assert.equal(first.alerted, true);
    assert.equal(rec.sent.length, 1);
    assert.equal(rec.sent[0].phone, watch.DEFAULT_ALERT_PHONE);
    assert.match(rec.sent[0].text, /נגמר הקרדיט/);
    assert.match(rec.sent[0].text, /Auto-reload/);
    assert.match(rec.sent[0].text, /openrouter\.ai/, 'the alert names both providers');

    // same outage, next tick → silence, not a drum
    assert.equal((await watch.checkCreditAlert(c, rec)).alerted, false);
    assert.equal(rec.sent.length, 1);
  });
});

test("OpenRouter's dry-credit phrasing (402 Insufficient credits) also trips the alarm", async () => {
  await withClient(async (c) => {
    await c.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
    await withTx(db.pool, (cc) => enqueue(cc, {
      userId: user.id, kind: 'checkin', idempotencyKey: 'cw:or',
    }));
    await c.query(
      `UPDATE outbox SET last_error = 'Insufficient credits. Add more using https://openrouter.ai/settings/credits'
        WHERE idempotency_key = 'cw:or'`);
    const rec = recorder();
    assert.equal((await watch.checkCreditAlert(c, rec)).alerted, true);
    assert.equal(rec.sent.length, 1);
  });
});

test('a NEW outage re-arms the alarm; a failed send does not consume it', async () => {
  await withClient(async (c) => {
    // resolve the previous outage
    await c.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
    const rec = recorder();
    assert.equal((await watch.checkCreditAlert(c, rec)).alerted, false);

    // a fresh outage begins — its first error is NEWER than the last alert
    await withTx(db.pool, (cc) => enqueue(cc, {
      userId: user.id, kind: 'checkin', idempotencyKey: 'cw:2',
    }));
    await c.query(
      `UPDATE outbox SET last_error = 'credit balance is too low'
        WHERE idempotency_key = 'cw:2'`);

    // the send itself fails (gateway down) → no flag stamped, retried next tick
    const failing = recorder(false);
    const tryFail = await watch.checkCreditAlert(c, failing);
    assert.equal(tryFail.alerted, false);
    assert.equal(failing.sent.length, 1, 'it did try');

    const ok = recorder();
    assert.equal((await watch.checkCreditAlert(c, ok)).alerted, true,
      'the failed attempt must not have consumed the one alarm this outage gets');

    // the alert target is a flag the dashboard can change without a deploy
    await flagsDomain.setFlag(c, watch.ALERT_PHONE_FLAG, '+972590000000');
    await c.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
    await withTx(db.pool, (cc) => enqueue(cc, {
      userId: user.id, kind: 'checkin', idempotencyKey: 'cw:3',
    }));
    await c.query(
      `UPDATE outbox SET last_error = 'credit balance is too low' WHERE idempotency_key = 'cw:3'`);
    const rec2 = recorder();
    await watch.checkCreditAlert(c, rec2);
    assert.equal(rec2.sent[0].phone, '+972590000000');
  });
});
