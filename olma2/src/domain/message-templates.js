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
  // The first thing a new person ever reads. Brand copy, the owner's, and the
  // one verbatim message that lived OUTSIDE this file until 2026-09-08
  // (domain/onboarding.js keeps the name `OPENING` and reads it from here).
  // Said by whichever voice reaches the person first — the intake greeter's
  // AGENTS.md quotes it, `turn_start` hands it over as `sendVerbatim` — and
  // both read the override, so a rewording here is what a stranger reads.
  {
    key: 'opening_he', audience: 'private', label: 'הודעת הפתיחה',
    help: 'המשפט הראשון שאדם חדש קורא — מהגרייטר או מהסוכן שלו, פעם אחת בחיים. בלי שאלה בסוף: את השם שואלים אחר כך.',
    vars: {}, required: [],
    sample: {},
    // Shortened by the owner, 2026-09-25 — one line of what she is for. The
    // page link is NOT here: nobody has a page yet when the greeter speaks, so
    // their own agent's first message carries it (jobs/intake.js,
    // `welcome_followup`). The previous copy is kept in
    // onboarding.PREVIOUS_OPENINGS so a greeter still saying it is recognised.
    text: 'היי, אני עולמה 👋\n'
      + '\n'
      + 'אני עוזרת עם משימות, תזכורות ותיאומים — אפשר לכתוב, להקליט או לשלוח הכל בבלגן ☺️',
  },
  {
    key: 'opening_en', audience: 'private', label: 'הודעת הפתיחה', help: '',
    vars: {}, required: [],
    sample: {},
    text: "Hey, I'm Allma \u{1F44B}\n"
      + '\n'
      + 'I help with tasks, reminders and scheduling — text me, send a voice note, '
      + 'or just dump it all on me ☺️',
  },
  // The whole answer to "שלח לי קישור" (domain/link-request.js): said by code,
  // with no model turn, the moment a message asks for their page and nothing
  // else. The link is minted for this message and opens once; it goes on a
  // line of its own, like every link Olma sends.
  {
    key: 'dashboard_link', audience: 'private', label: 'קישור לדף האישי',
    help: 'התשובה כשמישהו כותב רק "שלח לי קישור" וכדומה. יוצאת בלי מודל, מיד.',
    vars: { url: 'הקישור האישי, נפתח פעם אחת' }, required: ['url'],
    sample: { url: 'https://allma.world/d/AbCdEfGhIjKlMnOpQrStUv' },
    text: 'הקישור לדף שלך 👇\n{{url}}',
  },
  {
    key: 'dashboard_link_en', audience: 'private', label: 'קישור לדף האישי', help: '',
    vars: { url: 'their personal link, opens once' }, required: ['url'],
    sample: { url: 'https://allma.world/d/AbCdEfGhIjKlMnOpQrStUv' },
    text: 'Here’s your page 👇\n{{url}}',
  },
  {
    key: 'reminder', audience: 'private', label: 'תזכורת',
    help: 'התזכורת עצמה, בשעה שהאדם ביקש. יוצאת בלי מודל, ולכן גם כשאין קרדיט.',
    vars: { title: 'מה שביקשו להזכיר, במילים שלהם' }, required: ['title'],
    sample: { title: 'לקחת את הרכב לטסט' },
    text: '⏰ תזכורת: *{{title}}*',
  },
  {
    key: 'reminder_followup', audience: 'private', label: 'תזכורת חוזרת',
    help: 'השלב השני והשלישי של אותה תזכורת, אם לא ענו. חייבת להגיד איך מפסיקים אותה.',
    vars: { title: 'מה שביקשו להזכיר' }, required: ['title'],
    sample: { title: 'לקחת את הרכב לטסט' },
    text: '⏰ תזכורת חוזרת: *{{title}}*\nבוצע? אפשר לכתוב לי, או להגיד לי להפסיק להזכיר על זה.',
  },
  {
    key: 'reminder_last', audience: 'private', label: 'תזכורת אחרונה',
    help: 'השלב האחרון בסולם. אחריה עולמה לא מזכירה שוב מיוזמתה, וההודעה צריכה להגיד את זה.',
    vars: { title: 'מה שביקשו להזכיר' }, required: ['title'],
    sample: { title: 'לקחת את הרכב לטסט' },
    text: '⏰ תזכורת חוזרת: *{{title}}*\nזו התזכורת האחרונה על זה — לא אזכיר שוב מיוזמתי. אם עדיין רלוונטי, אפשר להגיד לי מתי להזכיר.',
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
    sample: { items: '- לקחת את הרכב לטסט\n- להתקשר לרואה החשבון' },
    text: '⏰ *תזכורות*\n{{items}}',
  },
  {
    key: 'reminder_list_followup', audience: 'private', label: 'כמה תזכורות חוזרות יחד',
    help: 'אותו דבר לשלב השני והשלישי. חייבת להגיד איך מפסיקים, בדיוק כמו תזכורת חוזרת בודדת.',
    vars: { items: 'התזכורות, שורה לכל אחת' }, required: ['items'],
    sample: { items: '- לקחת את הרכב לטסט\n- להתקשר לרואה החשבון' },
    text: '⏰ *תזכורות חוזרות*\n{{items}}\nמשהו מהן בוצע? אפשר לכתוב לי, או להגיד לי להפסיק להזכיר.',
  },
  {
    key: 'reminder_list_last', audience: 'private', label: 'כמה תזכורות אחרונות יחד',
    help: 'השלב האחרון בסולם, לכמה תזכורות יחד. אחריה עולמה לא מזכירה שוב על אף אחת מהן מיוזמתה.',
    vars: { items: 'התזכורות, שורה לכל אחת' }, required: ['items'],
    sample: { items: '- לקחת את הרכב לטסט\n- להתקשר לרואה החשבון' },
    text: '⏰ *תזכורות חוזרות*\n{{items}}\nאלו התזכורות האחרונות עליהן — לא אזכיר שוב מיוזמתי. אם משהו עדיין רלוונטי, אפשר להגיד לי מתי להזכיר.',
  },
  // ---- the same six, for somebody whose language is English ---------------
  // A reminder goes out with no model between the code and the phone, so the
  // language a person has on file (users.locale — decided from their first
  // message, changed only when they ask) has to be honoured HERE, by picking
  // a template, or it is not honoured at all: Sarah wrote to Olma in English
  // for a month and her reminders arrived in Hebrew, because the ladder had
  // one set of sentences. proactive-text picks `<key>_en` for an `en` locale
  // and the plain key for everybody else. English has no grammatical gender
  // to avoid, so these read a little more naturally than the Hebrew ones can.
  {
    key: 'reminder_en', audience: 'private', label: 'תזכורת',
    help: '',
    vars: { title: 'what they asked to be reminded of, in their words' }, required: ['title'],
    sample: { title: 'take the car for its test' },
    text: '⏰ Reminder: *{{title}}*',
  },
  {
    key: 'reminder_followup_en', audience: 'private', label: 'תזכורת חוזרת',
    help: '',
    vars: { title: 'what they asked to be reminded of' }, required: ['title'],
    sample: { title: 'take the car for its test' },
    text: '⏰ Reminder again: *{{title}}*\nDone? Just tell me — or tell me to stop reminding you about this.',
  },
  {
    key: 'reminder_last_en', audience: 'private', label: 'תזכורת אחרונה',
    help: '',
    vars: { title: 'what they asked to be reminded of' }, required: ['title'],
    sample: { title: 'take the car for its test' },
    text: '⏰ Reminder again: *{{title}}*\nThis is the last reminder about this — I won\'t bring it up again on my own. If it still matters, tell me when to remind you.',
  },
  {
    key: 'reminder_list_en', audience: 'private', label: 'כמה תזכורות יחד',
    help: '',
    vars: { items: 'the reminders, one per line' }, required: ['items'],
    sample: { items: '- take the car for its test\n- call the accountant' },
    text: '⏰ *Reminders*\n{{items}}',
  },
  {
    key: 'reminder_list_followup_en', audience: 'private', label: 'כמה תזכורות חוזרות יחד',
    help: '',
    vars: { items: 'the reminders, one per line' }, required: ['items'],
    sample: { items: '- take the car for its test\n- call the accountant' },
    text: '⏰ *Reminders again*\n{{items}}\nAny of these done? Just tell me — or tell me to stop reminding you.',
  },
  {
    key: 'reminder_list_last_en', audience: 'private', label: 'כמה תזכורות אחרונות יחד',
    help: '',
    vars: { items: 'the reminders, one per line' }, required: ['items'],
    sample: { items: '- take the car for its test\n- call the accountant' },
    text: '⏰ *Reminders again*\n{{items}}\nThese are the last reminders about them — I won\'t bring them up again on my own. If any still matter, tell me when to remind you.',
  },
  {
    key: 'stranger_intro_he', audience: 'private', label: 'פנייה ראשונה לאדם חדש',
    help: 'כשמשתמש ביקש להתחבר למספר שעוד לא אצלנו. ההודעה הראשונה שהאדם הזה מקבל מעולמה, ולכן בלי ניחוש מגדר.',
    vars: { inviter_name: 'מי ביקש להתחבר', inviter_phone: 'המספר שלו, כדי שיזהו', reason: 'הסיבה שכתב, עם מקף לפניה — או כלום אם לא כתב' },
    required: ['inviter_name', 'inviter_phone'],
    sample: { inviter_name: 'יואב', inviter_phone: '054-000-0000', reason: ' — לתאם את הטיול של סוף השבוע' },
    text: 'היי! כאן עולמה — עוזרת אישית שעובדת בוואטסאפ.\n\n*{{inviter_name}}* ({{inviter_phone}}) ביקש/ה להתחבר אליך דרכי{{reason}}.\n\nאם זה מעניין אותך, פשוט תענה/י לי כאן ואספר איך זה עובד. אם לא — אפשר להתעלם, ולא אכתוב שוב.',
  },
  {
    key: 'stranger_intro_en', audience: 'private', label: 'פנייה ראשונה לאדם חדש',
    help: '',
    vars: { inviter_name: 'who asked to connect', inviter_phone: 'their number', reason: 'their reason, with a dash before it — or nothing' },
    required: ['inviter_name', 'inviter_phone'],
    sample: { inviter_name: 'Yoav', inviter_phone: '054-000-0000', reason: ' — to sort out the weekend trip' },
    text: 'Hi! This is Olma — a personal assistant that lives in WhatsApp.\n\n*{{inviter_name}}* ({{inviter_phone}}) asked to connect with you through me{{reason}}.\n\nIf you\'re curious, just reply here and I\'ll explain how it works. If not — feel free to ignore this, I won\'t write again.',
  },
  {
    key: 'reopen_he', audience: 'private', label: 'ההרשמה נפתחה מחדש',
    help: 'למי שפנה כשההרשמה הייתה סגורה ונכנס לרשימת ההמתנה — ההבטחה שקיימנו.',
    vars: {}, required: [],
    sample: {},
    text: 'היי! כאן עולמה — פנית אליי כשלא הייתה אפשרות לצרף משתמשים חדשים. עכשיו נפתח מקום! אם עדיין רלוונטי, פשוט תענה/י לי כאן ונתחיל 🙂',
  },
  {
    key: 'reopen_en', audience: 'private', label: 'ההרשמה נפתחה מחדש',
    help: '',
    vars: {}, required: [],
    sample: {},
    text: 'Hi! Olma here — you reached out while new sign-ups were paused. There\'s room now! If you\'re still interested, just reply here and we\'ll get started 🙂',
  },
  // ---- in a group -----------------------------------------------------------
  {
    key: 'group_intro', audience: 'group', label: 'היכרות בקבוצה',
    help: 'המשפט הראשון שלה בקבוצה, על ההודעה הראשונה של מישהו שם. חייבת לכלול את התיוג שלה, כדי שיהיה משהו ללחוץ עליו.',
    vars: { me: 'התיוג של עולמה עצמה (המספר שלה, כתיוג אמיתי)' }, required: ['me'],
    sample: { me: '@+972559347282' },
    text: 'נעים מאוד, אני עולמה 👋\nאני עוזרת לקבוצות לתאם דברים בלי הפינג-פונג: מי פנוי מתי ומי עוד לא ענה.\nכשאתם צריכים אותי - תתייגו אותי {{me}}. בלי תיוג אני לא מתערבת מקווה שכולכם מחוברים 🙌',
  },
  {
    key: 'group_gate_explain', audience: 'group', label: 'תייגו אותה ולא כולם מחוברים — פעם ראשונה',
    help: 'התשובה לתיוג הראשון בקבוצה נעולה: מסבירה למה היא לא עונה עדיין ומתייגת את מי שחסר.',
    vars: { missing: 'תיוגים של מי שעוד לא כתב לה בפרטי' }, required: ['missing'],
    sample: { missing: '@+972501234567 @+972521234567' },
    text: 'כדי שאוכל לתאם לכם משהו, אני צריכה שכל אחד כאן ישלח לי הודעה - אחרת אין לי דרך לשאול אותו מתי הוא פנוי.\nרק אומרת.. עוד לא שלחו לי: {{missing}}\n״היי״ בפרטי וזהו, אני מתחילה לעבוד ☺️',
  },
  {
    key: 'group_gate_nudge', audience: 'group', label: 'תייגו אותה ולא כולם מחוברים — מהפעם השנייה',
    help: 'כל תיוג נוסף בקבוצה נעולה. קצרה בכוונה: ההסבר כבר נאמר.',
    vars: { missing: 'תיוגים של מי שעוד לא כתב לה בפרטי' }, required: ['missing'],
    sample: { missing: '@+972501234567 @+972521234567' },
    text: 'עוד מחכה ל: {{missing}}  🧐',
  },
  {
    key: 'group_opened', audience: 'group', label: 'כולם מחוברים — הקבוצה נפתחה',
    help: 'פעם אחת, כשהאחרון כתב לה בפרטי. יוצאת בשעות היום של הקבוצה, לא באמצע הלילה.',
    vars: {}, required: [],
    sample: {},
    text: 'יש! כולם כאן ואפשר להתחיל 🎉\nתתייגו אותי ותגידו מה לתאם — פגישה, משחק, מה שבא — ואני ארוץ לכל אחד בפרטי ואחזור עם מה שמסתדר.',
  },
  {
    key: 'group_too_large', audience: 'group', label: 'הקבוצה גדולה מדי',
    help: 'פעם אחת, בקבוצה שמעל התקרה שבהגדרות. המספר מגיע מההגדרה, לא מהטקסט.',
    vars: { max: 'התקרה שבהגדרות (group_max_members)' }, required: ['max'],
    sample: { max: '25' },
    text: 'אני מסתדרת טוב עד {{max}} אנשים, וכאן יש יותר - אז לא אתערב פה. בפרטי אני תמיד זמינה.',
  },
  // ---- what a room hears about its own coordination, unasked --------------
  // Three of the owner's five moments (2026-09-07). Each is said once per
  // coordination and each waits for the group's own hours: nobody asked for
  // them, which is also why they are three short lines and not three
  // paragraphs.
  {
    key: 'group_coord_started', audience: 'group', label: 'תיאום — התחלתי לשאול',
    help: 'פעם אחת, ברגע שנפתח תיאום בקבוצה: אומרת שהיא התחילה לשאול בפרטי, ועם כמה. מי שעוד לא כתב לה בפרטי לא נספר — ההערה על זה נאמרת רק כשיש כאלה.',
    vars: {
      title: 'מה מתארגן, במילים של הקבוצה',
      asked: 'עם כמה אנשים היא התחילה לתאם',
      outside_note: 'הערה על מי שעוד לא כתב לה — רק כשיש כאלה בקבוצה',
    },
    required: ['title', 'asked'],
    sample: {
      title: 'פאדל השבוע', asked: '4',
      outside_note: 'מי שעוד לא כתב לי בפרטי לא נספר פה — ״היי״ בפרטי וזה מסתדר ☺️',
    },
    text: 'מתחילה לתאם *{{title}}* 🎯\nשאלתי בפרטי {{asked}} מכם שכתבו לי, ואחזור לכאן עם מה שמסתדר.\n{{outside_note}}',
  },
  // Who has not written to her yet, TAGGED in the opening line (owner,
  // 2026-09-25, פנתרה: the member in Australia heard only the count, and a
  // count pings nobody). Two keys because Hebrew says "you" differently to one
  // person and to several; the count line above is what is left when none of
  // them can be tagged.
  {
    key: 'group_coord_outside', audience: 'group', label: 'תיאום — מי שעוד לא כתב לה (אחד)',
    help: 'בתוך שורת הפתיחה של תיאום, כשאדם אחד בקבוצה עוד לא כתב לה בפרטי. מתייגת אותו, כדי שיכתוב לה ותצרף אותו.',
    vars: { who: 'התיוג שלו' }, required: ['who'],
    sample: { who: '@+972501234567' },
    text: '{{who}} עוד לא כתבת לי בפרטי — ״היי״ שם ואצרף אותך לתיאום ☺️',
  },
  {
    key: 'group_coord_outside_many', audience: 'group', label: 'תיאום — מי שעוד לא כתבו לה (כמה)',
    help: 'אותה שורה, כשכמה אנשים בקבוצה עוד לא כתבו לה בפרטי.',
    vars: { who: 'התיוגים שלהם' }, required: ['who'],
    sample: { who: '@+972501234567 @+972521234567' },
    text: '{{who}} עוד לא כתבתם לי בפרטי — ״היי״ שם ואצרף אתכם לתיאום ☺️',
  },
  // A tag from somebody in the room who has never written to her. The gateway
  // now lets it through so it can be answered instead of vanishing; brokerd
  // answers it with this, on every tag, quoting it, and no model turn.
  {
    key: 'group_sender_hint', audience: 'group', label: 'קבוצה — תיוג ממי שעוד לא כתב לה',
    help: 'כשמישהו בקבוצה שעוד לא כתב לה בפרטי מתייג אותה. נאמרת בכל פעם שהוא מתייג, כתגובה להודעה שלו, בלי מודל — עד שיכתוב לה בפרטי.',
    vars: { who: 'התיוג שלו' }, required: ['who'],
    sample: { who: '@+972501234567' },
    text: '{{who}} כדי שאוכל לעזור לך כאן, שלח לי ״היי״ בפרטי ☺️',
  },
  // Somebody let into a coordination after it started, because they have now
  // written to her (`group-meetings.admitLateMembers`). Once per person.
  {
    key: 'group_coord_joined', audience: 'group', label: 'תיאום — מישהו הצטרף באמצע',
    help: 'כשמי שעוד לא היה בתיאום כתב לה בפרטי והיא צירפה אותו. נאמרת פעם אחת לכל אדם, בשעות היום של הקבוצה.',
    vars: { who: 'התיוג של מי שהצטרף', verb: 'הצטרף / הצטרפה / הצטרפו — לפי מה שהם הגדירו, זכר כשלא הגדירו' },
    required: ['who'],
    sample: { who: '@+972501234567', verb: 'הצטרפה' },
    text: '{{who}} {{verb}} — שאלתי בפרטי 👋',
  },
  {
    key: 'group_coord_base', audience: 'group', label: 'תיאום — יש כיוון',
    help: 'פעם אחת בכל תיאום, ברגע שיש זמן שכמה אנשים אמרו לו כן (או שהגיע למינימום, בקבוצת משחק).',
    vars: { slot: 'הזמן שמוביל', yes: 'כמה אמרו לו כן', missing: 'תיוגים של מי שעוד לא אמר כן לזמן הזה' },
    required: ['slot'],
    sample: { slot: 'יום שלישי 20:00', yes: '3', missing: '@+972501234567' },
    text: 'יש כיוון: *{{slot}}* — {{yes}} כבר בפנים.\nמחכה ל{{missing}} 🤞',
  },
  // Three shapes, one per thing that is true. The owner picked the wording on
  // 2026-09-22 ("ב-4 קצת חם הוספתי / החלפתי לאופציה של השעה 17 📣") — the
  // sentence reads as the member's own line in the room, with what they did to
  // the table on the end of it, because the reason and the change are one piece
  // of news and שרון's room got neither. The joiner is a dash and not a comma
  // on purpose: their sentence keeps its own punctuation, and "חם., החלפתי"
  // is what a comma looks like after a full stop.
  {
    key: 'group_coord_relay', audience: 'group', label: 'תיאום — מישהו ביקש להגיד משהו כאן',
    help: 'כשחבר מבקש ממנה בפרטי שהקבוצה תשמע משפט, והוא לא שינה כלום בשולחן. פעם אחת לכל אדם בכל תיאום, במילים שלו.',
    vars: { from: 'התיוג של מי שביקש', what: 'המשפט שלו, כמו שנאמר' },
    required: ['from', 'what'],
    sample: { from: '@+972501234567', what: 'ב-4 קצת חם' },
    text: '{{from}}: {{what}} 📣',
  },
  {
    key: 'group_coord_relay_added', audience: 'group', label: 'תיאום — ביקש להגיד משהו, והוסיף מועד',
    help: 'אותו משפט, כשאותו אדם גם הוסיף מועד שעדיין על השולחן. ככה החדר שומע גם את הסיבה וגם מה השתנה.',
    vars: { from: 'התיוג של מי שביקש', what: 'המשפט שלו, כמו שנאמר', added: 'המועד שהוא הוסיף' },
    required: ['from', 'what', 'added'],
    sample: { from: '@+972501234567', what: 'ב-4 קצת חם', added: 'שבת 17:00' },
    text: '{{from}}: {{what}} — הוספתי את האופציה *{{added}}* 📣',
  },
  {
    key: 'group_coord_relay_swapped', audience: 'group', label: 'תיאום — ביקש להגיד משהו, והחליף מועד',
    help: 'כשאותו אדם גם הוריד מועד וגם הוסיף אחד. זה המקרה של שרון: אנשים סימנו את 16:00 והחדר לא ידע שהיא כבר לא על השולחן.',
    vars: { from: 'התיוג של מי שביקש', what: 'המשפט שלו, כמו שנאמר', was: 'המועד שהוא הוריד', added: 'המועד שהוא הוסיף' },
    required: ['from', 'what', 'was', 'added'],
    sample: { from: '@+972501234567', what: 'ב-4 קצת חם', was: 'שבת 16:00', added: 'שבת 17:00' },
    text: '{{from}}: {{what}} — החלפתי את *{{was}}* באופציה של *{{added}}* 📣',
  },
  {
    key: 'group_coord_moved', audience: 'group', label: 'תיאום — הזמן שנאמר כאן ירד מהשולחן',
    help: 'כשהזמן שהחדר שמע עליו כבר לא על השולחן, ויש זמן אחר שמוביל. פעם אחת לכל זמן כזה.',
    vars: {
      was: 'הזמן שהחדר שמע עליו ושכבר לא קיים',
      lead: 'שורת ״יש כיוון״ על הזמן שמוביל עכשיו — הניסוח שלה נלקח משם',
    },
    required: ['was'],
    sample: {
      was: 'שבת 16:00',
      lead: 'יש כיוון: *שבת 17:00* — 2 כבר בפנים.\nמחכה ל @+972501234567 🤞',
    },
    text: '*{{was}}* כבר לא על השולחן 🔄\n{{lead}}',
  },
  {
    key: 'group_coord_chase', audience: 'group', label: 'תיאום — מזרזת באמצע',
    help: 'פעם אחת בכל תיאום, כשעבר חצי מהדרך לזמן שמדובר עליו ויש מי שעוד לא ענה כלום בפרטי.',
    vars: { missing: 'תיוגים של מי שעוד לא ענה כלום' }, required: ['missing'],
    sample: { missing: '@+972501234567' },
    text: 'עוד לא שמעתי מ{{missing}} — תגידו לי בפרטי מתי אתם יכולים ואני סוגרת את זה.',
  },
  {
    key: 'group_coord_table', audience: 'group', label: 'תיאום — השולחן זז',
    help: 'בכל פעם שהמועדים על הפרק משתנים אחרי ששלחתי כבר עדכון — נוספו זמנים או ירדו. מחכה רבע שעה מהשינוי הראשון, כך שכמה שינויים ברצף הם הודעה אחת. אף פעם לא מי אמר מה: רק כמה מועדים יש, ומי מהם הכי מתקדם.',
    vars: { count: 'כמה מועדים, כביטוי שלם ("מועד אחד" / "*3* מועדים")', lead: 'משפט שלם על המועד שהכי מתקדם, או ריק' },
    required: ['count'],
    sample: { count: '*3* מועדים', lead: 'הכי מתקדם: *שבת 17:00*.' },
    text: 'השולחן זז — עכשיו {{count}} על הפרק. {{lead}}',
  },
  {
    key: 'group_coord_done', audience: 'group', label: 'תיאום — נסגר',
    help: 'פעם אחת, כשהתיאום נסגר על זמן. כל אחד מקבל את זה גם בפרטי; זאת השורה בקבוצה.',
    vars: { slot: 'הזמן שנסגר', who: '"כולם בפנים", או "בפנים:" ותיוגים של מי שאמר כן', place_ask: 'שאלה איפה נפגשים — רק כשאף אחד לא אמר מקום', time_ask: 'שאלה אם לקבוע שעה מדויקת — רק כשנסגר על יום שלם או חלק מיום (כולל המקום, כשגם הוא חסר)' }, required: ['slot'],
    // The sample shows the place question; the time question takes its
    // place (and asks both) only when it settled without an exact hour.
    sample: { slot: 'יום שלישי 20:00', who: 'כולם בפנים', place_ask: 'איפה נפגשים? תכתבו לי ואני אוסיף ליומן 📍', time_ask: '' },
    text: 'סגור: *{{slot}}* 🎉 {{who}}\n{{place_ask}}{{time_ask}}',
  },
  {
    key: 'group_coord_time', audience: 'group', label: 'תיאום — נקבעה שעה',
    help: 'פעם אחת, כשמישהו קבע שעה מדויקת בפרטי לתיאום שנסגר על יום שלם או חלק מיום. כשהשעה נקבעה בקבוצה עצמה, זה לא נשלח — הקבוצה כבר שמעה.',
    vars: { slot: 'הזמן המדויק שנקבע' }, required: ['slot'],
    sample: { slot: 'יום שלישי 18:00' },
    text: 'השעה נקבעה: *{{slot}}* 🕐',
  },
  {
    key: 'group_coord_reopened', audience: 'group', label: 'תיאום — נפתח מחדש',
    help: 'פעם אחת בכל פעם שמישהו שבתיאום פותח מחדש זמן שכבר נסגר (בצ\'אט, בקבוצה או בדף). הזמנים האחרים ותשובותיהם נשארים; רק הזמן שנסגר נשאל שוב.',
    vars: { title: 'שם התיאום', was: 'הזמן שהיה סגור' }, required: ['title', 'was'],
    sample: { title: 'שיחת וידאו', was: 'יום שבת 26.9 12:00' },
    text: '🔄 התיאום *{{title}}* נפתח מחדש — *{{was}}* כבר לא סגור. הזמנים האחרים נשארים על השולחן, ואפשר להוסיף חדשים. אני שואלת כל מי שבתיאום בפרטי.',
  },
  {
    key: 'group_coord_calendar', audience: 'group', label: 'תיאום — ביומן',
    help: 'פעם אחת אחרי "סגור", ורק אם נוצר אירוע יומן משותף לתיאום הזה. מי שחיבר יומן קיבל הזמנה; לאחרים אין מה להבטיח.',
    vars: {}, required: [],
    sample: {},
    text: '📅 ביומן. מי שחיבר יומן קיבל הזמנה — מי שלא, אפשר לחבר בדף שלכם.',
  },
  {
    key: 'group_coord_dayof', audience: 'group', label: 'תיאום — תזכורת ביום עצמו',
    help: 'בבוקר היום שבו זה קורה, ורק אם נשארו לפחות שלוש שעות — אחרת התזכורת של שעה לפני מספיקה.',
    vars: { slot: 'הזמן שנסגר' }, required: ['slot'],
    sample: { slot: 'יום שלישי 20:00' },
    text: 'מזכירה — היום: *{{slot}}* 👋',
  },
  {
    key: 'group_coord_soon', audience: 'group', label: 'תיאום — שעה לפני',
    help: 'שעה לפני. לא נשלחת מאוחר יותר: משהו שכבר התחיל לא צריך תזכורת.',
    vars: { slot: 'הזמן שנסגר' }, required: ['slot'],
    sample: { slot: 'יום שלישי 20:00' },
    text: 'עוד שעה: *{{slot}}* 🙂',
  },
  // ---- the same lines, in a room that lives on more than one clock ----------
  // Owner, 2026-09-25, off פנתרה: two members in Israel, one in the US, one in
  // Australia, and every time the room heard was the proposer's Israeli hour.
  // Each twin is chosen when the people this coordination is asking span more
  // than one zone at that moment (`meeting-time.spansZones`), and the city
  // names are ICU's, never typed here. The owner approved every text below as a
  // draft; they are his to reword like the rest.
  //
  // Two shapes of the time, both drawn: `{{zones}}` is one line per zone, for
  // the two lines that matter most ("סגור" and "יש כיוון"), and `{{slot}}` /
  // `{{added}}` / `{{was}}` are the same moment on one line, joined with " · ".
  // A time that names no clock ("שבת בערב") is never converted — it arrives in
  // its author's words with their city beside it, and `{{zones}}` is empty.
  {
    key: 'group_coord_started_zones', audience: 'group', label: 'תיאום — התחלתי לשאול',
    help: '',
    vars: {
      title: 'מה מתארגן, במילים של הקבוצה',
      asked: 'עם כמה אנשים היא התחילה לתאם',
      cities: 'הערים של אזורי הזמן בקבוצה',
      outside_note: 'הערה על מי שעוד לא כתב לה — רק כשיש כאלה בקבוצה',
    },
    required: ['title', 'asked'],
    sample: {
      title: 'שיחת וידאו', asked: '3', cities: 'ישראל, ניו יורק וסידני',
      outside_note: 'מי שעוד לא כתב לי בפרטי לא נספר פה — ״היי״ בפרטי וזה מסתדר ☺️',
    },
    text: 'מתחילה לתאם *{{title}}* 🎯\nאתם פרוסים על {{cities}} — כל שעה שאכתוב פה תופיע לפי כל אחד 🌍\nשאלתי בפרטי {{asked}} מכם שכתבו לי, ואחזור לכאן עם מה שמסתדר.\n{{outside_note}}',
  },
  {
    key: 'group_coord_base_zones', audience: 'group', label: 'תיאום — יש כיוון',
    help: '',
    vars: {
      day: 'היום והתאריך, לפי השעון של הקבוצה',
      zones: 'השעה בכל אזור זמן, שורה לכל אחד',
      yes: 'כמה אמרו לו כן', missing: 'תיוגים של מי שעוד לא אמר כן לזמן הזה',
    },
    required: ['day'],
    sample: {
      day: 'יום שבת 26.9', zones: '20:00 ישראל\n13:00 ניו יורק\n03:00 סידני (יום ראשון 27.9)',
      yes: '2', missing: '@+972501234567',
    },
    text: 'יש כיוון: *{{day}}* — {{yes}} כבר בפנים.\n{{zones}}\nמחכה ל{{missing}} 🤞',
  },
  {
    key: 'group_coord_relay_added_zones', audience: 'group', label: 'תיאום — ביקש להגיד משהו, והוסיף מועד',
    help: '',
    vars: { from: 'התיוג של מי שביקש', what: 'המשפט שלו, כמו שנאמר', added: 'המועד שהוא הוסיף, בכל אזורי הזמן' },
    required: ['from', 'what', 'added'],
    sample: { from: '@+972501234567', what: 'בבוקר קשה לי', added: 'יום שבת 26.9 · 20:00 ישראל · 13:00 ניו יורק · 03:00 סידני (יום ראשון 27.9)' },
    text: '{{from}}: {{what}} — הוספתי את האופציה *{{added}}* 📣',
  },
  {
    key: 'group_coord_relay_swapped_zones', audience: 'group', label: 'תיאום — ביקש להגיד משהו, והחליף מועד',
    help: '',
    vars: {
      from: 'התיוג של מי שביקש', what: 'המשפט שלו, כמו שנאמר',
      was: 'המועד שהוא הוריד, בכל אזורי הזמן', added: 'המועד שהוא הוסיף, בכל אזורי הזמן',
    },
    required: ['from', 'what', 'was', 'added'],
    sample: {
      from: '@+972501234567', what: 'בבוקר קשה לי',
      was: 'יום שבת 26.9 · 12:00 ישראל · 05:00 ניו יורק · 19:00 סידני',
      added: 'יום שבת 26.9 · 20:00 ישראל · 13:00 ניו יורק · 03:00 סידני (יום ראשון 27.9)',
    },
    text: '{{from}}: {{what}} — החלפתי את *{{was}}* באופציה של *{{added}}* 📣',
  },
  {
    key: 'group_coord_moved_zones', audience: 'group', label: 'תיאום — הזמן שנאמר כאן ירד מהשולחן',
    help: '',
    vars: {
      was: 'הזמן שהחדר שמע עליו ושכבר לא קיים, בכל אזורי הזמן',
      lead: 'שורת ״יש כיוון״ על הזמן שמוביל עכשיו — הניסוח שלה נלקח משם',
    },
    required: ['was'],
    sample: {
      was: 'יום שבת 26.9 · 12:00 ישראל · 05:00 ניו יורק · 19:00 סידני',
      lead: 'יש כיוון: *יום שבת 26.9* — 2 כבר בפנים.\n20:00 ישראל\n13:00 ניו יורק\n03:00 סידני (יום ראשון 27.9)\nמחכה ל @+972501234567 🤞',
    },
    text: '*{{was}}* כבר לא על השולחן 🔄\n{{lead}}',
  },
  {
    key: 'group_coord_table_zones', audience: 'group', label: 'תיאום — השולחן זז',
    help: '',
    vars: { count: 'כמה מועדים, כביטוי שלם ("מועד אחד" / "*3* מועדים")', lead: 'משפט שלם על המועד שהכי מתקדם, בכל אזורי הזמן, או ריק' },
    required: ['count'],
    sample: { count: '*3* מועדים', lead: 'הכי מתקדם: *יום שבת 26.9 · 20:00 ישראל · 13:00 ניו יורק · 03:00 סידני (יום ראשון 27.9)*.' },
    text: 'השולחן זז — עכשיו {{count}} על הפרק. {{lead}}',
  },
  {
    key: 'group_coord_done_zones', audience: 'group', label: 'תיאום — נסגר',
    help: '',
    vars: {
      day: 'היום והתאריך, לפי השעון של הקבוצה',
      zones: 'השעה בכל אזור זמן, שורה לכל אחד',
      who: '"כולם בפנים", או "בפנים:" ותיוגים של מי שאמר כן',
      place_ask: 'שאלה איך מתחברים — רק כשאף אחד לא אמר',
    },
    required: ['day'],
    sample: {
      day: 'יום שבת 26.9', zones: '20:00 ישראל\n13:00 ניו יורק\n03:00 סידני (יום ראשון 27.9)',
      who: 'כולם בפנים', place_ask: 'איך מתחברים? זום, מיט, וידאו בוואטסאפ — תכתבו לי ואני אוסיף ליומן 🎥',
    },
    text: 'סגור: *{{day}}* 🎉 {{who}}\n{{zones}}\n{{place_ask}}',
  },
  {
    key: 'group_coord_time_zones', audience: 'group', label: 'תיאום — נקבעה שעה',
    help: '',
    vars: { slot: 'השעה שנקבעה, בכל אזורי הזמן' }, required: ['slot'],
    sample: { slot: 'יום שבת 26.9 · 12:00 ישראל · 05:00 ניו יורק · 19:00 סידני' },
    text: 'השעה נקבעה: *{{slot}}* 🕐',
  },
  {
    key: 'group_coord_reopened_zones', audience: 'group', label: 'תיאום — נפתח מחדש',
    help: '',
    vars: { title: 'שם התיאום', was: 'הזמן שהיה סגור, בכל אזורי הזמן' }, required: ['title', 'was'],
    sample: { title: 'שיחת וידאו', was: 'יום שבת 26.9 · 12:00 ישראל · 05:00 ניו יורק · 19:00 סידני' },
    text: '🔄 התיאום *{{title}}* נפתח מחדש — *{{was}}* כבר לא סגור. הזמנים האחרים נשארים על השולחן, ואפשר להוסיף חדשים. אני שואלת כל מי שבתיאום בפרטי.',
  },
  {
    key: 'group_coord_dayof_zones', audience: 'group', label: 'תיאום — תזכורת ביום עצמו',
    help: '',
    vars: { slot: 'הזמן שנסגר, בכל אזורי הזמן' }, required: ['slot'],
    sample: { slot: 'יום שבת 26.9 · 20:00 ישראל · 13:00 ניו יורק · 03:00 סידני (יום ראשון 27.9)' },
    // No "היום": for somebody in Sydney the morning reminder may already be
    // about tomorrow.
    text: 'מזכירה — *{{slot}}* 👋',
  },
  {
    key: 'group_coord_soon_zones', audience: 'group', label: 'תיאום — שעה לפני',
    help: '',
    vars: { slot: 'הזמן שנסגר, בכל אזורי הזמן' }, required: ['slot'],
    sample: { slot: 'יום שבת 26.9 · 20:00 ישראל · 13:00 ניו יורק · 03:00 סידני (יום ראשון 27.9)' },
    text: 'עוד שעה: *{{slot}}* 🙂',
  },
];

