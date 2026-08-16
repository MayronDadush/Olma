'use strict';
// Structured result → text for the agent. Compact JSON, not prose — the HTTP
// adapter returns the same structures as JSON to dashboards; this adapter's
// whole job is the text envelope plus defense-in-depth scrubbing.

const TOKEN_RE = /olma_tok_[0-9a-f]{32}/g;

// No identity token may ever appear in tool output, whatever field it hid in.
function scrubTokens(text) {
  return text.replace(TOKEN_RE, '[REDACTED]');
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
