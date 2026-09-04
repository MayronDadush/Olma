'use strict';
// Olma voice bridge — path D. A standalone process that puts the REAL Olma on
// a phone call: Twilio Media Streams in, Deepgram Nova-3 Hebrew STT, the same
// DeepSeek that runs Olma's background cognition as the brain (reading the
// user's real USER.md and calling the real domain functions), Cartesia Sonic
// TTS out. No ElevenLabs, no copied prompt, no second Olma.
//
// Deliberately NOT part of olma2: its own unit, its own port (127.0.0.1:8791),
// fronted by Caddy at /voice-bridge. A crash here drops a call and touches
// nothing else. Audio is mulaw-8k end to end — Twilio speaks it natively and
// Cartesia emits it natively, so the bridge never transcodes a single sample.
//
// MULTI-USER since 2026-09-02. It used to resolve ONE user by phone at
// startup and hold them in a module-level global; every tool call, the system
// prompt, the greeting and the dial target all read that global. Adding a
// second person to an allowlist under that design would have rung the first
// person's phone and handed the second person's caller the first person's
// private card — so the user is resolved PER CALL instead:
//
//   dial → placeCall(user) embeds <Parameter name="userId"> in the TwiML
//        → Twilio echoes it back on the stream's `start` event
//        → the bridge loads THAT user and threads them through the Call
//
// Fail-closed by construction: a stream that arrives without a valid,
// active userId is hung up rather than served, and there is no default user
// left to fall back to. Who may be called is VOICE_ENABLED_PHONES in .env.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');

const OLMA = '/opt/olma2';
module.paths.unshift(path.join(OLMA, 'node_modules'));
const { Pool } = require(path.join(OLMA, 'node_modules/pg'));
const tasks = require(path.join(OLMA, 'src/domain/tasks.js'));
const calendar = require(path.join(OLMA, 'src/domain/calendar.js'));
const users = require(path.join(OLMA, 'src/domain/users.js'));
const { refreshUserCard } = require(path.join(OLMA, 'src/intake/user-card.js'));

