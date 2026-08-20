'use strict';
// Learned preferences as rows, not markdown inside AGENTS.md. The delivery
// gate reads availability from here (key 'availability'); everything else is
// free-form key/value the agent maintains about how this person likes to work.
const { ok, err } = require('./results');
const audit = require('./audit');

const KEY_RE = /^[a-z0-9_.-]{1,64}$/;

async function remember(client, userId, key, value) {
  if (!KEY_RE.test(key || '')) return err('invalid', 'key must be short lowercase [a-z0-9_.-]');
  if (!value || !String(value).trim()) return err('invalid', 'value required');
  const text = String(value).trim();
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
// 08:00-21:00 is ONLY a fallback for someone who has not told us their hours
// yet — quiet hours run from 21:00 until 08:00. It is a starting point, not
// an answer: the agent is expected to learn each person's real hours in
// conversation and store them here (see agents-template.md), because a
// shift worker and a parent of a toddler do not share a schedule.
const DEFAULT_WINDOW = { start: '08:00', end: '21:00' };

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

module.exports = { remember, forget, list, availabilityWindow, DEFAULT_WINDOW };
