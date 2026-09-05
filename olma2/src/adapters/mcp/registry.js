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
  ...require('./tools/email'),
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
