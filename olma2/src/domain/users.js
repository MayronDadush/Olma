'use strict';
// User identity and creation. resolveByToken is the whole auth mechanism, same
// as v1: the identity token lives in a workspace-only file, so possession of
// the token IS the identity. No function here ever accepts a caller-supplied
// user_id as proof of anything.
const crypto = require('node:crypto');
const { ok, err } = require('./results');
const audit = require('./audit');
const timezoneRepair = require('./timezone-repair');
const language = require('./language');

function newIdentityToken() {
  return 'olma_tok_' + crypto.randomBytes(16).toString('hex');
}

async function resolveByToken(client, identityToken) {
  // The wording of these two messages is load-bearing twice over: the MCP shim
  // matches on it to self-heal with the session's proven token, and the tail
  // tells the model the one recovery that actually works — re-reading the file
  // — instead of leaving it to invent another guess.
  // Careful: no token-prefix literal in here — everything on this path flows
  // through scrubTokens-guarded output, and the e2e suite asserts the prefix
  // never appears in any reply, error text included.
  const recovery = ' — read the file .olma-identity in your workspace and retry with its exact contents as olma_identity (exactly 41 characters), never from memory and never a shortened form from an earlier call';
  if (!identityToken || typeof identityToken !== 'string') return err('forbidden', 'missing identity token' + recovery);
  const { rows } = await client.query(
    `SELECT * FROM users WHERE identity_token = $1`, [identityToken]
  );
  if (!rows[0]) return err('forbidden', 'unknown identity token' + recovery);
  if (rows[0].status === 'blocked') return err('forbidden', 'user is blocked');
  return ok({ user: rows[0] });
}

async function getByPhone(client, phone) {
  const { rows } = await client.query(`SELECT * FROM users WHERE phone = $1`, [phone]);
  return rows[0] || null;
}

async function getById(client, id) {
  const { rows } = await client.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Creates the user with everything a user always has: primary whatsapp
// channel row + free entitlement. One place, so no code path can create a
// user missing its invariants.
async function createUser(client, { phone, firstName, lastName, locale, timezone, invitedByConnectionId, status }) {
  if (!/^\+\d{7,15}$/.test(phone || '')) return err('invalid', 'phone must be E.164');
  const existing = await getByPhone(client, phone);
  if (existing) return err('conflict', 'user already exists', { userId: existing.id });

  const token = newIdentityToken();
  const { rows } = await client.query(
    `INSERT INTO users (phone, first_name, last_name, locale, timezone, identity_token, invited_by_connection_id, status)
     VALUES ($1, $2, $3, COALESCE($4, 'he'), $5, $6, $7, COALESCE($8, 'active'))
     RETURNING *`,
    [phone, cleanName(firstName) || null, cleanName(lastName) || null,
     locale || null, timezone || null, token,
     invitedByConnectionId || null, status || null]
  );
  const user = rows[0];
  await client.query(
    `INSERT INTO user_channels (user_id, channel_type, channel_identifier, is_primary)
     VALUES ($1, 'whatsapp', $2, TRUE)`,
    [user.id, phone]
  );
  await client.query(`INSERT INTO entitlements (user_id) VALUES ($1)`, [user.id]);
  await audit.record(client, user.id, 'user.provisioned', { phone, invitedByConnectionId: invitedByConnectionId || null });
  return ok({ user });
}

// Proactive sends resolve their target through here — never a hardcoded
// whatsapp:direct:<phone> in calling code.
async function primaryChannel(client, userId) {
  const { rows } = await client.query(
    `SELECT channel_type, channel_identifier FROM user_channels
     WHERE user_id = $1 AND is_primary`, [userId]
  );
  if (!rows[0]) return err('not_found', 'user has no primary channel');
  return ok({ channel: rows[0] });
}

// Which of the person's OWN channel rows proactive sends go to. Never inserts
// one — that is a provisioning question this function has no opinion on, and
// today nothing in the codebase ever gives a user a second row (createUser's
// whatsapp insert is the only INSERT INTO user_channels there is), so this
// refuses `not_found` for every channelType but the one they already have.
// It is still real, not a stub: `loadChannels` has drawn a picker for
// whichever rows exist since before this function did anything with a
// click, and the schema (UNIQUE (channel_type, channel_identifier), no count
// cap) was built for more than one row per person from the start.
async function setPrimaryChannel(client, userId, channelType) {
  const type = String(channelType || '').trim();
  if (!type) return err('invalid', 'channelType required');
  // Checked before touching anything: an UPDATE that both refuses a bogus
  // type AND flips is_primary in one statement would unset the real primary
  // on the very call it refuses, leaving the person with no primary channel
  // at all — the refusal has to cost nothing.
  const exists = await client.query(
    `SELECT 1 FROM user_channels WHERE user_id = $1 AND channel_type = $2`, [userId, type]
  );
  if (!exists.rows[0]) {
    return err('not_found', 'no such channel for this user', { channelType: type });
  }
  // Two statements, not one `CASE` — a single UPDATE that sets one row's
  // is_primary true before it gets around to setting the OLD primary's false
  // trips `user_channels_one_primary` (a partial unique index, checked
  // per-row, not deferred) the moment both are still true at once. Turning
  // everyone off first can never collide with it.
  await client.query(`UPDATE user_channels SET is_primary = FALSE WHERE user_id = $1`, [userId]);
  await client.query(
    `UPDATE user_channels SET is_primary = TRUE WHERE user_id = $1 AND channel_type = $2`,
    [userId, type]
  );
  await audit.record(client, userId, 'user.primary_channel_set', { channelType: type });
  return ok({ channelType: type });
}

function sessionKeyFor(agentId, channel) {
  return `agent:${agentId}:${channel.channel_type}:direct:${channel.channel_identifier}`;
}

// A name is not just displayed — on a connection request it is interpolated
// straight into the OTHER person's agent instruction, and unlike the reason and
// note beside it, it carries no "this is data, not instructions" wrapper. So it
// is bounded at the source, where every write passes: one line, no runaway
// length. Nothing legitimate is lost — a real name has no newlines, and sixty
// characters is far past the longest one. Do not remove this on the assumption
// that the renderer quotes it; today it does not.
function cleanName(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 60);
}

