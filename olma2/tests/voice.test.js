'use strict';
// domain/voice.requestCall: the WhatsApp→phone-call trigger. The bridge (a
// separate loopback-only process) is the judge of who may be called; this
// module must relay its verdict as an envelope and never throw — a person
// whose number is not enabled gets an honest sentence, not a crashed turn.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { freshDb, makeUser } = require('./helpers');
const voice = require('../src/domain/voice');
const registry = require('../src/adapters/mcp/registry');

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972526269826', { firstName: 'מירון' });
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

// A stand-in bridge on an ephemeral port, answering like the real dial API.
function fakeBridge(answer) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ url: req.url, body });
        const a = typeof answer === 'function' ? answer(body) : answer;
        res.writeHead(a.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(a.json));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}/dial`,
      seen,
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

test('the tool is registered and requires no arguments beyond identity', () => {
  const def = registry.TOOLS.find((t) => t.name === 'call_me_on_the_phone');
  assert.ok(def, 'call_me_on_the_phone must be in the registry');
  assert.equal(def.inputSchema.required.length, 1); // identity only
  // The doctrine that keeps 60 agents from pitching a one-user pilot:
  assert.match(def.description, /Never offer/i);
});

test('a bridge ok dials, audits, and reports calling', async () => {
  const bridge = await fakeBridge({ json: { ok: true, callSid: 'CA123' } });
  process.env.VOICE_BRIDGE_DIAL_URL = bridge.url;
  try {
    const r = await withClient((c) => voice.requestCall(c, user));
    assert.equal(r.ok, true);
    assert.equal(r.data.calling, true);
    // The bridge was asked for THIS user's phone, not a guess.
    assert.equal(JSON.parse(bridge.seen[0].body).phone, '+972526269826');
    const audited = await withClient((c) =>
      c.query(`SELECT detail FROM audit_log WHERE event = 'voice.call_requested' AND actor_id = $1`, [user.id]));
    assert.equal(audited.rows.length, 1);
  } finally {
    delete process.env.VOICE_BRIDGE_DIAL_URL;
    await bridge.close();
  }
});

test('a bridge refusal comes back as an err envelope, verbatim and unaudited', async () => {
  const bridge = await fakeBridge({ status: 403, json: { ok: false, error: 'voice calls are not enabled for this user yet' } });
  process.env.VOICE_BRIDGE_DIAL_URL = bridge.url;
  try {
    const r = await withClient((c) => voice.requestCall(c, user));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'unavailable');
    assert.match(r.error.message, /not enabled/);
    const audited = await withClient((c) =>
      c.query(`SELECT 1 FROM audit_log WHERE event = 'voice.call_requested' AND actor_id = $1
               AND detail->>'callSid' IS NULL`, [user.id]));
    assert.equal(audited.rows.length, 0, 'a refused dial must not be audited as a call');
  } finally {
    delete process.env.VOICE_BRIDGE_DIAL_URL;
    await bridge.close();
  }
});

test('an unreachable bridge is an err, never a throw', async () => {
  // A port nothing listens on — connection refused, immediately.
  process.env.VOICE_BRIDGE_DIAL_URL = 'http://127.0.0.1:1/dial';
  try {
    const r = await withClient((c) => voice.requestCall(c, user));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'unavailable');
  } finally {
    delete process.env.VOICE_BRIDGE_DIAL_URL;
  }
});

test('a busy bridge (409, call in progress) relays as-is', async () => {
  const bridge = await fakeBridge({ status: 409, json: { ok: false, error: 'a call is already in progress' } });
  process.env.VOICE_BRIDGE_DIAL_URL = bridge.url;
  try {
    const r = await withClient((c) => voice.requestCall(c, user));
    assert.equal(r.ok, false);
    assert.match(r.error.message, /already in progress/);
  } finally {
    delete process.env.VOICE_BRIDGE_DIAL_URL;
    await bridge.close();
  }
});
