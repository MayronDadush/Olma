#!/usr/bin/env node
'use strict';
// The messages a person actually gets — a reminder, a batch of them, the
// morning digest, a brain dump read back, a meeting update — each in a few
// styling variants, sent as real WhatsApp messages so the owner can look at
// them on a phone and say which ones work.
//
// This is a DECISION AID, not a feature. Nothing here changes what production
// sends: the variants are written out longhand so they can be argued with,
// and only the ones he picks turn into template wording or a line of
// doctrine. Kept in the repo rather than pasted into a chat because the next
// round of this question will want to edit these and send them again.
//
// The shapes are real. 1.x and 2.x are the owner's own reminder templates
// (domain/message-templates.js) restyled and nothing else; 3.x, 4.x and 5.x
// are model-written kinds, so their WORDS here are invented to be typical —
// what is being judged is the layout, not the sentences.
//
// Every variant is built through domain/message-format so a channel that
// renders no styling gets the same messages in plain text, and so nothing
// here can demonstrate a style the formatter would not actually produce.
//
// It goes out on the RAW pipe: a sampler's exact characters ARE its content,
// and a model asked to relay them would tidy the asterisks away. Same reason
// scripts/send-formatting-sampler.js does. It is an operator probe aimed at a
// phone the operator names — not gated, not budgeted, not audited. Do not
// point it at anybody but yourself.
//
// Two sets, chosen with --set:
//   places   (default) one worked example per place a style could plug into,
//            A..H — "where does each style earn its keep?"
//   variants the same everyday message in two or three layouts, 1..5 —
//            "which layout for this message?"
//
//   node scripts/send-format-preview.js --user 1                    # print A..H
//   node scripts/send-format-preview.js --user 1 --apply
//   node scripts/send-format-preview.js --user 1 --only A --apply
//   node scripts/send-format-preview.js --user 1 --set variants --apply
const { createPool } = require('../src/db/pool');
const format = require('../src/domain/message-format');
const users = require('../src/domain/users');
const { runOpenclaw } = require('../src/channels/openclaw');

// WhatsApp keeps its own order, but two sends landing in the same second have
// been seen to swap. A preview whose numbering is out of order is unreadable.
const GAP_MS = 1500;

