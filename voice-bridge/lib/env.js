'use strict';
// The bridge's own .env reader: KEY=value lines, optional `export `, first
// file wins, and a value already in the environment is never overwritten —
// so the unit's Environment= and a shell's exports outrank every file.
// Files that do not exist are skipped silently (the box has twilio.env, a
// laptop does not). Zero dependencies, same as everything else here.
const fs = require('node:fs');

const LINE = /^(?:export )?([A-Z_][A-Z0-9_]*)=(.*)$/;

// loadEnvFiles(paths, env = process.env) -> the keys it set, in order.
function loadEnvFiles(paths, env = process.env) {
  const set = [];
  for (const f of paths) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = line.match(LINE);
      if (!m || env[m[1]] !== undefined) continue;
      env[m[1]] = m[2];
      set.push(m[1]);
    }
  }
  return set;
}

module.exports = { loadEnvFiles, LINE };