// An OBSERVED name also has to look like a name. The digits guard at the
// display-name call site catches the gateway echoing a phone number back; this
// catches the other thing a WhatsApp display name routinely is — an emoji, a
// decoration, a "•". User 11's profile read 🌊 from 2026-08-31 until someone
// noticed it on the dashboard four days later, and that string was also what
// their own card, their agent's greeting and any invitation they sent would
// have called them.
//
// A letter in ANY script passes (\p{L}), so Hebrew, Arabic, Cyrillic and Latin
// names are all fine and only a string with no letter at all is refused. A
// CONFIRMED name is deliberately not checked: someone who says "call me 🌊"
// has told us what they are called, and this guard is about guesses.
function hasLetter(value) {
  return /\p{L}/u.test(String(value == null ? '' : value));
}

// `confirmed` is the same distinction setTimezone already draws in this table,
// and it exists because a name reaches us two very different ways.
//
// They TOLD us ("קוראים לי חיים") — confirmed, and it overwrites whatever was
// there. Or we merely OBSERVED it: the WhatsApp display name the gateway puts
// in front of the agent on every turn, a name someone else had us saved under,
// a name read back out of the conversation by the extraction job. An
// observation is a good guess and a bad fact — good enough to open with, never
// good enough to overwrite what the person themselves confirmed, and it leaves
// name_confirmed FALSE so the agent still checks.
//
// Getting this wrong in the cheap direction is what caused the failure this
// parameter exists to end: with no way to write a name we were not certain of,
// a name we did know sat in the fact table as prose while users.first_name
// stayed NULL, and everything keyed on first_name — the card the agent reads
// every turn, connection invitations, the dashboard — behaved as though we had
// never heard of the person.
async function setName(client, userId, firstName, lastName, { confirmed = true, source = null } = {}) {
  const first = cleanName(firstName);
  let last = cleanName(lastName);
  if (!first) return err('invalid', 'first name required');
  const isConfirmed = confirmed !== false;
  if (!isConfirmed) {
    if (!hasLetter(first)) return err('invalid', 'that is decoration, not a name');
    // "חיים 🌊" is a real first name beside an emoji. Refusing the whole
    // string would lose the name; only the letterless half is dropped.
    if (last && !hasLetter(last)) last = '';
  }
  const { rows } = await client.query(
    // The guarded UPDATE, not a read-then-write: two turns can land here at
    // once, and the guard has to be the write itself.
    // last_name: an explicit set clears it (they gave one name, that is now
    // their name); a guess that carries no surname leaves an existing one
    // alone rather than deleting information nobody asked to delete.
    `UPDATE users
        SET first_name = $2,
            last_name = COALESCE($3, CASE WHEN $4 THEN NULL ELSE last_name END),
            name_confirmed = $4
      WHERE id = $1 AND ($4 = TRUE OR name_confirmed = FALSE)
      RETURNING id, first_name, last_name, name_confirmed`,
    [userId, first, last || null, isConfirmed]
  );
  if (!rows[0]) {
    // Costs a query only on the path that already did nothing, and keeps the
    // two reasons a write can be refused from wearing each other's message.
    const { rows: exists } = await client.query(`SELECT id FROM users WHERE id = $1`, [userId]);
    if (!exists[0]) return err('not_found', 'no such user');
    return err('conflict', 'they already told us their name', { reason: 'name_confirmed' });
  }
  await audit.record(client, userId, isConfirmed ? 'user.name_set' : 'user.name_observed', {
    firstName: rows[0].first_name, lastName: rows[0].last_name, source,
  });
  return ok({ user: rows[0] });
}

