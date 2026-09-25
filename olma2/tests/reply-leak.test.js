'use strict';
// The gate between the model's text and somebody's phone.
//
// The founding case is Yahav's, 2026-09-10 08:28: he asked for a reminder at
// 13:00, the reminder was armed correctly, and what arrived was the model
// working out whether it had been — our column names, an ISO instant, a
// paragraph about the turn context, in English, about him in the third person.
// It is replayed here whole, exactly as it reached his phone, because a check
// whose failure cannot be written down is one nobody will trust in six weeks.
//
// The second case is the one this repo already recorded and could not stop:
// two English paragraphs of working notes above a Hebrew answer (2026-09-07).
// That one must lose the notes and KEEP the answer, which is the whole reason
// the rule is "everything up to the last dropping line" and not "cancel".
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser } = require('./helpers');
const leak = require('../src/domain/reply-leak');
const hebrewQuality = require('../src/domain/hebrew-quality');
const { createBrokerServer } = require('../src/brokerd/server');
const { resendableVerbatim } = require('../src/jobs/unanswered');
process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `reply-leak-plugin-test-${process.pid}.log`);

let db, broker, plugin;
before(async () => {
  db = await freshDb();
  broker = createBrokerServer({ pool: db.pool, placeMark: () => ({ attempted: false }) });
  plugin = await import('../gateway-plugin/olma-turn/index.js');
});
after(async () => { await db.teardown(); });

// Yahav's message, as delivered. The last line is the sentinel the whole thing
// was building towards: the model had decided there was nothing to say, and
// said all of that instead.
const YAHAV = [
  'הם אמרו 13:00 — due_at נקבע ל-13:00. remind_at שמרתי 13:00, שזה הזמן שהם אמרו — לא צריך להזכיר לפני, זה בדיוק בשעה שהם ביקשו. The reminder is set for 13:00 their time.',
  '',
  "Wait, let me re-check — remind_at was set to 2026-09-10T10:00:00Z which is 13:00 in Asia/Jerusalem. That's correct — the reminder will fire at 13:00 exactly as they asked. And due_at also at 13:00. Good.",
  '',
  "The hints say a 👍 was placed and the reminder is armed for the hour they named, so nothing to add — unless there's an undelivered reply from before.",
  '',
  'Looking at the turn context: it says one of their recent messages was read but produced no reply. The only message I see in this session is theirs.',
  '',
  'NO_REPLY',
].join('\n');

// The 2026-09-07 shape: notes first, the message last.
const NOTES_ABOVE = [
  'I see they replied about the credit card. Let me check what due_at was stored for that task before answering.',
  'The task is there and the reminder is armed.',
  '',
  'סגור, אזכיר לך היום ב-13:00 לבטל את האשראי 🙏',
].join('\n');

// Ordinary messages, the shapes Olma really sends. None of them may move.
const ORDINARY = [
  'סגור, אזכיר לך ב-13:00 🙏',
  'רשמתי לך: לבטל את האשראי, היום ב-13:00.',
  'בוקר טוב! יש לך היום פגישה ב-11:00 ושתי משימות פתוחות.',
  'Got it — I will remind you at 13:00 today.',
  'הנה קישור לחיפוש: https://www.google.com/search?q=bank_leumi+service_hours',
  'ביטלתי את התזכורת. משהו נוסף?',
  'כתבת "due_at" — לא בטוחה שהבנתי, תוכל לנסח מחדש?',
  'אשמח לעזור. מתי נוח לך?',
  // Written on 2026-09-15 to break the two tiers added that day, and kept
  // because a drop tier is only as good as the sentences it leaves alone.
  // An emoji as a sign-off hands nobody a mark; a reply verb with no mark after
  // it is Olma saying when she will answer; and a bare third-person opening is
  // a real relay whenever what follows is somebody else's news rather than the
  // reader's own words quoted back.
  'תודה! 🙏',
  'סגור 👍',
  'אשיב לך ברגע שאדע יותר.',
  'אענה לך אחרי הפגישה 🙏',
  'אחזור אליך בהקדם 👍',
  'I will answer you later today.',
  'They asked me to remind you tomorrow.',
  'הם אמרו שיגיעו מחר בבוקר.',
  'היא אמרה שזה בסדר מבחינתה.',
  'מיכאל אמר שהוא מגיע ב-7.',
  'הוא אמור להגיע ב-8.',
  'ביקשתי ממנו להגיב לך.',
  // Written on 2026-09-15 for the deliberation tier, which is the first one
  // that drops plain English with no marker in it. Each is a shape the tier
  // fires on — "Let me", "Actually,", a third-person opening, "I should",
  // "So", "OK" — used the way a person uses it, and each must reach the phone.
  'Let me know if that works for you.',
  'Let me know when you land 🙏',
  'Actually, the meeting moved to 6pm.',
  'He asked me to pass on that he is running late.',
  'She said she will be there at 8.',
  'They want to meet on Thursday instead.',
  'I should have this ready by noon.',
  'I need your address for the delivery.',
  'Sure, I will look into it and get back to you.',
  'So, tomorrow at 10 works?',
  'OK, see you at the office.',
  'The reminder is set for 13:00 👍',
];

// 2026-09-15, twice in ninety minutes, to a bare "תודה". The gate passed both
// byte for byte — every word of them is ordinary Hebrew or ordinary English and
// neither carries a column name, an instant or a frame. What they carry is the
// SHAPE: Olma opening by quoting the person's own message back at them in the
// third person, and then naming the mark she was about to place.
const THANKS_HE = 'הוא אמר "תודה" על כך שעדכנתי את התזכורת ל-18:00. תודה פשוטה — 👍 בחזרה.';
const THANKS_EN = [
  'He said "תודה" again, this time replying to the recent reminder about "לדבר עם מיכאל" that is still chasing.',
  '',
  'Since the hint says a bare "תודה" is probably about the newest reminder, and there is no instruction to act on — just a thanks — I will reply with 👍.',
].join('\n');

// Miron, 2026-09-15 09:03:06. Two paragraphs of plain English narration, and
// only the LAST line carries the sentinel. The gate found exactly that one
// leak, `sentinel` never condemned a paragraph, and the whole draft went out
// with the token stripped: "...I should reply ." (audit_log `reply.gated`,
// kept: 305 — reproduced byte for byte against this text).
const MIRON_SENTINEL = [
  'He replied to the reminder about talking to Ester and said "תמחק את המשימה" '
    + '— the task was archived, the 👍 was placed.',
  '',
  'The hint says a 👍 was already placed and if all I have is a plain instruction '
    + 'with nothing to add, I should reply NO_REPLY.',
].join('\n');

// Miron, 2026-09-15 09:48:32, a --deliver turn carrying a scheduled update.
// The gate cut every paragraph that named the sentinel or `turn_start`
// (audit: chars 800, kept 364, kinds sentinel+internal) — and the paragraph
// right after the cut, "Let me deliver the model update naturally.", carried
// no marker at all, so it reached his phone as the first line of the update.
// That paragraph is what the deliberation tier was measured for.
// Reconstructed from the transcript on the box; the English is verbatim, the
// Hebrew reply is paraphrased, and only the English is what the test is about.
const MIRON_DELIVERY = [
  'He sent "תמחק את המשימה" earlier and I replied with NO_REPLY because the 👍 was placed. Now I have two things:',
  '',
  '1. The reminder about "לדבר עם אסתר" was done (NO_REPLY already handled).',
  '2. The subscription update about new OpenRouter models.',
  '',
  'But first — the user\'s message hasn\'t appeared yet. The turn_start says `directive: proceed` with no actual message from the person yet. This is a delivery turn for the scheduled update only.',
  '',
  'Let me deliver the model update naturally.',
  '',
  'היי 👋 עדכון מודלים מ-OpenRouter:',
  '> מודלים חדשים: DeepSeek Pro Latest – $0.96 לקלט, $2.88 לפלט; DeepSeek Flash Latest – $0.15 לקלט, $0.60 לפלט. שניהם מודלי טקסט בלבד.',
  'Flash Latest פחות או יותר אותו מחיר כמו הנוכחי, Pro יקר משמעותית. שום דבר מרעיש בתחום התמונות והוידאו כרגע.',
].join('\n');

