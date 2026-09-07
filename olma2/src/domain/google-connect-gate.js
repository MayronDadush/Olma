'use strict';
// One door in front of every NEW Google consent link.
//
// The code half of a Google feature ships and auto-deploys; the half that
// lives in Google's console — the scopes, and the verification tier they put
// the app on — does not. In between, the link we hand somebody lands on
// Google's unverified-app warning, and a first impression that opens with
// "this app is not secure" is worse than a feature nobody was offered yet.
// That is the same reasoning `email_access_phones` already carries for mail,
// and this is the calendar-and-contacts twin of it (owner, 2026-09-08).
//
// ONE flag for all three doors on purpose: `start_google_connection` mints a
// single link covering calendar and contacts together, so a gate that closed
// only the calendar would still send the same person to the same screen
// through the contacts half. The screen is one screen; the switch is one
// switch. '' = nobody but an admin, 'all' = everybody, or a comma-separated
// E.164 list for a staged reopening.
//
// It gates MINTING a new link, never an existing connection: somebody who
// connected while it was open keeps working, syncing and reading exactly as
// before. Nothing is disconnected and nothing is revoked.
const flags = require('./flags');
const { ok, err } = require('./results');

const FLAG = 'google_connect_phones';

// Said to the MODEL, so it has to answer the question the model is about to
// ask itself — "should I offer this instead?" — and close it. The media
// precedent's wording, for the same reason: without the last clause the model
// helpfully tells the person to go and request access from somebody.
const REFUSAL = 'connecting Google is switched off on this server at the moment. '
  + 'Do not offer it, do not produce or promise a link, and do not suggest they ask anyone for access. '
  + 'If they asked for it themselves, say in one short line that it is not available just yet, '
  + 'with nothing technical in it, and carry on with what they came for.';

// `client` reads the flag and the user's own row; an admin is allowed whatever
// the list says, so the owner can always test the flow on himself.
async function requireGoogleConnect(client, userId) {
  const { rows } = await client.query(`SELECT phone, role FROM users WHERE id = $1`, [userId]);
  const user = rows[0];
  if (user && user.role === 'admin') return ok({ via: 'admin' });
  const raw = String((await flags.getFlag(client, FLAG)) ?? '').trim();
  if (raw.toLowerCase() === 'all') return ok({ via: 'open' });
  const allowed = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (user && user.phone && allowed.includes(user.phone)) return ok({ via: 'allowlist' });
  return err('forbidden', REFUSAL, { reason: 'google_connect_closed' });
}

module.exports = { requireGoogleConnect, FLAG, REFUSAL };
