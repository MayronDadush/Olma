'use strict';
// The name of the parameter every tool carries its identity in — and why it
// is deliberately NOT called `identity_token`.
//
// OpenClaw redacts tool-call ARGUMENTS before persisting them to the session
// transcript, keyed on the argument's NAME: anything normalising to token /
// key / secret / auth / credential / session / code is written out masked
// (`olma_t…1234`). The session file is what the model's context is rebuilt
// from on the next turn, so under the old name every agent saw its own past
// calls carrying a masked token — and DeepSeek v4-flash imitates the
// precedent in front of it over the instruction in AGENTS.md. Measured on the
// live box 2026-08-27: ~40% of calls in long-running sessions went out with
// the mask as the token, 118 auth.failed rows in one day, every turn paying
// 5-15s for the read-file-and-retry dance, and side-calls issued alongside a
// failed one sometimes never retried at all (a real cancel_meeting was lost
// this way). Sessions created fresh that same morning, with no masked example
// behind them, got 15/15 right — the precedent IS the cause.
//
// Renaming is the narrow fix. The alternative was logging.redactSensitive:
// "off", which works but disables masking for the whole gateway; this changes
// only our own parameter. It costs nothing in secrecy: the same token already
// sits in these same files in the clear, in the result of the agent reading
// `.olma-identity` and in AGENTS.md inside every system prompt — the masking
// never protected it here, it only broke the caller. The files are 0600 on a
// single-tenant box, and render.js still scrubs tokens out of everything
// flowing back the other way.
//
// Verified against the installed gateway's own redaction module: the
// normalised key `olma_identity` is not in its sensitive set, and the token's
// VALUE matches none of its 92 default patterns — only the key name ever
// triggered this.
const IDENTITY_PARAM = 'olma_identity';

// Agents provisioned before the rename have `identity_token` written into
// their AGENTS.md, and a session already under way has turns of it behind
// them. Both keep working: the doctrine resync that ships with a deploy
// reaches workspaces AFTER the code is live, and a model mid-session keeps
// copying what it sees for a while either way. Accepting both names is what
// makes the rename invisible to a live user instead of a cutover with a
// window where nobody can authenticate.
const LEGACY_IDENTITY_PARAM = 'identity_token';

// The identity out of a tool-call's arguments, whichever name it arrived
// under. The new name wins when both are present.
function readIdentity(args) {
  if (!args || typeof args !== 'object') return undefined;
  const fresh = args[IDENTITY_PARAM];
  if (fresh !== undefined && fresh !== null && fresh !== '') return fresh;
  return args[LEGACY_IDENTITY_PARAM];
}

// Everything EXCEPT the identity, under either name — what a handler is
// allowed to see. A handler that could read the identity out of its own args
// would be a second door into auth; there is exactly one (users.resolveByToken).
function stripIdentity(args) {
  const rest = { ...(args || {}) };
  delete rest[IDENTITY_PARAM];
  delete rest[LEGACY_IDENTITY_PARAM];
  return rest;
}

module.exports = { IDENTITY_PARAM, LEGACY_IDENTITY_PARAM, readIdentity, stripIdentity };
