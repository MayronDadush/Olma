'use strict';
// Runs INSIDE the gateway process on every accepted inbound message
// (docs/automation/hooks.md, `message:received`). It is an observation
// point: nothing here can block or change the run, which is the point — the
// person's message is already on its way to the model, and this only makes
// brokerd aware of it a few seconds earlier than the model's first tool call.
//
// What travels: the agent id (from the session key), the message id, whether
// it was a voice note, the sender's display name, and the id of the message
// they replied to when they used WhatsApp reply. What does not: the text.
// brokerd has no use for it and the shim never sent it either.
//
// Fire-and-forget over the unix socket with a short timeout. brokerd being
// down is not this hook's problem: the model's own turn_start (or the
// implicit opener on its first tool call) still opens the turn as before.
const net = require('node:net');

const SOCK = process.env.OLMA_SOCK || '/opt/olma2/run/brokerd.sock';
// Two clocks, not one. The brokerd budget starts when the socket CONNECTS;
// before that a separate, longer cap covers a socket that never does. One
// clock from the start was wrong in a way the trace could finally show
// (2026-09-07, u-3): the 2s timer fired at 3.8s with `connected:false`. A
// timer that fires late means the gateway's own event loop was blocked — its
// pre-model bookkeeping for a heavy user runs seconds — and when the loop
// came back the timer ran before the connect callback and destroyed a socket
// that was about to succeed. Eleven of the first ~200 opens died that way,
// every one with nothing on brokerd's side, because none ever reached it.
// The gateway runs this hook through `fireAndForgetHook`, so nobody is kept
// waiting by a longer cap; it only bounds how long a socket may sit unopened.
const TIMEOUT_MS = 2000;      // from connect: brokerd's answer
const CONNECT_CAP_MS = 10000; // from start: a socket that never connects
// One bounded line per event, next to the socket, so "did the hook run" is a
// question with an answer. Shape only: type, action, agent, outcome. Never the
// text, never the sender. Best-effort; a failed write is not this hook's job.
const TRACE = process.env.OLMA_HOOK_TRACE || '/opt/olma2/run/turn-open-hook.log';
function trace(fields) {
  try { require('node:fs').appendFileSync(TRACE, JSON.stringify({ at: new Date().toISOString(), ...fields }) + '\n'); } catch { /* best effort */ }
}

// One line at import time, so "was THIS file loaded, by which process" is
// answerable from the trace alone.
trace({ loaded: true, pid: process.pid, file: __filename });

function agentIdOf(sessionKey) {
  const m = /^agent:(u-\d+):/.exec(String(sessionKey || ''));
  return m ? m[1] : null;
}

