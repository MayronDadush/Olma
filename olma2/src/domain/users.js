'use strict';
// User identity and creation. resolveByToken is the whole auth mechanism, same
// as v1: the identity token lives in a workspace-only file, so possession of
// the token IS the identity. No function here ever accepts a caller-supplied
// user_id as proof of anything.
const crypto = require('node:crypto');
const { ok, err } = require('./results');
const audit = require('./audit');
const timezoneRepair = require('./timezone-repair');

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
  const last = cleanName(lastName);
  if (!first) return err('invalid', 'first name required');
  const isConfirmed = confirmed !== false;
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
// sentence must not flip the whole relationship.
async function setLocale(client, userId, locale) {
  const code = String(locale || '').trim().toLowerCase().slice(0, 8);
  if (!/^[a-z]{2}(-[a-z]{2,8})?$/.test(code)) {
    return err('invalid', `unknown language code: ${locale}`);
  }
  await client.query(`UPDATE users SET locale = $2 WHERE id = $1`, [userId, code]);
  await audit.record(client, userId, 'user.locale_set', { locale: code });
  return ok({ locale: code });
}

// Who the assistant IS for this person, changed only on their own explicit
// ask ("תהיה גבר", "אני רוצה לקרוא לך נועה") — nothing observes its way into
// this. gender flips the Hebrew speech register everywhere the assistant
// speaks of itself (and picks the phone-call voice); name replaces אולמה.
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
  return ok({ gender: rows[0].assistant_gender, name: rows[0].assistant_name || 'אולמה' });
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

module.exports = {
  newIdentityToken, resolveByToken, getByPhone, getById,
  createUser, primaryChannel, sessionKeyFor, setName, setTimezone, setLocale,
  setAssistantPersona,
  cleanName,
};
