'use strict';
// What a coordination is called on somebody's Google calendar (owner,
// 2026-10-08). A coordination's title is whatever its opener said, and that
// was often WHEN as much as WHAT: "פאדל בשבת הבאה 17:00, 4 שחקנים" and
// "פאדל לשבוע הקרוב" went onto calendars as the event's name, where the event
// itself already says the day and the hour — and "לשבוע הקרוב" is wrong a week
// later. So the calendar copy is the title with the time taken out, and a
// title that says nothing once it is ("פגישה", "פגישה של הקבוצה") is named
// after the people, or after the room. Code, never a model: the same title
// gives the same name every time.
//
// Only the CALENDAR copy. The chat and the page keep the opener's words —
// that is how the people in it know the coordination.

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'].join('|');
const NEXT = '(?:\\s+ה?(?:הבאה?|הקרובה?|הקרובים|הבאים))';
const HE = '\\u0590-\\u05FF';
// Each is a time phrase, bounded on both sides by something that is not a
// Hebrew letter so "שבת" never matches inside another word.
const TIME_PHRASES = [
  // "השבוע", "לשבוע הקרוב", "בחודשיים הקרובים", "שבוע הבא" — a bare "שבוע"
  // is a word ("סיכום שבוע"), so only with ה or with what follows it.
  '[לב]?ה(?:שבוע|חודש)',
  `[לב]?(?:שבוע|חודש|שבועיים|חודשיים)${NEXT}`,
  // "בשבת הבאה", "יום שבת", "ביום שלישי" — a weekday only with ב / יום in
  // front of it, or "הבא" after it: a bare "לשבת" is also "to sit".
  `(?:ב?יום\\s+|ב)(?:${DAYS})${NEXT}?`,
  `ל?(?:${DAYS})${NEXT}`,
  // the moving words
  '[לב]?(?:היום|מחרתיים|מחר|הערב|הלילה|הבוקר)',
  // a part of the day
  'ב(?:ערב|בוקר|צהריים|לילה)',
  // a date and a clock, with or without the ב- in front — never right after
  // a Latin word, where "2.5" is a version ("Mercury 2.5"), not the 2nd of May
  '(?<![A-Za-z]\\s*)ב?-?\\d{1,2}[./]\\d{1,2}(?:[./]\\d{2,4})?',
  '(?<![A-Za-z]\\s*)ב?-?\\s?\\d{1,2}:\\d{2}',
];
const TIME_RE = new RegExp(`(^|[^${HE}])(?:${TIME_PHRASES.join('|')})(?=$|[^${HE}])`, 'gu');
// "…, 4 שחקנים": a head count is the room's business, not the event's name.
const COUNT_RE = /[,،]?\s*\d+\s+(?:שחקנים|שחקניות|אנשים|משתתפים|חברים)(?![\u0590-\u05FF])/gu;
const EDGE_RE = /^[\s,.:;\-–—]+|[\s,.:;\-–—]+$/gu;

// A name that says nothing on its own once the time is gone.
const GENERIC_RE = /^(?:פגישה|מפגש|ישיבה|meeting)(?:\s+(?:של|עם|ל)\s*ה?קבוצה|\s+קבוצתית)?$/iu;

function withoutTime(title) {
  if (typeof title !== 'string') return '';
  let s = title.replace(COUNT_RE, ' ');
  // Twice: removing one phrase can leave a second one at a new edge.
  for (let i = 0; i < 2; i++) s = s.replace(TIME_RE, '$1');
  return s.replace(/\s+/gu, ' ').replace(/\s+([,.:;])/gu, '$1').replace(EDGE_RE, '');
}

// `meetings.startMeeting`'s own fallback when nobody named it: "פגישה — דב, מירון".
const DEFAULT_RE = /^פגישה — /u;

function isGeneric(name) {
  return !name || GENERIC_RE.test(name.trim()) || DEFAULT_RE.test(name.trim());
}

// "דב ומירון", "דב, מירון וגלי".
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} ו${names[names.length - 1]}`;
}

// The pure half: the title, the room's subject (null for a private one) and
// the first names of the people still in it.
function eventTitle(title, { roomSubject = null, names = [] } = {}) {
  const cleaned = withoutTime(title);
  if (!isGeneric(cleaned)) return cleaned;
  const head = cleaned && GENERIC_RE.test(cleaned) && !/קבוצ/u.test(cleaned) ? cleaned : 'פגישה';
  const subject = (roomSubject || '').trim();
  if (subject) return `${head} – ${subject}`;
  const people = names.map((n) => (n || '').trim()).filter(Boolean);
  return people.length ? `${head} ${joinNames(people)}` : head;
}

async function eventTitleFor(client, meetingId) {
  const { rows: [m] } = await client.query(
    `SELECT m.title, g.subject AS room_subject
       FROM meetings m LEFT JOIN chat_groups g ON g.id = m.group_id
      WHERE m.id = $1`, [meetingId]);
  if (!m) return 'פגישה';
  const { rows: people } = await client.query(
    `SELECT u.first_name FROM meeting_participants p JOIN users u ON u.id = p.user_id
      WHERE p.meeting_id = $1 AND p.state <> 'opted_out'
      ORDER BY (p.user_id = (SELECT initiator_id FROM meetings WHERE id = $1)) DESC, p.user_id`,
    [meetingId]);
  return eventTitle(m.title, { roomSubject: m.room_subject, names: people.map((p) => p.first_name) });
}

module.exports = { eventTitle, eventTitleFor, withoutTime, isGeneric };
