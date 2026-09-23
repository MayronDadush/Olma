'use strict';
// "תעזור לי עד שבוע הבא" — the two halves of the code-decided chase: the
// hook's reading of the words, and the server's reading of the day. The rest
// (brokerd carrying it, add_task arming it) is in tests/turn-open.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.OLMA_HOOK_TRACE = require('node:path').join(require('node:os').tmpdir(), `chase-deadline-hook-${process.pid}.log`);
const { chaseDeadline } = require('../gateway-hooks/olma-turn-open/handler');
const cd = require('../src/domain/chase-deadline');
const { partsInZone } = require('../src/domain/datetime');

const TZ = 'Asia/Jerusalem';
const dayOf = (d, tz = TZ) => {
  const p = partsInZone(tz, d);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};

// The founding sentence, word for word.
const CHAIM = 'אני אשמח שתזכיר לי מתי לקחת את המצלמה לתיקון כדי להתחיל לעבוד איתה אני רוצה שעד שבוע הבא היא תהיה מוכנה תעזור לי בתזכורת תודה רבה';

test('חיים\'s sentence reads as a chase to next week', () => {
  assert.deepEqual(chaseDeadline(CHAIM), { kind: 'next_week', namedHour: false });
});

test('the shapes a deadline is said in', () => {
  const yes = [
    ['תזכיר לי כל יום עד סוף החודש לשלם את החשבון', { kind: 'end_of_month' }],
    ['תזכירי לי עד סוף השבוע להחזיר את הספר', { kind: 'end_of_week' }],
    ['תעזרי לי עם זה עד סופ"ש', { kind: 'end_of_week' }],
    ['תנדנד לי על זה עד החודש הבא', { kind: 'next_month' }],
    ['תזכיר לי כל יום עד מחרתיים', { kind: 'days', n: 2 }],
    ['תזכירי לי עד יום חמישי לסגור את זה', { kind: 'weekday', weekday: 4 }],
    ['תעזור לי להתכונן, המבחן ועד שבת אני צריך לסיים', { kind: 'weekday', weekday: 6 }],
    ['תזכיר לי כל יום עד ה-15 לשלם', { kind: 'date', day: 15 }],
    ['תזכיר לי עד 3 באוקטובר להגיש', { kind: 'date', day: 3, month: 10 }],
    ['תעזור לי לזכור עד 15/10', { kind: 'date', day: 15, month: 10 }],
    ['תזכיר לי עד 1.11.2026', { kind: 'date', day: 1, month: 11 }],
    ['תזכיר לי כל יום ב-8:30 עד שבוע הבא', { kind: 'next_week', namedHour: true }],
  ];
  for (const [text, want] of yes) {
    assert.deepEqual(chaseDeadline(text), { namedHour: false, ...want }, text);
  }
});

// The nine real messages on the box that say "עד" and are not a chase, each
// reworded to its shape (2026-09-24), plus the readings this must never make.
test('what is not a chase: ranges, trips, shifts, and a reminder with a deadline beside it', () => {
  const no = [
    // the nine: none of them asks for anything
    'אני בעבודה מ-8 עד 17',
    'אני בחו"ל עד יום שלישי',
    'המשמרת שלי עד 23:00',
    'יש לי חוג מ-16:00 עד 17:30',
    'אני פנוי עד 12',
    'הם אצלנו עד שבוע הבא',
    'נסגר עד סוף החודש',
    'הילדים בקייטנה עד ה-20',
    'תוכלי בבקשה לשלוח לי התראות כל 3 דקות החל מ7 בבוקר, עד שארשום קמתי?',
    // asks, but "עד" is an hour range
    'תזכיר לי מחר מ-9 עד 11',
    'תזכיר לי עד 8.10',
    'תזכיר לי עד 11',
    // asks, but names a different day for the reminder: one reminder, a deadline
    'תזכיר לי מחר להגיש את הדוח עד סוף השבוע',
    'תזכיר לי ביום שני שעד שבוע הבא צריך לשלם',
    // "until" something that is not a day
    'תעזור לי עד שני ימים לפני',
    'תזכיר לי עד שאסיים',
    // nothing
    '', null,
  ];
  for (const text of no) assert.equal(chaseDeadline(text), null, String(text));
});

test('a reply block is somebody else\'s words', () => {
  const quoted = '[Replying to Olma id:3EB0X]\nתזכורת: עד שבוע הבא\n[/Replying]\nתודה';
  assert.equal(chaseDeadline(quoted), null);
});

test('clean drops anything that is not a verdict', () => {
  assert.equal(cd.clean(null), null);
  assert.equal(cd.clean({ kind: 'forever' }), null);
  assert.equal(cd.clean({ kind: 'days', n: 30 }), null);
  assert.equal(cd.clean({ kind: 'weekday', weekday: 7 }), null);
  assert.equal(cd.clean({ kind: 'date', day: 32 }), null);
  assert.equal(cd.clean({ kind: 'date', day: 5, month: 13 }), null);
  assert.deepEqual(cd.clean({ kind: 'next_week', namedHour: 'yes', text: 'x' }), { kind: 'next_week', namedHour: false });
});

