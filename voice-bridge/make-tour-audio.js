'use strict';
// Regenerate the voice tour as one WAV file. NOT a recording of the call —
// the call itself is never recorded (personal content must not sit at a
// vendor) — this is the identical text re-rendered by the identical voices.
// Kept at 8kHz mono on purpose: that IS the phone line, and judging a voice
// at studio quality would be judging something the user will never hear.
const fs = require('node:fs');
for (const line of fs.readFileSync('/opt/olma2-voice-bridge/.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const KEY = process.env.CARTESIA_API_KEY;
const MODEL = process.env.CARTESIA_MODEL || 'sonic-3';
const RATE = 8000;

const VOICES = [
  [1, 'ff857c8e-e7f9-4afd-af42-dce9f3c5ab02', 'ירדן'],
  [4, 'bd05edd9-cec9-4600-9af4-c9ba4e032ff9', 'טליה'],
  [6, '43300c5e-f925-4cd2-adf7-0a031c0e242e', 'עלמה'],
  [7, '2821fd0c-35c7-4adf-9c42-32e394bf85cb', 'עדי'],
  [8, '84b969ad-19c7-428d-b742-48d387f7f138', 'גיל'],
  [9, '33124162-0d74-48af-ab1c-c1c01bac0247', 'עידו'],
  [10, 'daa4d6bb-da62-4e16-8065-76cd87942475', 'איתן'],
  [11, '3e32f3c5-9ac0-4192-9994-87fdb277120f', 'נועם'],
  [12, '921f4026-af53-4761-ac56-1c32e44856e8', 'רונן'],
  [13, 'a976c076-3e31-4bf2-a178-8c3ce3d52b2a', 'אייל'],
];
const LINE = 'היי מירון, אני אוֹלְמָה. מחר יש לך תשלום שכר דירה בשמונה בבוקר, ופגישה אצל דוקטור לוי באחת עשרה ורבע. רוצה שאזכיר לך בבוקר?';

async function tts(voiceId, text) {
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: { 'X-API-Key': KEY, 'Cartesia-Version': '2025-04-16', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_id: MODEL, language: 'he', voice: { mode: 'id', id: voiceId },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: RATE },
      transcript: text,
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 150)}`);
  return Buffer.from(await res.arrayBuffer());
}

function wavHeader(dataLen) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataLen, 40);
  return h;
}

(async () => {
  const parts = [];
  const gap = Buffer.alloc(RATE * 2 * 0.6 | 0); // 0.6s of silence between voices
  for (const [num, id, name] of VOICES) {
    process.stderr.write(`rendering ${num} ${name}\n`);
    parts.push(await tts(id, `קול מספר ${num}. ${LINE}`), gap);
  }
  const data = Buffer.concat(parts);
  const out = process.argv[2] || '/opt/olma2-voice-bridge/voice-tour.wav';
  fs.writeFileSync(out, Buffer.concat([wavHeader(data.length), data]));
  console.log(`${out} — ${(data.length / (RATE * 2)).toFixed(0)}s, ${(data.length / 1e6).toFixed(1)}MB`);
})().catch((e) => { console.error(e.message); process.exit(1); });
