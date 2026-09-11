'use strict';
// Which calendar a person lives by, and what that implies about the days they
// are unlikely to want anything on.
//
// Pure and DB-free on purpose: the delivery gate reads it on every row and the
// check-in rung reads it to write a sentence somebody will read, so it must be
// cheap and it must give the same answer in both places. A second copy of
// "Hebrew means Saturday" in the copy and in the gate is how the message we
// send and the behaviour we deliver drift apart.

// A zone, not a country: `users.timezone` is what we actually hold, and it is
// the only field that is right about somebody who speaks English and lives in
// Tel Aviv. Sunday is a WORKING day in Israel, so guessing a Christian
// calendar for them would silence an ordinary Sunday — the expensive mistake
// in this pair, and the reason geography overrules language here.
const ISRAEL_ZONES = new Set(['Asia/Jerusalem', 'Asia/Tel_Aviv']);

function isIsrael(timezone) {
  return ISRAEL_ZONES.has(String(timezone || '').trim());
}

const CALENDARS = new Set(['jewish', 'christian', 'none']);

// jewish | christian | none.
//
// `preference` is the `holiday_calendar` preference row when there is one, and
// it wins outright — a person who has said which calendar they keep is never
// guessed about again. Nothing WRITES that key yet; the holiday layer is what
// teaches the model it exists, and reading it from the start is what keeps
// that a one-line change rather than a second decision point.
//
// There is no Muslim calendar here, and an Arabic speaker in Israel would get
// Saturday rather than Friday. That is a guess we know is wrong for them, left
// as a guess rather than invented: `quiet_days` is one sentence away and a row
// they state beats every rule in this file.
function calendarFor({ locale, timezone, preference } = {}) {
  const stated = String(preference || '').trim().toLowerCase();
  if (CALENDARS.has(stated)) return stated;
  if (String(locale || '').trim().toLowerCase().startsWith('he')) return 'jewish';
  if (isIsrael(timezone)) return 'jewish';
  return 'christian';
}

// The weekday index (0 = Sunday, matching preferences.DAY_NAMES and
// gate.weekdayInTz) that somebody on this calendar gets by default, or null
// when there is nothing to assume.
function defaultQuietDay(calendar) {
  if (calendar === 'jewish') return 6;    // Saturday
  if (calendar === 'christian') return 0; // Sunday
  return null;
}

// How that day is NAMED to the person. It lives here rather than beside the
// copy because the copy and the gate must never be able to disagree about
// which day this is — the check-in rung states it in the same message that
// announces the default hours, and the test pins the sentence to this table
// for exactly the reason it pins the hours to DEFAULT_WINDOW.
const QUIET_DAY_WORDS = {
  0: { he: 'בימי ראשון', en: 'on Sundays' },
  6: { he: 'בשבת', en: 'on Saturdays' },
};

function quietDayWord(day, locale) {
  const words = QUIET_DAY_WORDS[day];
  if (!words) return null;
  return String(locale || '').trim().toLowerCase().startsWith('en') ? words.en : words.he;
}

module.exports = {
  calendarFor, defaultQuietDay, quietDayWord,
  isIsrael, QUIET_DAY_WORDS, ISRAEL_ZONES,
};
