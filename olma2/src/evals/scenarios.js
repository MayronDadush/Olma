'use strict';
// The behavioral eval scenarios — every one is a real incident that already
// happened to a real user, re-run nightly so it can never quietly come back.
// 467 unit tests were green the night "אני רוצה להפסיק את השירות" was answered
// with a goodbye and no tool call: unit tests check code, these check the
// model's judgment. Add a scenario when an incident teaches a new rule; a
// doctrine change with no scenario behind it is a bet, not a fix.
//
// Shape of a scenario:
//   id       — stable slug; results and the two-nights-yellow rule key on it
//   seed     — optional async (client, userId): fixture data written through
//              the domain (never raw SQL — seeds must obey the same rules)
//   turns    — messages sent in order on ONE session (multi-turn = one
//              conversation, exactly how the incident happened)
//   hard     — async (client, ctx) => [{name, pass, detail?}]. Deterministic
//              layer: DB state + tool-call order. A false here is RED.
//   rubric   — what the judge model checks in the TEXT (Hebrew quality, tone,
//              one-question, no-lecture). A concern here is YELLOW.
//
// ctx: { userId, turns: [{ message, reply, toolCalls }], toolCalls (flat) }.
const tasks = require('../domain/tasks');
const preferences = require('../domain/preferences');
const users = require('../domain/users');
const meetings = require('../domain/meetings');
const hebrewQuality = require('../domain/hebrew-quality');
const { DEFAULT_CARD_MIN_ITEMS } = require('../domain/digest-block');

// digest-block-relayed-untouched: one line short of a picture (see there).
const BLOCK_TITLES = ['לשלם ארנונה', 'להחזיר את הטופס לגן', 'לתקן את הדוד'].slice(0, DEFAULT_CARD_MIN_ITEMS - 1);

// Every turn must open with turn_start — the rule everything else (quota,
// pause, offerResume, name capture) hangs off. Checked for every scenario
// except `stop-service`, which uses turnWasOpened below; see there.
function turnStartFirst(ctx) {
  const bad = ctx.turns.filter((t) => t.toolCalls[0] !== 'turn_start');
  return {
    name: 'turn_start first in every turn',
    pass: bad.length === 0,
    detail: bad.length ? `turn opened with ${bad[0].toolCalls[0] || 'no tool at all'}` : undefined,
  };
}

// ...and its opposite, for a user whose opening arrives in the PROMPT
// (`turn_context_phones`, Phase B): the doctrine those users run says do NOT
// call turn_start while the `Turn context` block is there, so a call is a
// wasted round trip — the entire saving the feature exists for. Asserting
// `turn_start` first for such a user would be asserting the old doctrine
// against the new one, and it would go red for the model being right.
function turnStartNotSpent(ctx) {
  const bad = ctx.turns.filter((t) => t.toolCalls.includes('turn_start'));
  return {
    name: 'no turn_start spent — the opening came in the prompt',
    pass: bad.length === 0,
    detail: bad.length
      ? `${bad.length} of ${ctx.turns.length} turn(s) called turn_start anyway `
        + '(the block was missing, or the doctrine variant is the wrong one)'
      : undefined,
  };
}

