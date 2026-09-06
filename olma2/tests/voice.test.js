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

// A stand-in bridge on an ephemeral port, answering like the real API.
//
// It ROUTES, because the paths are the point: /dial rings a phone and /probe
// does not. `probe` is omitted by default, so the default fake is a bridge
// that predates /probe and 404s it — the exact thing the box can really be,
// the two processes shipping on separate workflows. A route left out answers
// 404 exactly as the real bridge does.
function fakeBridge(answer, probe) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ url: req.url, body });
        const route = req.url === '/probe' ? probe : (req.url === '/dial' ? answer : null);
        const a = route == null
          ? { status: 404, json: { ok: false, error: 'not found' } }
          : (typeof route === 'function' ? route(body) : route);
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

// Asked for a call reminder on 2026-09-05, Sarah was told "I can call you now
// if you'd like" — an offer that would have come straight back as a refusal,
// her US number never having been on the bridge's list. The assistant had no
// way to ask, so it guessed. `callAvailable` is that way, and its answer is
// THREE-valued on purpose: yes, no, and "could not ask" — because a bridge
// that is down must never be rendered as a feature somebody lost.
test('callAvailable probes without ringing anything', async () => {
  const bridge = await fakeBridge(
    { json: { ok: true, callSid: 'CA-SHOULD-NOT-HAPPEN' } },
    { json: { ok: true, available: true } });
  process.env.VOICE_BRIDGE_DIAL_URL = bridge.url;
  try {
    assert.equal(await voice.callAvailable(user), true);
    assert.deepEqual(bridge.seen.map((r) => r.url), ['/probe'], 'nothing touched /dial');
    assert.equal(JSON.parse(bridge.seen[0].body).phone, '+972526269826');
  } finally {
    delete process.env.VOICE_BRIDGE_DIAL_URL;
    await bridge.close();
  }
});

// The whole reason the probe is a PATH and not a `probe: true` field on /dial.
// olma2 and the bridge deploy on separate workflows, so this is a real state
// the box can be in for minutes: an old bridge has no /probe, 404s it, and the
// card simply omits the line. The same old bridge would have IGNORED a flag on
// /dial and rung Sarah's phone to answer a question about rendering a card.
test('a bridge too old to have /probe answers nothing, and rings nobody', async () => {
  const stale = await fakeBridge({ json: { ok: true, callSid: 'CA-SHOULD-NOT-HAPPEN' } });
  process.env.VOICE_BRIDGE_DIAL_URL = stale.url;
  try {
    assert.equal(await voice.callAvailable(user), null);
    assert.deepEqual(stale.seen.map((r) => r.url), ['/probe'], 'nothing touched /dial');
  } finally {
    delete process.env.VOICE_BRIDGE_DIAL_URL;
    await stale.close();
  }
});

test('a refusal the bridge actually made is a no', async () => {
  const bridge = await fakeBridge(null, { status: 403, json: { ok: false, error: 'not enabled' } });
  process.env.VOICE_BRIDGE_DIAL_URL = bridge.url;
  try {
    assert.equal(await voice.callAvailable(user), false);
  } finally {
    delete process.env.VOICE_BRIDGE_DIAL_URL;
    await bridge.close();
  }
});

// null is not false. An unreadable answer is "we do not know", and the card
// leaves the line off entirely rather than telling someone their calls are
// gone every time the bridge restarts (CLAUDE.md, "A thing that could not be
// READ is never a thing in trouble").
test('a bridge that is down or broken answers nothing, not "no"', async () => {
  process.env.VOICE_BRIDGE_DIAL_URL = 'http://127.0.0.1:1/dial';
  try {
    assert.equal(await voice.callAvailable(user), null);
  } finally { delete process.env.VOICE_BRIDGE_DIAL_URL; }

  const broken = await fakeBridge(null, { status: 500, json: { ok: false, error: 'boom' } });
  process.env.VOICE_BRIDGE_DIAL_URL = broken.url;
  try {
    assert.equal(await voice.callAvailable(user), null, 'a 500 is not a verdict');
  } finally {
    delete process.env.VOICE_BRIDGE_DIAL_URL;
    await broken.close();
  }
});

test('the card says what the bridge said, and stays silent when it said nothing', () => {
  const { renderCard } = require('../src/intake/user-card');
  const u = { first_name: 'Sarah', locale: 'en', timezone: 'America/Los_Angeles' };
  assert.match(renderCard(u, [], [], { calls: true }), /Phone calls: available/);
  const no = renderCard(u, [], [], { calls: false });
  assert.match(no, /Phone calls: NOT available/);
  assert.match(no, /never offer to call them/, 'the line carries its own instruction');
  assert.doesNotMatch(renderCard(u, [], [], { calls: null }), /Phone calls/);
  assert.doesNotMatch(renderCard(u, [], [], {}), /Phone calls/);
});
