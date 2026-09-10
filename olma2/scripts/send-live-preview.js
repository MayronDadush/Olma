#!/usr/bin/env node
'use strict';
// What THIS person's messages actually look like, rendered by the code that
// will render them.
//
// The two preview scripts beside this one show hand-written samples — useful
// for deciding a layout, useless for deciding whether the layout SHIPPED.
// Everything here goes through the production functions:
// `proactive-text.renderReminderText`, `digest-block.renderDigestBlock`,
// `intake/messages.introMessage`, `proactive-text.renderGroupCoordination`.
// So a template the owner reworded, a locale on the users row, a channel that
// renders nothing — all of it is in the output, because none of it is
// simulated here.
//
// The DATA is invented (a plausible morning, three plausible reminders); the
// RENDERING is not. That is the whole point: what is on trial is the layout,
// and inventing the layout would have been testing my own prose.
//
// Overrides come from the live `message_templates` flag, so the sentences are
// whatever the admin page says today — never the defaults unless that is what
// is stored. Without a database (`--print` with no --user) it falls back to
// the defaults and says so, because "these are your words" would otherwise be
// a claim nothing checked.
//
// Same operator-probe framing as the other two: the raw pipe, no gate, no
// budget, no audit. Point it at yourself.
//
//   node scripts/send-live-preview.js --user 1              # print only
//   node scripts/send-live-preview.js --user 1 --apply
//   node scripts/send-live-preview.js --print --locale en   # no DB needed
const { createPool } = require('../src/db/pool');
const users = require('../src/domain/users');
const templates = require('../src/domain/message-templates');
const proactiveText = require('../src/domain/proactive-text');
const digestBlock = require('../src/domain/digest-block');
const listBlock = require('../src/domain/list-block');
const messages = require('../src/intake/messages');
const { sendRawMessage } = require('../src/channels/openclaw');

const GAP_MS = 1500;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

// A person's own words stay their own words, so an English speaker's titles
// are English here. Not a rendering rule — the renderer never translates
// anything — but a preview whose Hebrew titles sit under English rungs reads
// as a bug that is not there.
const WORDS = {
  he: {
    car: 'לקחת את הרכב לטסט', accountant: 'להתקשר לרואה החשבון', rates: 'לשלם ארנונה',
    milk: 'לקנות חלב *דל לקטוז*', file: 'לשלוח את report_final_v2',
    dana: 'פגישה עם דנה', cafe: 'קפה ליד המשרד', delivery: 'משלוח מהמחסן',
    school: 'הורים־מורים', form: 'להחזיר את הטופס לגן', boiler: 'לתקן את הדוד',
    inviter: 'יואב', reason: 'לתאם את הטיול של סוף השבוע', slot: 'יום שלישי 20:00',
  },
  en: {
    car: 'take the car for its test', accountant: 'call the accountant', rates: 'pay the council tax',
    milk: 'buy *lactose-free* milk', file: 'send report_final_v2',
    dana: 'coffee with Dana', cafe: 'the cafe by the office', delivery: 'warehouse delivery',
    school: 'parents evening', form: 'return the nursery form', boiler: 'fix the boiler',
    inviter: 'Yoav', reason: 'to sort out the weekend trip', slot: 'Tuesday 20:00',
  },
};

function wordsFor(locale) {
  return String(locale || '').trim().toLowerCase().startsWith('en') ? WORDS.en : WORDS.he;
}

// A morning worth looking at: something timed today, something with an end,
// something tomorrow, a whole-day task, one with no date at all. Every shape
// the block has a branch for, so nothing in it goes unseen.
function sampleDigest(now, w) {
  const day = 24 * 3600_000;
  const at = (base, h, m) => new Date(base + h * 3600_000 + (m || 0) * 60_000).toISOString();
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const t0 = midnight.getTime();
  return {
    events: [
      { title: w.dana, due_at: at(t0, 10), location: w.cafe },
      { title: w.delivery, due_at: at(t0, 14), ends_at: at(t0, 16) },
      { title: w.school, due_at: at(t0 + day, 18, 30) },
    ],
    tasks: [
      { title: w.rates, due_at: at(t0, 0) },
      { title: w.form, due_at: at(t0 + day, 0) },
      { title: w.boiler, due_at: null },
    ],
  };
}

