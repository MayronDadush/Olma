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
//   node scripts/send-format-preview.js --user 1              # print only
//   node scripts/send-format-preview.js --user 1 --apply
//   node scripts/send-format-preview.js --user 1 --only 3 --apply
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
    const groups = samples(format.formatterFor(channelType))
      .filter((g) => !only || g.id === only);
    if (!groups.length) throw new Error(`--only ${only} matches no group`);

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
