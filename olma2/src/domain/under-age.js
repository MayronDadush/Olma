'use strict';
// "Allma is not for anyone under 16" is a sentence in the privacy policy, and
// until 2026-09-28 nothing checked it (compliance review of that day). The one
// place we could KNOW is the birth date somebody types on their own profile
// page (`users.birth_date`, migration 068) — and a date typed in is actual
// knowledge, which is what US COPPA turns on for a child under 13.
//
// So when a saved birth date makes the person younger than MIN_AGE on the day
// it is saved, ONE `issues` row is filed for the owner. That is all this does:
// it never messages the person, never pauses or deletes anything, and it is
// not BREAKS_USERS (their tool calls work fine). It is a proposal for the
// owner to act on (`.claude/rules/detectors.md`).
//
// A birth date is a DATE, not an instant: it has no zone, and neither does an
// age. What has a zone is TODAY — "are they 16 yet" on the evening before
// their birthday in Jerusalem is already the birthday in UTC+14 and still the
// day before in UTC. So today is read in the PERSON's zone and the two dates
// are compared as calendar dates, never as milliseconds (the same off-by-one
// `user-dashboard-events.js` warns about).
const issues = require('./issues');

const MIN_AGE = 16;
const FALLBACK_TZ = 'Asia/Jerusalem';
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseYmd(s) {
  const m = YMD_RE.exec(String(s || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Whole years between two calendar dates. A 29 February birthday turns a year
// older on 1 March in a common year (28 Feb < 29 Feb), which errs towards
// "still under" by one day — the safe side for this question.
function ageOn(birthYmd, todayYmd) {
  const b = parseYmd(birthYmd);
  const t = parseYmd(todayYmd);
  if (!b || !t) return null;
  const beforeBirthday = t[1] < b[1] || (t[1] === b[1] && t[2] < b[2]);
  return t[0] - b[0] - (beforeBirthday ? 1 : 0);
}

// The calendar date it is right now where they are. An unreadable zone falls
// back rather than throwing: `users.timezone` is never NULL, but a save must
// not fail over an alarm.
function localToday(now, tz) {
  const fmt = (zone) => new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  try { return fmt(tz || FALLBACK_TZ); } catch { return fmt(FALLBACK_TZ); }
}

function isUnderAge(birthYmd, todayYmd, min = MIN_AGE) {
  const age = ageOn(birthYmd, todayYmd);
  return age !== null && age < min;
}

// Deterministic — it is the dedup key — and it carries no birth date.
function titleFor(userId) {
  return `Under-16 birth date saved: user ${userId}`;
}

// Called by `users.setPersonal` after a birth date is written. Files at most
// one OPEN row per person: a second save while one is open adds nothing, and
// a save after the owner has closed it is a new fact and files again.
async function flagIfUnderAge(client, userId, birthYmd, tz, now = new Date()) {
  if (!birthYmd) return { flagged: false };
  const today = localToday(now, tz);
  const age = ageOn(birthYmd, today);
  if (age === null || age >= MIN_AGE) return { flagged: false, age };
  const title = titleFor(userId);
  const { rows } = await client.query(
    `SELECT id FROM issues WHERE title = $1 AND status IN ('new', 'triaged') LIMIT 1`, [title]);
  if (rows[0]) return { flagged: true, filed: false, issueId: rows[0].id, age };
  const res = await issues.reportIssue(client, userId, {
    category: 'edge_case',
    source: 'agent_detected',
    title,
    // The age, not the date: enough to tell under-13 (COPPA) from 13-15.
    detail: JSON.stringify({
      age, under13: age < 13, savedOn: today,
      note: 'Birth date saved on their profile page says they are under 16. Nothing was sent, paused or deleted. Owner to decide.',
    }),
    relatedEntityType: 'user',
    relatedEntityId: userId,
  });
  const issue = res.ok ? res.data.issue : null;
  return { flagged: true, filed: Boolean(issue), issueId: issue ? issue.id : null, age };
}

module.exports = { MIN_AGE, ageOn, localToday, isUnderAge, titleFor, flagIfUnderAge };