test('Yahav\'s message: every paragraph of the working-out is found, and nothing was left to deliver', () => {
  const v = leak.gateReply(YAHAV);
  assert.equal(v.action, 'cancel');
  assert.equal(v.text, '');
  // What each paragraph was caught by, in the order it appears. The third
  // paragraph carries no marker of its own — it is dropped because a LATER
  // line does, which is the rule this case exists to hold open.
  assert.deepEqual(v.reported.map((l) => `${l.line}:${l.kind}:${l.at}`), [
    '0:internal:due_at',
    '0:narration:הם אמרו 1',
    '2:internal:remind_at',
    '2:deliberation:let me re-check',
    '2:instant:2026-09-10T10:00:00Z',
    '4:block:The hints say',
    '6:block:turn context',
    '6:deliberation:Looking at the turn context',
    '8:sentinel:NO_REPLY',
  ]);
  assert.ok(v.leaks.length >= 4, 'all of them changed the message');
  // The two tiers added on 2026-09-15 read the founding case too, and that is
  // the argument for them: `narration` on its opening and `block` on its third
  // paragraph both fire on shape alone. Yahav's leak named our columns and was
  // caught for it; the two that followed named nothing and were not. Strip
  // every column name out of this message and it still does not go out.
  const shapeOnly = v.reported.filter((l) => l.kind === 'narration' || l.at === 'The hints say');
  assert.equal(shapeOnly.length, 2, 'the shape tiers see it without help from the closed list');
  // And the measured tier, which came last, reads two of its paragraphs on
  // shape alone as well ("let me re-check", "Looking at the turn context").
  assert.equal(v.reported.filter((l) => l.kind === 'deliberation').length, 2);
});

// The pair that reopened this on 2026-09-15. Neither is caught by anything the
// gate knew on 2026-09-10: the whole point of them is that the working-out was
// written in the person's own language with none of our names in it.
test('a thanks answered with the working-out: both languages, nothing delivered', () => {
  const he = leak.gateReply(THANKS_HE);
  assert.equal(he.action, 'cancel');
  assert.equal(he.text, '');
  assert.deepEqual(he.reported.map((l) => `${l.kind}:${l.at}`), [
    'mark:👍 בחזרה',
    'narration:הוא אמר "',
  ]);

  const en = leak.gateReply(THANKS_EN);
  assert.equal(en.action, 'cancel');
  assert.equal(en.text, '');
  // Three separate tells, on two paragraphs: the opening quotation, the name of
  // our own hints object, and the mark handed to the act of replying.
  assert.deepEqual(en.reported.map((l) => `${l.line}:${l.kind}`), [
    '0:narration',
    '0:deliberation',
    '2:block',
    '2:mark',
  ]);
});

// Report-only, and that has to be visible: a finding that changes nothing must
// still leave the message byte for byte, or `trim`'s own `.trim()` eats the
// whitespace of a reply nobody had a complaint about.
test('narration alone is reported and delivered unchanged', () => {
  const text = 'הוא אמר "בסדר" ונסגר.';
  const v = leak.gateReply(text);
  assert.equal(v.action, 'pass');
  assert.equal(v.text, text, 'delivered byte for byte');
  assert.deepEqual(v.leaks, [], 'nothing about the message changed');
  assert.equal(v.reported.length, 1);
  assert.equal(v.reported[0].kind, 'narration');
});

// `\b` after a Hebrew word never matches — Hebrew letters are not `\w`, so
// there is no boundary between one and the space after it. The first draft of
// the narration pattern used `\b` and read 0/3 on the real leaks while looking
// entirely correct. The lookahead is what replaces it, and this is the case
// that would have caught the dead regex.
test('the Hebrew narration pattern is not boundary-dead', () => {
  assert.match('הם אמרו 13:00 — הכל סגור.', leak.NARRATION_RE);
  assert.match('הוא אמר "תודה".', leak.NARRATION_RE);
  assert.doesNotMatch('הוא אמור להגיע ב-8.', leak.NARRATION_RE, 'אמור is not אמר');
});

test('notes above an answer lose the notes and keep the answer', () => {
  const v = leak.gateReply(NOTES_ABOVE);
  assert.equal(v.action, 'trim');
  assert.equal(v.text, 'סגור, אזכיר לך היום ב-13:00 לבטל את האשראי 🙏');
});

test('an ordinary reply is delivered byte for byte', () => {
  for (const text of ORDINARY) {
    const v = leak.gateReply(text);
    assert.equal(v.action, 'pass', `moved: ${text} → ${JSON.stringify(v)}`);
    assert.equal(v.text, text);
    assert.deepEqual(v.leaks, []);
  }
});

// The sentinel is the one marker that never drops its line, because
// jobs/unanswered.js reads "בוצע NO_REPLY" as a real reply on purpose (the
// doctrine says the words in front of it are delivered). A gate that cancelled
// it would delete the one word the person was owed.
test('the silence sentinel: alone it is a decision, with words it is a stray token', () => {
  assert.deepEqual(leak.gateReply('NO_REPLY'), { action: 'pass', text: 'NO_REPLY', leaks: [], reported: [] });
  assert.deepEqual(leak.gateReply('  NO_REPLY\n').action, 'pass');
  const v = leak.gateReply('בוצע NO_REPLY');
  assert.equal(v.action, 'trim');
  assert.equal(v.text, 'בוצע');
  assert.equal(leak.gateReply('NO_REPLY\n\nNO_REPLY').action, 'cancel');
});

// Miron, 2026-09-15: the gate found exactly one leak — `sentinel`, on the LAST
// line — and, under the rule above ("with words it is stripped"), delivered
// every word in front of it anyway. Nothing else in the draft matched
// anything (plain English narration, no column name, no frame, no instant),
// so `drops()` never fired for any paragraph and the sentinel-strips-in-place
// rule reached all the way back to the first line. What arrived on his phone
// was the whole draft with the literal string "NO_REPLY" removed:
//   "...I should reply ."
// — a dangling sentence exactly where the token used to be
// (`incidents.md`, "The sentinel that only stripped itself").
//
// `hasEarlierContent` distinguishes this from "בוצע NO_REPLY" above by the one
// fact the doctrine itself names: is there real content BEFORE the sentinel's
// line. "בוצע NO_REPLY" has none — one line, nothing before it. Miron's draft
// has two paragraphs of narration before the line carrying the token, so the
// sentinel now condemns through its own paragraph like any other leak, and
// with nothing else in the draft to keep, the whole thing cancels.
test('Mirons message: narration ending in the sentinel is a leak, not a stray token', () => {
  const v = leak.gateReply(MIRON_SENTINEL);
  assert.equal(v.action, 'cancel');
  assert.equal(v.text, '');
  // `block` is the same day's other fix seeing "The hint says"; `sentinel` is
  // this one; `deliberation` is the measured tier that came that evening,
  // reading the third-person opening about the reader. Any one alone cancels
  // the draft now, and the next case proves the sentinel half stands on its own.
  assert.deepEqual(v.leaks.map((l) => l.kind).sort(), ['block', 'deliberation', 'sentinel']);

  // The same shape with nothing else for the gate to hold on to — no hint
  // cited, no mark handed to a verb, no quotation after a pronoun. Only the
  // sentinel, only on the last line, with narration in front of it.
  const bare = MIRON_SENTINEL.replace('The hint says a 👍 was already placed', 'A 👍 was already placed');
  const b = leak.gateReply(bare);
  assert.equal(b.action, 'cancel');
  assert.deepEqual(b.leaks.filter((l) => l.kind !== 'deliberation').map((l) => l.kind), ['sentinel']);
});

