'use strict';
// Declarative tool registry — the single list both the MCP shim (tools/list)
// and brokerd (dispatch) read. Every schema requires the identity parameter
// (see identity-param.js for its name and why it is not called *_token); no
// tool accepts a caller-supplied user id as identity. Handlers get (client,
// user, args) inside a transaction and return structured results; rendering
// to text happens in render.js, never here.
//
// Since the split into ./tools/: this file is the ORDER. Each file exports
// the tools of one domain; the gateway lists tools in the order below, so a
// new domain is a new line here, placed on purpose.
const TOOLS = [
  ...require('./tools/turn-gate'),
  ...require('./tools/profile'),
  ...require('./tools/digest'),
  ...require('./tools/cards'),
  ...require('./tools/media-generation'),
  ...require('./tools/live-updates'),
  ...require('./tools/tasks'),
  ...require('./tools/reminders'),
  ...require('./tools/preferences'),
  ...require('./tools/combined-connect'),
  ...require('./tools/calendar'),
  // No `./tools/email` (2026-09-07). `gmail.readonly` is a RESTRICTED scope
  // and prices the whole app into Google's paid verification track — the five
  // mailbox tools were deleted rather than left here refusing, because an
  // unlisted tool file is what tests/tool-registry-layout.test.js forbids and
  // a listed one spends the schema budget on every turn to offer something
  // that cannot happen. `domain/mail.js` and its 32 tests are untouched:
  // reopening is re-adding one small file, after re-verification.
  // See domain/mail.js, "closed, and the flag is not what closes it".
  ...require('./tools/issues'),
  ...require('./tools/contacts'),
  ...require('./tools/bulk-contact-import'),
  ...require('./tools/connections'),
  ...require('./tools/messages-between-people'),
  ...require('./tools/shares'),
  ...require('./tools/meetings'),
  ...require('./tools/facts'),
];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function toolDefinitions() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

module.exports = { TOOLS, BY_NAME, toolDefinitions };