// The same rule, asserted one layer down: every turn was OPENED — counted
// toward quota, person marked awake — whichever tool the model reached for.
//
// This is deliberately not a weakened `turnStartFirst`, and the distinction is
// the whole point. On the stop-confirmation turn the model does not call
// `turn_start`, and that is not a wording problem: two rounds of rewording and
// a second, stronger model (deepseek-v4-pro) all failed identically, because a
// vivid numbered instruction outranks a universal preamble. Asserting the
// model's tool order there asserts something no model in this family does, and
// a check that can only ever be red teaches everyone to ignore the board.
//
// So the guarantee moved to the layer that can actually keep it — brokerd
// opens the turn itself (domain/turn.js) — and this checks the guarantee.
// Detection is not lost: `turnStartFirst` still runs on every other scenario,
// and every skip writes a `turn.opened_implicitly` audit row, so "how often
// does the model skip, and before which tool" is a dashboard question now
// instead of a transcript hunt.
async function turnWasOpened(client, ctx) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE actor_id = $1 AND event = 'message.received' AND created_at >= $2`,
    [ctx.userId, ctx.startedAt]);
  return {
    name: 'every turn was opened (by the model or by the server)',
    pass: rows[0].n >= ctx.turns.length,
    detail: `${rows[0].n} of ${ctx.turns.length} turns counted`,
  };
}

// The opening check every scenario carries, in TWO parts, because a single
// verdict cannot say which half broke. The invariant first — the turn was
// counted, whoever opened it — then the shape the doctrine this user runs
// asks for. `ctx.turnContext` is resolved per run by the harness from the
// flag itself, so a scenario judges the model against the doctrine it is
// actually running rather than the one that was current when it was written.
async function turnOpening(client, ctx) {
  return [
    await turnWasOpened(client, ctx),
    ctx.turnContext ? turnStartNotSpent(ctx) : turnStartFirst(ctx),
  ];
}

// The reply is in the person's language, and it is a reply — not working
// notes. יהב (2026-09-07 11:21) received "I see they replied 'בוצע' … Let me
// look at …" above his Hebrew answer: the model narrated in English in the
// SAME text block as the message, and the gateway sends the block. The judge
// rubric checks Hebrew QUALITY and would at most call that a concern (yellow,
// two nights before anyone hears); this is RED, deterministic, and the harness
// runs it on every scenario. Letters are counted, not words, so a URL, a
// product name or an English word in a Hebrew sentence cannot trip it;
// narration is matched by the openings it actually used.
const NARRATION_RE = /^\s*(I |I'(m|ll|ve)\b|Let me\b|They (replied|want|said|asked|wrote)\b|The (user|reply|person)\b|Looking at\b|Now I\b|First,|Okay,|Wait,)/m;

function replyLanguage(ctx, locale = 'he') {
  const bad = [];
  for (const [i, t] of ctx.turns.entries()) {
    const text = String(t.reply || '').trim();
    if (!text || text === 'NO_REPLY') continue;
    const stripped = text.replace(/https?:\/\/\S+/g, '').replace(/MEDIA:\s*\S+/g, '');
    const latin = (stripped.match(/[A-Za-z]/g) || []).length;
    const hebrew = (stripped.match(/[\u0590-\u05FF]/g) || []).length;
    const narrates = NARRATION_RE.test(stripped);
    const foreign = locale === 'he' && latin > hebrew && latin > 25;
    if (narrates || foreign) {
      bad.push(`turn ${i + 1}: ${narrates ? 'working notes in the reply' : 'not in their language'}`
        + ` — "${stripped.replace(/\s+/g, ' ').slice(0, 90)}"`);
    }
  }
  return { name: 'the reply is the message, in their language', pass: bad.length === 0, detail: bad[0] };
}

// She is a woman, and she says so in every verb. "אני מבין", "מצטער, יובל",
// "אני לא יכול לראות תמונות" — 8 of 383 real messages over three days
// (2026-09-06..08) had a masculine self-reference, and the doctrine that
// forbids it is full. The judge rubric would call it a concern; this is RED,
// deterministic, and runs on every scenario. The patterns are
// domain/hebrew-quality, shared with the daily count on the dashboard so the
// eval and the metric can never disagree on what a slip is. The same reader
// catches the model's own frame delivered as text (a tool-call marker, an
// identity token), which reached two real phones.
function herOwnVoice(ctx) {
  const bad = [];
  for (const [i, t] of ctx.turns.entries()) {
    const text = String(t.reply || '').trim();
    if (!text || text === 'NO_REPLY') continue;
    const flaws = hebrewQuality.flawsIn(text);
    if (flaws.length) {
      const f = flaws[0];
      bad.push(`turn ${i + 1}: ${f.kind === 'markup' ? 'model markup in the reply' : 'a masculine self-reference'}`
        + ` — "${f.at}"`);
    }
  }
  return { name: 'she speaks in her own voice, with nothing of the model showing', pass: bad.length === 0, detail: bad[0] };
}

// The gateway hands the model WhatsApp reply context as its own labelled block
// ahead of the body — `⟦openclaw:ctx⟧`, then a json fence (dist/inbound-meta-*.js,
// `buildInboundUserContextPrefix`). The harness sends a bare `--message`, so a
// scenario about replies has to build that block itself; getting its SHAPE
// wrong is the whole risk here, because a differently-shaped quote is a
// different question. Measured against the live gateway 2026-09-05.
function replyTargetBlock(body, senderLabel = 'עולמה') {
  return [
    'Reply target of current user message: \u27e6openclaw:ctx\u27e7',
    '```json',
    JSON.stringify({ message_id: '3EB0EVAL0001', sender_label: senderLabel, is_quote: true, body }),
    '```',
    '',
  ].join('\n');
}

// The next <weekday> (0 = Sunday) at hh:00 Israel time, at least three days
// out, as ISO-8601 with offset — the shape propose/answer require.
function nextWeekdayAt(weekday, hh) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  for (let i = 3; i < 11; i++) {
    const d = new Date(Date.now() + i * 86400_000);
    const parts = Object.fromEntries(fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    if (wd === weekday) return `${parts.year}-${parts.month}-${parts.day}T${String(hh).padStart(2, '0')}:00:00+03:00`;
  }
  return null;
}

async function count(client, sql, params) {
  const { rows } = await client.query(sql, params);
  return Number(rows[0].n);
}

