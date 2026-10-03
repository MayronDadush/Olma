'use strict';
// brokerd → gamesd (games/src/join.js): open a night for somebody, seat
// somebody by a code, and where their nights stand (domain/turn.advise). gamesd listens on the box only and refuses anything a
// proxy forwarded, so this is plain HTTP to 127.0.0.1.
//
// Short on purpose. The whole shortcut runs inside the plugin's 800ms wait
// (gateway-plugin/olma-turn, buildLinkShortcutHandler), and a gamesd that has
// not answered in time is a message that goes to the model instead — which,
// with the pack on, has the same night's tools.
const DEFAULT_URL = 'http://127.0.0.1:8794';
const TIMEOUT_MS = 500;

// Read per call, like the gateway's config path: a test sets it after load.
const baseUrl = () => process.env.OLMA_GAMESD_URL || DEFAULT_URL;

async function call(route, body, { timeoutMs = TIMEOUT_MS } = {}) {
  // A test that forgot to inject its own must never reach the live service
  // (rules/testing.md, "A test file must never reach the LIVE gateway").
  if (process.env.NODE_TEST_CONTEXT && !process.env.OLMA_GAMESD_URL) {
    throw new Error('gamesd: refusing the live service from a test');
  }
  const res = await fetch(baseUrl() + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`gamesd ${route}: HTTP ${res.status}`);
  return res.json();
}

module.exports = {
  open: (body, opts) => call('/api/open', body, opts),
  join: (body, opts) => call('/api/join', body, opts),
  mine: (body, opts) => call('/api/mine', body, opts),
};
