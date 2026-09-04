'use strict';
// Calendar, contacts and Gmail are three separate `integrations` rows, but
// when they came from ONE combined consent (domain/google-connect.js) they
// share a single refresh token at Google. Revoking it kills all three at
// once — so a disconnect of just one must only call google.revoke() when it
// is removing the LAST sibling still standing. Skip it while another one
// lives on, or "stop syncing contacts" silently breaks a working calendar.
//
// A grant made the OLD way (one provider, one solo consent) is
// indistinguishable from a combined one once it is sitting in `integrations`
// — there is no column recording which flow produced it. Assuming they might
// share a token is the safe default: a needless GET before a DELETE, never a
// live connection killed by surprise.
const GOOGLE_FAMILY_PROVIDERS = ['google_calendar', 'google_contacts', 'gmail'];

async function hasOtherGoogleConnection(client, userId, excludingProvider) {
  const others = GOOGLE_FAMILY_PROVIDERS.filter((p) => p !== excludingProvider);
  if (!others.length) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM integrations WHERE user_id = $1 AND provider = ANY($2) LIMIT 1`,
    [userId, others]
  );
  return rows.length > 0;
}

module.exports = { GOOGLE_FAMILY_PROVIDERS, hasOtherGoogleConnection };
