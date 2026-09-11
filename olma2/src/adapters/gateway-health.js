'use strict';
// The gateway's own /health, probed from outside it — the one component
// nothing was watching (docs/incidents.md, "A dead gateway read green on
// `/health` (fixed 2026-09-03)").
//
// Rules: read the BODY and require ok:true (an unknown path answers 200 with
// the control-UI HTML); it proves the process is up and NOTHING MORE; three
// states, not two — a config that cannot be read is `unknown`, never `down`,
// and `unknown` never turns /health red; and it must never gate a deploy:
// deploy.sh checks /ready, which does not call it.
//
// "Nothing more" used to be followed by a list of things said to have their
// own detectors, "a linked WhatsApp" among them. It did not have one. On
// 2026-09-11 the WhatsApp channel died at 06:07 and came back at 12:05, six
// hours in which `checkGateway` returned `live` on every five-minute tick,
// `/health` served `{"ok":true}` throughout, and nothing anywhere noticed
// that not one message could leave the box (`incidents.md`, "Six hours with
// nobody to talk to"). `checkChannels` below is that missing detector: same
// three states, same never-alarm-on-unreadable rule, asked over the gateway's
// own WebSocket because the CLI costs 4.1s of CPU an answer.
const http = require('node:http');
const occ = require('../intake/openclaw-config');
const gatewayRpc = require('../channels/gateway-rpc');

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

// A channel is DOWN only when the gateway says so in as many words. Every
// other reading — the RPC unavailable, the socket refused, a payload we do
// not recognise, a field missing — is `unknown`, because the remedy here is a
// gateway restart and "could not tell" must never trigger one. Same rule as
// the unreadable config above, and it is the whole difference between a
// detector and a hazard.
//
// `configured: false` is not a fault: a channel nobody set up is not a
// channel that broke. Only `linked`/`running`/`connected` count, and only
// when they are explicitly `false` — the gateway reports all three, and any
// one of them false is a channel that cannot carry a message.
function readChannels(payload) {
  const channels = payload && typeof payload === 'object' ? payload.channels : null;
  if (!channels || typeof channels !== 'object') return null;
  const out = [];
  for (const [id, c] of Object.entries(channels)) {
    if (!c || typeof c !== 'object' || c.configured === false) continue;
    const bad = ['linked', 'running', 'connected'].filter((k) => c[k] === false);
    out.push({
      id,
      down: bad.length > 0,
      // Carried for the alert text: "6/10" is the difference between a channel
      // that just dropped and one that has been failing to come back.
      reconnectAttempts: Number.isFinite(c.reconnectAttempts) ? c.reconnectAttempts : null,
      says: bad.length ? `${bad.join('/')} = false` : null,
    });
  }
  return out;
}

// -> { status: 'live' | 'down' | 'unknown', detail: string|null, channels: [...] }
async function checkChannels({ rpc } = {}) {
  const ask = rpc || gatewayRpc.channelsStatus;
  let payload;
  try {
    payload = await ask();
  } catch (e) {
    return { status: 'unknown', detail: `cannot ask the gateway: ${(e && e.message) || e}`, channels: [] };
  }
  const channels = readChannels(payload);
  if (!channels) return { status: 'unknown', detail: 'gateway answered without a channel list', channels: [] };
  if (!channels.length) return { status: 'unknown', detail: 'no channel is configured', channels: [] };
  const down = channels.filter((c) => c.down);
  if (!down.length) return { status: 'live', detail: null, channels };
  const detail = down
    .map((c) => `${c.id}: ${c.says}${c.reconnectAttempts ? `, ${c.reconnectAttempts} reconnect attempts` : ''}`)
    .join('; ');
  return { status: 'down', detail, channels };
}

module.exports = { checkGateway, checkChannels, readChannels, gatewayAddress, TIMEOUT_MS, DEFAULT_PORT };
