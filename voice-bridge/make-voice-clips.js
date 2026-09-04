'use strict';
// One clip per candidate voice, for the audition page. Rendered at 8kHz —
// the phone line's real bandwidth — then resampled up for the mp3 container
// only, so the clip is universally playable while still SOUNDING like the
// phone. Judging a phone voice at studio quality judges the wrong thing.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
for (const line of fs.readFileSync('/opt/olma2-voice-bridge/.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const KEY = process.env.CARTESIA_API_KEY;
const MODEL = process.env.CARTESIA_MODEL || 'sonic-3';
const RATE = 8000;
const OUT = '/opt/olma2-voice-bridge/clips';

const VOICES = [
  [1, 'ff857c8e-e7f9-4afd-af42-dce9f3c5ab02'],
  [4, 'bd05edd9-cec9-4600-9af4-c9ba4e032ff9'],
  [6, '43300c5e-f925-4cd2-adf7-0a031c0e242e'],
  [7, '2821fd0c-35c7-4adf-9c42-32e394bf85cb'],
  [8, '84b969ad-19c7-428d-b742-48d387f7f138'],
  [9, '33124162-0d74-48af-ab1c-c1c01bac0247'],
  [10, 'daa4d6bb-da62-4e16-8065-76cd87942475'],
  [11, '3e32f3c5-9ac0-4192-9994-87fdb277120f'],
  [12, '921f4026-af53-4761-ac56-1c32e44856e8'],
  [13, 'a976c076-3e31-4bf2-a178-8c3ce3d52b2a'],
];
const LINE = 'היי מירון, אני אוֹלְמָה. מחר יש לך תשלום שכר דירה בשמונה בבוקר, ופגישה אצל דוקטור לוי באחת עשרה ורבע. רוצה שאזכיר לך בבוקר?';

function wavHeader(dataLen) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataLen, 40);
  return h;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [num, id] of VOICES) {
    const res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: { 'X-API-Key': KEY, 'Cartesia-Version': '2025-04-16', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: MODEL, language: 'he', voice: { mode: 'id', id },
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: RATE },
        transcript: LINE, // no "קול מספר N" — the page shows the number
      }),
    });
    if (!res.ok) throw new Error(`voice ${num}: ${res.status} ${(await res.text()).slice(0, 120)}`);
    const pcm = Buffer.from(await res.arrayBuffer());
    const wav = `${OUT}/v${num}.wav`;
    fs.writeFileSync(wav, Buffer.concat([wavHeader(pcm.length), pcm]));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-ar', '22050', '-ac', '1', '-b:a', '48k', `${OUT}/v${num}.mp3`]);
    fs.unlinkSync(wav);
    console.log(`v${num}.mp3 ${(fs.statSync(`${OUT}/v${num}.mp3`).size / 1024).toFixed(0)}KB`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
