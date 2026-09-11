'use strict';
// Learned preferences as rows, not markdown inside AGENTS.md. The delivery
// gate reads availability from here (key 'availability'); everything else is
// free-form key/value the agent maintains about how this person likes to work.
const { ok, err } = require('./results');
const audit = require('./audit');
const { phoneLike } = require('./facts');
const holidays = require('./holidays');

const KEY_RE = /^[a-z0-9_.-]{1,64}$/;

async function remember(client, userId, key, value) {
  if (!KEY_RE.test(key || '')) return err('invalid', 'key must be short lowercase [a-z0-9_.-]');
  if (!value || !String(value).trim()) return err('invalid', 'value required');
  const text = String(value).trim();
  // Same structural rule as facts (see phoneLike there): phone numbers live in
  // contacts/connections, never in prose a model might mis-recall.
  if (phoneLike(text)) {
    return err('invalid', 'a phone number never goes into a preference — save the person with save_contact instead');
  }
  // 'overwrote' in the audit detail = this write replaced a DIFFERENT existing
  // value. The corrections metric (jobs/metrics.js) needs it to tell "the
  // person changed what we knew" apart from an agent idempotently re-saving
  // the same thing — both look identical as bare preference.remembered events.
  const { rows: prev } = await client.query(
    `SELECT value FROM user_preferences WHERE user_id = $1 AND key = $2`, [userId, key]
  );
  const overwrote = prev.length > 0 && prev[0].value !== text;
  await client.query(
    `INSERT INTO user_preferences (user_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, learned_at = now()`,
    [userId, key, text]
  );
  await audit.record(client, userId, 'preference.remembered', { key, overwrote });
  return ok({ key });
}

async function forget(client, userId, key, user = {}) {
  const { rowCount } = await client.query(
    `DELETE FROM user_preferences WHERE user_id = $1 AND key = $2`, [userId, key]
  );
  if (!rowCount) return err('not_found', 'no such preference');
  await audit.record(client, userId, 'preference.forgotten', { key });
  // Deleting this one key does not mean "no quiet days" any more — it means
  // "go back to the default", which since 2026-09-11 is a real day. Every
  // sentence a person actually says here ("write to me on Saturdays too") is
  // the OPPOSITE of what the delete now does, so the one call that can get
  // this wrong is told so on its own result.
  //
  // It is guidance about a TOOL, never an instruction to write: this tool is
  // marked done (reactions.TOOL_MARKS), the 👍 is already on their message,
  // and an unconditional "say something" beside a mark is the markPlaced
  // fault. If the model needs to fix it, the fix is another call, not a line.
  if (key === 'quiet_days') {
    const day = holidays.defaultQuietDay(holidays.calendarFor(user));
    const word = holidays.quietDayWord(day, user.locale);
    if (word) {
      return ok({
        key,
        hints: {
          quietDayDefault: `The DEFAULT quiet day is now back for them: ${word}.`
            + ' If what they meant was that they want no quiet day at all, that is not this call —'
            + ' save quiet_days as "none" instead.',
        },
      });
    }
  }
  return ok({ key });
}

async function list(client, userId) {
  const { rows } = await client.query(
    `SELECT key, value, learned_at FROM user_preferences WHERE user_id = $1 ORDER BY key`,
    [userId]
  );
  return ok({ preferences: rows });
}

// Availability for the delivery gate. Stored as "HH:MM-HH:MM" in the user's
// own timezone under key 'availability'.
//
// 09:00-21:00 is ONLY a fallback for someone who has not told us their hours
// yet — quiet hours run from 21:00 until 09:00. It is a starting point, not
// an answer: the agent is expected to learn each person's real hours in
// conversation and store them here (see agents-template.md), because a
// shift worker and a parent of a toddler do not share a schedule.
//
// The number moved 09:00-20:00 → 08:00-21:00 → 09:00-21:00 (owner, 2026-09-08),
// and the last move is the first one a stranger is TOLD about: the discovery
// ladder's timezone rung now states these hours in the same message that asks
// which country they are in. So this constant is no longer only a fallback —
// it is a sentence somebody read, and changing it without changing that
// sentence makes the first message we ever sent them a lie.
const DEFAULT_WINDOW = { start: '09:00', end: '21:00' };

