'use strict';
// Validate a CANDIDATE openclaw.json before it is written: the gateway does
// not reject an invalid config, it ignores it — every later reload is skipped,
// silently (docs/model-experiments.md, "The finding that outlived the
// experiment"). So the candidate goes to a scratch OPENCLAW_HOME and through
// `openclaw config validate --json`; anything but `valid: true` means do not
// write. Moved out of scripts/sync-agent-tool-policies.js unchanged when
// scripts/register-games-mcp.js needed the same check.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function validateCandidate(cfg) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-toolpolicy-'));
  try {
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
    let out;
    try {
      out = execFileSync('openclaw', ['config', 'validate', '--json'], {
        env: { ...process.env, OPENCLAW_HOME: home }, encoding: 'utf8', timeout: 60_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      out = e && e.stdout ? String(e.stdout) : '';
      if (!out) return { valid: false, why: `openclaw config validate could not run: ${e.message}` };
    }
    const j = JSON.parse(out);
    return { valid: j.valid === true, why: JSON.stringify(j.errors || j.issues || []).slice(0, 500) };
  } catch (e) {
    return { valid: false, why: `validation unreadable: ${e.message}` };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

module.exports = { validateCandidate };
