'use strict';
// Every sentence Olma sends VERBATIM — no model between the code and the
// phone — and the one place an operator can reword any of them without a
// deploy.
//
// Two kinds of message are fixed text on purpose: the ones that must not be
// downstream of a model's billing account (a reminder, its follow-ups), and
// the ones a model must not improvise (a first contact, everything said in a
// locked group, where the agent is muted anyway). Their wording used to live
// in three files as string literals, which made "change one word" a commit,
// a suite run and a deploy. The owner asked (2026-09-06) to be able to change
// any of them from the admin page. So:
//
//   * the DEFAULT text stays in this file, next to the placeholders it needs.
//     Code is still where the wording is reviewed, and a fresh install says
//     the right things with an empty flag row;
//   * an OVERRIDE is a string in the `message_templates` flag, keyed by
//     template. The render functions in proactive-text.js and
//     intake/messages.js take the loaded overrides as their last argument and
//     fall back to the default for anything absent or unusable;
//   * an override is validated at the edge (the dashboard form) AND at
//     render, with the same rule: it must contain every REQUIRED placeholder
//     and no placeholder the template does not know. A nudge without the
//     `{{missing}}` tags would be a sentence that pings nobody — and looks
//     fine in the box.
//
// Placeholders are `{{name}}`. Nothing else is interpreted: no conditionals,
// no HTML, no markdown beyond what WhatsApp renders itself.
const flagsDomain = require('./flags');

const FLAG = 'message_templates';
const MAX_LENGTH = 1500;
const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

