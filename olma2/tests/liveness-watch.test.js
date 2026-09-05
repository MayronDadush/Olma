'use strict';
// "Will I hear if something breaks?" — the owner, 2026-09-05. The job speaks
// over the gateway's own pipe (the owner chose no second channel), so what it
// must get right is the repair — restart a dead gateway — and what it must not
// do is speak on a single bad probe.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');
const { withTx } = require('../src/db/pool');
const flags = require('../src/domain/flags');
const watch = require('../src/jobs/liveness-watch');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });
beforeEach(async () => {
  await db.pool.query(`DELETE FROM outbox`);
  await withTx(db.pool, (c) => flags.setFlag(c, watch.STATE_FLAG, {}));
});

function deps(over = {}) {
  const log = { wa: [] };
  return {
    log,
    d: {
      checkGateway: async () => over.gateway || { status: 'live', detail: 'live', port: 1 },
      send: async (to, text) => { log.wa.push({ to, text }); return over.waFails ? { ok: false } : { ok: true }; },
      now: over.now,
      settleMs: 0,
      restartGateway: async () => { log.restarts = (log.restarts || 0) + 1; return over.restartFails ? false : true; },
      ...over.extra,
    },
  };
}
const tick = (d) => withTx(db.pool, (c) => watch.run(c, d));

test('a healthy system says so on the heartbeat and tells nobody', async () => {
  const { log, d } = deps();
  const note = await tick(d);
  assert.equal(note.gateway, 'live');
  assert.equal(note.down, false);
  assert.equal(note.stuck, 0);
  assert.deepEqual(log.wa, []);
});

test('a dead gateway is restarted on the second tick, not the first, and at most once per half hour', async () => {
  const t0 = Date.parse('2026-09-06T09:00:00Z');
  const down = { status: 'down', detail: 'ECONNREFUSED', port: 18789 };
  let { log, d } = deps({ gateway: down, now: t0, waFails: true });
  let note = await tick(d);
  assert.equal(note.down, true);
  assert.equal(note.ticks, 1);
  assert.equal(log.restarts, undefined, 'one bad probe is not an outage');

  ({ log, d } = deps({ gateway: down, now: t0 + 300_000, waFails: true }));
  note = await tick(d);
  assert.equal(log.restarts, 1, 'the repair is tried');
  assert.equal(note.restarted, true);
  assert.equal(note.alertFailed, true, 'the pipe is the gateway: it cannot be told, and the heartbeat says so');
  assert.equal(note.alerted, undefined);

  ({ log, d } = deps({ gateway: down, now: t0 + 600_000, waFails: true }));
  note = await tick(d);
  assert.equal(log.restarts, undefined, 'no second restart inside the cooldown');

  ({ log, d } = deps({ gateway: down, now: t0 + 40 * 60_000, waFails: true }));
  note = await tick(d);
  assert.equal(log.restarts, 1, 'cooldown over, one more try');

  ({ log, d } = deps({ now: t0 + 60 * 60_000 }));
  note = await tick(d);
  assert.equal(note.down, false);
  assert.equal(note.recovered, undefined, 'nothing had been announced, so nothing is un-announced');
  assert.deepEqual(log.wa, []);
  assert.deepEqual(await withTx(db.pool, (c) => flags.getFlag(c, watch.STATE_FLAG)), {});
});

test('a dead gateway that comes back after the automatic restart is reported as healed, once', async () => {
  const t0 = Date.parse('2026-09-06T12:00:00Z');
  const down = { status: 'down', detail: 'ECONNREFUSED', port: 1 };
  let { log, d } = deps({ gateway: down, now: t0 });
  await tick(d);
  let probes = 0;
  ({ log, d } = deps({ now: t0 + 300_000, extra: { checkGateway: async () => (probes++ === 0 ? down : { status: 'live', detail: 'live', port: 1 }) } }));
  const note = await tick(d);
  assert.equal(log.restarts, 1);
  assert.equal(note.restartOk, true);
  assert.equal(note.gateway, 'live', 'the verdict is the re-probe, not the first probe');
  assert.equal(note.selfHealed, 'whatsapp');
  assert.match(log.wa[0].text, /הופעל מחדש אוטומטית/);
  assert.deepEqual(await withTx(db.pool, (c) => flags.getFlag(c, watch.STATE_FLAG)), {});
});

test('a flap — one bad tick, then fine — is never mentioned', async () => {
  const down = { status: 'down', detail: 'timeout', port: 1 };
  const { d } = deps({ gateway: down });
  await tick(d);
  const out = deps();
  const note = await tick(out.d);
  assert.equal(note.down, false);
  assert.deepEqual(out.log.wa, []);
});

test('stuck deliveries with a live gateway: told after two ticks, once, then every six hours, and recovery is said', async () => {
  const { rows: [u] } = await db.pool.query(`INSERT INTO users (phone, status, first_name) VALUES ('+972500001111','active','A') RETURNING id`);
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, attempts, created_at) VALUES ($1, 'reminder', '{}', 5, now() - interval '1 hour')`, [u.id]);
  const t0 = Date.parse('2026-09-06T09:00:00Z');
  let { log, d } = deps({ now: t0 });
  await tick(d);
  assert.deepEqual(log.wa, []);
  ({ log, d } = deps({ now: t0 + 300_000 }));
  let note = await tick(d);
  assert.equal(note.stuck, 1);
  assert.equal(note.alerted, 'whatsapp');
  assert.match(log.wa[0].text, /תקועות/);
  assert.match(log.wa[0].text, /olmachat/);
  ({ log, d } = deps({ now: t0 + 600_000 }));
  note = await tick(d);
  assert.equal(note.alerted, undefined, 'already told — silence');
  ({ log, d } = deps({ now: t0 + 7 * 3600_000 }));
  note = await tick(d);
  assert.equal(note.alerted, 'whatsapp', 'six hours on, one reminder');
  await db.pool.query(`DELETE FROM outbox`);
  ({ log, d } = deps({ now: t0 + 8 * 3600_000 }));
  note = await tick(d);
  assert.equal(note.recovered, 'whatsapp');
  assert.match(log.wa[0].text, /חזרה לעבוד/);
});

test('a probe that could not judge is reported, not alarmed', async () => {
  const { log, d } = deps({ gateway: { status: 'unknown', detail: 'cannot read gateway config: ENOENT', port: null } });
  const note = await tick(d);
  assert.equal(note.gateway, 'unknown');
  assert.match(note.gatewayDetail, /ENOENT/);
  assert.equal(note.down, false);
  assert.deepEqual(log.wa, []);
});
