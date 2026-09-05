'use strict';
// The gateway's own /health, probed from outside it — the one component
// nothing was watching (docs/incidents.md, "A dead gateway read green on
// `/health` (fixed 2026-09-03)").
//
// Rules: read the BODY and require ok:true (an unknown path answers 200 with
// the control-UI HTML); it proves the process is up and nothing more (a
// linked WhatsApp, provider credit, a working turn have their own
// detectors); three states, not two — a config that cannot be read is
// `unknown`, never `down`, and `unknown` never turns /health red; and it
// must never gate a deploy: deploy.sh checks /ready, which does not call it.
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