// Their language, changed ONLY on their own explicit request — an observed
// language is set once at provisioning (domain/language.js) and never
// silently revised afterwards, because a single English word in a Hebrew
// sentence must not flip the whole relationship. `noteObservedLanguage` below
// is how we NOTICE we got it wrong; it still never writes this column.
// Chasing is opt-in (domain/reminders.RUNGS, migration 072). This is the
// STANDING answer — every reminder of theirs climbs the full ladder — beside
// the per-reminder one set_task_reminder takes. Off by default, and turning it
// off again leaves the ladders already walking exactly where they are: a rung
// that is about to go out is the thing they just asked to stop, and stopping
// it is stopRecentLadders' job, said in their own words.
async function setReminderNudge(client, userId, on) {
  const value = on === true;
  await client.query(`UPDATE users SET reminder_nudge = $2 WHERE id = $1`, [userId, value]);
  await audit.record(client, userId, 'user.reminder_nudge_set', { on: value });
  return ok({ reminderNudge: value });
}

async function setLocale(client, userId, locale) {
  const code = String(locale || '').trim().toLowerCase().slice(0, 8);
  if (!/^[a-z]{2}(-[a-z]{2,8})?$/.test(code)) {
    return err('invalid', `unknown language code: ${locale}`);
  }
  await client.query(`UPDATE users SET locale = $2 WHERE id = $1`, [userId, code]);
  await audit.record(client, userId, 'user.locale_set', { locale: code });
  return ok({ locale: code });
}

// One message's language, as reported by the only party that can see it.
//
// This never changes users.locale. It counts how many messages in a row
// disagreed with what we store and, at three, hands the agent a nudge to ASK
// — the same shape as the travel detector, and for the same reason the owner
// gave when that one was built: confirm in a message, never act silently.
// Switching somebody's language underneath them because a heuristic fired is
// exactly the silent act that rule forbids.
//
// The CODE crosses this boundary and nothing else. No message text is passed
// in, stored, or audited — see domain/language.js for why that constraint
// shapes the whole design.
async function noteObservedLanguage(client, user, observed, now) {
  const decided = language.decideStreak({
    stored: user.locale,
    observed,
    prevObserved: user.locale_observed,
    prevCount: user.locale_observed_count,
    askedAt: user.locale_asked_at,
    now,
  });

  // The ask is stamped in the SAME statement that records the streak. Two
  // statements would let a crash between them hand the nudge to the agent and
  // forget that it did, which is how a helpful question becomes one asked on
  // every message.
  await client.query(
    `UPDATE users SET locale_observed = $2, locale_observed_count = $3
        ${decided.ask ? ', locale_asked_at = now()' : ''}
      WHERE id = $1`,
    [user.id, decided.observed, decided.count]);

  // Audited only when it leads somewhere. A row per message would bury the
  // audit log under the most common event in the system, and "they wrote in
  // the language we expected" is not a finding.
  if (decided.ask) {
    await audit.record(client, user.id, 'user.locale_mismatch_noticed',
      { observed: decided.observed, stored: user.locale || null, streak: decided.count });
  }
  return decided;
}