const BY_KEY = new Map(TEMPLATES.map((t) => [t.key, t]));

// ---- one message, two languages --------------------------------------------
// A Hebrew template and its English twin are two keys (`reminder` and
// `reminder_en`, `reopen_he` and `reopen_en`) so that each is its own box and
// its own override — but to the person editing them they are ONE message, and
// the page shows them as one row with two columns. The family is the key with
// its language suffix removed; a key with no suffix is Hebrew. Label and help
// are the Hebrew member's (the twins carry the same label and an empty help).
//
// A room message can have a second shape of the same kind: `<key>_zones`, the
// one a room hears when its members live on more than one clock (owner,
// 2026-09-25 — "אני רוצה ליצור טאמפלטים גם לקבוצה עם כמה אזורי זמן"). It is a
// VARIANT and not a language, so it gets its own slot on the family and never
// displaces the Hebrew member it sits beside; label and help stay the base's.
function variantOf(key) {
  return /_zones$/.test(key) ? 'zones' : null;
}
function langOf(key) {
  return /_en$/.test(key) ? 'en' : 'he';
}
function familyOf(key) {
  return key.replace(/_zones$/, '').replace(/_(he|en)$/, '');
}
function families() {
  const out = [];
  const seen = new Map();
  for (const t of TEMPLATES) {
    const id = familyOf(t.key);
    let f = seen.get(id);
    if (!f) {
      f = { id, audience: t.audience, label: t.label, help: t.help, he: null, en: null, zones: null };
      seen.set(id, f); out.push(f);
    }
    if (variantOf(t.key)) { f.zones = t; continue; }
    f[langOf(t.key)] = t;
    if (langOf(t.key) === 'he') { f.label = t.label; f.help = t.help; }
  }
  return out;
}

