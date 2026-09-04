'use strict';
// The one component nothing was watching.
//
// `/health` measured the DB and every sweep's heartbeat, and answered 200
// while the gateway — the process every user's WhatsApp message goes through,
// in both directions — was refusing connections. Found 2026-09-03 by a raw
// `message send` coming back ECONNREFUSED against a green board. That instance
// was a concurrent session's deliberate restart and lasted thirteen seconds,
// so it cost nothing; nothing about the page would have looked different at
// hour three. Same shape as the credit outage that ran thirteen hours behind a
// green board, and the workspace-seal failure that dropped 126 real messages
// while /health honestly reported everything it measured.
//
// ---- what this probe does and does not prove ----
//
// The gateway serves its OWN `/health` on its configured port, unauthenticated,
// answering `{"ok":true,"status":"live"}`. That is a real route, checked on the
// live box: an unknown path returns the control-UI HTML instead, so a 200
// alone would only prove that some HTTP server answered. The body is read and
// `ok` must be true.
//
// It proves the gateway process is up and serving. It does NOT prove WhatsApp
// is linked, that the model provider has credit, or that a turn would succeed
// — those have their own detectors. It catches the total failure, which is the
// one that was invisible.
//
// ---- three states, not two ----
//
// A config we cannot read is `unknown`, never `down`. "Could not look" and
// "looked and it was dead" must not wear the same word — the rule this
// codebase keeps relearning (a null session index is not an empty one; a
// failed balance call is not $0 remaining). `unknown` does not turn /health
// red: manufacturing an outage out of missing information is how a monitoring
// page trains its reader to ignore it.
//
// ---- and it must never gate a deploy ----
//
// `scripts/deploy.sh` checks `/ready`, deliberately, and `/ready` does not call
// this. A gateway restart that overlaps a deploy would otherwise roll back
// code that had nothing to do with it — and gateway restarts happen, including
// the one that exposed this gap.
const http = require('node:http');
const occ = require('../intake/openclaw-config');

// Loopback, a trivial JSON route, one vCPU. Three seconds is far past any
// honest answer; a gateway that cannot produce this in that time is wedged,
// which is the failure, not a slow reply.
const TIMEOUT_MS = 3000;
const DEFAULT_PORT = 18789;

function gatewayAddress(configPath) {
  const cfg = occ.loadConfig(configPath);            // throws if unreadable
  const gw = (cfg && cfg.gateway) || {};
  const port = Number.isInteger(gw.port) ? gw.port : DEFAULT_PORT;
  return { host: '127.0.0.1', port };
}

function get(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 512) body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
  });
}

// -> { status: 'live' | 'down' | 'unknown', detail: string|null, port: number|null }
async function checkGateway({ configPath, timeoutMs = TIMEOUT_MS, fetchImpl } = {}) {
  let addr;
  try {
    addr = gatewayAddress(configPath);
  } catch (e) {
    return { status: 'unknown', detail: `cannot read gateway config: ${e.code || e.message}`, port: null };
  }
  const call = fetchImpl || get;
  const res = await call(addr.host, addr.port, timeoutMs);
  if (res.error) return { status: 'down', detail: res.error, port: addr.port };
  if (res.statusCode !== 200) {
    return { status: 'down', detail: `http ${res.statusCode}`, port: addr.port };
  }
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  // An unknown path on this port serves the control UI with a 200, so the body
  // is what separates "the gateway answered" from "something answered".
  if (!parsed || parsed.ok !== true) {
    return { status: 'down', detail: 'health route did not report ok', port: addr.port };
  }
  return { status: 'live', detail: parsed.status || null, port: addr.port };
}

module.exports = { checkGateway, gatewayAddress, TIMEOUT_MS, DEFAULT_PORT };
