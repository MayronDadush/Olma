'use strict';
// Diagnostic hook: records that an internal event reached managed hook code.
// Shape only — type, action, a session-key prefix, the context's key names.
const fs = require('node:fs');
const LOG = process.env.OLMA_HOOK_PROBE_LOG || '/opt/olma2/run/hook-probe.log';
function line(fields) {
  try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...fields }) + '\n'); } catch { /* best effort */ }
}
line({ loaded: true, file: __filename });
module.exports = function probe(event) {
  const ctx = (event && event.context) || {};
  line({
    type: event && event.type, action: event && event.action,
    sessionKey: String((event && event.sessionKey) || '').slice(0, 40),
    contextKeys: Object.keys(ctx).slice(0, 30),
    messageId: ctx.messageId ? String(ctx.messageId).slice(0, 40) : null,
  });
  return false;
};
module.exports.default = module.exports;