// `received` carries a `media` array; `preprocessed` carries a flat
// `mediaType` (and a `transcript` once a voice note was transcribed).
function isVoice(context) {
  const c = context || {};
  const media = Array.isArray(c.media) ? c.media : [];
  if (media.some((m) => /^audio\//i.test(String((m && (m.mimeType || m.contentType || m.type)) || '')))) return true;
  if (/^audio\//i.test(String(c.mediaType || ''))) return true;
  return typeof c.transcript === 'string' && c.transcript.trim() !== '';
}

// WhatsApp reply. The event carries no `replyToId` field on OpenClaw 2026.8.1
// (the mapper that builds the preprocessed context drops it), but the `body`
// it does carry is the channel's envelope line, and the WhatsApp channel
// writes the quoted message into it as
//   [Replying to <sender> id:<message id>]\n<quoted text>\n[/Replying]
// Only the id is read out of that — the quoted text stays in the gateway
// like everything else here. A future gateway that puts `replyToId` on the
// event wins over the parse. Why brokerd needs it at all: the prompt the
// `before_prompt_build` plugin sees is the bare text (measured 2026-09-06 —
// the Conversation info block with `reply_to_id` is attached to the prompt
// AFTER that hook), so for the people whose turn opens in the prompt this is
// the only place the reply is visible before the model runs.
const REPLY_MARKER_RE = /\[Replying to [^\]\n]*?\bid:([^\s\]]+)\]/;
function replyToIdOf(context) {
  const c = context || {};
  const direct = c.replyToId || c.replyToIdFull;
  if (direct) return String(direct).slice(0, 80);
  const m = REPLY_MARKER_RE.exec(String(c.body || ''));
  return m ? m[1].slice(0, 80) : null;
}

// ── A message that is only thanks ────────────────────────────────────────────
// "תודה" earns a reply, a sign-off and a good evening, and every one of those
// is a notification for an exchange that was already over. A 🙏 says the same
// thing for the price of nothing (brokerd places it; see domain/reactions.js),
// and the hint that rides the opening tells the model the mark is the answer.
//
// The classification happens HERE, inside the gateway, and only the BOOLEAN
// travels — the text stays on this side like everything else in this file.
//
// Deliberately strict, and the asymmetry is the whole design: a miss costs one
// "בשמחה", which is today's behaviour, while a false positive means Olma
// silently ignores something somebody actually asked. So the message must
// CONTAIN an explicit thanks and every other word must be on a short filler
// list; anything else — a question mark, a verb, a noun nobody listed — is not
// this. Long-form gratitude ("תודה על כל העזרה אתמול") takes the ordinary path
// on purpose.
//
// Every language somebody here might thank in (owner, 2026-09-26: "בכל
// השפות"), each with the words that make its "thank you very much" — and
// nothing else, for the same asymmetry. A new language is a word on each list.
const THANKS_WORD_RE = new RegExp('^(' + [
  'תודה', 'תודות', 'תנקס', 'טנקס',                              // Hebrew
  'thanks', 'thankyou', 'thank', 'thx', 'thnx', 'tnx', 'tnks', 'ty', // English
  'شكرا', 'مشكور', 'مشكورة',                                     // Arabic
  'спасибо', 'спс', 'благодарю',                                  // Russian
  'merci',                                                        // French
  'gracias',                                                      // Spanish
  'danke', 'dank',                                                // German
  'grazie',                                                       // Italian
  'obrigado', 'obrigada', 'valeu',                                // Portuguese
  'አመሰግናለሁ',                                                    // Amharic
].join('|') + ')$', 'u');
const FILLER_WORD_RE = new RegExp('^(' + [
  'רבה', 'ענק', 'ענקית', 'גדולה', 'לך', 'לכם', 'מראש', 'מעולה', 'סבבה', 'אחלה', 'מושלם', 'יאללה', 'אוקיי', 'אוקי',
  'ok', 'okay', 'you', 'u', 'so', 'much', 'very', 'lots', 'lot', 'a', 'great', 'perfect', 'cool', 'nice',
  'جزيلا', 'كتير', 'كثيرا',                                       // شكرا جزيلا
  'большое', 'огромное',                                          // большое спасибо
  'beaucoup', 'mille',                                            // merci beaucoup, mille grazie
  'muchas', 'mil',                                                // muchas gracias
  'vielen', 'schön', 'sehr',                                      // vielen Dank, danke schön
  'tante',                                                        // grazie tante
  'muito',                                                        // muito obrigado
].join('|') + ')$', 'u');
const REPLY_BLOCK_RE = /\[Replying to[^\]]*\][\s\S]*?\[\/Replying\]/g;
const MAX_THANKS_WORDS = 5;

function thanksOnly(text) {
  const raw = String(text || '').replace(REPLY_BLOCK_RE, ' ');
  // A question is never a closed exchange, whatever else is in the sentence.
  if (/[?？]/.test(raw)) return false;
  // Everything that is not a letter or a space goes: punctuation, digits,
  // emoji and the direction marks WhatsApp sprinkles through Hebrew.
  const words = raw.replace(/[^\p{L}\s]/gu, ' ').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > MAX_THANKS_WORDS) return false;
  let sawThanks = false;
  for (const w of words) {
    if (THANKS_WORD_RE.test(w)) { sawThanks = true; continue; }
    if (!FILLER_WORD_RE.test(w)) return false;
  }
  return sawThanks;
}