test('a real short reply plus a trailing sentinel on the SAME line still just strips the token', () => {
  // The exact case the rule exists to protect, restated with narration on
  // EITHER side to prove the fix is about POSITION, not about banning the
  // combination outright: a sentinel with nothing before it never condemns,
  // whatever comes on its own line.
  const v = leak.gateReply('בוצע, סגרתי את המשימה NO_REPLY');
  assert.equal(v.action, 'trim');
  assert.equal(v.text, 'בוצע, סגרתי את המשימה');
});

test('KNOWN GAP: narration and the sentinel crammed onto ONE line, no break at all, still only strips the token', () => {
  // `hasEarlierContent` reads LINES, and both real incidents on file (Yahav's,
  // Miron's) are multi-line — models write reasoning as separate sentences or
  // paragraphs. A single unbroken line of prose ending in NO_REPLY has no
  // known real example to measure a fix against, so none is guessed here
  // (CLAUDE.md, "A hint that fires on ordinary input is worse than no hint" —
  // the same rule cuts the other way too: don't ship a detector for a shape
  // nobody has seen). Documented as a gap, not silently accepted: if this
  // shape shows up for real, it belongs in the incident story above it and a
  // new test right here, exactly like the last two additions to this file.
  // Since the deliberation tier the gap is NARROWER than it was: a one-liner
  // that opens on the reader in the third person with a tell ("He replied and
  // archived the task, so I should say NO_REPLY.") is caught by that tier,
  // not by the sentinel rule. What is still open is a one-liner with none of
  // the measured shapes in it.
  const caught = leak.gateReply('He replied and archived the task, so I should say NO_REPLY.');
  assert.equal(caught.action, 'cancel');
  assert.deepEqual(caught.leaks.map((l) => l.kind), ['deliberation', 'sentinel']);
  const v = leak.gateReply('The task is archived and the mark is on, so this is NO_REPLY.');
  assert.equal(v.action, 'trim', 'not caught — see the comment above');
});

test('the clean narration paragraph AFTER the last marker is dropped too (Miron 09:48)', () => {
  // Until 2026-09-15 this was a KNOWN GAP: everything that named the sentinel
  // or `turn_start` went, exactly as the audit row says it did, and the
  // paragraph after the cut — first-person English deliberation with no
  // marker in it — went out as the first line of the update. The
  // `deliberation` tier was measured against fourteen days of real traffic
  // before it was allowed to drop anything (`incidents.md`, "The working-out,
  // measured"), and "Let me deliver" is its opener shape. The first paragraph
  // is now found twice — its third-person opening about the reader is the
  // tier's `third` shape — and the update behind it all is what he gets.
  const v = leak.gateReply(MIRON_DELIVERY);
  assert.equal(v.action, 'trim');
  assert.deepEqual(v.leaks.map((l) => `${l.line}:${l.kind}:${l.at}`), [
    '0:deliberation:He sent',
    '0:sentinel:NO_REPLY',
    '2:sentinel:NO_REPLY',
    '5:internal:turn_start',
    '5:deliberation:But first',
    '7:deliberation:Let me deliver',
  ]);
  assert.ok(v.text.startsWith('היי 👋 עדכון מודלים'), 'the update is the first line now');
  assert.ok(!v.text.includes('Let me deliver'), 'and the deliberation in front of it is gone');
});

// The deliberation tier, in the shapes the measurement found. Paraphrased —
// the real paragraphs stay on the box — but each is the shape of one that
// was read there, with the guard that shape needs.
const DELIBERATION = [
  // opener: a closed verb list after "Let me" (so "Let me know" is not one)
  ['Let me check the calendar first.', 'Let me check'],
  ['Let me deliver the model update naturally.', 'Let me deliver'],
  ['Now I have two things to handle.', 'Now I'],
  ['Looking at the today block, nothing is due.', 'Looking at the today block'],
  // mid: the working-out that begins with what it was reasoning from
  ['The number does not match anyone obvious in his contacts. Let me check.', 'Let me check'],
  // third: the reader in the third person, plus a tell (Hebrew quoted back, one of our nouns)
  ['He said "תמחק את המשימה" so I archived it.', 'He said'],
  ['They asked to move the meeting, so I should update the task.', 'They asked'],
  // soft: a hedge opening, plus a first-person step or the reader in the third person
  ['Actually, I need to save the reminder before replying.', 'Actually,'],
  ['Wait, he already answered the intake question.', 'Wait,'],
];

test('deliberation: every measured shape drops, and names what it fired on', () => {
  for (const [text, at] of DELIBERATION) {
    const v = leak.gateReply(text);
    assert.equal(v.action, 'cancel', `should drop: ${text}`);
    assert.ok(v.leaks.some((l) => l.kind === 'deliberation' && l.at === at), `${text} → ${JSON.stringify(v.leaks)}`);
  }
});

test('deliberation: the working-out above a Hebrew answer loses only the working-out', () => {
  const text = 'Actually, I need to save the reminder first.\n\nרשמתי לך: להתקשר לבנק, מחר ב-10:00 👍';
  const v = leak.gateReply(text);
  assert.equal(v.action, 'trim');
  assert.equal(v.text, 'רשמתי לך: להתקשר לבנק, מחר ב-10:00 👍');
});

test('deliberation: a bare third-person opening or a hedge with no tell is a sentence to a person', () => {
  for (const text of [
    'He asked me to pass on that he is running late.',
    'They want to meet on Thursday instead.',
    'Actually, the meeting moved to 6pm.',
    'So, tomorrow at 10 works?',
    'Let me know if that works for you.',
  ]) {
    assert.equal(leak.deliberationIn(text, text), null, text);
    assert.equal(leak.gateReply(text).action, 'pass', text);
  }
});

// ---- the working-out in Hebrew (2026-09-23) ---------------------------------
//
// Miron, the poker coordination, 09:52 UTC — exactly as it reached his phone.
// Every drop tier was English, the one English line quoted the block name
// (which `scannable` strips), and the gate answered `pass` with zero findings.
const MIRON_POKER = [
  '',
  '',
  'הוא הגיב על ההודעה שלי על הפוקר. הוא אומר "צריך שכולם יהיו פנויים" — תגובה לשאלה "מתי נוח לך?", לא סתם משפט. זה בעצם אומר שהוא לא אמר עדיין מתי נוח לו, אלא מעיר שכולם צריכים להיות פנויים (ברור, אבל לא עונה על השאלה).',
  '',
  'אני צריך להבין: האם הוא מתכוון שזה ברור מאליו, או שהוא שואל אם כולם פנויים לפני שהוא עונה? כנראה שהוא לא מבין שכל אחד עונה בנפרד.',
  '',
  'אכתוב לו שכל אחד עונה לי בפרטי ורק אחר כך אני מעלה הצעה לשולחן, ושיחזור על השאלה — מתי נוח לו.',
  '',
  '>  They used WhatsApp reply on ONE earlier message, and the "Reply target of current user message" block above holds its text. Answer THAT message — "סיימתי" on a reply to a rent reminder closes the rent task, not the newest thing either of you said.',
  '',
  'ההודעה שהוא הגיב עליה היא "עמית מחפש פוקר בזום. אתם 3, צריך עד 4. מתי נוח לך?" — והוא אומר "צריך שכולם יהיו פנויים". אז הוא עונה על השאלה שלי בכך שהוא אומר שכולם צריכים להיות פנויים. לא ברור אם זאת תשובה ("לא משנה מתי נוח לי, תמצא זמן שכולם פנויים") או הבהרה.',
  '',
  'אני צריך להסביר שכל אחד אומר לי בפרטי מה נוח לו, ואז אני מעלה זמן שכולם יכולים. ולשאול שוב — מה נוח לו.',
].join('\n');

