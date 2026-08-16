'use strict';
// Structured results — the contract every domain function returns.
// The MCP adapter renders these to text for the agent; the HTTP adapter
// returns them as JSON. Domain code never builds user-facing prose.

function ok(data) {
  return { ok: true, data: data ?? null };
}

// code: 'not_found' | 'forbidden' | 'invalid' | 'conflict'
// message: developer/agent-facing, terse, English. Presentation happens in adapters.
function err(code, message, extra) {
  return { ok: false, error: { code, message, ...(extra || {}) } };
}

module.exports = { ok, err };
