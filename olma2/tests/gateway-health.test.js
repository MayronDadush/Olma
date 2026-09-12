'use strict';
// Driven against a REAL http server on a real port rather than a stubbed
// fetch, because the parts that were worth getting wrong are all in the
// plumbing: reading the body at all, distinguishing "something answered 200"
// from "the gateway answered", and a connection that is refused versus one
// that hangs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gatewayHealth = require('../src/adapters/gateway-health');
const { checkGateway, DEFAULT_PORT } = gatewayHealth;

function tmpConfig(cfg) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'olma-gwh-')), 'openclaw.json');
  fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { return await fn(port); } finally { server.close(); }
}

test('a live gateway reports live, and the port comes from the config', async () => {
  await withServer((req, res) => {
    assert.equal(req.url, '/health');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'live' }));
  }, async (port) => {
    const out = await checkGateway({ configPath: tmpConfig({ gateway: { port } }) });
    assert.deepEqual(out, { status: 'live', detail: 'live', port });
  });
});

// The whole reason this reads the body. An unknown path on the gateway's port
// serves its control UI with a 200, so a bare connect check — or a
// status-code-only check — would call a gateway that had lost its health
// route perfectly healthy.
test('a 200 that is not the health route is not a live gateway', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html>control ui</html>');
  }, async (port) => {
    const out = await checkGateway({ configPath: tmpConfig({ gateway: { port } }) });
    assert.equal(out.status, 'down');
    assert.match(out.detail, /did not report ok/);
  });
});

test('valid json that says ok:false is down, not live', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, status: 'degraded' }));
  }, async (port) => {
    assert.equal((await checkGateway({ configPath: tmpConfig({ gateway: { port } }) })).status, 'down');
  });
});

test('a non-200 carries the code, so the page says what it saw', async () => {
  await withServer((req, res) => { res.writeHead(503); res.end('nope'); }, async (port) => {
    const out = await checkGateway({ configPath: tmpConfig({ gateway: { port } }) });
    assert.equal(out.status, 'down');
    assert.equal(out.detail, 'http 503');
  });
});

test('nothing listening is down, with the reason', async () => {
  // Bind and immediately release, so the port is real and certainly free.
  const port = await withServer(() => {}, async (p) => p);
  const out = await checkGateway({ configPath: tmpConfig({ gateway: { port } }), timeoutMs: 1000 });
  assert.equal(out.status, 'down');
  assert.equal(out.detail, 'ECONNREFUSED');
  assert.equal(out.port, port);
});

// A gateway that accepts the connection and then never answers is the wedge
// this whole system has hit repeatedly — it must read as down, not hang the
// dashboard's own request.
test('a gateway that accepts and never answers times out as down', async () => {
  await withServer(() => { /* deliberately never responds */ }, async (port) => {
    const started = Date.now();
    const out = await checkGateway({ configPath: tmpConfig({ gateway: { port } }), timeoutMs: 200 });
    assert.equal(out.status, 'down');
    assert.equal(out.detail, 'timeout');
    assert.ok(Date.now() - started < 3000, 'the probe must not outlive its own deadline');
  });
});

// "Could not look" is not "looked and it was dead". Reporting an outage we
// did not observe is how a monitoring page spends its credibility.
test('an unreadable or malformed config is unknown, never down', async () => {
  const missing = await checkGateway({ configPath: '/nonexistent/olma-gwh/openclaw.json' });
  assert.equal(missing.status, 'unknown');
  assert.match(missing.detail, /cannot read gateway config/);
  assert.equal(missing.port, null);

  const garbage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'olma-gwh-')), 'openclaw.json');
  fs.writeFileSync(garbage, 'not json at all');
  assert.equal((await checkGateway({ configPath: garbage })).status, 'unknown');
});