// The three real messages the Hebrew tier changes on 21 days of traffic
// (2,697 messages), and nothing else did: the shape of each, with what fired.
const HEBREW_DELIBERATION = [
  ['אני צריכה למצוא את המשימה הזו כדי לצרף לה תזכורת. בואי נראה איך הן שמורות.', 'אני צריכה למצוא'],
  ['יהב אמר שהכל בוצע חוץ מטופס פנסיה. אני צריך לסמן את כל המשימות האחרות כהושלמו.', 'אני צריך לסמן'],
  ['אני צריך להבין: האם הוא מתכוון שזה ברור מאליו?', 'אני צריך להבין'],
  ['אני צריך להסביר שכל אחד אומר לי בפרטי מה נוח לו.', 'אני צריך להסביר'],
];

// Sentences Olma really says, several of them one word away from a shape above.
const HEBREW_ORDINARY = [
  'אני צריכה לדעת מתי נוח לך',
  'אכתוב לה שאתה מאחר',
  'הוא אמר שיאחר',
  'הוא כתב: "מירון רוצה לתאם איתך דייט"',
  'הוא כתב: "אני צריך להבין מה קורה עם המעבר"',
  'היא ענתה על ההודעה שלי: מתאים לה שלישי',
  'היא רוצה לדעת אם בעצם נוח לך מחר',
  'אני צריכה לבדוק רגע ביומן — מתי בערך?',
  'אני צריכה לוודא: התכוונת ליום שלישי?',
];

test('Miron\'s poker message: the Hebrew working-out is found, and nothing is delivered', () => {
  const v = leak.gateReply(MIRON_POKER, { readerWritesHebrew: true });
  assert.equal(v.action, 'cancel');
  assert.equal(v.text, '');
  const kinds = v.leaks.map((l) => `${l.kind}:${l.at}`);
  assert.ok(kinds.includes('hebrew:אני צריך להבין'), kinds.join(' | '));
  assert.ok(kinds.includes('hebrew:אני צריך להסביר'), kinds.join(' | '));
  assert.ok(kinds.includes('block:Reply target of current user message'),
    'a block name is ours even inside quotation marks');
  // And for every reader: this is not the English tier, it does not need one.
  for (const readerWritesHebrew of [false, null]) {
    assert.equal(leak.gateReply(MIRON_POKER, { readerWritesHebrew }).action, 'cancel');
  }
});

test('hebrew: every measured shape drops, and names what it fired on', () => {
  for (const [text, at] of HEBREW_DELIBERATION) {
    const v = leak.gateReply(text);
    assert.equal(v.action, 'cancel', `should drop: ${text}`);
    assert.ok(v.leaks.some((l) => l.kind === 'hebrew' && l.at === at), `${text} → ${JSON.stringify(v.leaks)}`);
  }
});

test('hebrew: the working-out above an answer loses only the working-out', () => {
  const text = 'אני צריכה למצוא את המשימה הזו.\n\nמצאתי — הוספתי תזכורת למחר ב-9:00 👍';
  const v = leak.gateReply(text);
  assert.equal(v.action, 'trim');
  assert.equal(v.text, 'מצאתי — הוספתי תזכורת למחר ב-9:00 👍');
});

test('hebrew: a sentence to a person, or somebody else\'s words quoted, is delivered', () => {
  for (const text of HEBREW_ORDINARY) {
    const v = leak.gateReply(text, { readerWritesHebrew: true });
    assert.equal(v.action, 'pass', `${text} → ${JSON.stringify(v.leaks)}`);
    assert.equal(v.text, text);
  }
});

test('hebrew: the reader in the third person is REPORTED, never dropped', () => {
  // One hit on 21 days of traffic, in a message the step tier already
  // cancels — and every tell that tells it from a relay is a real sentence.
  const own = 'היא ענתה על ההודעה שלי: מתאים לה שלישי';
  const v = leak.gateReply(own);
  assert.equal(v.action, 'pass');
  assert.deepEqual(v.reported.map((l) => l.kind), ['hebrew-narration']);
  assert.ok(leak.REPORT_ONLY.has('hebrew-narration') && leak.KEEPS_LINE.has('hebrew-narration'));
  // NARRATION_RE learned the verbs this leak used — reported, as before.
  const quoted = 'הוא אומר "צריך שכולם יהיו פנויים"';
  assert.deepEqual(leak.gateReply(quoted).reported.map((l) => l.kind), ['narration']);
  assert.equal(leak.gateReply(quoted).action, 'pass');
});

// The wide tier. Every internal name nobody has thought of is this shape — and
// so is a word a developer might have put in a task title, which is why it is
// reported and delivered rather than dropped. The audit row is where the next
// addition to the closed list comes from.
test('an unknown snake_case identifier is reported and still delivered', () => {
  const v = leak.gateReply('סיימתי את user_service, מה הלאה?');
  assert.equal(v.action, 'pass');
  assert.equal(v.text, 'סיימתי את user_service, מה הלאה?');
  assert.deepEqual(v.reported, [{ kind: 'identifier', at: 'user_service', line: 0 }]);
  assert.deepEqual(v.leaks, []);
  // and it never fires inside a link, an address or a quotation
  for (const t of ['ראה https://x.co/a_b/c_d', 'שלח ל-first_last@example.com', 'אמרת "hold_reason" נכון?']) {
    assert.deepEqual(leak.gateReply(t).reported, [], t);
  }
});

// A frame marker can BE a live credential, so the phrase that tripped the
// detector is redacted before anything writes it down (domain/token-leak.js
// learned this first).
test('a leaked identity token cancels the message and is never written down in the clear', () => {
  const tok = `olma_tok_${'a1b2c3d4'.repeat(4)}`;
  const v = leak.gateReply(`{"name": "olma_add_task", "olma_identity": "${tok}"}`);
  assert.equal(v.action, 'cancel');
  const written = JSON.stringify(v.reported);
  assert.ok(!written.includes(tok), 'the token is not in the finding');
  assert.match(written, /olma_\*\*\*|frame/);
  // hebrew-quality reads the same frame markers from this module now, so the
  // daily count and the delivery gate can never disagree about what a frame is
  assert.equal(hebrewQuality.MARKUP_RE, leak.FRAME_RE);
  assert.ok(hebrewQuality.flawsIn(`שלום <|tool_calls|>`).some((f) => f.kind === 'markup'));
});

// ---- the `english` tier ----------------------------------------------------
//
// Measured on the box on 2026-09-22 (`scripts/measure-reply-gate.js`, 8 days,
// 37 agents, 255 assistant messages, 639 paragraphs): TWELVE English paragraphs
// were delivered with no finding at all, nine of them to people who write
// Hebrew and three of them real replies to the two people who write English.
// Every string below is one of those twelve, verbatim off the transcripts.
const ENGLISH_LEAKS = [
  // u-36 Sharon, 12:12 and 15:03 — the second is the one the owner reported,
  // and its Hebrew half is a real answer to a real question.
  ['Now write the reply — one short message, one offer, the zone statement, then the name question.\n\nהיי שחר 👋 שמרתי שהזמינות שלך היא שבת אחרי 16:00, ראשון ורביעי.',
    'היי שחר 👋 שמרתי שהזמינות שלך היא שבת אחרי 16:00, ראשון ורביעי.'],
  ["The user answered my name question indirectly — they're not correcting me, so I'll confirm the name. And they asked a question about what I run on.\n\nכן, בדיוק — אני רצה על OpenClaw.",
    'כן, בדיוק — אני רצה על OpenClaw.'],
  // u-37 Gal — "with this model" is the system describing its own insides.
  ["No contacts named padel. I need to ask Gal who's in the group so I can start coordinating.\n\nפאדל גנג — אחלה שם 😎",
    'פאדל גנג — אחלה שם 😎'],
  ["I can't see the image content with this model. Let me ask Gal to tell me who's in the group.\n\nהתמונה לא נקראת לי — תכתוב לי מי בפאדל גנג?",
    'התמונה לא נקראת לי — תכתוב לי מי בפאדל גנג?'],
  ["I still don't know who's in the Padel Gang. That's a good question — who are the other players I need to coordinate with.\n\nנעים להכיר באמת 😊",
    'נעים להכיר באמת 😊'],
  // u-3, the owner's own phone.
  ['Now for the update — deliver the OpenRouter new models update as subscribed.\n\nוגם — התזכורת על לשלוח לאורלי מחכה לך.',
    'וגם — התזכורת על לשלוח לאורלי מחכה לך.'],
];