function samples(f) {
  const b = (s) => f.bold(s);
  return [
    {
      id: '1', title: 'תזכורת בודדת', source: 'טקסט קבוע — התבנית שלך',
      variants: [
        { id: '1.1', label: 'כמו היום', text: '⏰ תזכורת: לקחת את הכביסה מהמכבסה' },
        { id: '1.2', label: 'הדבר עצמו מודגש', text: `⏰ תזכורת: ${b('לקחת את הכביסה מהמכבסה')}` },
        { id: '1.3', label: 'ציטוט', text: `⏰ תזכורת\n${f.quote('לקחת את הכביסה מהמכבסה')}` },
      ],
    },
    {
      id: '2', title: 'כמה תזכורות באותו רגע', source: 'טקסט קבוע — התבנית שלך',
      variants: [
        {
          id: '2.1', label: 'כמו היום',
          text: '⏰ תזכורות:\n• לקחת את הכביסה מהמכבסה\n• להתקשר לרואה החשבון\n• לשלם ארנונה',
        },
        {
          id: '2.2', label: 'כותרת מודגשת + רשימה של וואטסאפ',
          text: `⏰ ${b('תזכורות')}\n${f.bullets(['לקחת את הכביסה מהמכבסה', 'להתקשר לרואה החשבון', 'לשלם ארנונה'])}`,
        },
        {
          id: '2.3', label: 'ממוספר',
          text: `⏰ ${b('תזכורות')}\n${f.numbered(['לקחת את הכביסה מהמכבסה', 'להתקשר לרואה החשבון', 'לשלם ארנונה'])}`,
        },
      ],
    },
    {
      id: '3', title: 'דייג׳סט בוקר', source: 'כתוב על ידי המודל — המילים כאן להמחשה',
      variants: [
        {
          id: '3.1', label: 'כמו היום — פרוזה',
          text: 'בוקר טוב מירון 👋\n'
            + 'היום ביומן: פגישה עם דנה ב-10:00, ומשלוח מהמחסן בין 14:00 ל-16:00.\n'
            + 'על הרשימה: לשלם ארנונה, להחזיר את הטופס לגן, ולסגור סיכום עם רואה החשבון.\n'
            + 'דנה עוד לא ענתה לך על יום חמישי.\n'
            + 'הדבר הראשון היום זה הטופס לגן — הוא נסגר מחר.',
        },
        {
          id: '3.2', label: 'כותרות ורשימות',
          text: 'בוקר טוב מירון 👋\n\n'
            + `${b('ביומן היום')}\n`
            + `${f.bullets(['10:00 — פגישה עם דנה', '14:00-16:00 — משלוח מהמחסן'])}\n\n`
            + `${b('על הרשימה')}\n`
            + `${f.bullets(['לשלם ארנונה', 'להחזיר את הטופס לגן', 'לסגור סיכום עם רואה החשבון'])}\n\n`
            + 'דנה עוד לא ענתה לך על יום חמישי.\n'
            + 'הדבר הראשון היום: הטופס לגן, הוא נסגר מחר.',
        },
        {
          id: '3.3', label: 'פרוזה, רק השעות מודגשות',
          text: 'בוקר טוב מירון 👋\n'
            + `היום ביומן: פגישה עם דנה ב-${b('10:00')}, ומשלוח מהמחסן בין ${b('14:00')} ל-${b('16:00')}.\n`
            + 'על הרשימה: לשלם ארנונה, להחזיר את הטופס לגן, ולסגור סיכום עם רואה החשבון.\n'
            + 'דנה עוד לא ענתה לך על יום חמישי.\n'
            + 'הדבר הראשון היום זה הטופס לגן — הוא נסגר מחר.',
        },
      ],
    },
    {
      id: '4', title: 'בריין־דאמפ שנרשם בחזרה', source: 'כתוב על ידי המודל — המילים כאן להמחשה',
      variants: [
        {
          id: '4.1', label: 'כמו היום — פרוזה',
          text: 'רשמתי הכל 👍\n'
            + 'בבית: לתקן את הדוד ולהזמין מסננים למים.\n'
            + 'בעבודה: לשלוח הצעת מחיר ללקוח ולסגור סיכום עם רואה החשבון.\n'
            + 'ולילדים: הטופס לגן ונעליים לרוני.',
        },
        {
          id: '4.2', label: 'קטגוריות מודגשות ורשימות',
          text: 'רשמתי הכל 👍\n\n'
            + `${b('בית')}\n${f.bullets(['לתקן את הדוד', 'להזמין מסננים למים'])}\n\n`
            + `${b('עבודה')}\n${f.bullets(['לשלוח הצעת מחיר ללקוח', 'לסגור סיכום עם רואה החשבון'])}\n\n`
            + `${b('ילדים')}\n${f.bullets(['הטופס לגן', 'נעליים לרוני'])}`,
        },
        {
          id: '4.3', label: 'שורה לכל קטגוריה',
          text: 'רשמתי הכל 👍\n'
            + `${b('בית')} — לתקן את הדוד, להזמין מסננים למים\n`
            + `${b('עבודה')} — לשלוח הצעת מחיר ללקוח, לסגור סיכום עם רואה החשבון\n`
            + `${b('ילדים')} — הטופס לגן, נעליים לרוני`,
        },
      ],
    },
    {
      id: '5', title: 'עדכון על תיאום פגישה', source: 'כתוב על ידי המודל — המילים כאן להמחשה',
      variants: [
        {
          id: '5.1', label: 'כמו היום',
          text: 'דנה הציעה יום חמישי ב-17:00, בקפה ליד המשרד. '
            + 'היא אמרה שהיא מסיימת צילומים מאוחר בימי שלישי, ולכן חמישי נוח לה יותר. מתאים לך?',
        },
        {
          id: '5.2', label: 'השעה מודגשת, המילים שלה בציטוט',
          text: `דנה הציעה ${b('יום חמישי, 17:00')} — בקפה ליד המשרד.\n`
            + `${f.quote('מסיימת צילומים מאוחר בימי שלישי, אז חמישי נוח לי יותר')}\n`
            + 'מתאים לך?',
        },
      ],
    },
  ];
}