// `vars` describes every placeholder the template may use, in the operator's
// words; `required` names the ones an override must keep. The `label`/`help`
// pair is what the page shows, in the same voice as the settings table.
const TEMPLATES = [
  // ---- to one person, in private ------------------------------------------
  {
    key: 'reminder', audience: 'private', label: 'תזכורת',
    help: 'התזכורת עצמה, בשעה שהאדם ביקש. יוצאת בלי מודל, ולכן גם כשאין קרדיט.',
    vars: { title: 'מה שביקשו להזכיר, במילים שלהם' }, required: ['title'],
    text: '⏰ תזכורת: {{title}}',
  },
  {
    key: 'reminder_followup', audience: 'private', label: 'תזכורת חוזרת',
    help: 'השלב השני והשלישי של אותה תזכורת, אם לא ענו. חייבת להגיד איך מפסיקים אותה.',
    vars: { title: 'מה שביקשו להזכיר' }, required: ['title'],
    text: '⏰ תזכורת חוזרת: {{title}}\nבוצע? אפשר לכתוב לי, או להגיד לי להפסיק להזכיר על זה.',
  },
  {
    key: 'reminder_last', audience: 'private', label: 'תזכורת אחרונה',
    help: 'השלב האחרון בסולם. אחריה עולמה לא מזכירה שוב מיוזמתה, וההודעה צריכה להגיד את זה.',
    vars: { title: 'מה שביקשו להזכיר' }, required: ['title'],
    text: '⏰ תזכורת חוזרת: {{title}}\nזו התזכורת האחרונה על זה — לא אזכיר שוב מיוזמתי. אם עדיין רלוונטי, אפשר להגיד לי מתי להזכיר.',
  },
  // ---- the same three rungs, when several arrive at once -------------------
  // Nine reminders that come due in the same minute were nine messages, one
  // per row, because the outbox drains a row at a time. Vered got exactly that
  // on her first morning. A list is not a different message — it is the same
  // rung, said once, and it therefore needs one template per rung: a batch may
  // only make the promise every line in it makes, and 'זו התזכורת האחרונה'
  // is a promise.
  {
    key: 'reminder_list', audience: 'private', label: 'כמה תזכורות יחד',
    help: 'כשכמה תזכורות מגיעות באותו רגע — הודעה אחת במקום אחת לכל תזכורת. אותו שלב ראשון, רק ברשימה.',
    vars: { items: 'התזכורות, שורה לכל אחת' }, required: ['items'],
    text: '⏰ תזכורות:\n{{items}}',
  },
  {
    key: 'reminder_list_followup', audience: 'private', label: 'כמה תזכורות חוזרות יחד',
    help: 'אותו דבר לשלב השני והשלישי. חייבת להגיד איך מפסיקים, בדיוק כמו תזכורת חוזרת בודדת.',
    vars: { items: 'התזכורות, שורה לכל אחת' }, required: ['items'],
    text: '⏰ תזכורות חוזרות:\n{{items}}\nמשהו מהן בוצע? אפשר לכתוב לי, או להגיד לי להפסיק להזכיר.',
  },
  {
    key: 'reminder_list_last', audience: 'private', label: 'כמה תזכורות אחרונות יחד',
    help: 'השלב האחרון בסולם, לכמה תזכורות יחד. אחריה עולמה לא מזכירה שוב על אף אחת מהן מיוזמתה.',
    vars: { items: 'התזכורות, שורה לכל אחת' }, required: ['items'],
    text: '⏰ תזכורות חוזרות:\n{{items}}\nאלו התזכורות האחרונות עליהן — לא אזכיר שוב מיוזמתי. אם משהו עדיין רלוונטי, אפשר להגיד לי מתי להזכיר.',
  },
  {
    key: 'stranger_intro_he', audience: 'private', label: 'פנייה ראשונה לאדם חדש (עברית)',
    help: 'כשמשתמש ביקש להתחבר למספר שעוד לא אצלנו. ההודעה הראשונה שהאדם הזה מקבל מעולמה, ולכן בלי ניחוש מגדר.',
    vars: { inviter_name: 'מי ביקש להתחבר', inviter_phone: 'המספר שלו, כדי שיזהו', reason: 'הסיבה שכתב, עם מקף לפניה — או כלום אם לא כתב' },
    required: ['inviter_name', 'inviter_phone'],
    text: 'היי! כאן עולמה — עוזרת אישית שעובדת בוואטסאפ.\n\n{{inviter_name}} ({{inviter_phone}}) ביקש/ה להתחבר אליך דרכי{{reason}}.\n\nאם זה מעניין אותך, פשוט תענה/י לי כאן ואספר איך זה עובד. אם לא — אפשר להתעלם, ולא אכתוב שוב.',
  },
  {
    key: 'stranger_intro_en', audience: 'private', label: 'פנייה ראשונה לאדם חדש (אנגלית)',
    help: 'אותה הודעה למספר שאינו ישראלי.',
    vars: { inviter_name: 'who asked to connect', inviter_phone: 'their number', reason: 'their reason, with a dash before it — or nothing' },
    required: ['inviter_name', 'inviter_phone'],
    text: 'Hi! This is Olma — a personal assistant that lives in WhatsApp.\n\n{{inviter_name}} ({{inviter_phone}}) asked to connect with you through me{{reason}}.\n\nIf you\'re curious, just reply here and I\'ll explain how it works. If not — feel free to ignore this, I won\'t write again.',
  },
  {
    key: 'reopen_he', audience: 'private', label: 'ההרשמה נפתחה מחדש (עברית)',
    help: 'למי שפנה כשההרשמה הייתה סגורה ונכנס לרשימת ההמתנה — ההבטחה שקיימנו.',
    vars: {}, required: [],
    text: 'היי! כאן עולמה — פנית אליי כשלא הייתה אפשרות לצרף משתמשים חדשים. עכשיו נפתח מקום! אם עדיין רלוונטי, פשוט תענה/י לי כאן ונתחיל 🙂',
  },
  {
    key: 'reopen_en', audience: 'private', label: 'ההרשמה נפתחה מחדש (אנגלית)',
    help: 'אותה הודעה למספר שאינו ישראלי.',
    vars: {}, required: [],
    text: 'Hi! Olma here — you reached out while new sign-ups were paused. There\'s room now! If you\'re still interested, just reply here and we\'ll get started 🙂',
  },
  // ---- in a group -----------------------------------------------------------
  {
    key: 'group_intro', audience: 'group', label: 'היכרות בקבוצה',
    help: 'המשפט הראשון שלה בקבוצה, על ההודעה הראשונה של מישהו שם. חייבת לכלול את התיוג שלה, כדי שיהיה משהו ללחוץ עליו.',
    vars: { me: 'התיוג של עולמה עצמה (המספר שלה, כתיוג אמיתי)' }, required: ['me'],
    text: 'נעים מאוד, אני עולמה 👋\nאני עוזרת לקבוצות לתאם דברים בלי הפינג-פונג: מי פנוי מתי ומי עוד לא ענה.\nכשאתם צריכים אותי - תתייגו אותי {{me}}. בלי תיוג אני לא מתערבת מקווה שכולכם מחוברים 🙌',
  },
  {
    key: 'group_gate_explain', audience: 'group', label: 'תייגו אותה ולא כולם מחוברים — פעם ראשונה',
    help: 'התשובה לתיוג הראשון בקבוצה נעולה: מסבירה למה היא לא עונה עדיין ומתייגת את מי שחסר.',
    vars: { missing: 'תיוגים של מי שעוד לא כתב לה בפרטי' }, required: ['missing'],
    text: 'כדי שאוכל לתאם לכם משהו, אני צריכה שכל אחד כאן ישלח לי הודעה - אחרת אין לי דרך לשאול אותו מתי הוא פנוי.\nרק אומרת.. עוד לא שלחו לי: {{missing}}\n״היי״ בפרטי וזהו, אני מתחילה לעבוד ☺️',
  },
  {
    key: 'group_gate_nudge', audience: 'group', label: 'תייגו אותה ולא כולם מחוברים — מהפעם השנייה',
    help: 'כל תיוג נוסף בקבוצה נעולה. קצרה בכוונה: ההסבר כבר נאמר.',
    vars: { missing: 'תיוגים של מי שעוד לא כתב לה בפרטי' }, required: ['missing'],
    text: 'עוד מחכה ל: {{missing}}  🧐',
  },
  {
    key: 'group_opened', audience: 'group', label: 'כולם מחוברים — הקבוצה נפתחה',
    help: 'פעם אחת, כשהאחרון כתב לה בפרטי. יוצאת בשעות היום של הקבוצה, לא באמצע הלילה.',
    vars: {}, required: [],
    text: 'יש! כולם כאן ואפשר להתחיל 🎉\nתתייגו אותי ותגידו מה לתאם — פגישה, משחק, מה שבא — ואני ארוץ לכל אחד בפרטי ואחזור עם מה שמסתדר.',
  },
  {
    key: 'group_too_large', audience: 'group', label: 'הקבוצה גדולה מדי',
    help: 'פעם אחת, בקבוצה שמעל התקרה שבהגדרות. המספר מגיע מההגדרה, לא מהטקסט.',
    vars: { max: 'התקרה שבהגדרות (group_max_members)' }, required: ['max'],
    text: 'אני מסתדרת טוב עד {{max}} אנשים, וכאן יש יותר - אז לא אתערב פה. בפרטי אני תמיד זמינה.',
  },
];

