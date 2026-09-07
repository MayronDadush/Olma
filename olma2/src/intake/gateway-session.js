'use strict';
// Delete a stored session from the RUNNING gateway.
//
// This exists because deleting a user did not stick. `deprovisionUser` removes
// the DB row, the agent, the binding and the workspace — everything olma2
// owns — and the intake sweep put the person straight back, because the sweep
// reads the GATEWAY's session store and that is not ours to delete from
// (jobs/intake.js iterates every intake session with no age bound; a phone
// that ever reached the greeter and has no active user row is provisioned on
// the next tick). A phantom user created by an eval run against production
// came back sixty seconds after being deleted, twice, before anyone looked at
// the store instead of the database (incidents.md, "The user who would not
// stay deleted").
//
// Through the CLI, never the sqlite file: the gateway owns that store, holds
// it open, and archives the transcript on the way out (CLAUDE.md, "We were a
// second writer to someone else's file"). Same shape as gateway-restart.js —
// an awaited spawn with a deadline, because this runs inside brokerd, the one
// process that answers live users.
const { spawn } = require('node:child_process');
const { inTestProcess } = require('./production-guard');

const DELETE_TIMEOUT_MS = 30_000;

// key shape: agent:<agentId>:<channel>:<chatType>:<peer> (channels/sessions.js)
function intakeSessionKey(phone, agentId = 'intake') {
  return `agent:${agentId}:whatsapp:direct:${phone}`;
}

// THREE values, never two. `null` is "not attempted" — the suite runs on the
// box during `deploy.sh --restart`, where the gateway is production and its
// sessions belong to real people, so a test process must never reach it. A
// caller that cannot tell "refused to try" from "tried and failed" would
// report a session as surviving when nothing ever asked about it.
function deleteSession(key, { timeoutMs = DELETE_TIMEOUT_MS } = {}) {
  if (inTestProcess()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('openclaw', ['sessions', 'delete', key, '--yes'], {
        env: { ...process.env, XDG_RUNTIME_DIR: '/run/user/0' },
        stdio: 'ignore',
      });
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

module.exports = { deleteSession, intakeSessionKey, DELETE_TIMEOUT_MS };