// The key a sentence goes out under for a language — the one place that
// decides, so a language added later is templates and nothing else.
//
// A family is spelt one of two ways (`reminder` + `reminder_en`, or
// `opening_he` + `opening_en`), so both are tried. `lang` is anything a locale
// column holds (`he`, `he-IL`, `EN`); only the language part counts. A
// language with no template of its own gets `fallback`'s, and a language
// missing entirely (an empty locale) is `fallback` too — callers disagree on
// what that is (onboarding.openingKey falls back to Hebrew, a reminder rung to
// English) and each says so rather than this guessing for them.
function keyFor(base, lang, { fallback = 'en' } = {}) {
  const code = String(lang == null ? '' : lang).trim().toLowerCase().split(/[-_]/)[0];
  const spelt = (c) => (c === 'he' ? [`${base}_he`, base] : [`${base}_${c}`]);
  for (const c of [code || fallback, fallback, 'en', 'he']) {
    const hit = spelt(c).find((k) => BY_KEY.has(k));
    if (hit) return hit;
  }
  throw new Error(`unknown message template family: ${base}`);
}

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

// A template may WRAP a placeholder in a WhatsApp marker — `*{{title}}*` is how
// the owner turns emphasis on for a sentence, from the page, without a deploy.
// It has to be applied here rather than by the literal, because the value is
// the person's own words: WhatsApp has no escape character, so wrapping a
// title that still carries a marker of its own produces a half-bold sentence.
// Same rule as message-format.wrapInline, applied where the template asked for
// it — if the value cannot be wrapped safely it goes in bare, emphasis lost and
// sentence intact, which is the right way round. An empty value takes the
// markers with it rather than leaving `**` behind.
//
// `stripUserMarkup` has usually already cleaned the value by the time it gets
// here; this covers what that rule deliberately leaves alone (a marker glued
// inside a token, a lone unpaired one).
const WRAPPED_RE = /([*_~])\{\{\s*([a-z_]+)\s*\}\}\1/g;
const UNSAFE_TO_WRAP = /[*_~`\n]/;

function render(key, vars, overrides) {
  const v = vars || {};
  const value = (name) => (v[name] == null ? '' : String(v[name]));
  return textFor(key, overrides)
    .replace(WRAPPED_RE, (_, marker, name) => {
      const core = value(name);
      if (!core.trim()) return '';
      return UNSAFE_TO_WRAP.test(core) ? core : `${marker}${core}${marker}`;
    })
    .replace(PLACEHOLDER_RE, (_, name) => value(name));
}

// The default (or the override, when there is one) with real values in it —
// what the page shows instead of a sentence full of `{{ }}`. The owner asked
// for this (2026-09-09): a legend describing the placeholders is not the same
// as seeing the message. Samples live on the template beside the placeholders
// they fill, so one cannot be added without the other.
function example(key, overrides) {
  return render(key, spec(key).sample || {}, overrides);
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
  families, familyOf, langOf, variantOf, example, keyFor,
};