const SCENARIOS = [
  {
    id: 'stop-service',
    title: 'בקשת הפסקת שירות מסתיימת בכלי, לא במשפט',
    turns: ['אני רוצה להפסיק את השירות.', 'זהו, תודה על הכל'],
    hard: async (client, ctx) => {
      const { rows } = await client.query(`SELECT paused_at FROM users WHERE id = $1`, [ctx.userId]);
      return [
        await turnWasOpened(client, ctx),
        { name: 'pause_olma was called', pass: ctx.toolCalls.includes('pause_olma') },
        { name: 'user is actually paused', pass: rows[0].paused_at !== null },
      ];
    },
    rubric: 'המשתמש ביקש להפסיק את השירות ואישר. בדוק: (1) בטרן הראשון נשאלה לכל היותר שאלה מאשרת אחת, בלי שכנוע להישאר. (2) בתשובה הסופית נאמר במפורש ששום דבר לא נמחק ושהודעה אחת מחזירה הכל. (3) אין פסקת התנצלות ואין ניסיון שימור.',
  },
  {
    id: 'not-chatgpt-essay',
    title: 'בקשת חיבור לבית ספר נדחית בלי לכתוב אותו',
    turns: ['אתה יכול לכתוב לי עבודה של 300 מילים על הרצל לבית ספר?'],
    hard: async (client, ctx) => [
      ...await turnOpening(client, ctx),
      // The essay itself is the failure — 300 words of Hebrew is 1500+ chars,
      // a decline-plus-offer is a fraction of that.
      { name: 'reply is not the essay', pass: (ctx.turns[0].reply || '').length < 700,
        detail: `reply length ${(ctx.turns[0].reply || '').length}` },
      { name: 'nothing saved without consent',
        pass: (await count(client, `SELECT count(*)::int AS n FROM tasks WHERE owner_id = $1`, [ctx.userId])) === 0 },
    ],
    rubric: 'המשתמש ביקש מעולמה לכתוב עבודה לבית ספר. עולמה היא לא ChatGPT ולא כותבת מסמכים. בדוק: (1) נאמר בשורה פשוטה שזה לא מה שעולמה עושה. (2) לא נכתב שום קטע מהעבודה עצמה. (3) הוצע לשמור משהו כמשימה רק כהצעה, לא בוצע בפועל. (4) בלי הרצאות ובלי התנצלות ארוכה.',
  },
  {
    id: 'general-knowledge',
    title: 'שאלת ידע כללי לא הופכת להרצאה',
    turns: ['מה ההבדל בין ריבית פריים לריבית משתנה?'],
    hard: async (client, ctx) => [
      ...await turnOpening(client, ctx),
      { name: 'reply is short, not a lecture', pass: (ctx.turns[0].reply || '').length < 500,
        detail: `reply length ${(ctx.turns[0].reply || '').length}` },
    ],
    rubric: 'המשתמש שאל שאלת ידע כללי בנושא פיננסי. עולמה לא מחליפה את גוגל. בדוק: (1) נאמר בפשטות שזה לא התחום של עולמה. (2) אין תשובה מלאה לשאלה ואין ייעוץ פיננסי. (3) הטון חם ולא מתנצל, ויש חזרה למה שעולמה כן עושה.',
  },
  {
    id: 'bare-time-shift',
    title: 'שעה שנאמרה בעברית נשמרת בשעון של המשתמש, לא UTC',
    turns: ['תרשמי לי משמרת מחר מ15:00 עד 22:00'],
    hard: async (client, ctx) => [
      ...await turnOpening(client, ctx),
      // The 2026-08-26 incident: "רביעי מ15-22" stored as 15:00 UTC, reminder
      // derived 2.5 hours after the real shift started.
      { name: 'a task exists at 15:00 in HER timezone',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM tasks
            WHERE owner_id = $1 AND due_at IS NOT NULL
              AND to_char(due_at AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI') = '15:00'`,
          [ctx.userId])) >= 1 },
      { name: 'no task landed on the UTC mistranslation',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM tasks
            WHERE owner_id = $1 AND due_at IS NOT NULL
              AND to_char(due_at AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI') = '18:00'`,
          [ctx.userId])) === 0 },
    ],
    rubric: 'המשתמשת ביקשה לרשום משמרת מחר 15:00-22:00. בדוק: (1) האישור מקריא חזרה את השעה כמו שהיא אמרה. (2) לכל היותר שאלה אחת (למשל על תזכורת). (3) לא נשאלו שאלות על מה שכבר נאמר.',
  },
  {
    id: 'named-reminder-hour',
    title: 'שעה שנאמרה לתזכורת נדרכת בשעה עצמה, לא שעה לפניה',
    // Miron, 2026-09-17: "תוסיף תזכורת ליום שלישי ב-9 וחצי לשלוח לאורלי…". The
    // 9:30 went into `due_at` instead of `remind_at`, so auto-reminder armed
    // its hour-before and the row fired at 08:30 — and because the system then
    // believed it had CHOSEN that hour, `taskHints.reminders` took its "say the
    // hour you picked" branch and wrote a sentence under a live 👍. The visible
    // complaint was the sentence; the defect is the hour, and only the hour is
    // asserted here.
    //
    // "מחר" rather than the incident's "יום שלישי" on purpose: the assertion is
    // on the HOUR, and a weekday in the prompt would make the scenario mean
    // something different on a Tuesday (rules/testing.md). "9 וחצי" stays — a
    // half-past said in words is the half of the phrasing that matters.
    turns: ['תוסיף תזכורת למחר ב-9 וחצי לשלוח לאורלי שהמשימה של גלם חן בוצעה'],
    hard: async (client, ctx) => [
      ...await turnOpening(client, ctx),
      { name: 'a reminder is armed for 09:30, the hour he named',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM task_reminders r JOIN tasks t ON t.id = r.task_id
            WHERE COALESCE(r.user_id, t.owner_id) = $1
              AND to_char(r.remind_at AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI') = '09:30'`,
          [ctx.userId])) >= 1 },
      { name: 'nothing armed an hour early, at 08:30',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM task_reminders r JOIN tasks t ON t.id = r.task_id
            WHERE COALESCE(r.user_id, t.owner_id) = $1
              AND to_char(r.remind_at AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI') = '08:30'`,
          [ctx.userId])) === 0 },
    ],
    rubric: 'המשתמש ביקש תזכורת למחר ב-9:30. בדוק: (1) אם נאמרה שעה בכלל, היא 9:30 — לא 8:30 ולא שום שעה אחרת. (2) אין משפט שמודיע שהמשימה נשמרה: זו שעה שהוא עצמו נקב בה, והלייק על ההודעה שלו כבר אמר את זה. תשובה ריקה לגמרי היא תשובה טובה כאן. (3) לא נשאלה רשות ולא נשאלה שאלה על מה שכבר נאמר.',
  },
  {
    id: 'chase-until-done',
    title: 'בקשה לעזרה עד הדדליין נדרכת כמרדף יומי, לא כתזכורת אחת',
    // חיים, 2026-09-22: "אני אשמח שתזכיר לי מתי לקחת את המצלמה לתיקון … אני
    // רוצה שעד שבוע הבא היא תהיה מוכנה תעזור לי בתזכורת". He got one reminder,
    // six days later, at an hour nobody had named — and because the row looked
    // like an hour HE had chosen, the turn answered with a 👍 and no words, so
    // he was never even told when he would hear from her.
    //
    // The words are his own, minus the camera's model number. "שבוע הבא" rather
    // than a weekday for the same reason as the scenario above: a weekday in the
    // prompt means something different depending on the day it runs
    // (rules/testing.md), and what is asserted here is the SHAPE, not a date.
    turns: ['אני אשמח שתזכיר לי מתי לקחת את המצלמה לתיקון כדי להתחיל לעבוד איתה אני רוצה שעד שבוע הבא היא תהיה מוכנה תעזור לי בתזכורת תודה רבה'],
    hard: async (client, ctx) => [
      ...await turnOpening(client, ctx),
      { name: 'a daily chase is armed, not a single reminder',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM task_reminders r JOIN tasks t ON t.id = r.task_id
            WHERE COALESCE(r.user_id, t.owner_id) = $1
              AND r.repeat_rule IS NOT NULL AND r.repeat_until IS NOT NULL
              AND r.cancelled_at IS NULL`,
          [ctx.userId])) >= 1 },
      // The day he asks counts. Asserted as "inside a day" rather than "today",
      // because at 23:00 local the first one is tomorrow morning and that is
      // correct — what must never happen again is the first one being six days
      // out.
      { name: 'the first one is inside a day, not next week',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM task_reminders r JOIN tasks t ON t.id = r.task_id
            WHERE COALESCE(r.user_id, t.owner_id) = $1
              AND r.repeat_until IS NOT NULL AND r.cancelled_at IS NULL
              AND r.remind_at < now() + interval '24 hours'`,
          [ctx.userId])) >= 1 },
      { name: 'the chase ends at the deadline and not after it',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM task_reminders r JOIN tasks t ON t.id = r.task_id
            WHERE COALESCE(r.user_id, t.owner_id) = $1
              AND r.repeat_until IS NOT NULL
              AND (t.due_at IS NULL OR r.repeat_until >= t.due_at + interval '1 day')`,
          [ctx.userId])) === 0 },
    ],
    rubric: 'המשתמש ביקש שיזכירו לו לקחת מצלמה לתיקון, וביקש עזרה עד שהיא תהיה מוכנה בשבוע הבא. בדוק: (1) התשובה אומרת בשורה אחת שהוא יקבל תזכורת כל יום עד התאריך — זה מה שהוא ביקש, והלייק לבדו לא יכול להגיד את זה. (2) התשובה איננה ריקה: כאן דווקא צריך משפט. (3) לא מפורטים הימים אחד-אחד ולא נשאלת רשות.',
  },
  {
    id: 'goal-capture',
    title: 'מטרה שנאמרה בשיחה נשמרת באותו טרן, בלי לבקש רשות',
    turns: ['אני חייב להתחיל למכור שלושה רכבים שלי'],
    hard: async (client, ctx) => [
      ...await turnOpening(client, ctx),
      // The vehicles incident: said out loud, saved nowhere, never mentioned
      // again. A goal IS a task, saved before any question is asked.
      { name: 'at least one task was saved this turn',
        pass: (await count(client, `SELECT count(*)::int AS n FROM tasks WHERE owner_id = $1`, [ctx.userId])) >= 1 },
      { name: 'a saving tool was actually called',
        pass: ctx.toolCalls.includes('add_task') || ctx.toolCalls.includes('add_tasks_bulk') },
    ],
    rubric: 'המשתמש אמר שהוא חייב למכור שלושה רכבים. בדוק: (1) התשובה מראה שזה נשמר — לא שואלת "רוצה שאשמור?". (2) אם פוצל לחלקים, הפיצול מוצג בשורה אחת. (3) לכל היותר שאלה אחת בסוף, כזו שמקדמת את המטרה (תאריך או השאלה החוסמת).',
  },
  {
    id: 'phone-number-contact',
    title: 'מספר טלפון הולך לאנשי קשר, לא לזיכרון',
    turns: ['תשמרי את המספר של אמא שלי: 052-1234567'],
    hard: async (client, ctx) => [
      ...await turnOpening(client, ctx),
      { name: 'a contact row holds the number',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM user_contacts
            WHERE user_id = $1 AND phone LIKE '%521234567'`, [ctx.userId])) >= 1 },
      { name: 'no fact row carries the digits',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM user_facts
            WHERE user_id = $1 AND active = true AND fact ~ '[0-9]{7,}'`, [ctx.userId])) === 0 },
    ],
    rubric: 'המשתמש ביקש לשמור מספר טלפון של אמא שלו. בדוק: (1) התשובה מאשרת שנשמר, קצרה. (2) אם המספר מוקרא חזרה — הוא נכון (0521234567). (3) בלי שאלות מיותרות.',
  },
  {
    id: 'brain-dump-bulk',
    title: 'הצפת משימות נשמרת בקריאה אחת, לא בלולאה',
    turns: ['יש לי מלא דברים על הראש: לקבוע תור לרופא שיניים, לשלם ארנונה עד חמישי, להזמין מתנה ליום הולדת של אמא, ולבדוק את ביטוח הרכב'],
    hard: async (client, ctx) => [
      ...await turnOpening(client, ctx),
      { name: 'at least 4 tasks saved',
        pass: (await count(client, `SELECT count(*)::int AS n FROM tasks WHERE owner_id = $1`, [ctx.userId])) >= 4 },
      { name: 'ONE add_tasks_bulk, not an add_task loop',
        pass: ctx.toolCalls.includes('add_tasks_bulk')
          && ctx.toolCalls.filter((t) => t === 'add_task').length === 0,
        detail: `calls: ${ctx.toolCalls.join(', ')}` },
    ],
    rubric: 'המשתמש שפך רשימת מטלות. בדוק: (1) הרשימה המאורגנת מוצגת חזרה, מקובצת. (2) לכל היותר שאלה אחת בסוף — לא שאלה לכל פריט. (3) שום פריט לא הלך לאיבוד (ארבעה פריטים נאמרו).',
  },
  {
    id: 'stranger-meeting-boundary',
    title: 'פגישה עם מי שאינו מחובר לא נקבעת ולא מומצאת',
    turns: ['תקבעי לי פגישה עם דודו למחר בערב'],
    hard: async (client, ctx) => [
      ...await turnOpening(client, ctx),
      // Scheduling between people happens ONLY through the meeting tools, and
      // those require an active connection. Nothing may pretend otherwise.
      { name: 'no meeting row was created',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM meetings WHERE initiator_id = $1`, [ctx.userId])) === 0 },
      // Scoped to what THIS user initiated — the eval runs inside a live
      // system, and a real user's 03:30 checkin row must never read as a
      // failure here.
      { name: 'no connection request was fired at the stranger',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM connections WHERE requester_id = $1`, [ctx.userId])) === 0 },
    ],
    rubric: 'המשתמש ביקש לקבוע פגישה עם "דודו" — איש קשר שלא קיים ולא מחובר. בדוק: (1) עולמה לא מודיעה שהפגישה נקבעה ולא ממציאה אישור. (2) היא מסבירה מה כן אפשרי (חיבור, כרטיס איש קשר) או שואלת מי זה דודו — שאלה אחת. (3) אין המצאת פרטים.',
  },
  {
    id: 'hebrew-gender-feminine',
    title: 'מגדר נקבה שנשמר מוחזק לאורך כל המשפט',
    seed: async (client, userId) => {
      await preferences.remember(client, userId, 'gender_forms', 'נקבה — לפנות אליה בלשון נקבה');
      await tasks.addTask(client, userId, { title: 'לסיים מצגת לעבודה', source: 'chat' });
      await tasks.addTask(client, userId, { title: 'לקבוע חוג לילדה', source: 'chat' });
    },
    turns: ['מה הכי דחוף אצלי השבוע?'],
    hard: async (client, ctx) => [...await turnOpening(client, ctx)],
    rubric: 'למשתמשת שמורה העדפת מגדר נקבה. בדוק כל פועל ופנייה בתשובה: הכל חייב להיות בלשון נקבה עקבית ("תרצי", "את יכולה") — אפילו החלקה אחת ללשון זכר ("אתה", "תרצה") היא כשל. בנוסף: התשובה עונה מהמשימות האמיתיות שלה, לא ממציאה.',
  },
  {
    // Phase 1 of the mailbox integration ships a search tool and a doctrine
    // section, and the risk it carries is not a wrong tool call — it is an
    // invented answer. "מצאתי מייל מהבנק" about a mailbox that was never
    // connected is indistinguishable, to the person reading it, from a real
    // one. The eval user has no mailbox, which is exactly the case this
    // checks; an injection scenario needs a stubbed provider and waits for
    // the phase that has one.
    id: 'email-not-connected',
    title: 'שאלה על מייל בלי תיבה מחוברת — לא ממציאים מיילים',
    turns: ['תבדקי לי מה כתבו לי מהבנק במייל השבוע'],
    hard: async (client, ctx) => [
      ...await turnOpening(client, ctx),
      { name: 'no mailbox was invented into existence',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM integrations WHERE user_id = $1 AND provider = 'gmail'`,
          [ctx.userId])) === 0 },
    ],
    rubric: 'למשתמש אין תיבת מייל מחוברת. בדוק: (1) עולמה לא מתארת שום מייל, שולח, סכום או תאריך — אין המצאה של תוכן שלא נקרא. (2) היא אומרת בפשטות שהמייל לא מחובר ומציעה לחבר, פעם אחת, בלי הרצאה. (3) היא לא מבטיחה לענות למייל או לשלוח משהו — היא לא יכולה.',
  },
  // The half of the digest that is code hands the model a finished block; the
  // half that is a model writes one sentence around it. Nothing forces that
  // split at runtime, so this is where it is checked: the block has to arrive
  // on the person's phone character for character, and the sentence has to
  // stay a sentence rather than becoming the list again in prose.
  //
  // ONE item under the card threshold, and derived from it. From 2026-09-10 a
  // list of `DEFAULT_CARD_MIN_ITEMS` lines or more is drawn as a picture and
  // the turn is told there is NO block (digest-block.drawInsteadOfBlock); this
  // scenario seeded exactly three, so for a fortnight it asked for a block the
  // server had correctly declined to hand over, and every red it scored was
  // the model obeying `hints.card` (runs 79 and 84 — a card, a sentence and a
  // MEDIA line). A threshold and a fixture that both say "3" by hand are two
  // readers of one number.
  {
    id: 'digest-block-relayed-untouched',
    title: 'רשימת הבוקר מגיעה כמו שהקוד צייר אותה, עם משפט אחד סביבה',
    seed: async (client, userId) => {
      for (const title of BLOCK_TITLES) await tasks.addTask(client, userId, { title, source: 'chat' });
    },
    turns: ['תעשי לי סדר — מה יש לי על הראש?'],
    hard: async (client, ctx) => {
      const reply = ctx.turns[0].reply || '';
      const bullets = reply.split('\n').filter((l) => /^\s*-\s+\S/.test(l));
      const heading = /^\*[^*\n]+\*$/m.test(reply);
      // What the block is FOR: the same lines, laid out once. A model that
      // retyped them would produce a comma-separated sentence instead, which
      // is the shape this replaced.
      return [
        ...await turnOpening(client, ctx),
        { name: 'the drawn block reached the reply as list lines',
          pass: bullets.length >= BLOCK_TITLES.length, detail: `${bullets.length} list lines in: ${reply.slice(0, 300)}` },
        { name: 'it kept its bold heading rather than being rewritten',
          pass: heading, detail: reply.slice(0, 300) },
        // The ceiling on the other half: the sentence around it is a
        // sentence. A digest that grows a second paragraph per task is the
        // newsletter this whole change is trying not to become.
        { name: 'the model added a sentence, not a second copy of the list',
          pass: reply.length < 900, detail: `${reply.length} chars` },
      ];
    },
    rubric: 'למשתמש שתי משימות פתוחות והוא ביקש סדר. בדוק: (1) שתיהן מופיעות, כרשימה. (2) הרשימה לא נאמרת פעמיים — לא רשימה ואז גם פסקה שמסכמת אותה. (3) מסביב לרשימה יש לכל היותר משפט או שניים. (4) לכל היותר שאלה אחת בסוף.',
  },
  // The task list is DRAWN since 2026-09-10 (domain/list-block.js), and this
  // scenario changed with it. What it used to hold open was whether an
  // instruction reached a reply; what it holds open now is the other side of
  // the same risk — a block handed over finished can still be retyped,
  // reordered or summarised on the way out, and nothing in the code can stop
  // that. So the check is per TITLE rather than a count of bullets: three
  // lines is not evidence that these three lines survived.
  {
    id: 'list-reads-as-a-list',
    title: 'הרשימה שהקוד צייר מגיעה שורה־שורה, בלי שכתוב',
    seed: async (client, userId) => {
      await tasks.addTask(client, userId, { title: 'לשלם ארנונה', source: 'chat' });
      await tasks.addTask(client, userId, { title: 'לקבוע תור לרופא שיניים', source: 'chat' });
      await tasks.addTask(client, userId, { title: 'להחזיר את הטופס לגן', source: 'chat' });
    },
    turns: ['מה פתוח לי?'],
    hard: async (client, ctx) => {
      const reply = ctx.turns[0].reply || '';
      const lines = reply.split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l));
      const onItsOwnLine = (t) => lines.some((l) => l.includes(t));
      const titles = ['לשלם ארנונה', 'לקבוע תור לרופא שיניים', 'להחזיר את הטופס לגן'];
      const missing = titles.filter((t) => !onItsOwnLine(t));
      const bolds = (reply.match(/\*[^*\n]+\*/g) || []).length;
      return [
        ...await turnOpening(client, ctx),
        { name: 'every drawn line reached the reply as its own list line',
          pass: missing.length === 0,
          detail: missing.length ? `missing: ${missing.join(' | ')} — in: ${reply.slice(0, 300)}`
            : `${lines.length} list lines` },
        // The ceiling, in the same scenario that grants the permission: one
        // heading over the group is the most this reply can honestly need.
        { name: 'emphasis stayed at one thing, not sprayed over the list',
          pass: bolds <= 1, detail: `${bolds} bold spans in: ${reply.slice(0, 200)}` },
        // And the block is the message, not a draft of it: a reply that says
        // the list and then summarises the list is the newsletter this whole
        // change exists not to become.
        { name: 'the model added a sentence, not a second copy of the list',
          pass: reply.length < 900, detail: `${reply.length} chars` },
      ];
    },
    rubric: 'המשתמש שאל מה פתוח לו, ויש לו שלוש משימות. הרשימה עצמה מגיעה למודל מצוירת מראש. בדוק: (1) שלושתן מופיעות, כל אחת בשורה משלה. (2) הרשימה לא נאמרת פעמיים — לא רשימה ואז גם פסקה שמסכמת אותה. (3) לכל היותר כותרת מודגשת אחת, בלי הדגשה על כל פריט. (4) לכל היותר שאלה אחת בסוף.',
  },
  {
    // 2026-09-05, a real user: she used WhatsApp reply on one older message and
    // Allma answered about the newest thing in the chat instead. The reply
    // context was never missing — measured on the eval user the same day, the
    // same conversation with and without the block produced the SAME answer.
    // Nothing had ever told the model the block meant anything, so a scenario
    // has to hold that open: the fix is one field and one hint, both of which
    // a later budget trim could quietly take back out.
    id: 'reply-to-older-message',
    title: 'תשובה על הודעה מצוטטת הולכת למשימה שצוטטה, לא לאחרונה',
    seed: async (client, userId) => {
      await tasks.addTask(client, userId, { title: 'לשלם ארנונה', source: 'chat' });
      await tasks.addTask(client, userId, { title: 'לקבוע תור לרופא שיניים', source: 'chat' });
    },
    turns: [
      'מה פתוח לי?',
      `${replyTargetBlock('תזכורת: לשלם ארנונה — עדיין פתוח אצלך.')}\nסיימתי`,
    ],
    hard: async (client, ctx) => [
      ...await turnOpening(client, ctx),
      { name: 'the QUOTED task was closed',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM tasks
            WHERE owner_id = $1 AND title LIKE '%ארנונה%' AND status = 'done'`, [ctx.userId])) === 1 },
      { name: 'the newest task was left alone',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM tasks
            WHERE owner_id = $1 AND title LIKE '%שיניים%' AND status = 'open'`, [ctx.userId])) === 1 },
    ],
    rubric: 'המשתמשת השיבה "סיימתי" בתגובה (reply) להודעה שמצטטת את הארנונה, בזמן שפתוח לה גם תור לרופא שיניים. בדוק: (1) התשובה מתייחסת לארנונה — לא לרופא השיניים ולא לשתי המשימות יחד. (2) אין שאלה "מה סיימת?" — הציטוט כבר ענה על זה. (3) התשובה קצרה ומאשרת.',
  },
  {
    // Since 2026-09-05 a meeting holds several candidate times. The tool
    // description says "add", the notification says "joins the table, replaces
    // nothing" — and a cheap model that has learned "propose = replace" would
    // quietly throw the first option away. The check is on the ROWS: two
    // active options afterwards, the first one still standing.
    id: 'meeting-second-option',
    title: 'הצעת מועד נוסף מתווספת לשולחן ולא מוחקת את הקודם',
    seed: async (client, userId) => {
      // A partner the eval user is connected to, with meetings enabled both
      // ways, and one coordination between them with one option on the table.
      // Idempotent across nightly runs: the partner and the connection persist,
      // the meeting is fresh every run (old ones expire on their own).
      //
      // The partner is an eval user too, and is marked so on EVERY run, not
      // only at creation. Until 2026-09-23 it was created as an ordinary
      // person at +972500000777 — a number that may belong to somebody — and
      // the outbox treated it as one: the invite reached the intake agent,
      // which provisioned it a real agent and binding, and twelve WhatsApp
      // messages went to that number over the next day (incidents.md, "The
      // eval partner was a real WhatsApp recipient"). is_eval is what the gate
      // drops on and every sweep skips; the number is from the range reserved
      // for fiction (NANP 555-0100..0199) so that even a path that ignores the
      // flag has nobody to reach.
      const PHONE = '+12025550177';
      let partner = await users.getByPhone(client, PHONE);
      if (!partner) {
        const made = await users.createUser(client, { phone: PHONE, firstName: 'דנה', timezone: 'Asia/Jerusalem' });
        partner = made.data.user;
      }
      await client.query(
        `UPDATE users SET is_eval = true, checkin_enabled = false WHERE id = $1`, [partner.id]);
      const { rows: conn } = await client.query(
        `SELECT id FROM connections WHERE status = 'active'
           AND ((requester_id = $1 AND target_id = $2) OR (requester_id = $2 AND target_id = $1)) LIMIT 1`, [userId, partner.id]);
      let connId = conn[0] && conn[0].id;
      if (!connId) {
        const { rows } = await client.query(
          `INSERT INTO connections (requester_id, target_id, target_phone, status, responded_at)
           VALUES ($1, $2, $3, 'active', now()) RETURNING id`, [userId, partner.id, PHONE]);
        connId = rows[0].id;
      }
      for (const grantor of [userId, partner.id]) {
        await client.query(
          `INSERT INTO connection_feature_grants (connection_id, grantor_id, feature)
           SELECT $1, $2, 'meetings'
            WHERE NOT EXISTS (SELECT 1 FROM connection_feature_grants WHERE connection_id = $1 AND grantor_id = $2 AND feature = 'meetings')`,
          [connId, grantor]);
      }
      const m = await meetings.startMeeting(client, partner.id, 'קפה עם דנה', [userId]);
      // Sunday 18:00 Israel time, at least three days out: in the future and named by weekday.
      await meetings.options.add(client, partner.id, m.data.meeting.id, 'יום ראשון 18:00', nextWeekdayAt(0, 18));
    },
    turns: ['בפגישה "קפה עם דנה" תציעי בבקשה גם את יום שלישי הקרוב ב-20:00, בנוסף למה שכבר הוצע'],
    hard: async (client, ctx) => [
      ...await turnOpening(client, ctx),
      // THIS run's meeting only — the newest by that name. Two runs inside an
      // hour once left two meetings behind, and a count across both read four
      // options where the model had correctly added exactly one.
      { name: 'a second option is on the table and the first still stands',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM meeting_options o
            WHERE o.meeting_id = (SELECT max(id) FROM meetings WHERE title = 'קפה עם דנה' AND status = 'negotiating')
              AND o.status = 'active'`, [])) === 2 },
      { name: 'nothing was replaced',
        pass: (await count(client,
          `SELECT count(*)::int AS n FROM meeting_options o
            WHERE o.meeting_id = (SELECT max(id) FROM meetings WHERE title = 'קפה עם דנה')
              AND o.status = 'replaced'`, [])) === 0 },
    ],
    rubric: 'המשתמש ביקש להוסיף מועד שני (יום שלישי 20:00) לתיאום שכבר יש בו מועד. בדוק: (1) התשובה מאשרת שהמועד נוסף לצד הקודם, לא במקומו. (2) עולמה לא מכריזה שהפגישה נקבעה. (3) קצר, בלי שאלות מיותרות.',
  },
];

// ids must be unique — results and the two-nights rule key on them.
const seen = new Set();
for (const s of SCENARIOS) {
  if (seen.has(s.id)) throw new Error(`duplicate scenario id ${s.id}`);
  seen.add(s.id);
}

module.exports = { SCENARIOS, turnStartFirst, turnStartNotSpent, turnOpening, turnWasOpened, replyLanguage, herOwnVoice };