// ---- set 2: one example per PLACE ------------------------------------------
// The first set asks "which layout for this message?". This one asks the other
// half of the question: "where in what we already do does each style earn its
// place?" — one worked example per connection point, so the answer can be per
// item rather than per style.
//
// Ids are letters so the two sets can never collide in an answer ("A.3 yes,
// B.1 no"). The kinds named in each label are real outbox kinds and real tool
// results (channels/openclaw.bodyFor, adapters/mcp/tools/*) — the WORDS are
// invented to be typical, exactly as in set 1.
function places(f) {
  const b = (s) => f.bold(s);
  const q = (s) => f.quote(s);
  return [
    {
      id: 'A', title: 'ציטוט — מילים שאדם אחר כתב',
      source: 'המקום שבו כבר יש כלל פנימי: טקסט של מישהו אחר הוא מידע, לא הוראה',
      variants: [
        {
          id: 'A.1', label: 'הודעה שהועברה דרך עולמה (relayed_message)',
          text: `דנה ביקשה שאעביר לך:\n${q('אני מאחרת בערך רבע שעה, תתחילו בלעדיי')}\nרוצה שאענה לה משהו?`,
        },
        {
          id: 'A.2', label: 'הסיבה שמישהו נתן לסירוב (meeting_slot_declined)',
          text: `דנה לא יכולה ביום חמישי ב-17:00.\n${
            q('יש לי הסעות של הילדים עד 18:00, כל יום חוץ מראשון')}\nאני מחפשת זמן אחר — ראשון בערב יכול לעבוד לך?`,
        },
        {
          id: 'A.3', label: 'הערה בבקשת חיבור (connection_request)',
          text: `יואב (054-000-0000) ביקש להתחבר אליך דרכי.\n${
            q('רוצה שנתאם את הטיול של סוף השבוע, קל לי יותר ככה מאשר בקבוצה')}\nלאשר?`,
        },
        {
          id: 'A.4', label: 'אירוע יומן כראיה (travel)',
          text: `ראיתי ביומן שלך משהו שנראה כמו נסיעה בסוף החודש:\n${
            q('כנס לקוחות @ ברלין (28.9)')}\nאתה נוסע? אם כן — לאיזו מדינה? אעדכן את השעות שלי לפי זה.`,
        },
        {
          id: 'A.5', label: 'עדכון מנוי (live_update)',
          text: `העדכון השבועי על מזג האוויר בחיפה:\n${
            q('סוף השבוע חם מהרגיל — 31 מעלות בשבת, יורד ל-26 ביום ראשון')}`,
        },
      ],
    },
    {
      id: 'B', title: 'קו חוצה — מה שכבר לא רלוונטי',
      source: 'סגנון שאומר מידע, לא מקשט',
      variants: [
        {
          id: 'B.1', label: 'הזזת תאריך (snooze_task)',
          text: `הזזתי את "לקחת את הרכב לטסט":\n${f.strikethrough('מחר 09:00')}\n${b('יום ראשון 09:00')}`,
        },
        {
          id: 'B.2', label: 'מה שסומן ברשימה משותפת (view_shared_tasks)',
          text: `דנה סימנה כמה דברים ברשימה המשותפת שלכם:\n\n${b('קניות לשבת')}\n${
            f.bullets([f.strikethrough('חלה'), f.strikethrough('יין'), 'סלט', 'פרחים'])}`,
        },
        {
          id: 'B.3', label: 'מה שנארכב לבד (tasks_auto_archived)',
          text: `ניקיתי מהרשימה שני דברים שהזמן שלהם עבר:\n${
            f.bullets([f.strikethrough('להזמין מקום למסעדה ל-3.9'), f.strikethrough('לשלוח את הטופס עד 5.9')])
          }\nאם משהו מהם עדיין רלוונטי — תגיד לי ואחזיר.`,
        },
        {
          id: 'B.4', label: 'אופציה שירדה מהשולחן (get_meeting_status)',
          text: `${b('המצב בתיאום "ערב משחקים"')}\n`
            + '1. יום שלישי 20:00 — דנה ✅, יואב ✅\n'
            + `2. ${f.strikethrough('יום רביעי 20:00')} — ירד, שניים לא יכולים\n`
            + '3. שבת 19:00 — דנה ✅\n'
            + 'מה מהם מתאים לך?',
        },
      ],
    },
    {
      id: 'C', title: 'ממוספר מול תבליטים — כשהתשובה היא בחירה',
      source: 'הסגנון היחיד שמשנה תפקוד ולא מראה: אפשר לענות "2"',
      variants: [
        {
          id: 'C.1', label: 'ממוספר',
          text: 'יש שלוש אפשרויות על השולחן ל"פגישת צוות":\n'
            + `${f.numbered(['יום שני 10:00', 'יום שלישי 14:00', 'יום חמישי 09:30'])}\n`
            + 'אפשר פשוט לענות לי מספר.',
        },
        {
          id: 'C.2', label: 'אותו דבר בתבליטים — להשוואה',
          text: 'יש שלוש אפשרויות על השולחן ל"פגישת צוות":\n'
            + `${f.bullets(['יום שני 10:00', 'יום שלישי 14:00', 'יום חמישי 09:30'])}\n`
            + 'מה מתאים לך?',
        },
      ],
    },
    {
      id: 'D', title: 'רשימות — כל מקום שקוראים בו רשימה בחזרה',
      source: 'הקבוצה הגדולה ביותר: 12 כלים מחזירים רשימה',
      variants: [
        {
          id: 'D.1', label: 'רשימת קניות (shopping-list)',
          text: `פירקתי לך את זה לרשימה 👍\n\n${b('קניות')}\n${
            f.bullets(['חלב', 'קוטג׳', 'גבינה צהובה', 'לחם פרוס'])}`,
        },
        {
          id: 'D.2', label: 'מה פתוח אצלך (list_my_tasks)',
          text: 'זה מה שפתוח אצלך עכשיו:\n\n'
            + `${b('היום')}\n${f.bullets(['להחזיר את הטופס לגן', 'לשלם ארנונה'])}\n\n`
            + `${b('השבוע')}\n${f.bullets(['לסגור סיכום עם רואה החשבון', 'לתקן את הדוד'])}\n\n`
            + `${b('בלי תאריך')}\n${f.bullets(['להזמין מסננים למים'])}`,
        },
        {
          id: 'D.3', label: 'תזכורות שעוד לפניך (list_my_reminders)',
          text: `${b('התזכורות שעוד לפניך')}\n${f.bullets([
            'מחר 08:00 — הטופס לגן',
            'ראשון 09:00 — רכב לטסט',
            'כל יום 12:00 — החזרים לקופה',
          ])}`,
        },
        {
          id: 'D.4', label: 'היומן (my_calendar_events)',
          text: `${b('מחר ביומן')}\n${f.bullets([
            '09:00 — סטנדאפ',
            '11:30 — דנה, קפה ליד המשרד',
            '16:00 — הורים־מורים',
          ])}\nהבוקר שלך צפוף, ומ-13:00 עד 16:00 אתה פנוי.`,
        },
      ],
    },
    {
      id: 'E', title: 'מודגש — העוגן שצריך לתפוס בגלילה',
      source: 'השעה, מי מדבר, ומילת המצב',
      variants: [
        {
          id: 'E.1', label: 'השעה שנסגרה (meeting_confirmed)',
          text: `סגור 🎉 ${b('יום חמישי, 17:00')} — קפה ליד המשרד.\nהוספתי ליומן והזמנתי את דנה.`,
        },
        {
          id: 'E.2', label: 'מי מדבר (share_offer)',
          text: `${b('יואב')} מציע לשתף אותך במשימה "ציוד לטיול" — תוכלו להוסיף ולסמן ביחד.\nלאשר?`,
        },
        {
          id: 'E.3', label: 'מילת המצב (meeting_cancelled)',
          text: `${b('בוטל')} — דנה ביטלה את הפגישה של יום חמישי ב-17:00.\n`
            + 'היא הייתה כבר סגורה, אז הורדתי אותה מהיומן שלך.',
        },
        {
          id: 'E.4', label: 'בקבוצה (group_coord_done)',
          text: `סגור: ${b('יום שלישי 20:00')} 🎉`,
        },
      ],
    },
    {
      id: 'H', title: 'טקסט שאדם כתב, עם הדגשה בפנים',
      source: 'מה שקורה אחרי הניקוי שביקשת',
      variants: [
        {
          id: 'H.1', label: 'הכוכביות שלו נעלמות, המילים נשארות',
          text: 'נניח שנשמר אצלך "לקנות חלב *דל לקטוז*". '
            + 'התזכורת יוצאת בלי הכוכביות — הן לא נשמרו כהדגשה שמישהו בחר, '
            + 'והמילים בטבלה נשארו בדיוק כמו שנכתבו:\n\n'
            + '⏰ תזכורת: לקנות חלב דל לקטוז',
        },
        {
          id: 'H.2', label: 'מה שהניקוי לא נוגע בו, בכוונה',
          text: 'סימן שדבוק לתוך מילה הוא חלק מהמילה, לא הדגשה — אז הוא נשאר:\n'
            + `${f.bullets(['לשלוח את report_final_v2', 'להגיע בין 7~8 בערב', 'להזמין 3 * 4 שולחנות'])}\n`
            + 'למחוק סימן מתוך המילים של מישהו זה משהו שמותר לטעות בו פעם אחת, '
            + 'ולכן הכלל מצומצם בכוונה.',
        },
      ],
    },
  ];
}