test('english: a paragraph with no Hebrew in it, to somebody who writes Hebrew, loses the paragraph and keeps the answer', () => {
  for (const [text, kept] of ENGLISH_LEAKS) {
    // Each of these was DELIVERED — the corpus is the residue every other
    // tier passed, which is the whole reason this tier exists. If one of them
    // ever starts being caught lexically, this line is where you find out.
    const before = leak.gateReply(text);
    assert.equal(before.action, 'pass', `already caught without the flag: ${text.slice(0, 50)}`);
    const after = leak.gateReply(text, { readerWritesHebrew: true });
    assert.equal(after.action, 'trim');
    assert.equal(after.text, kept);
    assert.ok(after.leaks.some((l) => l.kind === 'english'), JSON.stringify(after.leaks));
  }
});

test('english: a reply that is ONLY the working-out reaches nobody', () => {
  // All three of these were delivered whole on the box. Each is a turn whose
  // real work was a tool call, so silence is the correct message, not a loss:
  // מאיה's accept went through, גלי's reminder was cancelled with a 👍 on it.
  for (const text of [
    "From the status: אופציה 37 — מירון ✅, אלי ✅.\n\nNow she's answering. I'll accept that option for her.",
    "I'll gather the morning info now.",
    "The recent reminder is about taking medication. She says it's cancelled.",
  ]) {
    assert.equal(leak.gateReply(text, { readerWritesHebrew: true }).action, 'cancel', text);
  }
});

test('english: the tri-state — only `true` arms it, and a person who writes English keeps their reply', () => {
  // u-12's locale is `en` and u-13's says `he` while he writes English; both
  // got a real English reply in the window, and neither may lose it. `null` is
  // the honest answer for the second and it must behave like `false`.
  for (const text of ['its all good 👍',
    "you have nothing in the calendar those days, and since it's Erev Yom Kippur today I'm guessing Friday morning at the beach could work?"]) {
    for (const reader of [false, null, undefined]) {
      assert.equal(leak.gateReply(text, { readerWritesHebrew: reader }).action, 'pass',
        `reader=${reader}: ${text}`);
    }
  }
  // …and the default, for every caller that passes nothing at all.
  assert.equal(leak.gateReply('its all good 👍').action, 'pass');
});

test('english: the lines that must survive even for a Hebrew reader', () => {
  const armed = { readerWritesHebrew: true };
  // A relayed block is somebody else's text — a subscribed update, a digest,
  // another person's message. The first measurement of this tier deleted
  // Miron's OpenRouter update through exactly this line.
  const relayed = 'הנה העדכון:\n\n> מודלים חדשים ב-OpenRouter:\n> Xiaomi MiMo-V2.6-Pro-UltraSpeed ($4.35/$8.70), MiMo-V2.6-Flash ($0.14/$0.28), Grok 4.7 ($1.60/$4.80)';
  assert.equal(leak.gateReply(relayed, armed).action, 'pass', 'a relayed quote is not Olma writing English');
  // The gateway's own attachment convention, which carries the schedule card.
  assert.equal(leak.gateReply('הנה הכרטיס שלך 🙏\n\nMEDIA: /root/.openclaw/workspaces/u-7/cards/week.png', armed).action,
    'pass', 'a MEDIA line is not a sentence');
  // Short enough to be a name, a label or a sign-off rather than a paragraph.
  for (const short of ['👍', 'Padel Gang', 'OK 👍', 'Tel Aviv']) {
    assert.equal(leak.gateReply(short, armed).action, 'pass', short);
  }
  // One Hebrew letter anywhere means it is not this tier's business, and it is
  // read off the RAW line — a Hebrew phrase quoted back is still Hebrew.
  assert.equal(leak.gateReply('The meeting is on יום שלישי at four', armed).action, 'pass');
});

test('english: writesHebrew is a tri-state read off the columns, never a guess', () => {
  const { writesHebrew } = require('../src/domain/language');
  assert.equal(writesHebrew({ locale: 'he', locale_observed: null }), true);
  assert.equal(writesHebrew({ locale: 'he', locale_observed: 'he' }), true);
  // u-13 עמית: filed one way, writing the other. Neither column wins.
  assert.equal(writesHebrew({ locale: 'he', locale_observed: 'en' }), null);
  assert.equal(writesHebrew({ locale: 'en', locale_observed: null }), false);
  assert.equal(writesHebrew({ locale: null }), null);
  assert.equal(writesHebrew(null), null);
});

// A Hebrew reply with only the model's English next step on its end loses the
// tail and keeps the reply (2026-09-25, Dana: "רשמתי חמישי…" went out as
// nothing). The three shapes beside it are the ones the same measurement said
// must STILL drop whole, and each is a real line off the box.
const TAILS = {
  dana: 'רשמתי חמישי בערב החל מ-20:00 👍 let me see if the others are free.',
  quotesTheirHebrew: 'He wants me to remind him to talk to מיכאל tomorrow morning. Let me save the contact first.',
  hebrewWorkingOutEnglishTail: 'הם אמרו 13:00 — `due_at` נקבע ל-13:00. The reminder is set for 13:00 their time.',
  hebrewStep: 'יהב אמר שהכל בוצע. אני צריך לסמן את כל המשימות האחרות כהושלמו.',
};

test('a Hebrew reply keeps its words when only an English next step is stuck on its end', () => {
  for (const readerWritesHebrew of [true, false, null]) {
    const v = leak.gateReply(TAILS.dana, { readerWritesHebrew });
    assert.equal(v.action, 'trim', readerWritesHebrew);
    assert.equal(v.text, 'רשמתי חמישי בערב החל מ-20:00 👍');
    assert.deepEqual(v.leaks.map((l) => l.kind), ['deliberation-tail'], 'still reported, under its own name');
  }
  for (const key of ['quotesTheirHebrew', 'hebrewWorkingOutEnglishTail', 'hebrewStep']) {
    assert.equal(leak.gateReply(TAILS[key], { readerWritesHebrew: true }).action, 'cancel', key);
  }
  // A paragraph ABOVE still goes, and the kept head survives beneath it.
  const both = leak.gateReply('Let me check the table first.\n\n' + TAILS.dana);
  assert.equal(both.text, 'רשמתי חמישי בערב החל מ-20:00 👍');
});

