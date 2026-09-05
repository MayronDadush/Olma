'use strict';
// Is this task a MOMENT or a JOB?
//
// "תור רופא" at 09:00 and "לקבוע תור לרופא" are the same words about the same
// subject and behave in opposite ways once their time passes. The first
// happened, or it didn't, and either way it is over — leaving it on the list
// as overdue for ever is noise. The second is still worth doing at 11:00, at
// 15:00, and next Tuesday; archiving it would throw away the task.
//
// Nothing in the schema separated them, so the overdue list accumulated both
// and the ones that were genuinely finished stayed there arguing for
// attention. `tasks.kind` is that distinction, decided here — same discipline
// as task-category.js and for the same reason: no model turn, so an archive
// sweep cannot be downstream of a billing account.
//
// The default is 'todo', and that asymmetry is the whole safety argument. A
// job wrongly left on the list costs somebody a glance. A moment wrongly
// guessed archives a task they still had to do. So `event` has to be earned.

// The verb wins over everything. "לקבוע תור", "לתאם פגישה", "to book a
// flight" — each contains the noun for a moment and is a job about arranging
// one. This list is checked FIRST for exactly that reason, and it is why the
// distinction is possible at all: the difference between the two sentences is
// entirely in the verb.
const TODO_VERBS = [
  'לקבוע', 'לתאם', 'להזמין', 'להתקשר', 'לשאול', 'לבדוק', 'לברר', 'לסדר',
  'לארגן', 'לחפש', 'לשלוח', 'לכתוב', 'לענות', 'להחזיר', 'לזכור', 'להזכיר',
  'לקנות', 'לשלם', 'לחדש', 'למלא', 'לאסוף', 'לעזור', 'לתכנן', 'לסמס',
  'להעביר', 'לגשת', 'לקחת', 'להכין', 'לנקות', 'לגזום', 'לבטל',
  'book', 'schedule', 'arrange', 'call ', 'ask ', 'check', 'order', 'buy ',
  'pay ', 'send', 'email', 'text ', 'renew', 'find ', 'plan ', 'cancel',
  'remind', 'pick up', 'prepare', 'clean',
];

// A moment somebody will be AT. Nouns, mostly — a thing on a calendar rather
// than a thing on a list.
const EVENT_WORDS = [
  'תור ', 'תור-', 'התור', 'פגישה', 'פגישת', 'משמרת', 'טיסה', 'אימון',
  'שיעור', 'חוג ', 'מסיבה', 'ארוחת', 'ראיון', 'ביקור', 'הופעה', 'קונצרט',
  'חתונה', 'הרצאה', 'ישיבה', 'היפגש', 'לפגוש', 'להיפגש', 'דייט',
  'appointment', 'meeting', 'shift', 'flight', 'class', 'lesson', 'party',
  'dinner', 'lunch', 'brunch', 'interview', 'concert', 'wedding', 'session',
  'standup', 'stand-up', 'call with', 'coffee with', 'drinks',
];

const HE = /[֐-׿]/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Hebrew glues its prefixes on, so the stems are matched as substrings and
// earn that by being long. English gets a real word boundary. Same rule as
// task-category.js, stated once in each place it is relied on.
const compile = (list) => list.map((w) => (HE.test(w)
  ? new RegExp(escapeRe(w))
  : new RegExp(`\\b${escapeRe(w)}`, 'i')));

const TODO_RE = compile(TODO_VERBS);
const EVENT_RE = compile(EVENT_WORDS);

function normalise(s) {
  return String(s || '').replace(/[֑-ׇ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Words only. A start-and-end time was the obvious second signal and it is
// deliberately NOT used: "לעבוד על המצגת 14:00-16:00" is a job somebody
// blocked time for, and treating the block as proof of a moment would archive
// it at four o'clock whether or not the presentation got written. A range
// makes the calendar better (tasks.ends_at); it does not make a task finished.
function decideKind({ title } = {}) {
  const hay = normalise(title);
  if (!hay) return 'todo';
  for (const re of TODO_RE) if (re.test(hay)) return 'todo';
  for (const re of EVENT_RE) if (re.test(hay)) return 'event';
  return 'todo';
}

module.exports = { decideKind, TODO_VERBS, EVENT_WORDS };
