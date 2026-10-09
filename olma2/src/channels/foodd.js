'use strict';
// olma2 → foodd (food/src/server.js): the link to a person's food page, for
// the food icon on the home screen of their own page (/me). foodd listens on
// the box only and refuses anything a proxy forwarded, so this is plain HTTP
// to 127.0.0.1, the same shape as channels/gamesd.js.
const DEFAULT_URL = 'http://127.0.0.1:8795';
const TIMEOUT_MS = 2000;

// Read per call, like gamesd's: a test sets it after load.
const baseUrl = () => process.env.OLMA_FOODD_URL || DEFAULT_URL;

async function call(route, body, { timeoutMs = TIMEOUT_MS } = {}) {
  // A test that forgot to inject its own must never reach the live service
  // (rules/testing.md, "A test file must never reach the LIVE gateway").
  if (process.env.NODE_TEST_CONTEXT && !process.env.OLMA_FOODD_URL) {
    throw new Error('foodd: refusing the live service from a test');
  }
  const res = await fetch(baseUrl() + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`foodd ${route}: HTTP ${res.status}`);
  return res.json();
}

module.exports = {
  page: (body, opts) => call('/api/page', body, opts),
  // The evening picture (domain/food-picture.js): foodd asks an image model,
  // which takes seconds and up to a minute and a half, so its own deadline.
  picture: (body, opts) => call('/api/picture', body, { timeoutMs: 150_000, ...opts }),
};