// Who the assistant IS for this person, changed only on their own explicit
// ask ("תהיה גבר", "אני רוצה לקרוא לך נועה") — nothing observes its way into
// this. gender flips the Hebrew speech register everywhere the assistant
// speaks of itself (and picks the phone-call voice); name replaces עולמה.
// name: '' resets to the default rather than storing an empty string.
async function setAssistantPersona(client, userId, { gender, name } = {}) {
  let newGender = null;
  if (gender !== undefined && gender !== null) {
    newGender = String(gender).trim().toLowerCase();
    if (newGender !== 'female' && newGender !== 'male') {
      return err('invalid', `gender must be "female" or "male", got: ${gender}`);
    }
  }
  const nameGiven = name !== undefined && name !== null;
  const newName = nameGiven ? String(name).replace(/\s+/g, ' ').trim().slice(0, 40) || null : null;
  if (!newGender && !nameGiven) return err('invalid', 'nothing to change — pass gender and/or name');
  const { rows } = await client.query(
    `UPDATE users
        SET assistant_gender = COALESCE($2, assistant_gender),
            assistant_name = CASE WHEN $3 THEN $4 ELSE assistant_name END
      WHERE id = $1
      RETURNING assistant_gender, assistant_name`,
    [userId, newGender, nameGiven, newName]
  );
  if (!rows[0]) return err('not_found', 'no such user');
  await audit.record(client, userId, 'user.assistant_persona_set', {
    gender: rows[0].assistant_gender, name: rows[0].assistant_name,
  });
  return ok({ gender: rows[0].assistant_gender, name: rows[0].assistant_name || 'עולמה' });
}

// Changing the zone used to change one column and leave every instant already
// written at the old offset — see domain/timezone-repair.js for what that cost.
//
// The repair runs only when we are replacing a zone WE GUESSED. That gate is
// the whole safety argument, and it cuts both ways:
//
//   guessed → anything     the rows were converted through a zone that was
//                          never right, so they are all wrong by the same
//                          delta, and the wall clock the person said is
//                          recoverable exactly.
//   confirmed → anything   they told us Jerusalem and are now telling us
//                          Berlin: they MOVED. Their 15:00 Jerusalem meeting
//                          is still that instant, and re-labelling it 15:00
//                          Berlin would move a correct row for no reason.
//
// So travel is not a repair, and a first correction of a phone-prefix guess is.
async function setTimezone(client, userId, timezone, confirmed) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    return err('invalid', `unknown timezone: ${timezone}`);
  }
  // Read the old value under a lock in the same transaction as the write —
  // UPDATE ... RETURNING would hand back the new one, and this decides whether
  // a repair runs at all.
  const { rows: before } = await client.query(
    `SELECT timezone, timezone_confirmed FROM users WHERE id = $1 FOR UPDATE`, [userId]
  );
  if (!before[0]) return err('not_found', 'no such user');
  const wasGuessed = before[0].timezone_confirmed === false;
  const oldTz = before[0].timezone;

  await client.query(
    `UPDATE users SET timezone = $2, timezone_confirmed = $3 WHERE id = $1`,
    [userId, timezone, Boolean(confirmed)]
  );
  await audit.record(client, userId, 'user.timezone_set', { timezone, confirmed: Boolean(confirmed) });

  const repair = wasGuessed && oldTz && oldTz !== timezone
    ? await timezoneRepair.repairAfterZoneChange(client, userId, oldTz, timezone)
    : { tasks: [], reminders: [], meetings: [], fromTz: oldTz, toTz: timezone };

  return ok({
    timezone, confirmed: Boolean(confirmed),
    previousTimezone: oldTz,
    // Named for what the agent has to DO with them: say what moved, and raise
    // the meetings it could not move.
    movedTasks: repair.tasks, movedReminders: repair.reminders,
    meetingsToRecheck: repair.meetings,
  });
}

