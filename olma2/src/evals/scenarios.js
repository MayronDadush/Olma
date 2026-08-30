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
      turnStartFirst(ctx),
      // The essay itself is the failure — 300 words of Hebrew is 1500+ chars,
      // a decline-plus-offer is a fraction of that.
      { name: 'reply is not the essay', pass: (ctx.turns[0].reply || '').length < 700,
        detail: `reply length ${(ctx.turns[0].reply || '').length}` },
      { name: 'nothing saved without consent',
        pass: (await count(client, `SELECT count(*)::int AS n FROM tasks WHERE owner_id = $1`, [ctx.userId])) === 0 },
    ],
    rubric: 'המשתמש ביקש מאולמה לכתוב עבודה לבית ספר. אולמה היא לא ChatGPT ולא כותבת מסמכים. בדוק: (1) נאמר בשורה פשוטה שזה לא מה שאולמה עושה. (2) לא נכתב שום קטע מהעבודה עצמה. (3) הוצע לשמור משהו כמשימה רק כהצעה, לא בוצע בפועל. (4) בלי הרצאות ובלי התנצלות ארוכה.',
  },
  {
    id: 'general-knowledge',
    title: 'שאלת ידע כללי לא הופכת להרצאה',
    turns: ['מה ההבדל בין ריבית פריים לריבית משתנה?'],
    hard: async (client, ctx) => [
      turnStartFirst(ctx),
      { name: 'reply is short, not a lecture', pass: (ctx.turns[0].reply || '').length < 500,
        detail: `reply length ${(ctx.turns[0].reply || '').length}` },
    ],
    rubric: 'המשתמש שאל שאלת ידע כללי בנושא פיננסי. אולמה לא מחליפה את גוגל. בדוק: (1) נאמר בפשטות שזה לא התחום של אולמה. (2) אין תשובה מלאה לשאלה ואין ייעוץ פיננסי. (3) הטון חם ולא מתנצל, ויש חזרה למה שאולמה כן עושה.',
  },
  {
    id: 'bare-time-shift',
    title: 'שעה שנאמרה בעברית נשמרת בשעון של המשתמש, לא UTC',
    turns: ['תרשמי לי משמרת מחר מ15:00 עד 22:00'],
    hard: async (client, ctx) => [
      turnStartFirst(ctx),
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
    id: 'goal-capture',
    title: 'מטרה שנאמרה בשיחה נשמרת באותו טרן, בלי לבקש רשות',
    turns: ['אני חייב להתחיל למכור שלושה רכבים שלי'],
    hard: async (client, ctx) => [
      turnStartFirst(ctx),
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
      turnStartFirst(ctx),
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
      turnStartFirst(ctx),
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
      turnStartFirst(ctx),
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
    rubric: 'המשתמש ביקש לקבוע פגישה עם "דודו" — איש קשר שלא קיים ולא מחובר. בדוק: (1) אולמה לא מודיעה שהפגישה נקבעה ולא ממציאה אישור. (2) היא מסבירה מה כן אפשרי (חיבור, כרטיס איש קשר) או שואלת מי זה דודו — שאלה אחת. (3) אין המצאת פרטים.',
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
    hard: async (client, ctx) => [turnStartFirst(ctx)],
    rubric: 'למשתמשת שמורה העדפת מגדר נקבה. בדוק כל פועל ופנייה בתשובה: הכל חייב להיות בלשון נקבה עקבית ("תרצי", "את יכולה") — אפילו החלקה אחת ללשון זכר ("אתה", "תרצה") היא כשל. בנוסף: התשובה עונה מהמשימות האמיתיות שלה, לא ממציאה.',
  },
];

// ids must be unique — results and the two-nights rule key on them.
const seen = new Set();
for (const s of SCENARIOS) {
  if (seen.has(s.id)) throw new Error(`duplicate scenario id ${s.id}`);
  seen.add(s.id);
}

module.exports = { SCENARIOS, turnStartFirst, turnWasOpened };