async function availabilityWindow(client, userId) {
  const { rows } = await client.query(
    `SELECT value FROM user_preferences WHERE user_id = $1 AND key = 'availability'`,
    [userId]
  );
  if (!rows[0]) return ok({ window: DEFAULT_WINDOW, source: 'default' });
  const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(rows[0].value.trim());
  if (!m) return ok({ window: DEFAULT_WINDOW, source: 'default' }); // unparseable → fallback, never crash the gate
  return ok({ window: { start: `${m[1]}:${m[2]}`, end: `${m[3]}:${m[4]}` }, source: 'stated' });
}

// ---- days they want nothing at all -----------------------------------------
// A window is hours; this is DAYS. Somebody who keeps Shabbat, or simply does
// not want work on a Friday, cannot express that as "HH:MM-HH:MM" — and until
// 2026-09-08 there was nowhere in the system for the answer to go, so the
// question was never asked. It is asked now (jobs/checkin.js, the timezone
// rung), which is exactly why this had to exist first: a question whose answer
// has nowhere to land is worse than no question.
//
// Stored under key 'quiet_days' as lowercase English three-letter days,
// comma-separated: "fri,sat". English and not Hebrew because it is a key's
// value, read by code — what the PERSON said is in their own words in the
// conversation, and the model translates once, here.
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Since 2026-09-11 an unstated quiet day is not "none" — it is Saturday for
// somebody on a Jewish calendar and Sunday for a Christian one
// (domain/holidays.js). That makes the difference between "they have not
// said" and "they said none" load-bearing for the first time, so this returns
// THREE answers rather than two:
//
//   [5, 6]  they named days
//   []      they said, in so many words, that they want no quiet day
//   null    there is nothing here we can read as an answer
//
// Same distinction the rest of this codebase keeps having to relearn: `null`
// (could not read) and `[]` (read, found nothing) must never collapse into one
// value. Collapsed, a hand-typed "weekends" would silently cancel the default
// somebody was told about in their first week.
//
// Forgiving on the way in, because the gate reads this on every row and a
// hand-edited preference must never be able to stop delivery entirely.
// Deliberately short, and deliberately without "all"/"any": "all days" is the
// seven-day case one line down, not a refusal, and guessing wrong on that word
// is the one mistake here that mutes somebody.
const SAID_NONE = new Set(['none', 'no', 'never', 'nothing', 'off']);

function parseQuietDays(value) {
  const parts = String(value || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  const days = new Set();
  let none = false;
  for (const part of parts) {
    const i = DAY_NAMES.indexOf(part.slice(0, 3));
    if (i >= 0) { days.add(i); continue; }
    if (SAID_NONE.has(part)) none = true;
  }
  // A named day beats "none" in the same value: "no, only sat" is an answer
  // about Saturday, and reading it as a refusal would drop the one day in it.
  if (days.size && days.size < 7) return [...days].sort((a, b) => a - b);
  // Seven quiet days is not a preference, it is a pause — and pause is a
  // different feature with its own reversal path (domain/pause.js). Reading it
  // as "every day" would mute somebody permanently through a route nothing
  // reports on, so it is read as no answer at all, and the default stands.
  if (days.size >= 7) return null;
  return none ? [] : null;
}

// `user` is the joined users row — `locale` and `timezone` — plus the
// `holiday_calendar` preference, which is read here in the same query rather
// than by a second caller, because the DEFAULT is a fact about the person and
// every reader of it has to get the same one.
async function quietDays(client, userId, user = {}) {
  const { rows } = await client.query(
    `SELECT key, value FROM user_preferences
      WHERE user_id = $1 AND key IN ('quiet_days', 'holiday_calendar')`,
    [userId]
  );
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const stated = byKey.quiet_days === undefined ? null : parseQuietDays(byKey.quiet_days);
  if (stated !== null) return ok({ days: stated, source: 'stated' });
  const calendar = holidays.calendarFor({
    locale: user.locale, timezone: user.timezone, preference: byKey.holiday_calendar,
  });
  const day = holidays.defaultQuietDay(calendar);
  return ok({ days: day === null ? [] : [day], source: 'default', calendar });
}

module.exports = {
  remember, forget, list, availabilityWindow, DEFAULT_WINDOW,
  quietDays, parseQuietDays, DAY_NAMES, SAID_NONE,
};
