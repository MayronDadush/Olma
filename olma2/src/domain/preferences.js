'use strict';
// Learned preferences as rows, not markdown inside AGENTS.md. The delivery
// gate reads availability from here (key 'availability'); everything else is
// free-form key/value the agent maintains about how this person likes to work.
const { ok, err } = require('./results');
const audit = require('./audit');
const { phoneLike } = require('./facts');

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

async function forget(client, userId, key) {
  const { rowCount } = await client.query(
    `DELETE FROM user_preferences WHERE user_id = $1 AND key = $2`, [userId, key]
  );
  if (!rowCount) return err('not_found', 'no such preference');
  await audit.record(client, userId, 'preference.forgotten', { key });
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

// Forgiving on the way in, strict about the result: anything unrecognised is
// dropped rather than failing, because the gate reads this on every row and a
// hand-edited preference must never be able to stop delivery entirely.
function parseQuietDays(value) {
  const days = new Set();
  for (const part of String(value || '').toLowerCase().split(/[\s,]+/)) {
    const i = DAY_NAMES.indexOf(part.slice(0, 3));
    if (i >= 0) days.add(i);
  }
  // Seven quiet days is not a preference, it is a pause — and pause is a
  // different feature with its own reversal path (domain/pause.js). Reading it
  // as "every day" would mute somebody permanently through a route nothing
  // reports on, so it is read as nothing at all.
  if (days.size >= 7) return [];
  return [...days].sort((a, b) => a - b);
}

async function quietDays(client, userId) {
  const { rows } = await client.query(
    `SELECT value FROM user_preferences WHERE user_id = $1 AND key = 'quiet_days'`,
    [userId]
  );
  if (!rows[0]) return ok({ days: [], source: 'default' });
  const days = parseQuietDays(rows[0].value);
  return ok({ days, source: days.length ? 'stated' : 'default' });
}

module.exports = {
  remember, forget, list, availabilityWindow, DEFAULT_WINDOW,
  quietDays, parseQuietDays, DAY_NAMES,
};