// env: our own .env first (Deepgram/Cartesia), then olma2's (DB, OpenRouter)
for (const f of ['/opt/olma2-voice-bridge/.env', '/opt/olma2-voice-bridge/twilio.env', path.join(OLMA, '.env')]) {
  try {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^(?:export )?([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

const DG_KEY = process.env.DEEPGRAM_API_KEY;
const CART_KEY = process.env.CARTESIA_API_KEY;
const CART_MODEL = process.env.CARTESIA_MODEL || 'sonic-3';
let CART_VOICE = process.env.CARTESIA_VOICE_ID || '';
// TTS: elevenlabs (v3 — the Hebrew Miron already heard and accepted) or
// cartesia (kept for A/B; its native-Hebrew voice tested unclear on a real call)
const TTS = process.env.VOICE_TTS || 'elevenlabs';
const EL_KEY = process.env.ELEVENLABS_API_KEY;
const EL_VOICE = process.env.EL_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // Sarah
const EL_MODEL = process.env.EL_TTS_MODEL || 'eleven_v3'; // flash/turbo have NO Hebrew

// ---------------------------------------------------------------- persona ----
// Who the assistant is on the phone: gender picks the voice AND the grammar
// (Hebrew has no neutral register — a male voice speaking in the feminine is
// wrong in every sentence), and the user may rename the assistant. Since
// migration 025 the persona lives on the users row (assistant_gender /
// assistant_name) — the SAME columns WhatsApp's set_assistant_persona writes,
// so the two surfaces can never disagree. Re-read at every call start;
// changed mid-call via set_persona, which writes through the same domain
// function. Cartesia's voice id rides every TTS message, so the very next
// sentence after a switch already speaks in the new voice.
const VOICE_BY_GENDER = {
  female: '2821fd0c-35c7-4adf-9c42-32e394bf85cb', // עדי — Miron's pick, tour #7
  male: '921f4026-af53-4761-ac56-1c32e44856e8',   // רונן — tour #12
};
// The persona is per USER, so it is per CALL — never a module global. Two
// people on the line at once may run opposite genders, and a shared global
// would have each call rewriting the other's voice mid-sentence.
const DEFAULT_PERSONA = { gender: 'female', name: 'אולמה' };
async function loadPersona(userId) {
  const r = await pool.query(
    'SELECT assistant_gender, assistant_name FROM users WHERE id = $1', [userId]);
  if (!r.rows[0]) return { ...DEFAULT_PERSONA };
  return {
    gender: r.rows[0].assistant_gender || 'female',
    name: r.rows[0].assistant_name || 'אולמה',
  };
}
function personaVoice(persona) { return VOICE_BY_GENDER[persona.gender] || VOICE_BY_GENDER.female; }
// gFor(persona)(feminine, masculine) — every gendered word in
// prompt/greeting/fillers goes through this one switch.
const gFor = (persona) => (f, m) => (persona.gender === 'male' ? m : f);
// The default name is SPELLED differently for the ear than for the eye:
// Miron defined the pronunciation as "אול" + "מה" joined, and the spelling
// below is what steers the TTS closest to it. It lives in .env because
// picking it is an EAR decision made against a live engine, re-opened
// whenever the voice or the model changes — a config line, not a code edit.
// A custom name is spoken exactly as given.
const SPOKEN_DEFAULT_NAME = process.env.VOICE_SPOKEN_NAME || 'אוֹל מָה';
function spokenName(persona) { return persona.name === 'אולמה' ? SPOKEN_DEFAULT_NAME : persona.name; }
function greetingText(user, persona) {
  const g = gFor(persona);
  return `היי${user.first_name ? ' ' + user.first_name : ''}, ${g('זאת', 'זה')} ${spokenName(persona)}. מה קורה?`;
}

// Pre-rendered greeting for the ElevenLabs path only: the first thing the
// caller hears must not wait on a TTS round-trip ("היה לה הפסקה ארוכה
// בתחילת השיחה"). On the live Cartesia path the greeting is instead one
// entry in the frozen-phrase map below — same replay, but keyed by text and
// scoped per persona, so it needs no mechanism of its own.
// Keyed by the exact greeting TEXT, not by user: two users share a cache
// entry only when their greeting is word-for-word identical, and a persona
// or name change simply misses and speaks live. Prerendered once per
// enabled user at boot, so nobody's first call pays the TTS round-trip.
const GREETING_CACHE = new Map(); // text -> ulaw Buffer
async function prerenderGreeting(text) {
  if (GREETING_CACHE.has(text)) return;
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}/stream?output_format=ulaw_8000`, {
      method: 'POST',
      headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: EL_MODEL }),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const parts = [];
    for await (const c of res.body) parts.push(Buffer.from(c));
    const buf = Buffer.concat(parts);
    GREETING_CACHE.set(text, buf);
    log(`greeting cached: ${(buf.length / 8000).toFixed(1)}s of audio for "${text.slice(0, 40)}"`);
  } catch (e) { log('greeting prerender failed (will TTS live):', e.message); }
}

// The Cartesia half of the same idea — but this only ever READS. Rendering a
// take here would freeze whatever the dice gave that boot, turning
// "sometimes wrong" into "always wrong, until someone notices". Installing a
// take is a deliberate act with a human ear in it (scripts/freeze-greeting.js
// renders several, plays them, installs the chosen one). With no approved
// take on disk, GREETING_ULAW stays null and greet() speaks live — exactly
// what it does today.
// Frozen phrases — the generalisation of the frozen greeting, and the answer
// to a measurement: across 16 renderings (4 spellings x 4 sentences) Miron
// judged only 5 correct, spread evenly — 1/4, 1/4, 1/4, 2/4. The spelling
// barely moves the odds; the engine simply rolls the dice on this word. So
// the name is not steered any more, it is REPLAYED: an approved take per
// sentence, keyed by the exact text.
//
// Two sentences carry the name in practice (the greeting, and answering
// "what's your name") and the prompt keeps it out of the middle of other
// sentences, so this covers nearly every time it is said out loud. Anything
// not in the map is spoken live exactly as before.
// Takes are per GENDER, because a frozen take carries a voice: replaying
// עדי's recording while the persona is רונן would be a stranger finishing
// his sentence. Each side keeps its own approved takes, so switching persona
// never discards the other's — and a side with none simply speaks live.
const PHRASES_DIR = '/opt/olma2-voice-bridge/phrases';
let PHRASES = { female: new Map(), male: new Map() };
// Punctuation is stripped so "אוֹלמָה" and "אוֹלמָה." are the same phrase —
// the model's choice of full stop must not decide how its own name sounds.
const normPhrase = (s) => s.replace(/\s+/g, ' ').trim().replace(/[.!?…]+$/u, '');
function loadPhrases() {
  PHRASES = { female: new Map(), male: new Map() };
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(PHRASES_DIR, 'index.json'), 'utf8'));
    for (const gender of ['female', 'male']) {
      for (const [text, file] of Object.entries(idx[gender] || {})) {
        PHRASES[gender].set(normPhrase(text), fs.readFileSync(path.join(PHRASES_DIR, file)));
      }
    }
    log(`phrases: ${PHRASES.female.size} female + ${PHRASES.male.size} male approved take(s)`);
  } catch { log('phrases: none installed — every sentence spoken live'); }
}
// Keyed by text, so a greeting carrying one user's first name simply is not
// in the other user's map — multi-user safety falls out of the existing
// design rather than needing a check of its own.
const frozenFor = (persona, text) => PHRASES[persona.gender]?.get(normPhrase(text));

const OR_KEY = process.env.OPENROUTER_API_KEY;
// DeepSeek measured 4-6s to first token — fine for WhatsApp, dead air on a
// phone. Voice gets a fast-TTFT model; background cognition stays DeepSeek.
const LLM_MODEL = process.env.VOICE_LLM_MODEL || 'google/gemini-2.5-flash';
// Who may be called, as E.164, comma-separated. A config line and a restart,
// not a code edit — and an EXPLICIT list rather than "every active user",
// because a phone call is the most intrusive thing Olma can do and the cost
// per minute is real. The default keeps the historical single user, so a
// bridge deployed without the var behaves exactly as it did before.
const VOICE_PHONES = (process.env.VOICE_ENABLED_PHONES || '+972526269826')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Two calls at once on a 1-vCPU box is already optimistic; this is the ceiling
// that stops a third from degrading the two in progress.
const MAX_CONCURRENT_CALLS = Number(process.env.VOICE_MAX_CONCURRENT || 2);
const TZ = 'Asia/Jerusalem';
if (!DG_KEY || !OR_KEY || (TTS === 'cartesia' ? !CART_KEY : !EL_KEY)) { console.error('missing keys'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.OLMA_DB_URL || process.env.DATABASE_URL });

// The ONLY way a user enters this process. Both lookups re-check status and
// is_eval on every call rather than trusting a roster cached at boot: someone
// paused, deactivated or renamed since startup must not still be reachable
// by phone, and the eval user's number is fake so a call could only fail.
const USER_COLS = 'id, phone, first_name, workspace_path';
async function loadUserById(id) {
  const r = await pool.query(
    `SELECT ${USER_COLS} FROM users WHERE id = $1 AND status = 'active' AND NOT is_eval`, [id]);
  return r.rows[0] || null;
}
async function loadUserByPhone(phone) {
  const r = await pool.query(
    `SELECT ${USER_COLS} FROM users WHERE phone = $1 AND status = 'active' AND NOT is_eval`, [phone]);
  return r.rows[0] || null;
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ---------------------------------------------------------------- tools ----
// Same domain functions the MCP tools call — validated and audited identically.
const ilTime = (d) => d ? new Date(d).toLocaleString('he-IL', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit',
}) : null;

// Read tools are deliberately ABSENT: tasks+calendar are prefetched into the
// prompt at pickup, and on the previous live call the model ignored the "don't
// re-read" instruction and burned 26 seconds re-fetching what it already had.
// A tool that does not exist cannot be called.
const TOOLS = [
  { type: 'function', function: { name: 'add_task', description: 'הוספת משימה חדשה. אם נאמר מועד — due_at חייב לשאת אזור זמן ישראלי (+03:00), אחרת יסורב.', parameters: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, due_at: { type: 'string', description: 'ISO-8601 עם offset, למשל 2026-09-01T15:00:00+03:00. השמט אם לא נאמר מועד.' } } } } },
  { type: 'function', function: { name: 'complete_task', description: 'סימון משימה כבוצעה לפי id מרשימת המשימות שבהקשר', parameters: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'number' } } } } },
  { type: 'function', function: { name: 'reschedule_task', description: 'שינוי מועד של משימה קיימת (לפי id מהרשימה שבהקשר). לבקשת "תשני את השעה" — זה הכלי, לא add_task.', parameters: { type: 'object', required: ['task_id', 'due_at'], properties: { task_id: { type: 'number' }, due_at: { type: 'string', description: 'ISO-8601 עם offset ישראלי (+03:00)' } } } } },
  { type: 'function', function: { name: 'add_calendar_event', description: 'הוספת אירוע אמיתי ליומן Google. רק כשהמשתמש מבקש במפורש שזה יהיה ביומן. start חייב offset ישראלי (+03:00). end אופציונלי — ברירת מחדל שעה.', parameters: { type: 'object', required: ['title', 'start'], properties: { title: { type: 'string' }, start: { type: 'string', description: 'ISO-8601 עם offset, למשל 2026-09-01T15:00:00+03:00' }, end: { type: 'string', description: 'ISO-8601 עם offset. השמט לאירוע של שעה.' } } } } },
  { type: 'function', function: { name: 'refresh_data', description: 'שליפה מחדש של המשימות והיומן — רק אם המשתמש מבקש במפורש לרענן או אחרי כמה שינויים', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'end_call', description: 'ניתוק השיחה. קרא לזה כשהמשתמש מבקש לנתק / לסיים / אומר ביי — אחרי שאמרת משפט פרידה קצר.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'set_persona', description: 'שינוי דמות העוזר, רק לבקשה מפורשת של המשתמש: gender מחליף קול ולשון דיבור (זכר/נקבה), name מחליף את השם. אחרי הקריאה עני כבר בדמות החדשה.', parameters: { type: 'object', properties: { gender: { type: 'string', enum: ['male', 'female'], description: 'male = קול גבר ולשון זכר, female = קול אישה ולשון נקבה' }, name: { type: 'string', description: 'שם חדש לעוזר, רק אם המשתמש ביקש שם' } } } } },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));
// Spoken the instant a tool call is detected in the stream, so the user never
// waits in silence while the tool + the follow-up LLM round + TTS run
// (~3-4s on a calendar write). Rotated so it doesn't sound canned; a function,
// not a constant, because "בודקת/בודק" must follow the live persona.
const fillers = (g) => ['רק רגע…', 'שנייה, אני על זה…', g('אני בודקת…', 'אני בודק…'), 'רגע אחד…'];

// `user` is threaded in from the Call, never read from a global: every row
// this writes is scoped by it, so passing the wrong one would write one
// person's task onto another's list. Making it the first parameter means a
// caller cannot forget it silently.
async function runTool(user, name, args) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let out;
    // Domain functions return {ok, data}/{ok:false, error} envelopes — unwrap.
    if (name === 'list_tasks') {
      const r = await tasks.listTasks(client, user.id, { status: 'open' });
      const rows = r.ok ? r.data.tasks : [];
      out = r.ok
        ? { count: rows.length, tasks: rows.slice(0, 15).map((t) => ({ id: t.id, title: t.title, due: ilTime(t.due_at) })), ...(rows.length > 15 ? { note: `מוצגות 15 מתוך ${rows.length}` } : {}) }
        : { error: r.error.message };
    } else if (name === 'add_task') {
      const r = await tasks.addTask(client, user.id, { title: String(args.title || '').slice(0, 200), dueAt: args.due_at || null, source: 'voice_call' });
      out = r.ok
        ? { ok: true, id: r.data.task.id, title: r.data.task.title, due: ilTime(r.data.task.due_at) }
        : { error: r.error.message };
    } else if (name === 'complete_task') {
      const r = await tasks.completeTask(client, user.id, Number(args.task_id));
      out = r.ok ? { ok: true, completed: r.data.task?.title || args.task_id } : { error: r.error.message };
    } else if (name === 'reschedule_task') {
      const r = await tasks.snoozeTask(client, user.id, Number(args.task_id), args.due_at);
      out = r.ok ? { ok: true, id: args.task_id, due: ilTime(args.due_at) } : { error: r.error.message };
    } else if (name === 'add_calendar_event') {
      // end defaults to start+1h HERE, not in the model's head — but only when
      // start is well-formed; garbage passes through so createEvent's own
      // offset guard is the one that refuses it, with a message the model
      // can relay honestly.
      let end = args.end;
      if (!end && /^\d{4}-\d{2}-\d{2}T/.test(String(args.start || ''))) {
        const s = new Date(args.start);
        if (!isNaN(s)) end = new Date(s.getTime() + 3600_000).toISOString();
      }
      const r = await calendar.createEvent(client, user.id, { title: String(args.title || '').slice(0, 200), start: args.start, end });
      out = r.ok
        ? { ok: true, title: r.data.title, start: ilTime(args.start), ...(r.data.alreadyExisted ? { note: 'האירוע כבר היה קיים' } : {}) }
        : { error: r.error.message };
    } else if (name === 'refresh_data') {
      const t = await tasks.listTasks(client, user.id, { status: 'open' });
      let cal = { calendar: 'לא זמין' };
      try {
        const c = await calendar.listEvents(client, user.id, 2);
        if (c?.ok !== false) { const d = c.data || c; cal = { events: (d.events || []).slice(0, 8).map((e) => ({ title: e.title, start: e.start?.includes?.('T') ? ilTime(e.start) : e.start })) }; }
      } catch {}
      out = {
        tasks: t.ok ? t.data.tasks.slice(0, 15).map((x) => ({ id: x.id, title: x.title, due: ilTime(x.due_at) })) : [],
        ...cal,
      };
    } else if (name === 'calendar_events') {
      const r = await calendar.listEvents(client, user.id, 2).catch((e) => ({ ok: false, err: e.message }));
      if (!r || r.ok === false) out = { calendar: 'לא זמין כרגע' };
      else {
        const d = r.data || r;
        out = { events: (d.events || []).slice(0, 8).map((e) => ({ title: e.title, start: e.start?.includes?.('T') ? ilTime(e.start) : e.start })) };
        if (d.conflicts) out.conflicts = d.conflicts;
      }
    } else out = { error: 'unknown tool' };
    await client.query('COMMIT');
    log('tool', name, JSON.stringify(args).slice(0, 80), '->', JSON.stringify(out).slice(0, 120));
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log('tool ERR', name, e.message);
    return { error: e.message.slice(0, 150) }; // the model relays refusals honestly
  } finally { client.release(); }
}

// ---------------------------------------------------------------- brain ----
function systemPrompt(user, persona) {
  const g = gFor(persona);
  const sName = spokenName(persona);
  // The private fact card of THIS caller. Reading it off a global is what
  // would have put one user's card in front of another; it comes from the
  // per-call user row and nowhere else.
  let card = '';
  try { card = fs.readFileSync(path.join(user.workspace_path, 'USER.md'), 'utf8').slice(0, 6000); } catch {}
  const now = new Date().toLocaleString('he-IL', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' });
  // Every gendered form rides g(feminine, masculine) — the instructions
  // address the model in the persona's own gender so its self-reference and
  // its register can never disagree (the gender-slip failure class).
  return `${g('את', 'אתה')} ${sName} — ${g('העוזרת האישית', 'העוזר האישי')} של ${user.first_name || 'המשתמש'}, בשיחת טלפון. עכשיו: ${now} (שעון ישראל).

חוקי שיחת טלפון:
- משפטים קצרים מאוד. תשובה של שורה-שתיים. בלי רשימות ארוכות — אם יש הרבה פריטים, ${g('אמרי', 'אמור')} את שלושת החשובים ${g('ושאלי', 'ושאל')} אם להמשיך.
- עברית מדוברת וטבעית. ${g('פני', 'פנה')} אליו בלשון זכר, ${g('דברי על עצמך בלשון נקבה', 'דבר על עצמך בלשון זכר')}.
- את שמך ${g('כתבי', 'כתוב')} תמיד בדיוק כך: ${sName} — זו הצורה שנשמעת נכון בקול.
- כששואלים איך קוראים לך — ${g('עני', 'ענה')} במשפט קצר שהוא רק השם: "${sName}." ואז ${g('המשיכי', 'המשך')} בנפרד. אל ${g('תשלבי', 'תשלב')} את שמך באמצע משפט אחר.
- כבר אמרת שלום בפתיחת השיחה — אל ${g('תציגי', 'תציג')} את עצמך שוב.
- כשהוא מבקש לנתק / לסיים / אומר ביי: ${g('אמרי', 'אמור')} משפט פרידה קצר ${g('וקראי', 'וקרא')} ל-end_call באותו תור. אל ${g('תשאירי', 'תשאיר')} אותו לנתק לבד.
- טקסט להקראה בלבד: בלי כוכביות, בלי נקודות-רשימה, בלי הדגשות — הכל נאמר בקול.
- אל ${g('תקריאי', 'תקריא')} מזהים (id) בקול. אל ${g('תמציאי', 'תמציא')} משימה, אירוע או מועד שלא נמצאים בהקשר או שלא חזרו מכלי.
- המשימות והיומן כבר בהקשר — ${g('עני', 'ענה')} מהם ישירות. אם כלי נכשל, ${g('אמרי', 'אמור')} זאת בפשטות.
- כששואלים "מה יש לי" ביום מסוים: תמיד שני המקורות יחד — גם המשימות וגם אירועי היומן של אותו יום, ברשימה אחת ממוזגת.
- לעולם אל ${g('תתווכחי', 'תתווכח')} על מה נשמע ("אמרתי לך כבר") — אם הוא שואל על משהו שכבר אמרת, ${g('אמרי', 'אמור')} אותו שוב בפשטות.
- חוק ברזל: לעולם אל ${g('תגידי', 'תגיד')} "הוספתי" / "סימנתי" / "רשמתי" בלי שקראת לכלי באותו תור וקיבלת ok. להגיד שביצעת בלי לבצע זה השקר הגרוע ביותר ש${g('את יכולה', 'אתה יכול')} להגיד. אם הוא ביקש להוסיף — ${g('קראי', 'קרא')} ל-add_task עכשיו, ורק אחרי התשובה ${g('אשרי', 'אשר')}.
- ביומן: ${g('את יכולה', 'אתה יכול')} להוסיף אירוע אמיתי ליומן Google עם add_calendar_event — אבל רק כשהוא מבקש במפורש שזה יהיה ביומן. משהו לעשות בלי בקשת יומן = משימה (add_task). חוק הברזל חל גם כאן: "רשמתי ביומן" רק אחרי ok מהכלי.
- בקשה מורכבת (תיאום עם אנשים אחרים, משהו רב-שלבי): ${g('שמרי', 'שמור')} אותה כמשימה עם add_task ${g('ואמרי שתמשיכי', 'ואמור שתמשיך')} איתה בוואטסאפ. אל ${g('תנסי', 'תנסה')} לבצע אותה על הקו.
- מועדים: אם הוא נותן שעה, זה שעון ישראל — ${g('כתבי', 'כתוב')} אותה עם ‎+03:00. בלי מועד — אל ${g('תמציאי', 'תמציא')} אחד.
- שעות בקול: ${g('אמרי', 'אמור')} אותן כמו שאומרים בדיבור — "ארבע אחר הצהריים", "שמונה וחצי בערב" — לעולם לא "שש עשרה" ולא ספרות כמו "16:00". באנגלית: "four pm".
- אם הוא מבקש שהעוזר יהיה גבר או אישה, או רוצה לקרוא לך בשם אחר — ${g('קראי', 'קרא')} ל-set_persona. מהמשפט הבא הקול והלשון מתחלפים.

מה ש${g('את יודעת', 'אתה יודע')} עליו (הכרטיס האמיתי שלו, מעודכן לעכשיו):
---
${card}
---`;
}

async function* llmStream(messages, signal) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LLM_MODEL, messages, tools: TOOLS, stream: true, temperature: 0.4, max_tokens: 500 }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let buf = '';
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      try { yield JSON.parse(data); } catch {}
    }
  }
}

// ----------------------------------------------------------------- call ----
class Call {
  // user + persona are constructor arguments, not globals read at use time:
  // everything this object does on someone's behalf is scoped by the pair it
  // was born with, so two concurrent calls cannot see each other's caller.
  constructor(twilioWs, user, persona) {
    this.tw = twilioWs;
    this.user = user;
    this.persona = persona;
    this.g = gFor(persona);
    this.streamSid = null;
    this.turn = 0;            // barge-in guard: stale turns drop their output
    this.busy = false;
    this.speakEndsAt = 0;     // when the audio ALREADY QUEUED at Twilio finishes playing
    this.pendingUtterance = '';
    this.messages = [{ role: 'system', content: systemPrompt(this.user, this.persona) }];
    this.dg = null; this.cart = null;
    this.cartCtx = 0;
    this.fillerIdx = 0;
    this.startedAt = Date.now();
  }

  // Read questions were taking ~8s because every one cost a tool round-trip.
  // Fetch tasks+calendar once at pickup and pin them into the system prompt,
  // so the common questions answer straight from context; tools remain for
  // writes and for an explicit re-check.
  async prefetch() {
    const [t, c] = await Promise.all([runTool(this.user, 'list_tasks', {}), runTool(this.user, 'calendar_events', {})]);
    this.messages[0].content += `

תמונת מצב שנשלפה ברגע שהשיחה התחילה — עני על שאלות קריאה ישירות מכאן, בלי לקרוא לכלים:
המשימות הפתוחות: ${JSON.stringify(t)}
היומן הקרוב: ${JSON.stringify(c)}
קראי ל-refresh_data רק אם הוא מבקש במפורש לרענן.`;
    log('prefetch done');
  }

  // --- audio out: text -> Cartesia -> Twilio, pure mulaw passthrough
  openCartesia() {
    this.cart = new WebSocket(`wss://api.cartesia.ai/tts/websocket?api_key=${CART_KEY}&cartesia_version=2025-04-16`);
    this.cart.on('message', (m) => {
      let d; try { d = JSON.parse(m); } catch { return; }
      // accept any context of the CURRENT turn (a turn may span several
      // contexts around tool calls); drop only stale turns
      if (d.type === 'chunk' && d.data && d.context_id?.startsWith(`t${this.turn}c`)) {
        this.tw.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: d.data } }));
        // mulaw-8k is 8000 bytes/sec — track when queued audio finishes playing
        const ms = (Buffer.from(d.data, 'base64').length / 8000) * 1000;
        this.speakEndsAt = Math.max(this.speakEndsAt, Date.now()) + ms;
      } else if (d.type === 'error') log('cartesia error:', d.error || JSON.stringify(d).slice(0, 200));
    });
    this.cart.on('error', (e) => log('cartesia ws error', e.message));
  }

  // Push already-rendered mulaw straight at Twilio. 8000 bytes = 1 second,
  // which is also how the playback clock is kept (speakEndsAt drives both
  // barge-in evidence and the hangup grace).
  playFrozen(buf) {
    for (let i = 0; i < buf.length; i += 4000) {
      this.tw.send(JSON.stringify({ event: 'media', streamSid: this.streamSid,
        media: { payload: buf.subarray(i, i + 4000).toString('base64') } }));
    }
    this.speakEndsAt = Math.max(this.speakEndsAt, Date.now()) + (buf.length / 8000) * 1000;
  }

  speak(text, isFinalChunk) {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (TTS === 'elevenlabs') { if (clean) this.speakEleven(clean); return; }
    if (!clean) { if (isFinalChunk) this.cartFlush(isFinalChunk); return; }
    // A frozen take is sent immediately, while Cartesia's chunks arrive
    // asynchronously — so it may only be used when nothing is still playing,
    // or it would jump the queue and land mid-word. Idle line: deterministic
    // pronunciation. Busy line: fall through and take the roll.
    const frozen = frozenFor(this.persona, clean);
    if (frozen && Date.now() >= this.speakEndsAt) { this.playFrozen(frozen); return; }
    this.cart.send(JSON.stringify({
      model_id: CART_MODEL, language: 'he',
      voice: { mode: 'id', id: personaVoice(this.persona) },
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
      transcript: clean + ' ',
      context_id: `t${this.turn}c${this.cartCtx}`,
      continue: !isFinalChunk,
    }));
  }

  cartFlush(isFinal) {
    this.cart?.send(JSON.stringify({
      model_id: CART_MODEL, language: 'he', voice: { mode: 'id', id: personaVoice(this.persona) },
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
      transcript: ' ', context_id: `t${this.turn}c${this.cartCtx}`, continue: !isFinal,
    }));
  }

  // ElevenLabs path: one HTTP streaming request per sentence, chained so
  // sentences play in order. output_format=ulaw_8000 → the bytes ARE the
  // Twilio payload, no transcoding. A barge-in advances this.turn, and every
  // queued sentence rechecks it before (and while) sending.
  speakEleven(sentence) {
    const myTurn = this.turn;
    this.ttsChain = (this.ttsChain || Promise.resolve()).then(async () => {
      if (this.turn !== myTurn) return;
      // NOTE: optimize_streaming_latency is REFUSED by eleven_v3 (400
      // unsupported_model) — and v3 is the only EL model with Hebrew, so the
      // param cannot be used here at all. Learned live: a call where every
      // sentence 400'd and Olma was mute after the cached greeting.
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}/stream?output_format=ulaw_8000`, {
        method: 'POST',
        headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sentence, model_id: EL_MODEL }),
      });
      if (!res.ok) { log('elevenlabs tts', res.status, (await res.text()).slice(0, 150)); return; }
      for await (const chunk of res.body) {
        if (this.turn !== myTurn) { res.body.destroy?.(); return; }
        const buf = Buffer.from(chunk);
        this.tw.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: buf.toString('base64') } }));
        this.speakEndsAt = Math.max(this.speakEndsAt, Date.now()) + (buf.length / 8000) * 1000;
      }
    }).catch((e) => log('tts chain', e.message));
  }

  bargeIn() {
    // If >1.5s of queued audio dies here, the user never heard the tail of
    // that answer — but the MODEL's transcript says it was said. Live result:
    // she told him about a calendar event, the barge-in cut it, and she then
    // argued "אמרתי לך, אולי לא שמת לב" twice. Record the cut so the next
    // turn knows to just repeat instead of litigating what was heard.
    if (Date.now() < this.speakEndsAt - 1500) this.speechCut = true;
    this.turn++; this.cartCtx++;
    this.speakEndsAt = 0; // whatever was queued is being cleared right now
    this.busy = false;    // the aborted turn's finally never fires for a stale turn
    this.tw.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    if (this.abort) this.abort.abort();
  }

  // "is Olma talking right now" — either thinking, or audio still draining
  // from Twilio's playback buffer (we push it far faster than real time, so
  // `busy` alone goes false long before the voice stops — the reason the
  // first live test would not shut up when interrupted).
  speaking() { return this.busy || Date.now() < this.speakEndsAt; }

  // --- audio in: Twilio -> Deepgram
  openDeepgram() {
    const q = new URLSearchParams({
      model: 'nova-3', language: 'he', encoding: 'mulaw', sample_rate: '8000', channels: '1',
      interim_results: 'true', endpointing: '300', utterance_end_ms: '1200', vad_events: 'true',
      smart_format: 'true', punctuate: 'true',
    });
    // proper names the transcriber would otherwise mangle
    // 'מירון' used to be hard-coded here — it was the only user. The caller's
    // own name and the assistant's come from the call now, so a second user's
    // name is hinted to the transcriber instead of a stranger's.
    for (const k of ['אולמה', this.persona.name, this.user.first_name]) if (k) q.append('keyterm', k);
    this.dg = new WebSocket(`wss://api.deepgram.com/v1/listen?${q}`, { headers: { Authorization: `Token ${DG_KEY}` } });
    this.dg.on('open', () => log('deepgram open'));
    this.dg.on('error', (e) => log('deepgram error', e.message));
    this.dg.on('message', (m) => {
      let d; try { d = JSON.parse(m); } catch { return; }
      if (d.type === 'Results') {
        const alt = d.channel?.alternatives?.[0];
        const text = (alt?.transcript || '').trim();
        // he started talking while Olma is audibly mid-sentence → shut up NOW.
        // Two-char minimum so a cough or line noise doesn't cut her off.
        if (text.length > 1 && this.speaking()) this.bargeIn();
        if (text && d.is_final) this.pendingUtterance += (this.pendingUtterance ? ' ' : '') + text;
        if (d.speech_final && this.pendingUtterance) this.onUtterance();
      } else if (d.type === 'UtteranceEnd' && this.pendingUtterance) this.onUtterance();
    });
  }

  onUtterance() {
    const text = this.pendingUtterance; this.pendingUtterance = '';
    log('user:', text);
    this.handleTurn(text).catch((e) => log('turn error', e.message));
  }

  async handleTurn(userText) {
    if (this.busy) this.bargeIn();
    const myTurn = ++this.turn;
    this.busy = true;
    this.abort = new AbortController();
    // A barged-in turn leaves its user message dangling with no reply; a second
    // user message straight after is exactly what confused Gemini into
    // narrating an add_task it never performed. Merge instead.
    if (this.speechCut) {
      this.speechCut = false;
      this.messages.push({ role: 'system', content: 'הדיבור האחרון שלך נקטע באמצע ההשמעה — ייתכן שהמשתמש לא שמע את סופו. אם הוא שואל על משהו שכבר אמרת, פשוט ' + this.g('אמרי', 'אמור') + ' אותו שוב, בלי להתווכח על מה נשמע.' });
    }
    const last = this.messages[this.messages.length - 1];
    if (last?.role === 'user') last.content += ' ' + userText;
    else this.messages.push({ role: 'user', content: userText });

    try {
      let fillerSaid = false;
      for (let hop = 0; hop < 4; hop++) {
        let content = '', sentence = '';
        const toolCalls = [];
        for await (const ev of llmStream(this.messages, this.abort.signal)) {
          if (this.turn !== myTurn) return; // barged in — drop everything
          const delta = ev.choices?.[0]?.delta || {};
          if (delta.content) {
            content += delta.content; sentence += delta.content;
            // flush a sentence at a time so speech starts before the model finishes
            const cut = sentence.search(/[.!?…\n]["']?\s/);
            if (cut >= 0 && sentence.slice(0, cut + 1).trim().length > 2) {
              this.speak(sentence.slice(0, cut + 1), false);
              sentence = sentence.slice(cut + 1);
            }
          }
          for (const tc of delta.tool_calls || []) {
            toolCalls[tc.index] = toolCalls[tc.index] || { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolCalls[tc.index].id = tc.id;
            if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
            // A tool is coming and nothing has been spoken this turn — fill the
            // silence NOW, before the tool + follow-up round + TTS all run.
            // Guarded on the COMPLETE name so a partial chunk can't match, and
            // never before end_call ("רק רגע" and then hanging up is worse).
            const tname = toolCalls[tc.index].function.name;
            if (!fillerSaid && !content.trim() && tname !== 'end_call' && TOOL_NAMES.has(tname)) {
              fillerSaid = true;
              const F = fillers(this.g);
              this.speak(F[this.fillerIdx++ % F.length], true);
            }
          }
        }
        if (this.turn !== myTurn) return;
        if (sentence.trim()) this.speak(sentence, true);
        else if (content && TTS === 'cartesia') this.speak('', true); // close the TTS context

        if (toolCalls.length) {
          this.messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
          for (const tc of toolCalls) {
            let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
            let out;
            if (tc.function.name === 'end_call') { out = { ok: true, note: this.g('אמרי', 'אמור') + ' עכשיו משפט פרידה קצר — הניתוק יקרה רק אחרי שיושמע' }; this.scheduleHangup(); }
            else if (tc.function.name === 'set_persona') {
              // The SAME domain function WhatsApp's set_assistant_persona
              // calls — validated and audited identically, one source of
              // truth (users.assistant_gender / assistant_name).
              const r = await users.setAssistantPersona(pool, this.user.id, {
                gender: args.gender, name: typeof args.name === 'string' && args.name.trim() ? args.name : undefined,
              });
              if (r.ok) {
                // Mutates THIS call's persona only. It used to assign a module
                // global, which would have switched a concurrent caller's voice
                // and grammar mid-sentence from a decision they never made.
                this.persona = { gender: r.data.gender, name: r.data.name };
                this.g = gFor(this.persona);
                // The card is what the WhatsApp agent reads next turn — a
                // persona changed by phone must not be invisible there.
                refreshUserCard(pool, this.user.id).catch(() => {});
                // The rules themselves are gendered, so the system prompt must
                // flip WITH the persona — otherwise the model is instructed in
                // one gender and told to speak in the other.
                this.messages[0] = { role: 'system', content: systemPrompt(this.user, this.persona) };
                log(`persona (u${this.user.id}) ->`, JSON.stringify(this.persona));
                out = { ok: true, gender: this.persona.gender, name: this.persona.name, note: 'מעכשיו הקול והלשון הוחלפו — ' + this.g('עני', 'ענה') + ' בדמות החדשה' };
              } else out = r;
            }
            else out = await runTool(this.user, tc.function.name, args);
            this.messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out) });
          }
          this.cartCtx++; // new speech context for the post-tool answer
          // A small breath between "שנייה, אני על זה" and the result — back to
          // back they sound robotic (Miron's note). On a genuinely slow tool
          // this delay disappears into the wait; on a fast one it adds ~300ms.
          if (fillerSaid) {
            await new Promise((r) => setTimeout(r, 300));
            if (this.turn !== myTurn) return;
          }
          continue;
        }
        if (content) { this.messages.push({ role: 'assistant', content }); log('olma:', content.slice(0, 140)); }
        break;
      }
    } finally {
      if (this.turn === myTurn) this.busy = false;
    }
  }

  // The user must not wait to find out the line is alive: the greeting audio
  // is rendered ONCE at server start and replayed from memory at pickup —
  // zero TTS latency on the first thing they hear.
  greet() {
    this.turn++;
    // Built per call, not at boot — the persona (gender, name) may have
    // changed since the server started, and the cached EL audio is only
    // replayed when it still matches the text it was rendered from.
    const text = greetingText(this.user, this.persona);
    this.messages.push({ role: 'assistant', content: text });
    // The greeting is just another frozen phrase — same map, same per-gender
    // scoping, so a persona switch picks up that side's approved take (or
    // speaks live if it has none) with no separate mechanism to keep in sync.
    const frozen = frozenFor(this.persona, text) || GREETING_CACHE.get(text) || null;
    if (frozen) this.playFrozen(frozen);
    else this.speak(text, true);
  }

  scheduleHangup() {
    // 3s grace: the goodbye usually arrives on the LLM round AFTER the
    // end_call tool result, and hanging up 0.8s in cuts it off (seen live).
    // Any speech that does queue pushes speakEndsAt forward past the grace.
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (Date.now() > t0 + 3000 && Date.now() > this.speakEndsAt + 700) {
        clearInterval(iv);
        log('hanging up (end_call)');
        try { this.tw.close(); } catch {}
      }
    }, 200);
  }
}