// The plugin carries a port of domain/reply-leak.js because it loads in the
// gateway's own loader with nothing of ours beside it. This is what keeps the
// two from drifting: one corpus, both implementations, first disagreement wins.
test('the gateway plugin\'s copy and the domain module answer identically', () => {
  const corpus = [YAHAV, NOTES_ABOVE, THANKS_HE, THANKS_EN, MIRON_SENTINEL, MIRON_DELIVERY,
    ...ORDINARY, ...DELIBERATION.map(([text]) => text),
    'Actually, I need to save the reminder first.\n\nרשמתי לך: להתקשר לבנק, מחר ב-10:00 👍', 'NO_REPLY', 'בוצע NO_REPLY', 'בוצע, סגרתי את המשימה NO_REPLY', '', '   ',
    'סיימתי את user_service', 'DELIVERY: say good morning', 'הפגישה ב-2026-09-10T10:00:00Z',
    'Conversation info (untrusted metadata)', 'turn_start returned proceed',
    ...ENGLISH_LEAKS.map(([text]) => text),
    'הנה העדכון:\n\n> Xiaomi MiMo-V2.6-Pro-UltraSpeed, Grok 4.7',
    'הנה הכרטיס 🙏\n\nMEDIA: /root/.openclaw/workspaces/u-7/cards/week.png',
    'The meeting is on יום שלישי at four',
    MIRON_POKER, ...HEBREW_DELIBERATION.map(([text]) => text), ...HEBREW_ORDINARY,
    'אני צריכה למצוא את המשימה הזו.\n\nמצאתי — הוספתי תזכורת למחר ב-9:00 👍',
    'הוא אומר "צריך שכולם יהיו פנויים"', 'כתבת "Reply target of current user message"',
    ...Object.values(TAILS)];
  assert.deepEqual(plugin.INTERNAL_NAMES, leak.INTERNAL_NAMES, 'the closed lists are the same list');
  assert.equal(plugin.MIN_ENGLISH_WORDS, leak.MIN_ENGLISH_WORDS, 'the same floor');
  // Every case under every value the reader flag can take, because the option
  // is the newest way for the two copies to drift and the default is only one
  // of its three answers.
  for (const text of corpus) {
    for (const readerWritesHebrew of [true, false, null]) {
      const opts = { readerWritesHebrew };
      assert.deepEqual(plugin.gateReply(text, opts), leak.gateReply(text, opts),
        `disagreed on ${readerWritesHebrew}: ${JSON.stringify(text)}`);
      assert.deepEqual(plugin.leaksIn(text, opts), leak.leaksIn(text, opts),
        `disagreed on ${readerWritesHebrew}: ${JSON.stringify(text)}`);
    }
    assert.deepEqual(plugin.gateReply(text), leak.gateReply(text), `disagreed on: ${JSON.stringify(text)}`);
    assert.deepEqual(plugin.leaksIn(text), leak.leaksIn(text), `disagreed on: ${JSON.stringify(text)}`);
  }
});

test('the plugin remembers each agent\'s reader language, and forgets it when brokerd does not know', () => {
  // brokerd answers `turn_context` with `readerWritesHebrew`, the plugin holds
  // it per agent, and the gate reads it back a reply later — the flag has to
  // survive the gap between the two hooks, and it must not survive a `null`.
  plugin._resetReaders();
  assert.equal(plugin.readerOf('u-36'), null, 'an agent nobody has seen is unknown, not Hebrew');
  plugin.rememberReader('u-36', true);
  plugin.rememberReader('u-12', false);
  assert.equal(plugin.readerOf('u-36'), true);
  assert.equal(plugin.readerOf('u-12'), false);
  assert.equal(plugin.readerOf('u-99'), null);
  // u-13's row disagrees with itself, so brokerd sends null and the previous
  // answer must not be left standing in its place.
  plugin.rememberReader('u-36', null);
  assert.equal(plugin.readerOf('u-36'), null);
  plugin.rememberReader('u-12', undefined);
  assert.equal(plugin.readerOf('u-12'), null);
  plugin._resetReaders();
});

// ---- the hook itself -------------------------------------------------------

function fakeConnect(reply) {
  const sent = [];
  const connect = () => {
    const h = {};
    const s = { on(ev, fn) { h[ev] = fn; return s; }, write(x) { sent.push(JSON.parse(x)); setTimeout(() => h.data && h.data(JSON.stringify(reply) + '\n'), 0); }, end() { h.close && h.close(); }, destroy() {} };
    setTimeout(() => h.connect && h.connect(), 0);
    return s;
  };
  return { connect, sent };
}
const gateHandler = (reply = { id: 1, ok: true, filed: true }, log = () => {}) => {
  const { connect, sent } = fakeConnect(reply);
  return { handler: plugin.buildReplyGateHandler({ connect, log }), sent };
};
const KEY = 'agent:u-3:whatsapp:direct:+972500000000';

test('the hook cancels a reply that is only the working-out, and files it without the text', async () => {
  const log = [];
  const { handler, sent } = gateHandler(undefined, (o) => log.push(o));
  const out = await handler({ payload: { text: YAHAV }, sessionKey: KEY, channel: 'whatsapp' }, {});
  assert.deepEqual(out, { cancel: true, reason: 'olma_reply_leak' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'reply_gate');
  assert.equal(sent[0].params.action, 'cancel');
  assert.equal(sent[0].params.agentId, 'u-3');
  assert.ok(!JSON.stringify(sent).includes('Asia/Jerusalem'), 'the message never leaves the gateway');
  // The field is called `leaks` on the wire and is filled from `reported`:
  // brokerd is told everything that was FOUND, not only what moved the text,
  // because the report-only tiers exist precisely to be read later. So the
  // shape tiers appear here — `narration` on the opening, and the second
  // `block` on "The hints say" — beside the closed-list names.
  assert.deepEqual(sent[0].params.leaks.map((l) => l.kind), ['internal', 'narration', 'internal', 'deliberation', 'instant', 'block', 'block', 'deliberation', 'sentinel']);
  assert.equal(log.at(-1).action, 'cancel');
});

test('the hook trims narration off the front and delivers the rest', async () => {
  const { handler, sent } = gateHandler();
  const payload = { text: NOTES_ABOVE, replyToId: '3EB0X' };
  const out = await handler({ payload, sessionKey: KEY }, {});
  assert.deepEqual(out, { payload: { text: 'סגור, אזכיר לך היום ב-13:00 לבטל את האשראי 🙏', replyToId: '3EB0X' } });
  assert.equal(sent.find((m) => m.method === 'reply_gate').params.action, 'trim');
});

test('an ordinary reply is returned untouched, and brokerd hears only that it went out', async () => {
  const { handler, sent } = gateHandler();
  for (const text of ORDINARY) {
    assert.equal(await handler({ payload: { text }, sessionKey: KEY }, {}), undefined, text);
  }
  // The reply is never held for the socket: `reply_gate`, the one call the
  // hook awaits, is never made. What does go is fire-and-forget — the
  // `turn_progress` that drops a held 👀, and a `reply_claim` for a reply that
  // says it saved something (tests/phantom-save.test.js). This used to assert
  // "no socket at all" and passed only because it looked before the
  // fire-and-forget writes landed.
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!sent.some((m) => m.method === 'reply_gate'));
  assert.equal(sent.filter((m) => m.method === 'turn_progress').length, ORDINARY.length);
  assert.deepEqual(sent.find((m) => m.method === 'turn_progress').params, { agentId: 'u-3', what: 'reply' });
});

test('the hook arms the english tier off the agent id, and only for an agent brokerd answered for', async () => {
  // The two hooks are a whole turn apart — `before_prompt_build` learns the
  // language, the gate reads it back after the model has written. u-36 Sharon
  // is the measured case, and the same bytes to an agent nobody answered for
  // must go out untouched rather than being guessed at.
  const english = "I can't see the image content with this model. Let me ask Gal who's in the group.";
  plugin._resetReaders();
  const key = (agent) => `agent:${agent}:whatsapp:direct:+972500000000`;

  const quiet = gateHandler();
  assert.equal(await quiet.handler({ payload: { text: english }, sessionKey: key('u-36') }, {}), undefined);
  assert.equal(quiet.sent.length, 0, 'unknown reader, so the tier is not armed and brokerd hears nothing');

  plugin.rememberReader('u-36', true);
  const armed = gateHandler();
  const out = await armed.handler({ payload: { text: english }, sessionKey: key('u-36') }, {});
  assert.deepEqual(out, { cancel: true, reason: 'olma_reply_leak' });
  assert.equal(armed.sent[0].params.agentId, 'u-36');
  assert.deepEqual(armed.sent[0].params.leaks.map((l) => l.kind), ['english']);
  assert.ok(!JSON.stringify(armed.sent).includes('image content'), 'the message never leaves the gateway');

  // …and it is remembered PER AGENT: u-12 writes English and was never marked.
  const other = gateHandler();
  assert.equal(await other.handler({ payload: { text: english }, sessionKey: key('u-12') }, {}), undefined);
  assert.equal(other.sent.length, 0);
  plugin._resetReaders();
});

