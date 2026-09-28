'use strict';
// A deleted person's conversation is still on the box: `deprovision.js` removes
// the agent from the gateway CONFIG and their workspace, and leaves
// `agents/<id>/` — the sqlite store that holds every message they ever sent —
// on disk. Deliberately: on 2026-09-19 two agent dirs were removed under a
// running gateway and it died on a WAL identity mismatch, twice, ~100s with no
// WhatsApp listener (memory: never-rm-agent-dir-while-gateway-runs).
//
// Measured 2026-09-28 on OpenClaw 2026.8.1, and it decides the shape of this:
//   * the gateway holds EVERY agent store open, orphans included — 13 of the
//     14 dirs not in the config had live fds in the gateway process;
//   * its own `agents.delete` (RPC and CLI) refuses an agent that is no longer
//     in the config, which is every orphan deprovision leaves behind.
// So an orphan can only be removed while NOTHING holds it, which in practice
// means with the gateway stopped. This module plans and performs that, and
// `scripts/purge-orphan-agents.js` is the only caller: dry-run by default,
// never stops or starts the gateway itself, and refuses a dir any process has
// open. "Could not tell whether it is held" is refused too, never read as free.
const fs = require('node:fs');
const path = require('node:path');
const guard = require('./production-guard');

// Agents the gateway itself owns. Never ours to remove, whatever the config says.
const SYSTEM_AGENTS = new Set(['main', 'intake', 'ggreet']);
// Only the shapes Olma provisions: a person's agent and a room's.
const OURS = /^(u|g)-\d+$/;

// Pure. Every input is a list of ids; the answer says, per dir, why it stays.
function planPurge({ dirs, configIds, userAgentIds, groupAgentIds }) {
  const config = new Set(configIds);
  const users = new Set(userAgentIds);
  const groups = new Set(groupAgentIds);
  const purge = [];
  const keep = [];
  for (const id of [...dirs].sort()) {
    const reason = SYSTEM_AGENTS.has(id) ? 'system agent'
      : !OURS.test(id) ? 'not an agent Olma provisions'
        : config.has(id) ? 'in the gateway config'
          : users.has(id) ? 'a users row still names it'
            : groups.has(id) ? 'a chat_groups row still names it'
              : null;
    if (reason) keep.push({ id, reason }); else purge.push(id);
  }
  return { purge, keep };
}

// Which of `dirs` (absolute) any process has a file open under. `null` means
// this host cannot say (no /proc: macOS, or a /proc we may not read), and the
// caller must treat that as held.
function heldDirs(dirs, procRoot = '/proc') {
  let pids;
  try { pids = fs.readdirSync(procRoot).filter((p) => /^\d+$/.test(p)); } catch { return null; }
  const held = new Set();
  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(path.join(procRoot, pid, 'fd')); } catch { continue; } // exited, or not ours to read
    for (const fd of fds) {
      let target;
      try { target = fs.readlinkSync(path.join(procRoot, pid, 'fd', fd)); } catch { continue; }
      for (const d of dirs) if (target === d || target.startsWith(d + '/')) held.add(d);
    }
  }
  return held;
}

function dirBytes(dir) {
  let total = 0;
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); } else total += st.size;
  };
  walk(dir);
  return total;
}

// Removes each planned dir that nothing holds. Returns what happened per id.
function purge(home, ids, { procRoot } = {}) {
  guard.assertNotProduction('orphan agent purge', home);
  const abs = ids.map((id) => path.join(home, 'agents', id));
  const held = heldDirs(abs, procRoot);
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    if (held === null) { out.push({ id: ids[i], removed: false, why: 'cannot tell whether a process holds it' }); continue; }
    if (held.has(abs[i])) { out.push({ id: ids[i], removed: false, why: 'a process has it open' }); continue; }
    try {
      fs.rmSync(abs[i], { recursive: true, force: false });
      out.push({ id: ids[i], removed: true });
    } catch (e) { out.push({ id: ids[i], removed: false, why: e.code || e.message }); }
  }
  return out;
}

module.exports = { planPurge, heldDirs, purge, dirBytes, SYSTEM_AGENTS };