function build({ locale, channelType, overrides, now }) {
  const w = wordsFor(locale);
  const out = [];
  const add = (label, text) => { if (text) out.push({ label, text }); };
  const at = (h) => new Date(now + h * 3600_000).toISOString();
  const rem = (payload) => proactiveText.renderReminderText(payload, overrides, locale, channelType);

  // 1-3: the ladder, as it really renders. Rung 1 is a moment they chose;
  // 2 and 3 are Olma's, and each says its own way out.
  add('תזכורת — שלב 1', rem({ title: w.car }));
  add('תזכורת — שלב 2', rem({ title: w.car, attempt: 2 }));
  add('תזכורת — שלב 3 (אחרונה)', rem({ title: w.car, attempt: 3, finalAttempt: true }));

  // 4: several due in the same minute — one message, the list template.
  add('כמה תזכורות באותו רגע', rem({
    items: [w.car, w.accountant, w.rates],
  }));

  // 5: the case worth seeing with your own eyes — a title the PERSON typed
  // with asterisks in it. Their markers are cleaned; the template's own pair
  // still bolds the title; a marker glued inside a word survives.
  add('כותרת שהמשתמש כתב עם כוכביות', rem({ title: w.milk }));
  add('כותרת עם סימן שדבוק למילה', rem({ title: w.file }));

  // 6: the morning block, drawn.
  add('רשימת הבוקר (הבלוק שהקוד מצייר)',
    digestBlock.renderDigestBlock(sampleDigest(now, w), { locale, channelType, now }));

  // 6b-6c: the two lists a person asks for by name, drawn by the same code
  // that draws the morning. The reminder one is here because its hours are
  // the whole content — and because `chasing` is passed in deliberately, to
  // be seen NOT appearing.
  add('רשימת המשימות (הבלוק שהקוד מצייר)', listBlock.renderTaskListBlock({
    tasks: [
      { title: w.dana, kind: 'event', due_at: at(4), ends_at: at(5), location: w.cafe },
      { title: w.school, kind: 'event', due_at: at(30) },
      { title: w.rates, kind: 'todo', due_at: at(26) },
      { title: w.milk, kind: 'todo' },
      { title: w.boiler, kind: 'todo' },
    ],
  }, { locale, channelType, now }));
  add('רשימת התזכורות (הבלוק שהקוד מצייר)', listBlock.renderReminderListBlock({
    reminders: [
      { title: w.car, remind_at: at(3) },
      { title: w.accountant, remind_at: at(27), repeat_rule: 'weekly:MO,TH' },
      { title: w.file, remind_at: at(50) },
    ],
    chasing: [{ id: 1, taskId: 1, title: w.form, askedFor: at(-20), rungsSent: 1 }],
  }, { locale, channelType, now }));

  // 7: the first sentence a stranger reads.
  add('פנייה ראשונה לאדם חדש', messages.introMessage({
    inviterName: w.inviter,
    inviterPhone: '054-000-0000',
    reason: w.reason,
    phone: String(locale || '').toLowerCase().startsWith('en') ? '+1555' : '+972500000000',
  }, overrides));

  // 8-9: what a room hears. Always WhatsApp by definition, so these do not
  // follow the channel — they are here because the slot is bolded now and the
  // tags must NOT be.
  const groups = proactiveText;
  add('בקבוצה — יש כיוון', groups.renderGroupCoordination({
    kind: 'base', slot: w.slot, yes: 3, missing: ['+972501234567'],
  }, overrides));
  add('בקבוצה — נסגר', groups.renderGroupCoordination({
    kind: 'done', slot: w.slot,
  }, overrides));

  return out;
}

async function target() {
  const to = arg('--to');
  const userId = arg('--user');
  if (!userId) {
    // No database: defaults only, and the caller is told so rather than left
    // to assume these are the sentences on the admin page.
    return {
      phone: to, channelType: 'whatsapp', locale: arg('--locale') || 'he',
      overrides: {}, live: false, pool: null,
    };
  }
  const pool = createPool();
  const client = await pool.connect();
  try {
    const u = await users.getById(client, Number(userId));
    if (!u) throw new Error(`no user ${userId}`);
    const ch = await users.primaryChannel(client, u.id);
    if (!ch.ok) throw new Error(`user ${userId}: ${ch.error.message}`);
    return {
      phone: to || ch.data.channel.channel_identifier,
      channelType: ch.data.channel.channel_type,
      locale: u.locale,
      overrides: await templates.load(client),
      live: true,
      pool,
    };
  } finally {
    client.release();
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const now = Date.now();
  const t = await target();
  try {
    const items = build({ ...t, now });
    console.log(`locale ${t.locale} · channel ${t.channelType} · wording ${t.live ? 'live (message_templates)' : 'DEFAULTS — no database read'}`);
    for (const { label, text } of items) {
      console.log(`\n${'-'.repeat(52)}\n[${label}]\n\n${text}`);
    }
    console.log(`\n${'-'.repeat(52)}\n\n${items.length} messages${t.phone ? ` → ${t.phone}` : ''}`);

    if (!apply) {
      console.log('Dry run. Re-run with --apply to send them.');
      return;
    }
    if (!t.phone) throw new Error('--apply needs --user or --to');
    for (const [i, { label, text }] of items.entries()) {
      const res = await sendRawMessage({
        channel: t.channelType, target: t.phone, message: `[${label}]\n\n${text}`,
      });
      if (res.ok) console.log(`sent ${i + 1}/${items.length}`);
      else if (res.timedOut) console.log(`sent? ${i + 1}/${items.length} — handed over, then timed out`);
      else console.log(`FAILED ${i + 1}/${items.length}: ${res.error}`);
      if (i < items.length - 1) await new Promise((r) => setTimeout(r, GAP_MS));
    }
  } finally {
    if (t.pool) await t.pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
