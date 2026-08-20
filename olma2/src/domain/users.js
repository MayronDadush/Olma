'use strict';
// User identity and creation. resolveByToken is the whole auth mechanism, same
// as v1: the identity token lives in a workspace-only file, so possession of
// the token IS the identity. No function here ever accepts a caller-supplied
// user_id as proof of anything.
const crypto = require('node:crypto');
const { ok, err } = require('./results');
const audit = require('./audit');

function newIdentityToken() {
  return 'olma_tok_' + crypto.randomBytes(16).toString('hex');
}

async function resolveByToken(client, identityToken) {
  if (!identityToken || typeof identityToken !== 'string') return err('forbidden', 'missing identity token');
  const { rows } = await client.query(
    `SELECT * FROM users WHERE identity_token = $1`, [identityToken]
  );
  if (!rows[0]) return err('forbidden', 'unknown identity token');
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

async function setName(client, userId, firstName, lastName) {
  const first = cleanName(firstName);
  const last = cleanName(lastName);
  if (!first) return err('invalid', 'first name required');
  const { rows } = await client.query(
    `UPDATE users SET first_name = $2, last_name = $3, name_confirmed = TRUE
     WHERE id = $1 RETURNING id, first_name, last_name`,
    [userId, first, last || null]
  );
  await audit.record(client, userId, 'user.name_set', { firstName: rows[0].first_name, lastName: rows[0].last_name });
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

async function setTimezone(client, userId, timezone, confirmed) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    return err('invalid', `unknown timezone: ${timezone}`);
  }
  await client.query(
    `UPDATE users SET timezone = $2, timezone_confirmed = $3 WHERE id = $1`,
    [userId, timezone, Boolean(confirmed)]
  );
  await audit.record(client, userId, 'user.timezone_set', { timezone, confirmed: Boolean(confirmed) });
  return ok({ timezone, confirmed: Boolean(confirmed) });
}

module.exports = {
  newIdentityToken, resolveByToken, getByPhone, getById,
  createUser, primaryChannel, sessionKeyFor, setName, setTimezone, setLocale,
};