// How Olma addresses THEM, and when they were born — the two profile fields
// that had no column until migration 068. Written only from their own screen:
// nothing observes its way into either, for the same reason the assistant's
// persona is only ever changed on an explicit ask.
//
// `undefined` leaves a field alone; `null` or '' clears it, which is how
// "I would rather not say" is answered.
const GENDERS = new Set(['male', 'female']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validBirthDate(value, now = new Date()) {
  const m = DATE_RE.exec(String(value));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  // Rejects 2026-02-30 rolling into March, and a year nobody alive was born in
  // or that has not happened yet.
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d
    && y >= 1900 && probe.getTime() <= now.getTime();
}

async function setPersonal(client, userId, { gender, birthDate } = {}, now = new Date()) {
  const sets = [];
  const params = [userId];
  if (gender !== undefined) {
    const g = gender === null || gender === '' ? null : String(gender).trim().toLowerCase();
    if (g !== null && !GENDERS.has(g)) return err('invalid', 'gender must be "male" or "female"', { reason: 'gender' });
    params.push(g);
    sets.push(`gender = $${params.length}`);
  }
  if (birthDate !== undefined) {
    const b = birthDate === null || birthDate === '' ? null : String(birthDate).trim();
    if (b !== null && !validBirthDate(b, now)) {
      return err('invalid', 'birth date must be a real past date, YYYY-MM-DD', { reason: 'birth_date' });
    }
    params.push(b);
    sets.push(`birth_date = $${params.length}::date`);
  }
  if (!sets.length) return err('invalid', 'nothing to change — pass gender and/or birthDate');
  const { rows } = await client.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1
      RETURNING gender, to_char(birth_date, 'YYYY-MM-DD') AS birth_date`, params);
  if (!rows[0]) return err('not_found', 'no such user');
  // The fields that changed, never the values: a birthday is personal data and
  // the audit trail is read by operators.
  await audit.record(client, userId, 'user.personal_set', {
    gender: gender !== undefined, birthDate: birthDate !== undefined,
  });
  if (gender !== undefined) await syncGenderForms(client, userId, rows[0].gender);
  return ok({ gender: rows[0].gender, birthDate: rows[0].birth_date });
}

// The profile column moved, so the private chat's own record of it follows
// (owner, 2026-09-23: "אם יש מגדר בקבוצה חדש שיתעדכן גם בפרופיל … וכמובן אם הוא
// משנה בשיחה הפרטית … גם זה יהיה בהתאמה בקבוצה"). The `gender_forms`
// preference is what turn_start reads in the private chat; left alone, a
// change made on the page or in a room would be contradicted there by an
// older word. A preference that already reads the same way is left as they
// said it; a cleared gender takes the preference with it, or the room would
// fall back to it and keep using a form they just withdrew.
// `preferences.remember` is the other direction, and calls back into
// `setPersonal` only when the words disagree with the column, so the two
// cannot bounce.
async function syncGenderForms(client, userId, g) {
  const { genderFromWords, WORDS } = require('./gender-forms');
  const { rows: pref } = await client.query(
    `SELECT value FROM user_preferences WHERE user_id = $1 AND key = 'gender_forms'`, [userId]);
  const said = pref[0] ? genderFromWords(pref[0].value) : null;
  if (g === null) {
    if (!pref[0]) return;
    await client.query(`DELETE FROM user_preferences WHERE user_id = $1 AND key = 'gender_forms'`, [userId]);
    await audit.record(client, userId, 'preference.forgotten', { key: 'gender_forms', source: 'profile' });
    return;
  }
  if (said === g) return;
  await client.query(
    `INSERT INTO user_preferences (user_id, key, value) VALUES ($1, 'gender_forms', $2)
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, learned_at = now()`,
    [userId, WORDS[g]]);
  await audit.record(client, userId, 'preference.remembered', {
    key: 'gender_forms', overwrote: Boolean(pref[0]), source: 'profile',
  });
}

module.exports = {
  setPersonal,
  newIdentityToken, resolveByToken, getByPhone, getById,
  createUser, primaryChannel, setPrimaryChannel, sessionKeyFor, setName, setTimezone, setLocale,
  setReminderNudge,
  noteObservedLanguage,
  setAssistantPersona,
  cleanName,
};