// Fixed instants only (rules/testing.md). 2026-09-22 is a Tuesday.
const TUE = new Date('2026-09-22T11:40:00Z');      // Tue 14:40 in Israel
const SAT = new Date('2026-09-26T09:00:00Z');      // Sat 12:00 in Israel
const LATE = new Date('2026-09-22T21:30:00Z');     // Wed 00:30 in Israel, still Tue in UTC

test('the day, in their own zone', () => {
  const r = (v, now = TUE, timezone = TZ) => {
    const at = cd.resolve(v, { now, timezone });
    return at && dayOf(at, timezone);
  };
  // An Israeli week starts on Sunday: "next week" said on Tuesday is Sunday.
  assert.equal(r({ kind: 'next_week' }), '2026-09-27');
  assert.equal(r({ kind: 'end_of_week' }), '2026-09-26');
  // Elsewhere a week starts on Monday.
  assert.equal(r({ kind: 'next_week' }, TUE, 'Europe/London'), '2026-09-28');
  assert.equal(r({ kind: 'end_of_week' }, TUE, 'Europe/London'), '2026-09-27');
  // Said on Saturday, "next week" is tomorrow, and the end of this week is today — so nothing.
  assert.equal(r({ kind: 'next_week' }, SAT), '2026-09-27');
  assert.equal(r({ kind: 'end_of_week' }, SAT), null, 'a deadline of today is nothing to chase across');
  assert.equal(r({ kind: 'days', n: 1 }), '2026-09-23');
  assert.equal(r({ kind: 'days', n: 2 }), '2026-09-24');
  // A weekday is the NEXT one, never today.
  assert.equal(r({ kind: 'weekday', weekday: 2 }), '2026-09-29');
  assert.equal(r({ kind: 'weekday', weekday: 4 }), '2026-09-24');
  assert.equal(r({ kind: 'end_of_month' }), '2026-09-30');
  assert.equal(r({ kind: 'next_month' }), '2026-10-01');
  // A day of the month still to come is this month; one gone is next month's.
  assert.equal(r({ kind: 'date', day: 25 }), '2026-09-25');
  assert.equal(r({ kind: 'date', day: 15 }), '2026-10-15');
  assert.equal(r({ kind: 'date', day: 15, month: 10 }), '2026-10-15');
  assert.equal(r({ kind: 'date', day: 31, month: 11 }), null, 'there is no 31 November');
  assert.equal(r({ kind: 'date', day: 1, month: 9 }), null, 'a year away is not a chase');
  // "Today" is THEIR today: past midnight in Israel it is already Wednesday.
  assert.equal(r({ kind: 'days', n: 1 }, LATE), '2026-09-24');
  assert.equal(r({ kind: 'weekday', weekday: 3 }, LATE), '2026-09-30');
});

test('forTurn carries the day, the instant and the hour flag; pending spends once and expires', () => {
  const t = cd.forTurn({ kind: 'next_week', namedHour: true }, { now: TUE, timezone: TZ });
  assert.equal(t.day, '2026-09-27');
  assert.equal(dayOf(new Date(t.dueAt)), '2026-09-27');
  assert.equal(partsInZone(TZ, new Date(t.dueAt)).hh, 0, 'local midnight, the shape a day-long due_at has');
  assert.equal(t.namedHour, true);
  assert.equal(cd.forTurn({ kind: 'end_of_week' }, { now: SAT, timezone: TZ }), null);

  const turn = { chase: t, chaseUsed: false };
  assert.equal(cd.pending(turn, TUE.getTime() + 60_000), t);
  assert.equal(cd.pending(turn, TUE.getTime() + cd.TURN_CHASE_TTL_MS + 1), null,
    'the shim keeps one turn object for hours; a verdict nobody used must not wait for the next task');
  turn.chaseUsed = true;
  assert.equal(cd.pending(turn, TUE.getTime()), null);
  assert.equal(cd.pending(null), null);

  assert.equal(cd.onDay('2026-09-27T15:00:00+03:00', '2026-09-27', TZ), true);
  assert.equal(cd.onDay('2026-09-23T09:00:00+03:00', '2026-09-27', TZ), false);
  assert.equal(cd.onDay(null, '2026-09-27', TZ), false);
});

test('the hint says what the server will do and asks for nothing else', () => {
  const { turnHints } = require('../src/domain/turn');
  const quiet = turnHints({ chaseUntil: '2026-09-27' }).hints.chase;
  assert.match(quiet, /until 2026-09-27/);
  assert.match(quiet, /no.*remind_at|a remind_at/);
  const named = turnHints({ chaseUntil: '2026-09-27', chaseNamedHour: true }).hints.chase;
  assert.match(named, /pass the hour they named as remind_at/);
  assert.equal(turnHints({}).hints, undefined);
});
