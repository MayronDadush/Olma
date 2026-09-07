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
  ...require('./tools/group'),
];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// Who a tool is for. Unmarked means a person, because that is what 86 of them
// are; `audience: 'group'` is set by `groupTool` and by nothing else.
// brokerd enforces this — the list below only decides what a given agent is
// SHOWN, and a list is not a lock.
function audienceOf(t) { return t.audience === 'group' ? 'group' : 'user'; }

// What the shim serves. It is the WHOLE list, group tools included, and that
// is a measurement rather than a preference: the gateway spawns the MCP child
// with cwd `/root` and none of its own environment (checked on the live box,
// 2026-09-07 — `PWD=/root` and nothing else), and our agent entries carry no
// per-agent MCP scoping we could rely on. So the shim cannot know which agent
// it is answering, and a list it filtered by guesswork would take a group
// agent's only tools away from it.
//
// That is affordable exactly because the list is not the lock: brokerd refuses
// a group token on a person's tool and a person's token on a group tool, at
// the point of the call. The group set is kept tiny for the same reason every
// schema is (55k on every turn for everybody), and each one says GROUP AGENTS
// ONLY in its first three words so a person's model does not reach for it.
function toolDefinitions({ audience = null } = {}) {
  const list = audience ? TOOLS.filter((t) => audienceOf(t) === audience) : TOOLS;
  return list.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

module.exports = { TOOLS, BY_NAME, toolDefinitions, audienceOf };