// ------------------------------------------------------- voice tour mode ----
// VOICE_TOUR=1 in .env turns a call into an audition: each candidate Hebrew
// voice says one numbered line, then the call ends. No LLM, no tools, no
// Deepgram — set the flag, dial, listen, pick a number, unset the flag.
const TOUR = (process.env.VOICE_TOUR || '').trim();
// Numbers are STABLE across tours on purpose — round 1 left Miron weighing
// "4, 6, 7 and Yarden", so those keep their numbers here and the men get new
// ones. Renumbering between rounds would invalidate the shortlist he formed.
const TOUR_SETS = {
  women: [
    [1, 'ff857c8e-e7f9-4afd-af42-dce9f3c5ab02', 'ירדן'],
    [2, 'd0be495c-5e23-4b88-b12d-bc42d38be9a5', 'שירה'],
    [3, '1cd6668f-84b9-41a2-adbd-b7328f8d6ef4', 'הילה'],
    [4, 'bd05edd9-cec9-4600-9af4-c9ba4e032ff9', 'טליה'],
    [5, '1daba551-67af-465e-a189-f91495aa2347', 'יעל'],
    [6, '43300c5e-f925-4cd2-adf7-0a031c0e242e', 'עלמה'],
    [7, '2821fd0c-35c7-4adf-9c42-32e394bf85cb', 'עדי'],
  ],
  // The shortlist re-heard on a longer, realistic line, then the men.
  round2: [
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
  ],
};
const TOUR_VOICES = TOUR_SETS[TOUR] || TOUR_SETS.women;
// Deliberately gender-neutral about the SPEAKER ("אני אוֹלְמָה", "אשמע",
// "נדבר") so the identical line is fair to a male and a female voice — a
// grammatically female script would make every male candidate sound wrong
// for a reason that has nothing to do with the voice.
const TOUR_LINE = 'היי מירון, אני עוֹלְמָה. מחר יש לך תשלום שכר דירה בשמונה בבוקר, ופגישה אצל דוקטור לוי באחת עשרה ורבע. רוצה שאזכיר לך בבוקר?';
async function tourTtsBytes(voiceId, text) {
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: { 'X-API-Key': CART_KEY, 'Cartesia-Version': '2025-04-16', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_id: CART_MODEL, language: 'he', voice: { mode: 'id', id: voiceId },
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
      transcript: text,
    }),
  });
  if (!res.ok) throw new Error(`tour tts ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return Buffer.from(await res.arrayBuffer());
}
async function runVoiceTour(call) {
  const say = async (voiceId, text) => {
    const buf = await tourTtsBytes(voiceId, text);
    for (let i = 0; i < buf.length; i += 4000) {
      call.tw.send(JSON.stringify({ event: 'media', streamSid: call.streamSid, media: { payload: buf.subarray(i, i + 4000).toString('base64') } }));
    }
    // bytes are pushed instantly; wait out the playback plus a small breath
    await new Promise((r) => setTimeout(r, (buf.length / 8000) * 1000 + 500));
  };
  await say(TOUR_VOICES[0][1], 'היי מירון, סיור קולות. כל קול אומר את המספר שלו ואז אותו משפט. המספרים נשארו כמו קודם. מתחילים.');
  for (const [num, id, name] of TOUR_VOICES) {
    log(`tour voice ${num}: ${name}`);
    await say(id, `קול מספר ${num}. ${TOUR_LINE}`);
  }
  await say(TOUR_VOICES[0][1], 'זהו, סיימנו. תגיד לקלוד איזה מספר הכי אהבת. ביי.');
  try { call.tw.close(); } catch {}
}

// ------------------------------------------------------------- plumbing ----
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server });

// ---- dial API: how "תתקשרי אליי" in WhatsApp becomes a ringing phone ----
// A SEPARATE port, 127.0.0.1 only and NOT in the Caddy route — so only local
// processes (brokerd's MCP tool) can trigger a call, never the internet.
const TW_SID = process.env.TWILIO_SID, TW_TOKEN = process.env.TWILIO_TOKEN;
const OLMA_NUMBER = process.env.OLMA_CALLER_ID || '+972559347282';

// Who is on, or about to be on, a call. A dial RESERVES the slot for 60s so a
// double tap cannot ring twice in the seconds before Twilio's stream even
// connects; the live stream then holds it until the call ends. One map rather
// than a global counter, because "is this person already on the phone" and
// "is the box full" are different questions and the old single counter
// answered the second one for both — which is why one call used to block
// everybody.
const busy = new Map(); // userId -> { until } ; until = Infinity while streaming
function isBusy(userId) {
  const b = busy.get(userId);
  if (!b) return false;
  if (Date.now() > b.until) { busy.delete(userId); return false; } // stale reservation
  return true;
}
function busyCount() {
  for (const [id, b] of busy) if (Date.now() > b.until) busy.delete(id);
  return busy.size;
}

async function placeCall(user) {
  // The userId travels INSIDE the TwiML: Twilio echoes <Parameter> back as
  // start.customParameters on the media stream, which is the only thing tying
  // an incoming websocket to a person. Without it the bridge would have to
  // guess, and guessing here means answering one user with another's data.
  const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect>'
    + '<Stream url="wss://allma.world/voice-bridge">'
    + `<Parameter name="userId" value="${user.id}" />`
    + '</Stream></Connect></Response>';
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Calls.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${TW_SID}:${TW_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: OLMA_NUMBER, To: user.phone, Twiml: twiml }).toString(),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.message || `twilio ${res.status}`);
  return j.sid;
}
const dialServer = http.createServer((req, res) => {
  const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method !== 'POST' || req.url !== '/dial') return reply(404, { ok: false, error: 'not found' });
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', async () => {
    let phone = null; try { phone = JSON.parse(body).phone; } catch {}
    // Two gates, deliberately separate: the allowlist says who the FEATURE is
    // open to, the users table says the row is real, active and callable. The
    // 403 wording is unchanged so domain/voice.js's message to the user, and
    // its test, keep meaning what they said.
    if (!phone || !VOICE_PHONES.includes(phone)) return reply(403, { ok: false, error: 'voice calls are not enabled for this user yet' });
    if (!TW_SID || !TW_TOKEN) return reply(500, { ok: false, error: 'no twilio credentials on the bridge' });
    let user;
    try { user = await loadUserByPhone(phone); } catch (e) { log('dial lookup failed:', e.message); return reply(500, { ok: false, error: 'lookup failed' }); }
    if (!user) return reply(403, { ok: false, error: 'voice calls are not enabled for this user yet' });
    if (isBusy(user.id)) return reply(409, { ok: false, error: 'a call is already in progress' });
    if (busyCount() >= MAX_CONCURRENT_CALLS) return reply(503, { ok: false, error: 'the line is busy right now' });
    busy.set(user.id, { until: Date.now() + 60_000 }); // reserve BEFORE the await
    try {
      const sid = await placeCall(user);
      log(`dial requested via API for u${user.id} ->`, sid);
      reply(200, { ok: true, callSid: sid });
    } catch (e) {
      busy.delete(user.id); // a call that never rang must not hold the slot
      log('dial failed:', e.message); reply(502, { ok: false, error: e.message });
    }
  });
});

wss.on('connection', (ws) => {
  log('twilio connected');
  // The Call cannot be built yet: nothing here knows who is on the line until
  // Twilio sends `start` with the parameters placeCall put in the TwiML. So it
  // is created inside the start handler, and every other event tolerates it
  // being null — media frames arriving in that window are simply dropped,
  // which costs a fraction of a second of audio nobody has spoken into yet.
  let call = null;
  let starting = false;
  // Tracked separately from `call`, and set the moment the slot is reserved.
  // Reading the id off `call` instead would leak the reservation forever if the
  // caller hung up during the persona query that runs between the two — the
  // user would then be permanently unreachable until someone restarted the
  // process, which is a worse outcome than the hangup it followed.
  let heldUserId = null;
  ws.on('close', () => {
    if (heldUserId !== null) busy.delete(heldUserId);
    if (call) { call.dg?.close(); call.cart?.close(); }
  });

  async function onStart(d) {
    // FAIL CLOSED. Every refusal below hangs up rather than falling back to a
    // default user: there is no user here safe to guess, and guessing wrong
    // means reading a stranger their neighbour's private card. A stream can
    // only reach this port through Caddy, but the parameter is still treated
    // as untrusted input — it is coerced to an integer and looked up, never
    // interpolated anywhere.
    const raw = d.start?.customParameters?.userId;
    const userId = Number(raw);
    if (!Number.isInteger(userId) || userId <= 0) {
      log('refusing stream: no usable userId parameter', JSON.stringify(raw ?? null));
      try { ws.close(); } catch {}
      return;
    }
    const user = await loadUserById(userId);
    if (!user) {
      log(`refusing stream: user ${userId} is not an active callable user`);
      try { ws.close(); } catch {}
      return;
    }
    // Held for the whole stream so a second dial cannot land on top of a call
    // already in progress; the ws close handler above is what releases it.
    busy.set(user.id, { until: Infinity });
    heldUserId = user.id;
    // The socket may already have closed while the lookup above was in flight.
    if (ws.readyState !== ws.OPEN) { busy.delete(user.id); return; }

    // Read at pickup, not at boot: the persona may have been changed from
    // WhatsApp since the process started, so the very first word already
    // speaks in the right voice and register.
    const persona = await loadPersona(user.id).catch((e) => {
      log('persona load failed (defaults hold):', e.message);
      return { ...DEFAULT_PERSONA };
    });

    call = new Call(ws, user, persona);
    call.streamSid = d.start.streamSid;
    log(`stream start ${call.streamSid} for u${user.id} (${user.first_name || '?'})`);
    call.openDeepgram();
    if (TTS === 'cartesia') call.openCartesia();
    call.prefetch().catch((e) => log('prefetch failed', e.message)); // fresh data before the first question
    // a stuck call must not burn money silently
    setTimeout(() => { log('max duration reached, hanging up'); try { ws.close(); } catch {} }, 10 * 60 * 1000);
    // cartesia needs its socket open first; elevenlabs is plain HTTP
    if (TTS === 'cartesia') {
      const ready = () => call.cart.readyState === 1 ? call.greet() : setTimeout(ready, 100);
      ready();
    } else call.greet();
  }

  ws.on('message', (m) => {
    let d; try { d = JSON.parse(m); } catch { return; }
    if (d.event === 'start') {
      if (starting || call) return; // one start per stream
      starting = true;
      // The tour is a dev audition with no user, no LLM and no tools — it only
      // needs somewhere to push bytes, so it never builds a Call at all.
      if (TOUR) {
        runVoiceTour({ tw: ws, streamSid: d.start.streamSid })
          .catch((e) => { log('tour failed:', e.message); try { ws.close(); } catch {} });
        return;
      }
      onStart(d).catch((e) => { log('stream start failed:', e.message); try { ws.close(); } catch {} });
    } else if (d.event === 'media') {
      if (call?.dg?.readyState === 1) call.dg.send(Buffer.from(d.media.payload, 'base64'));
    } else if (d.event === 'stop') {
      if (!call) return;
      log(`call ended after ${((Date.now() - call.startedAt) / 1000).toFixed(0)}s (u${call.user.id})`);
      call.dg?.close(); call.cart?.close();
      // keep the transcript on disk so the facts pipeline can read it later.
      // jobs/voice-calls.js resolves `user` per file, so it was already ready
      // for this; the id in the NAME is only so two calls ending in the same
      // millisecond cannot overwrite each other.
      try {
        fs.mkdirSync('/opt/olma2-voice-bridge/transcripts', { recursive: true });
        fs.writeFileSync(`/opt/olma2-voice-bridge/transcripts/${Date.now()}-u${call.user.id}.json`,
          JSON.stringify({ user: call.user.id, messages: call.messages.slice(1) }, null, 1));
      } catch {}
    }
  });
});

(async () => {
  // Resolve the allowlist once at boot for a LOG LINE and for the greeting
  // prerender — never as the roster the dial API trusts. That one re-queries
  // per request, so someone paused or deactivated after boot stops being
  // callable immediately instead of at the next restart.
  const enabled = [];
  for (const phone of VOICE_PHONES) {
    const u = await loadUserByPhone(phone).catch(() => null);
    if (u) enabled.push(u);
    else log(`WARN: ${phone} is in VOICE_ENABLED_PHONES but is not an active user — calls to it will be refused`);
  }
  if (!enabled.length) { console.error('no callable users in VOICE_ENABLED_PHONES'); process.exit(1); }
  if (!CART_VOICE) {
    // pick a voice once; keep it stable by writing it back to .env manually later
    const res = await fetch('https://api.cartesia.ai/voices/', { headers: { 'X-API-Key': CART_KEY, 'Cartesia-Version': '2025-04-16' } });
    const list = await res.json();
    const voices = Array.isArray(list) ? list : (list.data || []);
    const pick = voices.find((v) => /female|woman/i.test(v.description || '') ) || voices[0];
    if (!pick) { console.error('no cartesia voices visible'); process.exit(1); }
    CART_VOICE = pick.id;
    log('picked cartesia voice:', pick.id, '-', (pick.name || '').slice(0, 40));
  }
  // Cache the greeting only for the EL voice — in cartesia mode the greeting
  // must come from the SAME voice as the rest of the call (it's an A/B test).
  // One render per enabled user, because the greeting carries their name.
  if (TTS === 'elevenlabs') {
    for (const u of enabled) {
      const persona = await loadPersona(u.id).catch(() => ({ ...DEFAULT_PERSONA }));
      await prerenderGreeting(greetingText(u, persona));
    }
  } else loadPhrases();
  const who = enabled.map((u) => `u${u.id} ${u.first_name || '?'}`).join(', ');
  server.listen(8791, '127.0.0.1', () => log(`voice bridge up for ${enabled.length} user(s) [${who}] on 127.0.0.1:8791, tts=${TTS}, max ${MAX_CONCURRENT_CALLS} concurrent`));
  dialServer.listen(8792, '127.0.0.1', () => log('dial API on 127.0.0.1:8792'));
})();