const SETS = { variants: samples, places };

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

async function target() {
  const to = arg('--to');
  const userId = arg('--user');
  if (to) return { phone: to, channelType: 'whatsapp', pool: null };
  if (!userId) throw new Error('one of --to <E.164> or --user <id> is required');
  const pool = createPool();
  const client = await pool.connect();
  try {
    const ch = await users.primaryChannel(client, Number(userId));
    if (!ch.ok) throw new Error(`user ${userId}: ${ch.error.message}`);
    return { phone: ch.data.channel.channel_identifier, channelType: ch.data.channel.channel_type, pool };
  } finally {
    client.release();
  }
}

// The label is what makes an answer possible ("2.2 כן, 4.3 לא"), and it rides
// INSIDE the message because a phone shows no other place to put it. It is
// not part of any variant — read every message from its second line down.
function labelled(v) {
  return `[${v.id}] ${v.label}\n\n${v.text}`;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const only = arg('--only');
  const { phone, channelType, pool } = await target();
  try {
    const setName = arg('--set') || 'places';
    const build = SETS[setName];
    if (!build) throw new Error(`--set must be one of: ${Object.keys(SETS).join(', ')}`);
    const groups = build(format.formatterFor(channelType))
      .filter((g) => !only || g.id === only.toUpperCase() || g.id === only);
    if (!groups.length) throw new Error(`--only ${only} matches no group in set "${setName}"`);

    const queue = [];
    for (const g of groups) {
      console.log(`\n===== ${g.id}. ${g.title}  (${g.source}) =====`);
      for (const v of g.variants) {
        const text = labelled(v);
        queue.push(text);
        console.log(`\n${'-'.repeat(52)}\n${text}`);
      }
    }
    console.log(`\n${'-'.repeat(52)}`);
    console.log(`\n${queue.length} messages → ${phone} (${channelType})`);

    if (!apply) {
      console.log('Dry run. Re-run with --apply to send them.');
      return;
    }
    for (const [i, text] of queue.entries()) {
      const res = await runOpenclaw([
        'message', 'send', '--channel', channelType, '--target', phone, '--message', text,
      ]);
      // A timeout on this pipe is not a failure — the CLI hands the message
      // over and only then waits (channels/openclaw.runOpenclaw) — so it is
      // reported and the run continues rather than stopping mid-preview.
      if (res.ok) console.log(`sent ${i + 1}/${queue.length}`);
      else if (res.timedOut) console.log(`sent? ${i + 1}/${queue.length} — CLI timed out after handing it over`);
      else console.log(`FAILED ${i + 1}/${queue.length}: ${res.error}`);
      if (i < queue.length - 1) await new Promise((r) => setTimeout(r, GAP_MS));
    }
  } finally {
    if (pool) await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