// The raw pipe sends as `main` and carries the owner's own wording with no
// model in the path (channels/openclaw.sendRawMessage) — a gate there could
// only ever do harm. Everything that puts MODEL output in front of somebody is
// covered, group agents and the intake greeter included.
//
// That last clause was a lie for as long as this test existed, and the test
// itself is what pinned it: `agent:intake:` sat in the UNGATED list beside
// `main`, because `ggreet` above it reads like "the greeter" and is not — it
// is the GROUP greeter, muted at the gateway, which has never spoken to
// anybody. `intake` is the one that meets every new person (2026-09-19).
test('the gate covers every agent that speaks with a model, and nothing that does not', async () => {
  const { handler, sent } = gateHandler();
  const gated = ['agent:u-3:whatsapp:direct:+1', 'agent:u-41:whatsapp:direct:+1',
    'agent:g-2:whatsapp:group:1@g.us', 'agent:ggreet:whatsapp:direct:+1',
    'agent:intake:whatsapp:direct:+1'];
  for (const key of gated) {
    assert.deepEqual(await handler({ payload: { text: YAHAV }, sessionKey: key }, {}), { cancel: true, reason: 'olma_reply_leak' }, key);
  }
  const n = sent.length;
  for (const key of ['agent:main:whatsapp:direct:+1', '', 'nonsense']) {
    assert.equal(await handler({ payload: { text: YAHAV }, sessionKey: key }, {}), undefined, key);
  }
  assert.equal(sent.length, n, 'and nothing was filed for them');
  // the session key off the context when the event has none
  assert.ok(await handler({ payload: { text: YAHAV } }, { sessionKey: KEY }));
});

// The founding case for `intake` being in that list: the first message a
// person ever read from Olma, 2026-09-19 07:46, replayed exactly as it reached
// their phone. The owner's opening copy is quoted in the greeter's prompt and
// came out intact; the model put its own frame above it, carrying the WhatsApp
// message id of the very message it was answering. `message_id` is already in
// INTERNAL_NAMES, so nothing about the detection had to change — the text was
// simply never shown to the gate. It must TRIM and not cancel: the copy below
// the leak is the whole point of that turn, and a person who gets nothing at
// all is worse off than one who gets the greeting.
const GREETER = [
  'הם לא משתתףתתייג:message_id:2A72C7B35E53CC579607',
  '',
  'היי, אני עולמה 👋',
  '',
  'אני כאן כדי לעזור לכם עם משימות, תזכורות ותיאומים מול האנשים שחשובים לכם.',
  'אפשר לכתוב, להקליט או פשוט לשלוח הכל בבלגן — אני אעשה לכם סדר ☺️',
].join('\n');

test("the greeter's own message id is trimmed and the owner's opening survives", async () => {
  const verdict = leak.gateReply(GREETER);
  assert.equal(verdict.action, 'trim');
  assert.deepEqual(verdict.leaks.map((l) => l.kind), ['internal']);
  assert.equal(verdict.leaks[0].at, 'message_id');
  assert.ok(verdict.text.startsWith('היי, אני עולמה'), verdict.text);
  assert.ok(verdict.text.includes('אני אעשה לכם סדר'), 'the opening copy is delivered whole');
  assert.ok(!verdict.text.includes('message_id'));
  assert.ok(!verdict.text.includes('משתתף'));

  // and end to end, through the hook, on the session key it actually arrived on
  const { handler } = gateHandler();
  const res = await handler({ payload: { text: GREETER }, sessionKey: 'agent:intake:whatsapp:direct:+972500000000' }, {});
  assert.equal(res.payload.text, verdict.text);
});

// A schedule card is not the thing that leaked. Cancelling would take it with
// the words, so the words go and the card lands.
test('a payload with media loses its caption instead of the whole delivery', async () => {
  const { handler } = gateHandler();
  const payload = { text: YAHAV, mediaUrls: ['/tmp/card.png'] };
  assert.deepEqual(await handler({ payload, sessionKey: KEY }, {}), { payload: { text: '', mediaUrls: ['/tmp/card.png'] } });
});

// A gate that can delay or break a reply is worse than no gate — but a gate
// that stops working the moment brokerd hiccups is not a gate at all. So the
// decision is local and only the REPORT needs the socket.
test('the hook still gates when brokerd is unreachable, and fails open on its own error', async () => {
  const log = [];
  const dead = () => { const h = {}; const s = { on(ev, fn) { h[ev] = fn; return s; }, write() {}, end() {}, destroy() {} }; setTimeout(() => h.error && h.error(new Error('ECONNREFUSED')), 0); return s; };
  const handler = plugin.buildReplyGateHandler({ connect: dead, log: (o) => log.push(o) });
  assert.deepEqual(await handler({ payload: { text: YAHAV }, sessionKey: KEY }, {}), { cancel: true, reason: 'olma_reply_leak' });
  assert.equal(log.at(-1).filed, false, 'and says so');
  // a payload shape it does not understand is not a reply it may cancel
  const { handler: h2 } = gateHandler();
  assert.equal(await h2({ payload: { text: null }, sessionKey: KEY }, {}), undefined);
  assert.equal(await h2({ sessionKey: KEY }, {}), undefined);
  assert.equal(await h2(null, null), undefined);
});

// ---- brokerd's side --------------------------------------------------------

const gateCall = (params) => broker.dispatch({ id: 1, method: 'reply_gate', params });

test('brokerd files the gate\'s report against the person, with the finding and never the message', async () => {
  const u = await makeUser(db.pool, '+972500999001');
  await db.pool.query('UPDATE users SET agent_id = $2 WHERE id = $1', [u.id, 'u-801']);
  assert.deepEqual(await gateCall({
    agentId: 'u-801', sessionKey: 'agent:u-801:whatsapp:direct:+972500999001', action: 'cancel',
    channel: 'whatsapp', chars: 812, kept: 0,
    leaks: [{ kind: 'internal', at: 'due_at', line: 0 }, { kind: 'instant', at: '2026-09-10T10:00:00Z', line: 2 }],
  }), { ok: true, filed: true });
  const { rows } = await db.pool.query(
    `SELECT actor_id, detail FROM audit_log WHERE event = 'reply.gated' ORDER BY id DESC LIMIT 1`);
  assert.equal(Number(rows[0].actor_id), u.id);
  assert.equal(rows[0].detail.action, 'cancel');
  assert.equal(rows[0].detail.chars, 812);
  assert.deepEqual(rows[0].detail.kinds, ['internal', 'instant']);
  assert.equal(rows[0].detail.leaks[0].at, 'due_at');
  // a group agent has no user row behind it and the row is still the record
  assert.deepEqual(await gateCall({ agentId: 'ggreet', action: 'pass', leaks: [{ kind: 'identifier', at: 'user_service', line: 0 }] }), { ok: true, filed: true });
  const { rows: g } = await db.pool.query(
    `SELECT actor_id, detail FROM audit_log WHERE event = 'reply.gated' ORDER BY id DESC LIMIT 1`);
  assert.equal(g[0].actor_id, null);
  assert.equal(g[0].detail.agentId, 'ggreet');
});

