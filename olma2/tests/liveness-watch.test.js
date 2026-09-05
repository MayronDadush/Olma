'use strict';
// "Will I hear if something breaks?" — the owner, 2026-09-05. This job is the
// first alarm in the system with a channel that is not the gateway, so the
// one thing it must get right is speaking when the gateway is dead, and the
// one thing it must not do is speak on a single bad probe.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');
const { withTx } = require('../src/db/pool');
const flags = require('../src/domain/flags');
const watch = require('../src/jobs/liveness-watch');
const twilio = require('../src/channels/twilio-sms');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });
beforeEach(async () => {
  await db.pool.query(`DELETE FROM outbox`);
  await withTx(db.pool, (c) => flags.setFlag(c, watch.STATE_FLAG, {}));
});

function deps(over = {}) {
  const log = { sms: [], wa: [] };
  return {
    log,
    d: {
      checkGateway: async () => over.gateway || { status: 'live', detail: 'live', port: 1 },
      sms: async (to, text) => { log.sms.push({ to, text }); return over.smsFails ? { ok: false, error: 'x' } : { ok: true, sid: 'SM1' }; },
      send: async (to, text) => { log.wa.push({ to, text }); return over.waFails ? { ok: false } : { ok: true }; },
      smsConfigured: over.smsConfigured ?? true,
      now: over.now,
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
  assert.deepEqual(log.sms, []);
  assert.deepEqual(log.wa, []);
});

test('a dead gateway is reported by SMS — after two ticks, once, then every six hours, and recovery is said', async () => {
  const t0 = Date.parse('2026-09-06T09:00:00Z');
  const down = { status: 'down', detail: 'ECONNREFUSED', port: 18789 };
  let { log, d } = deps({ gateway: down, now: t0, waFails: true });
  let note = await tick(d);
  assert.equal(note.down, true);
  assert.equal(note.ticks, 1);
  assert.deepEqual(log.sms, [], 'one bad probe is not an outage');

  ({ log, d } = deps({ gateway: down, now: t0 + 300_000, waFails: true }));
  note = await tick(d);
  assert.equal(note.alerted, 'sms', 'the gateway is the problem, so the gateway is not the channel');
  assert.equal(log.sms.length, 1);
  assert.match(log.sms[0].text, /שער התקשורת/);
  assert.match(log.sms[0].text, /olmachat/);

  ({ log, d } = deps({ gateway: down, now: t0 + 600_000, waFails: true }));
  note = await tick(d);
  assert.equal(note.alerted, undefined, 'still down, already told — silence');
  assert.equal(log.sms.length, 0);

  ({ log, d } = deps({ gateway: down, now: t0 + 7 * 3600_000, waFails: true }));
  note = await tick(d);
  assert.equal(note.alerted, 'sms', 'six hours on, one reminder');

  ({ log, d } = deps({ now: t0 + 8 * 3600_000 }));
  note = await tick(d);
  assert.equal(note.recovered, 'whatsapp', 'back up: the pipe works again and is the cheaper channel');
  assert.match(log.wa[0].text, /חזרה לעבוד/);
  assert.equal(note.down, false);
  const state = await withTx(db.pool, (c) => flags.getFlag(c, watch.STATE_FLAG));
  assert.deepEqual(state, {}, 'the outage is over and forgotten');
});

test('a flap — one bad tick, then fine — is never mentioned', async () => {
  const down = { status: 'down', detail: 'timeout', port: 1 };
  let { d } = deps({ gateway: down });
  await tick(d);
  let out = deps();
  const note = await tick(out.d);
  assert.equal(note.down, false);
  assert.equal(note.recovered, undefined, 'nothing was announced, so nothing is un-announced');
  assert.deepEqual(out.log.sms, []);
  assert.deepEqual(out.log.wa, []);
});

test('stuck deliveries with a live gateway go out over WhatsApp, with SMS as the fallback', async () => {
  const { rows: [u] } = await db.pool.query(`INSERT INTO users (phone, status, first_name) VALUES ('+972500001111','active','A') RETURNING id`);
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, attempts, created_at) VALUES ($1, 'reminder', '{}', 5, now() - interval '1 hour')`, [u.id]);
  const t0 = Date.parse('2026-09-06T09:00:00Z');
  let { log, d } = deps({ now: t0 });
  await tick(d);
  ({ log, d } = deps({ now: t0 + 300_000 }));
  let note = await tick(d);
  assert.equal(note.stuck, 1);
  assert.equal(note.alerted, 'whatsapp');
  assert.match(log.wa[0].text, /תקועות/);
  assert.equal(log.sms.length, 0, 'no SMS spent while the pipe works');

  // the pipe refuses the alert → SMS carries it
  await withTx(db.pool, (c) => flags.setFlag(c, watch.STATE_FLAG, {}));
  ({ log, d } = deps({ now: t0, waFails: true }));
  await tick(d);
  ({ log, d } = deps({ now: t0 + 300_000, waFails: true }));
  note = await tick(d);
  assert.equal(note.alerted, 'sms');
});

test('without Twilio configured and a dead gateway, the failure to alert is on the heartbeat', async () => {
  const down = { status: 'down', detail: 'ECONNREFUSED', port: 1 };
  const t0 = Date.parse('2026-09-06T09:00:00Z');
  let { d } = deps({ gateway: down, now: t0, waFails: true, smsConfigured: false });
  await tick(d);
  ({ d } = deps({ gateway: down, now: t0 + 300_000, waFails: true, smsConfigured: false }));
  const note = await tick(d);
  assert.equal(note.smsConfigured, false);
  assert.equal(note.alertFailed, true, 'not looking and nothing wrong must never read alike');
  assert.equal(note.alerted, undefined);
});

test('a probe that could not judge is reported, not alarmed', async () => {
  const { log, d } = deps({ gateway: { status: 'unknown', detail: 'cannot read gateway config: ENOENT', port: null } });
  const note = await tick(d);
  assert.equal(note.gateway, 'unknown');
  assert.match(note.gatewayDetail, /ENOENT/);
  assert.equal(note.down, false);
  assert.deepEqual(log.sms, []);
});

test('the SMS channel refuses to pretend when unconfigured, and never leaks the token', async () => {
  assert.equal(twilio.configured({}), false);
  const r = await twilio.send('+972500000000', 'hi', { env: {} });
  assert.equal(r.ok, false);
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 201, json: async () => ({ sid: 'SM123' }) }; };
  const env = { TWILIO_SID: 'ACxxx', TWILIO_TOKEN: 'secret-token', TWILIO_FROM: '+15550001' };
  const ok = await twilio.send('+972500000000', 'שלום', { env, fetchImpl });
  assert.deepEqual(ok, { ok: true, sid: 'SM123' });
  assert.match(calls[0].url, /Accounts\/ACxxx\/Messages\.json$/);
  assert.match(calls[0].init.body, /To=%2B972500000000/);
  assert.ok(!calls[0].init.body.includes('secret-token'), 'the token rides the auth header only');
  const bad = await twilio.send('+972500000000', 'x', { env, fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.deepEqual(bad, { ok: false, error: 'twilio http 401' });
});