const BY_KEY = new Map(TEMPLATES.map((t) => [t.key, t]));

function spec(key) {
  const t = BY_KEY.get(key);
  if (!t) throw new Error(`unknown message template: ${key}`);
  return t;
}

function placeholdersIn(text) {
  const out = new Set();
  for (const m of String(text).matchAll(PLACEHOLDER_RE)) out.add(m[1]);
  return out;
}

// A textarea submits CRLF and stray trailing spaces; the message should carry
// neither. Nothing else is touched — inner blank lines are the operator's.
function normalize(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n')
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').trim();
}

// { ok } or { ok: false, reason } — the reason in the operator's language,
// because the page shows it next to the box that was refused.
function validate(key, text) {
  const t = spec(key);
  const s = normalize(text);
  if (!s) return { ok: false, reason: 'ריק' };
  if (s.length > MAX_LENGTH) return { ok: false, reason: `ארוך מדי (מעל ${MAX_LENGTH} תווים)` };
  const found = placeholdersIn(s);
  const missing = t.required.filter((v) => !found.has(v));
  if (missing.length) return { ok: false, reason: `חסר ${missing.map((v) => `{{${v}}}`).join(', ')}` };
  const unknown = [...found].filter((v) => !Object.hasOwn(t.vars, v));
  if (unknown.length) return { ok: false, reason: `משתנה לא מוכר: ${unknown.map((v) => `{{${v}}}`).join(', ')}` };
  return { ok: true };
}

// The text that will actually go out for `key` — the override when one is
// stored and still valid, the default otherwise. Re-validating here is what
// makes a hand-edited flag row unable to ship a broken sentence.
function textFor(key, overrides) {
  const t = spec(key);
  const o = overrides && typeof overrides === 'object' ? overrides[key] : undefined;
  if (typeof o === 'string' && validate(key, o).ok) return normalize(o);
  return t.text;
}

function render(key, vars, overrides) {
  const v = vars || {};
  return textFor(key, overrides).replace(PLACEHOLDER_RE, (_, name) => (v[name] == null ? '' : String(v[name])));
}

async function load(client) {
  const stored = await flagsDomain.getFlag(client, FLAG);
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

// The body of a POST /templates, as the object to store plus what was refused
// and why. Blank means "the default"; the default typed back in is not an
// override; anything that fails validation is dropped rather than stored, and
// named, so the operator sees which box did not take rather than finding out
// from a group that got a nudge with no tags in it.
function parseForm(body) {
  const overrides = {};
  const rejected = {};
  for (const t of TEMPLATES) {
    const raw = normalize(body && body[t.key]);
    if (!raw) continue;
    if (raw === t.text) continue;
    const v = validate(t.key, raw);
    if (v.ok) overrides[t.key] = raw;
    else rejected[t.key] = v.reason;
  }
  return { overrides, rejected };
}

module.exports = {
  FLAG, MAX_LENGTH, TEMPLATES, spec, validate, normalize, textFor, render, load, parseForm, placeholdersIn,
};