test('brokerd refuses a report it cannot place, and redacts a token the plugin somehow did not', async () => {
  assert.equal((await gateCall({ agentId: 'main', action: 'cancel' })).ok, false);
  assert.equal((await gateCall({ agentId: '../x', action: 'cancel' })).ok, false);
  assert.equal((await gateCall({ agentId: 'u-801', action: 'send-it' })).ok, false);
  const tok = `olma_tok_${'9f8e7d6c'.repeat(4)}`;
  await gateCall({ agentId: 'u-801', action: 'cancel', leaks: [{ kind: 'frame', at: tok, line: 0 }] });
  const { rows } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE event = 'reply.gated' ORDER BY id DESC LIMIT 1`);
  assert.ok(!JSON.stringify(rows[0].detail).includes(tok));
});

// The gateway logs "no queued reply payloads" for a payload a HOOK cancelled,
// exactly as it does for a turn it swallowed — so without this the gate would
// manufacture the repair sweep's founding case on every message it stops,
// and a model turn would go and answer a message that was answered correctly.
test('a reply the gate cancelled is not a swallowed turn', () => {
  const laneLog = require('../src/jobs/lane-watchdog');
  const line = (messageId, cause) => JSON.stringify({
    time: new Date().toISOString(),
    message: 'visible channel turn dispatched with no queued reply payloads: '
      + `channel=whatsapp messageId=${messageId} sessionKey=${KEY} cause=${cause}`,
  });
  assert.deepEqual(laneLog.parseDroppedTurns(line('SWALLOWED1', 'completed')).map((d) => d.messageId), ['SWALLOWED1']);
  for (const cause of ['suppressed:cancelled_by_reply_payload_sending_hook', 'suppressed:empty_after_reply_payload_sending_hook']) {
    assert.deepEqual(laneLog.parseDroppedTurns(line('GATED1', cause)), [], cause);
  }
});

// ---- shipped is not running ------------------------------------------------
// Plugin code loads at gateway STARTUP and deploy.sh does not restart the
// gateway, so a merged gate is inert until somebody does — the state in which
// the suite is green, the code is on the box, and Yahav's message can happen
// again. The plugin stamps what it actually registered; config_guard reads it.
test('config_guard says when the running gateway predates the reply gate, and stays quiet when it cannot tell', async () => {
  const configGuard = require('../src/jobs/config-guard');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-gate-stamp-'));
  const file = path.join(dir, 'turn-context-plugin.registered');
  // what a gateway running today's plugin writes
  const on = [];
  plugin.default.register({ pluginConfig: {}, on: (name, fn) => on.push([name, fn]) });
  plugin.stampRegistration({ agents: 'all', hooks: on.map(([name]) => name) }, file);
  assert.deepEqual(configGuard.checkReplyGateLive({ registerStampPath: file }), { violations: [], skipped: null });
  assert.match(String(fs.readFileSync(file, 'utf8')), /reply_payload_sending/);
  // a gateway still running the build from before it
  plugin.stampRegistration({ agents: 'all', hooks: ['before_prompt_build', 'llm_input'] }, file);
  const stale = configGuard.checkReplyGateLive({ registerStampPath: file });
  assert.equal(stale.violations.length, 1);
  assert.match(stale.violations[0], /before the reply gate/);
  assert.match(stale.violations[0], /systemctl --user restart openclaw-gateway/);
  assert.equal(configGuard.breaksUsers(stale.violations[0]), false, 'nobody\'s tools are failing — a dashboard row');
  // overwritten, never appended: one file, one answer, however busy the box
  assert.equal(String(fs.readFileSync(file, 'utf8')).trim().split('\n').length, 1);
  // could not read is not a thing in trouble, and it says so rather than passing
  const missing = configGuard.checkReplyGateLive({ registerStampPath: path.join(dir, 'nope') });
  assert.deepEqual(missing.violations, []);
  assert.match(missing.skipped, /unreadable/);
  fs.writeFileSync(file, 'not json\n');
  assert.match(configGuard.checkReplyGateLive({ registerStampPath: file }).skipped, /unparseable/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The gate creates the exact fingerprint the repair sweep reads as a delivery
// fault: an assistant turn in the transcript with no `Sent` line behind it. It
// must not put back what the gate has just kept off somebody's phone — and the
// raw pipe it would use has no gate in it at all.
test('a cancelled reply is never re-sent verbatim by the repair sweep', () => {
  assert.deepEqual(resendableVerbatim(YAHAV), { ok: false, why: 'leak' });
  assert.deepEqual(resendableVerbatim(NOTES_ABOVE), { ok: true, gated: true, text: 'סגור, אזכיר לך היום ב-13:00 לבטל את האשראי 🙏' });
  assert.deepEqual(resendableVerbatim('סגור, אזכיר לך ב-13:00 🙏'), { ok: true, text: 'סגור, אזכיר לך ב-13:00 🙏' });
  assert.deepEqual(resendableVerbatim('בוצע NO_REPLY'), { ok: true, gated: true, text: 'בוצע' });
  assert.deepEqual(resendableVerbatim('  '), { ok: false, why: 'empty' });
  assert.deepEqual(resendableVerbatim('הנה\nMEDIA: /tmp/x.png'), { ok: false, why: 'media' });
});

// ---- a link that goes nowhere -----------------------------------------------
//
// The eight real ones are in the transcripts on the box; these are the seven
// that reached a person as a URL, plus every real link Olma has actually sent,
// so the rule is read off traffic and not off a hunch. 6 of 7 caught, 0 of 11
// real links touched.
test('a link that claims to be us, or lands on a path we do not serve, is caught', () => {
  const invented = [
    // our own hostname, a page retired ten days earlier (410)
    'https://allma.world/pick/d1bd2f3228fe065203bf07be921c9efdf7301d653361733a',
    'https://my.olma.app/dashboard?meeting=30',
    'https://my.openclaw.ai/dashboard?meeting=31',
    // three people, one minute, one coordination (2026-09-22)
    'https://dashboard.olma.ai/meetings/40',
    'https://dash.olma.app/meetings/40',
    'https://dashboard.openclaw.ai/meetings/40',
  ];
  for (const u of invented) assert.equal(leak.deadLink(u), true, u);

  // NAMED, not fixed: an invention on a domain that does not sound like ours
  // reads exactly like a real external link. This one went out on 2026-09-06
  // and this rule cannot see it — closing that needs the turn's own tool
  // results, which this gate does not get.
  assert.equal(
    leak.deadLink('https://preview-sandbox--6a9c6568cff3f4a92b4ecc77.base44.app/rsvp/6a9cf4ba'),
    false, 'KNOWN GAP — see the comment above deadLink');

  const real = [
    `https://allma.world/d/${'AbCdEfGhIjKlMnOpQrStUv'}`,
    `https://allma.world/d/${'a'.repeat(64)}`,
    'https://allma.world/privacy', 'https://allma.world/terms', 'https://allma.world/',
    'https://olmachat.duckdns.org/',
    'https://www.google.com/search?q=x',
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
    'https://letmegooglethat.com/?q=x',
    // a whole label, so somebody else's business is not ours to cut
    'https://olmafarm.com/shop', 'https://www.openclawresearch.org/paper',
  ];
  for (const u of real) assert.equal(leak.deadLink(u), false, u);
});

// It is lifted OUT; the sentence it sat in is the message and is delivered.
// Cutting the paragraph would take the question with it, which is the thing
// the invite exists to ask.
test('the dead link goes and the message stays', () => {
  const v = leak.gateReply('כרגע 5 בקבוצה על הפרק ושחרון אישר. מתי נוח לך להצטרף?\n\nhttps://dashboard.openclaw.ai/meetings/40');
  assert.equal(v.action, 'trim');
  assert.equal(v.text, 'כרגע 5 בקבוצה על הפרק ושחרון אישר. מתי נוח לך להצטרף?');
  assert.deepEqual(v.leaks.map((l) => l.kind), ['link']);
  assert.match(v.leaks[0].at, /dashboard\.openclaw\.ai/, 'the audit row has to name what was cut');

  // A real link is not touched, and nothing else about the message moves.
  const good = 'מתי נוח לך?\n\nhttps://allma.world/d/AbCdEfGhIjKlMnOpQrStUv';
  assert.deepEqual(leak.gateReply(good), { action: 'pass', text: good, leaks: [], reported: [] });

  // Mid-sentence, and twice in one message.
  const two = leak.gateReply('הנה https://dash.olma.app/meetings/40 וגם https://my.olma.app/x — מתי?');
  assert.equal(two.action, 'trim');
  assert.match(two.text, /^הנה +וגם +— מתי\?$/);

  // Nothing left but the link: better nothing than a link to nowhere.
  assert.equal(leak.gateReply('https://dashboard.olma.ai/meetings/40').action, 'cancel');
});
