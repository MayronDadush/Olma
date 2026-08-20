'use strict';
// Structured result → text for the agent. Compact JSON, not prose — the HTTP
// adapter returns the same structures as JSON to dashboards; this adapter's
// whole job is the text envelope plus defense-in-depth scrubbing.

// Olma's own identity tokens, plus Google's two credential shapes (`ya29.…`
// access tokens and `1//…` refresh tokens). The calendar code is written not
// to put either in a message, but this is the layer that has to hold if some
// future error path forgets.
const TOKEN_RES = [
  /olma_tok_[0-9a-f]{32}/g,
  /ya29\.[\w.\-]+/g,
  /1\/\/[\w\-]{10,}/g,
];

// No credential may ever appear in tool output, whatever field it hid in.
function scrubTokens(text) {
  return TOKEN_RES.reduce((s, re) => s.replace(re, '[REDACTED]'), text);
}

function renderResult(result) {
  if (result.ok) {
    return scrubTokens('OK ' + JSON.stringify(result.data ?? {}));
  }
  const e = result.error || { code: 'error', message: 'unknown error' };
  const extra = Object.entries(e)
    .filter(([k]) => !['code', 'message'].includes(k))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
  return scrubTokens(`ERROR ${e.code}: ${e.message}${extra ? ' (' + extra + ')' : ''}`);
}

module.exports = { renderResult, scrubTokens };
