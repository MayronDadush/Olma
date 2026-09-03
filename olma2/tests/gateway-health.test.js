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
const { checkGateway, DEFAULT_PORT } = require('../src/adapters/gateway-health');

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
