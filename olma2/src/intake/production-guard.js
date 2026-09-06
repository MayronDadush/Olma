'use strict';
// A test process must never touch the live gateway's home or its roster.
//
// This exists because it happened, three times in two days. `deploy.sh
// --restart` runs the full suite ON THE BOX, where `/root/.openclaw` is
// production. tests/mcp-e2e.test.js spawns a real brokerd against a throwaway
// database; brokerd runs every sweep, including `intake_sweep`; the sweep
// listed sessions from the LIVE session index, resolved those people against
// the EMPTY test database, got fresh low ids for them, and provisioned — into
// the live workspaces and the live openclaw.json. Six real users' identity
// files were overwritten with tokens from a database that no longer exists,
// and four agents (u-19, u-21, u-22, u-24) were bound to nothing. The damage
// was invisible for a day because the post-deploy `resync-agent-templates.js`
// rewrites AGENTS.md and silently healed half of it (2026-09-05 20:03,
// 2026-09-06 09:18 and 12:45; incidents.md).
//
// The primary fix is isolation — tests/helpers.js points OLMA_OPENCLAW_HOME
// and OLMA_OPENCLAW_CONFIG at a temp directory for every test process. This is
// the second lock, and it is not redundant: isolation travels by environment,
// and it is gone the moment a test spawns a child with a hand-built `env`
// instead of `{ ...process.env }`. `NODE_TEST_CONTEXT` is set by `node --test`
// in every test child and IS inherited by grandchildren (measured), so it
// still identifies the process even where our own variables did not survive.
//
// Fail CLOSED: throw rather than warn. A test that trips this is a test that
// was about to edit production, and the only safe outcome is a red suite.
const PRODUCTION_PATHS = ['/root/.openclaw'];

// `node --test` sets this in the child process it runs each file in.
// Nothing else does, so a false positive would need someone to export it by
// hand — in which case they have asked for the safe behaviour anyway.
function inTestProcess() {
  return Boolean(process.env.NODE_TEST_CONTEXT);
}

function isProductionPath(target) {
  if (!target) return false;
  return PRODUCTION_PATHS.some((p) => target === p || target.startsWith(p + '/'));
}

// `what` names the thing being reached for, so the failure says which call
// site to fix rather than only that something was blocked.
function assertNotProduction(what, target) {
  if (!inTestProcess() || !isProductionPath(target)) return;
  throw new Error(
    `refusing to touch the live gateway from a test process: ${what} resolved to ${target}. `
    + 'Set OLMA_OPENCLAW_HOME and OLMA_OPENCLAW_CONFIG to a temp directory — tests/helpers.js '
    + 'does this for every test file, so a spawned child that lost them was probably given a '
    + 'hand-built env instead of { ...process.env }.');
}

module.exports = { assertNotProduction, isProductionPath, inTestProcess, PRODUCTION_PATHS };
