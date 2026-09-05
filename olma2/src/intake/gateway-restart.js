'use strict';
// The blunt instrument, made non-blocking: restart the gateway when a config
// write was bindings-only and would otherwise be ignored (intake/provision.js
// and deprovision.js each explain the case they hit).
//
// It used to be spawnSync inside brokerd — the one process that answers live
// users — so a slow restart froze every turn_start for its whole duration.
// Now it is an awaited spawn with a deadline: the caller still learns whether
// the restart happened, and nobody else on the box waits for it.
//
// Only `openclaw-gateway` is a user-scope unit (CLAUDE.md, "systemd scope"),
// hence --user and the XDG_RUNTIME_DIR that `systemctl --user` needs when
// run from a system service.
const { spawn } = require('node:child_process');

const RESTART_TIMEOUT_MS = 60_000;

function restartGateway({ timeoutMs = RESTART_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('systemctl', ['--user', 'restart', 'openclaw-gateway'], {
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

module.exports = { restartGateway, RESTART_TIMEOUT_MS };
