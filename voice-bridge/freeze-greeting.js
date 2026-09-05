'use strict';
// Choose, by ear, the ONE take of the greeting that every call will open with.
//
// Cartesia is non-deterministic (measured 2026-08-31: identical transcript,
// different audio), so the opening sentence is a lottery unless it is frozen.
// This renders N independent takes for audition and installs the chosen one
// as /opt/olma2-voice-bridge/greeting.ulaw, alongside the exact text it was
// rendered from — the bridge replays it only while that text still matches.
//
//   node freeze-greeting.js               # render 5 takes -> mp3 to audition
//   node freeze-greeting.js --install 3   # freeze take 3, then restart the unit
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OLMA = '/opt/olma2';
const BRIDGE = '/opt/olma2-voice-bridge';
for (const f of [`${BRIDGE}/.env`, `${OLMA}/.env`]) {
  try {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}
const { Pool } = require(path.join(OLMA, 'node_modules/pg'));
const KEY = process.env.CARTESIA_API_KEY;
const MODEL = process.env.CARTESIA_MODEL || 'sonic-3';
// Same source of truth as the bridge — a take frozen from a different
// spelling than the one the bridge speaks would be a silent mismatch.
const SPOKEN_DEFAULT_NAME = process.env.VOICE_SPOKEN_NAME || 'אוֹל מָה';
const VOICE_BY_GENDER = {
  female: '2821fd0c-35c7-4adf-9c42-32e394bf85cb',
  male: '921f4026-af53-4761-ac56-1c32e44856e8',
};
const USER_PHONE = '+972526269826';
const TAKES_DIR = `${BRIDGE}/greeting-takes`;
const N = 5;

async function ttsMulaw(text, voiceId) {
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: { 'X-API-Key': KEY, 'Cartesia-Version': '2025-04-16', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_id: MODEL, language: 'he', voice: { mode: 'id', id: voiceId },
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
      transcript: text,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  return Buffer.from(await res.arrayBuffer());
}

(async () => {
  const pool = new Pool({ connectionString: process.env.OLMA_DB_URL || process.env.DATABASE_URL });
  const { rows } = await pool.query(
    'SELECT first_name, assistant_gender, assistant_name FROM users WHERE phone = $1', [USER_PHONE]);
  await pool.end();
  if (!rows[0]) throw new Error(`no user for ${USER_PHONE}`);
  const gender = rows[0].assistant_gender || 'female';
  const name = rows[0].assistant_name || 'עולמה';
  const spoken = /^[אע]ולמה$/.test(name) ? SPOKEN_DEFAULT_NAME : name;
  const text = `היי${rows[0].first_name ? ' ' + rows[0].first_name : ''}, ${gender === 'male' ? 'זה' : 'זאת'} ${spoken}. מה קורה?`;
  const voiceId = VOICE_BY_GENDER[gender] || VOICE_BY_GENDER.female;

  const install = process.argv.indexOf('--install');
  if (install >= 0) {
    const n = Number(process.argv[install + 1]);
    const src = `${TAKES_DIR}/take${n}.ulaw`;
    if (!Number.isInteger(n) || !fs.existsSync(src)) throw new Error(`no take ${process.argv[install + 1]} — render first`);
    const stored = fs.readFileSync(`${TAKES_DIR}/text.txt`, 'utf8');
    if (stored !== text) throw new Error('the takes were rendered from different text than the bridge would speak now — re-render');
    fs.copyFileSync(src, `${BRIDGE}/greeting.ulaw`);
    fs.writeFileSync(`${BRIDGE}/greeting.txt`, text);
    console.log(`frozen take ${n} (${(fs.statSync(src).size / 8000).toFixed(1)}s) for: ${text}`);
    console.log('now: systemctl restart olma-voice-bridge');
    return;
  }

  fs.mkdirSync(TAKES_DIR, { recursive: true });
  fs.writeFileSync(`${TAKES_DIR}/text.txt`, text);
  console.log(`text: ${text}`);
  for (let i = 1; i <= N; i++) {
    const ulaw = await ttsMulaw(text, voiceId);
    fs.writeFileSync(`${TAKES_DIR}/take${i}.ulaw`, ulaw);
    // mp3 for auditioning, straight from the mulaw the phone would hear —
    // auditioning a different encoding would be auditioning a different thing.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'mulaw', '-ar', '8000', '-ac', '1',
      '-i', `${TAKES_DIR}/take${i}.ulaw`, '-ar', '22050', '-b:a', '48k', `${TAKES_DIR}/take${i}.mp3`]);
    console.log(`take ${i}: ${(ulaw.length / 8000).toFixed(2)}s`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