// A config that parses but names no port is readable — we know where to look,
// the gateway's own default. That is a real observation, so it may be down.
test('a config with no gateway port falls back to the default and still observes', async () => {
  const out = await checkGateway({ configPath: tmpConfig({}), timeoutMs: 500 });
  assert.equal(out.port, DEFAULT_PORT);
  assert.notEqual(out.status, 'unknown', 'we knew where to look, so whatever we saw is an observation');
});

// ---- checkChannels ---------------------------------------------------------
// The detector that did not exist on 2026-09-11, when the WhatsApp channel was
// dead from 06:07 to 12:05 and every check in the system read green.
//
// The payload shapes below are the LIVE gateway's, copied from
// `openclaw gateway call channels.status` on the box — a reader tested against
// a hand-invented shape proves only that it can read what its author imagined.
const live = {
  ts: 1789124249744,
  channels: {
    whatsapp: {
      configured: true, statusState: 'linked', linked: true, running: true,
      connected: true, reconnectAttempts: 0, lastDisconnect: null,
      self: { e164: '+972559347282' },
    },
  },
};
const dead = {
  channels: {
    whatsapp: { configured: true, linked: true, running: true, connected: false, reconnectAttempts: 6 },
  },
};

test('a connected channel is live', async () => {
  const r = await gatewayHealth.checkChannels({ rpc: async () => live });
  assert.equal(r.status, 'live');
  assert.equal(r.channels.length, 1);
  assert.equal(r.channels[0].down, false);
});

test('a disconnected channel is down, and the detail names it and how hard it has tried', async () => {
  const r = await gatewayHealth.checkChannels({ rpc: async () => dead });
  assert.equal(r.status, 'down');
  assert.match(r.detail, /whatsapp/);
  assert.match(r.detail, /connected = false/);
  assert.match(r.detail, /6 reconnect attempts/);
});

test('any one of linked/running/connected false is enough', async () => {
  for (const key of ['linked', 'running', 'connected']) {
    const payload = { channels: { whatsapp: { configured: true, linked: true, running: true, connected: true, [key]: false } } };
    const r = await gatewayHealth.checkChannels({ rpc: async () => payload });
    assert.equal(r.status, 'down', `${key} = false must count`);
    assert.match(r.detail, new RegExp(key));
  }
});

// Everything here feeds a gateway RESTART, so every reading that is not an
// explicit "the gateway says this channel is broken" has to be `unknown`.
// "Could not tell" triggering a restart is the detector becoming the hazard.
test('anything short of the gateway saying so is unknown, never down', async () => {
  const cases = [
    ['rpc throws', async () => { throw new Error('gateway rpc is switched off'); }, /switched off/],
    ['no channels key', async () => ({ ts: 1 }), /without a channel list/],
    ['channels not an object', async () => ({ channels: 'whatsapp' }), /without a channel list/],
    ['nothing configured', async () => ({ channels: { whatsapp: { configured: false, connected: false } } }), /no channel is configured/],
    ['empty', async () => ({ channels: {} }), /no channel is configured/],
  ];
  for (const [label, rpc, detail] of cases) {
    const r = await gatewayHealth.checkChannels({ rpc });
    assert.equal(r.status, 'unknown', label);
    assert.match(r.detail, detail, label);
  }
});

// A field the gateway stopped sending must not read as a fault. Only an
// explicit `false` does — `undefined` is a version skew, not an outage.
test('missing fields are not a fault', async () => {
  const r = await gatewayHealth.checkChannels({ rpc: async () => ({ channels: { whatsapp: { configured: true } } }) });
  assert.equal(r.status, 'live');
});

test('one dead channel among healthy ones is still down', async () => {
  const r = await gatewayHealth.checkChannels({
    rpc: async () => ({ channels: { whatsapp: { configured: true, connected: true }, telegram: { configured: true, connected: false } } }),
  });
  assert.equal(r.status, 'down');
  assert.match(r.detail, /telegram/);
  assert.ok(!/whatsapp/.test(r.detail));
});