// ── A message that is only "stop reminding me" ───────────────────────────────
// מאיה, 2026-09-16: four messages about a hospital bag, then "להפסיק להזכיר",
// then a question back about WHICH one — and two more messages the next day
// (domain/reminders.stopRecentLadders holds the argument for why the answer is
// a write and not a question).
//
// Classified here for the same reason `thanksOnly` is: the words never leave
// the gateway, only the verdict. Strict in the same way and for the same
// asymmetry, but the asymmetry points the other way, so the shape differs. A
// miss costs what today already costs — the model handles it. A false positive
// stops ladders that were already chasing them, which is an hour they can ask
// for again in four words. So this matches a bit more freely than thanksOnly:
// a stop verb plus a reminding word anywhere in a short message.
//
// Deliberately NOT matched: anything with a question mark, anything naming a
// day or an hour ("תזכיר לי רק ביום שני", "תפסיקי עד מחר") — those are a
// RESCHEDULE and the model has to do them — and anything long enough to be
// carrying a second request.
const STOP_VERB_RE = /(להפסיק|תפסיק[יו]?|מפסיק|(?:^|\s)די(?=\s|$)|תעזב[יו]?|עזב[יו]? אותי|בלי|מספיק|stop|quit|enough|no more)/u;
const REMIND_WORD_RE = /(תזכורת|תזכורות|תזכורתי|להזכיר|תזכיר[יו]?|מזכיר[הי]?|נדנוד|לנדנד|remind|reminder|reminders|nagging|nag)/u;
const RESCHEDULE_RE = /(\d{1,2}[:.]\d{2}|\d{1,2}\s*(?:בבוקר|בערב|בלילה|בצהריים)|מחר|מחרתיים|היום|יום (?:א|ב|ג|ד|ה|ו|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|בעוד|שעה|שעות|דקות|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|later|instead)/u;
const MAX_STOP_WORDS = 8;

function stopRemindersOnly(text) {
  const raw = String(text || '').replace(REPLY_BLOCK_RE, ' ');
  if (/[?？]/.test(raw)) return false;
  if (RESCHEDULE_RE.test(raw)) return false;      // a new time is not a stop
  const words = raw.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > MAX_STOP_WORDS) return false;
  return STOP_VERB_RE.test(raw) && REMIND_WORD_RE.test(raw);
}

// ── "Help me, until next week" — a chase, decided here ───────────────────────
// חיים, 2026-09-22: "…אני רוצה שעד שבוע הבא היא תהיה מוכנה תעזור לי בתזכורת".
// The owner's rule is that a deadline plus a request for help is a CHASE — one
// reminder a day until that day (domain/reminders.startChase) — and left to the
// model the sentence was read two ways: six samples in a row dated the errand
// for tomorrow and armed one reminder. The owner's answer (2026-09-24) was that
// this goes through code, so the reading happens here and brokerd arms it.
//
// Only a VERDICT travels, like the two above: which deadline, as a kind the
// server resolves against the person's own clock (domain/chase-deadline.js),
// and whether a clock time was said. Never the words.
//
// Measured before it was written, on every real inbound message on the box
// (861, 2026-09-24): 112 carry an ASK word, 10 carry "עד", ONE carries both and
// it is חיים's. The nine "עד"-only ones are hour ranges, a trip, a work shift
// and a "wake me every 3 minutes until I say I'm up" — tests/chase-deadline
// .test.js holds each of them, reworded, as a reading this must never make.
//
// Strict in three ways, because a false positive is a drum somebody never
// asked for and a miss is today's behaviour:
//   - the horizon must FOLLOW "עד" directly — "מ-9 עד 11" is an hour range,
//     and a bare number after it never reads as a date;
//   - a date written with a dot and no year is an hour ("עד 8.10") and is not
//     read at all — a slash, a year, a month's name or "ה-15" are;
//   - a message that names a DIFFERENT day for the reminder ("תזכיר לי מחר
//     להגיש עד סוף השבוע") is one reminder with a deadline, unless it also
//     says "every day" in so many words.
// `\b` is dead against Hebrew (rules/turns-and-replies.md); every boundary here
// is a Hebrew-letter lookaround, and "עד" may carry ו/ש/ה in front of it.
const HE = 'א-ת';
const CHASE_ASK_RE = /(תזכיר|תזכרי|תזכירי|להזכיר|תזכורת|תזכורות|תעזור|תעזרי|לעזור|עזרה|תנדנד|לנדנד|תציק|תדאג|תדאגי|תמשיך|תמשיכי|תרדוף|תרדפי|remind|nudge|chase)/iu;
const EVERY_DAY_RE = new RegExp(`(כל\\s+יום|כל\\s+בוקר|כל\\s+ערב|יומית|יומי(?![${HE}])|every\\s*day|daily)`, 'iu');
const UNTIL_RE = new RegExp(`(?:^|[^${HE}])[ושה]?עד(?![${HE}])\\s*(?:ל(?=[${HE}]))?`, 'gu');
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const HE_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const NOT_A_WEEKDAY_AFTER = `(?![${HE}])(?!\\s*(?:ימים|שבועות|חודשים|שעות|דקות|פעמים))`;
// Tried in order at the point right after "עד"; the first that matches wins.
const HORIZONS = [
  [new RegExp(`^(?:ה)?שבוע\\s+(?:ה)?בא(?![${HE}])`, 'u'), () => ({ kind: 'next_week' })],
  [new RegExp(`^(?:ה)?חודש\\s+(?:ה)?בא(?![${HE}])`, 'u'), () => ({ kind: 'next_month' })],
  [new RegExp(`^(?:סוף\\s+(?:ה)?שבוע|סופ"?ש)(?![${HE}])`, 'u'), () => ({ kind: 'end_of_week' })],
  [new RegExp(`^סוף\\s+(?:ה)?חודש(?![${HE}])`, 'u'), () => ({ kind: 'end_of_month' })],
  [new RegExp(`^מחרתיים(?![${HE}])`, 'u'), () => ({ kind: 'days', n: 2 })],
  [new RegExp(`^מחר(?![${HE}])`, 'u'), () => ({ kind: 'days', n: 1 })],
  [new RegExp(`^(?:יום\\s+)?(${HE_WEEKDAYS.join('|')})${NOT_A_WEEKDAY_AFTER}`, 'u'),
    (m) => ({ kind: 'weekday', weekday: HE_WEEKDAYS.indexOf(m[1]) })],
  [new RegExp(`^(?:ה[-־]?\\s*)?(\\d{1,2})\\s*(?:ב|ל)?(${HE_MONTHS.join('|')}|מרס)(?![${HE}])`, 'u'),
    (m) => ({ kind: 'date', day: Number(m[1]), month: m[2] === 'מרס' ? 3 : HE_MONTHS.indexOf(m[2]) + 1 })],
  [/^(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?(?!\d)/u, (m) => ({ kind: 'date', day: Number(m[1]), month: Number(m[2]) })],
  [/^(\d{1,2})\.(\d{1,2})\.\d{2,4}(?!\d)/u, (m) => ({ kind: 'date', day: Number(m[1]), month: Number(m[2]) })],
  [/^ה[-־]?\s*(\d{1,2})(?![\d:.])/u, (m) => ({ kind: 'date', day: Number(m[1]) })],
];
// A day for the REMINDER, said beside the deadline.
const OTHER_DAY_RE = new RegExp(`(?:^|[^${HE}])(?:[ו]?(?:מחר|מחרתיים|היום|הערב|בעוד)|ביום)(?![${HE}])`, 'u');
const NAMED_HOUR_RE = new RegExp(`(\\d{1,2}:\\d{2}|בשעה\\s*\\d|\\d{1,2}\\s*(?:בבוקר|בערב|בצהריים|בלילה)(?![${HE}])|\\d{1,2}\\s*(?:am|pm)\\b)`, 'iu');
const MAX_CHASE_CHARS = 600;

function chaseDeadline(text) {
  const raw = String(text || '').replace(REPLY_BLOCK_RE, ' ').replace(/[‎‏‪-‮]/g, '');
  if (!raw.trim() || raw.length > MAX_CHASE_CHARS) return null;
  if (!CHASE_ASK_RE.test(raw)) return null;
  for (const until of raw.matchAll(UNTIL_RE)) {
    const from = until.index + until[0].length;
    const rest = raw.slice(from);
    for (const [re, build] of HORIZONS) {
      const m = rest.match(re);
      if (!m) continue;
      const verdict = build(m);
      // Everything outside the "עד …" phrase is where a reminder day would be.
      const outside = raw.slice(0, until.index) + ' ' + raw.slice(from + m[0].length);
      if (OTHER_DAY_RE.test(outside) && !EVERY_DAY_RE.test(raw)) return null;
      return { ...verdict, namedHour: NAMED_HOUR_RE.test(outside) };
    }
  }
  return null;
}

// "מה פתוח לי?" — a question about their whole LIST, not about today. The turn
// context carries a today block, and a model answering this from it told the
// eval user "הכל נקי" with two undated to-dos on file — no tool called, in 1
// of 5 trials even with a hint naming the undated count (runs 84, 86, 87,
// 2026-09-24). brokerd drops the block from this turn instead, so there is no
// empty list left to misread. Measured on 879 real messages: 8 hits, every one
// a question about the list ("מה המשימות שלי?", "איזה משימות פתוחות?"), and
// the three that named a day ("…להיום?", "…של מחר") correctly not.
// A bare "מה פתוח" must be about THEM ("לי", "אצלי") or end the sentence —
// "מה פתוח עכשיו באזור" is about a shop.
const B = `(?<![${HE}])`;
const E = `(?![${HE}])`;
const OPEN_LIST_RE = new RegExp([
  `${B}מה\\s+(?:עוד\\s+)?פתוח(?:ים|ות)?(?=\\s*(?:לי|אצלי|עליי|עלי|לנו|אצלנו|עדיין)${E}|\\s*[?!.]*\\s*$)`,
  `${B}מה\\s+(?:יש\\s+)?על\\s+הפרק${E}`,
  `${B}(?:מה|איזה|אילו)\\s+(?:עוד\\s+)?(?:ה)?משימות${E}`,
  `${B}מה\\s+(?:יש\\s+)?(?:לי\\s+)?ב?רשימ(?:ה|ת\\s+(?:ה)?משימות)${E}`,
  `${B}מה\\s+נשאר\\s+לי${E}`,
  `${B}מה\\s+יש\\s+לי\\s+לעשות${E}`,
  `(?:what'?s|what\\s+is)\\s+(?:still\\s+)?open`,
  `\\bmy\\s+(?:open\\s+)?tasks\\b`,
  `\\bmy\\s+(?:to-?do|task)\\s+list\\b`,
].join('|'), 'iu');
// A day named anywhere makes it a question about that day, which the today
// block (or a tool) answers — never this verdict.
const A_DAY_RE = new RegExp(`${B}(?:[לו]?(?:היום|מחר|מחרתיים|הערב|אתמול|השבוע|בשבוע|לשבוע|בחודש|לחודש|ביומן|בבוקר|בערב|בצהריים)`
  + `|[בל]?(?:${HE_WEEKDAYS.join('|')}|סופ"?ש)|יום\\s+[${HE}]+|שבוע\\s+הבא)${E}`
  + `|\\b(?:today|tonight|tomorrow|this\\s+week|next\\s+week|calendar)\\b`, 'iu');
const MAX_OPEN_LIST_CHARS = 160;

function asksOpenList(text) {
  const raw = String(text || '').replace(REPLY_BLOCK_RE, ' ').replace(/[‎‏‪-‮]/g, '').trim();
  if (!raw || raw.length > MAX_OPEN_LIST_CHARS) return false;
  return OPEN_LIST_RE.test(raw) && !A_DAY_RE.test(raw);
}

// Which inbound events open a turn. Measured on OpenClaw 2026.8.1 (2026-09-06,
// olma-hook-probe): a WhatsApp DM fires `message:preprocessed` ~300ms after
// the inbound log line and `agent:bootstrap` a second later — and NEVER
// `message:received`, which this hook had listened for alone while fifteen
// real messages went by. Both are accepted; a message id seen once is not
// opened twice should a later gateway fire both.
const OPENING_ACTIONS = new Set(['received', 'preprocessed']);
const SEEN_MAX = 500;
const seen = new Map(); // messageId → true, insertion-ordered, bounded
function seenBefore(messageId) {
  if (!messageId) return false;
  if (seen.has(messageId)) return true;
  seen.set(messageId, true);
  if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
  return false;
}

// Exported for tests: `connect` is the one seam (net.connect in production).
function handle(event, { connect = net.connect, sock = SOCK } = {}) {
  if (!event || event.type !== 'message' || !OPENING_ACTIONS.has(event.action)) { trace({ skip: 'not-inbound', type: event && event.type, action: event && event.action }); return false; }
  const agentId = agentIdOf(event.sessionKey);
  if (!agentId) { trace({ skip: 'no-agent', sessionKey: String(event.sessionKey || '').slice(0, 40) }); return false; }
  const ctx = event.context || {};
  const meta = ctx.metadata || {};
  const messageId = ctx.messageId ? String(ctx.messageId) : null;
  if (seenBefore(messageId)) { trace({ skip: 'duplicate', agentId, action: event.action }); return false; }
  // `received` puts the sender's name under metadata; `preprocessed` flattens it.
  const senderName = meta.senderName || ctx.senderName;
  const params = {
    agentId,
    messageId,
    kind: isVoice(ctx) ? 'voice' : 'text',
    senderName: senderName ? String(senderName).slice(0, 80) : null,
    replyToId: replyToIdOf(ctx),
    // The transcript when there is one — a voice note that says only "תודה"
    // is the same exchange — and the envelope body otherwise.
    thanks: thanksOnly(ctx.transcript || ctx.body),
    // "stop reminding me" — brokerd stops every ladder that has spoken to them
    // in the last day and puts a 👍 on this message (domain/reminders
    // .stopRecentLadders). The verdict travels; the words do not.
    stopReminders: stopRemindersOnly(ctx.transcript || ctx.body),
    // "help me until next week" — brokerd arms a daily chase to that day on
    // the task this turn saves (domain/chase-deadline). A kind, never words.
    chase: chaseDeadline(ctx.transcript || ctx.body),
    // "מה פתוח לי?" — brokerd leaves the today block out of this turn, so
    // the answer comes from their list and not from an empty day.
    openList: asksOpenList(ctx.transcript || ctx.body),
    at: new Date(event.timestamp || Date.now()).toISOString(),
  };
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    // `ms` from the start and `connectMs` for when the socket opened, on every
    // line: the gap between them is the gateway's own stall, and what follows
    // `connectMs` is brokerd's.
    const started = Date.now();
    let connected = false;
    let connectMs = null;
    let socket;
    try { socket = connect(sock); } catch { return finish(false); }
    const timing = () => ({ ms: Date.now() - started, connected, ...(connectMs === null ? {} : { connectMs }) });
    const giveUp = () => { try { socket.destroy(); } catch { /* gone */ } trace({ agentId, outcome: 'timeout', ...timing() }); finish(false); };
    let t = setTimeout(giveUp, CONNECT_CAP_MS);
    socket.on('error', (e) => { clearTimeout(t); trace({ agentId, outcome: 'error', ...timing(), error: String(e && e.code || e).slice(0, 40) }); finish(false); });
    socket.on('connect', () => {
      connected = true;
      connectMs = Date.now() - started;
      clearTimeout(t);
      t = setTimeout(giveUp, TIMEOUT_MS);
      socket.write(JSON.stringify({ id: 1, method: 'turn_open', params }) + '\n');
    });
    // Resolve BEFORE ending the socket: a synchronous 'close' would otherwise
    // settle the promise as a failure that already succeeded.
    socket.on('data', (d) => { clearTimeout(t); trace({ agentId, outcome: 'sent', ...timing(), replyTo: Boolean(params.replyToId), thanks: params.thanks, reply: String(d).slice(0, 80) }); finish(true); try { socket.end(); } catch { /* gone */ } });
    socket.on('close', () => { clearTimeout(t); finish(done ? undefined : false); });
  });
}

module.exports = handle;
module.exports.default = handle;
module.exports.handle = handle;
module.exports.agentIdOf = agentIdOf;
module.exports.isVoice = isVoice;
module.exports.replyToIdOf = replyToIdOf;
module.exports.thanksOnly = thanksOnly;
module.exports.stopRemindersOnly = stopRemindersOnly;
module.exports.chaseDeadline = chaseDeadline;
module.exports.asksOpenList = asksOpenList;
module.exports._resetSeen = () => seen.clear();
