'use strict';
// One consent link for calendar + contacts, instead of two separate ones from
// calendar.js / google-contacts.js. Google itself shows one checkbox per scope
// on its consent screen, so this does not remove the user's ability to grant
// only some of what was asked — it only removes the need to click "connect"
// twice and approve two separate screens for the same account.
//
// Gmail was the third member until 2026-09-30. `gmail.readonly` is a
// RESTRICTED scope and prices the whole app into Google's paid verification
// track, so it was closed on 2026-09-07 and removed from the code entirely on
// 2026-09-30. A state minted before then may still carry `mail: true` in
// requested_services; it is ignored, never granted.
//
// This module owns exactly ONE thing the single-purpose flows do not need:
// turning ONE code exchange into UP TO TWO `integrations` rows. Everything
// else — the encrypted-column shape, the checkbox-not-ticked trap, the
// connected/needs_reauth/disconnected vocabulary — is copied from them
// deliberately (same house rule stated in google-contacts.js: copying the
// plumbing beats threading a shared parameter through live, working files).
//
// PARTIAL grants are the normal case here, not a failure: a person who
// wanted "calendar and contacts" but unticked contacts on Google's screen
// should end up with calendar connected and a plain sentence about contacts —
// never nothing at all because one of two pieces was declined. Only when NOTHING
// requested was actually granted is the token revoked and the whole thing
// reported as declined.
const { ok, err } = require('./results');
const actionLink = require('./action-link');
const audit = require('./audit');
const cryptoStore = require('./crypto-store');
const google = require('./google-oauth');
const connectGate = require('./google-connect-gate');
const { enqueue } = require('../outbox/enqueue');
const calendar = require('./calendar');
const googleContacts = require('./google-contacts');

const PROVIDER = 'google_connect';
const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';

// ---- consent ----------------------------------------------------------------

// calendarAccess: null (not requested) | 'read_only' | 'read_write'.
// wantContacts: boolean. At least one of the two must be truthy.
async function beginConnection(client, user, { calendarAccess, wantContacts } = {}) {
  if (calendarAccess && !google.SCOPES[calendarAccess]) {
    return err('invalid', 'calendarAccess must be "read_only", "read_write", or omitted');
  }
  if (!calendarAccess && !wantContacts) {
    return err('invalid', 'ask which of calendar or contacts the user wants — at least one is required');
  }
  // Calendar and contacts share the consent screen this gate exists to keep
  // people off, so the combined link is refused whenever it is asked for.
  const gate = await connectGate.requireGoogleConnect(client, user.id);
  if (!gate.ok) return gate;
  if (!google.isConfigured()) {
    return err('invalid', 'Google is not configured on this server');
  }

  const scopes = new Set([google.EMAIL_SCOPE]);
  if (calendarAccess) for (const s of google.SCOPES[calendarAccess].split(' ')) scopes.add(s);
  if (wantContacts) scopes.add(CONTACTS_SCOPE);

  const state = google.newState();
  const requestedServices = {
    calendar: calendarAccess || null,
    contacts: Boolean(wantContacts),
  };
  await client.query(
    `INSERT INTO oauth_states (state, user_id, provider, requested_services, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [state, user.id, PROVIDER, JSON.stringify(requestedServices), google.STATE_TTL_MS / 1000]
  );
  await audit.record(client, user.id, 'google_connect.auth_started', requestedServices);

  const parts = [];
  if (calendarAccess === 'read_write') parts.push('יומן (צפייה + עריכה)');
  else if (calendarAccess === 'read_only') parts.push('יומן (צפייה בלבד)');
  if (wantContacts) parts.push('אנשי קשר (קריאה בלבד)');

  return ok(actionLink.withLink(google.buildConsentUrl(state, [...scopes].join(' ')), {
    requested: requestedServices,
    validForMinutes: google.STATE_TTL_MS / 60000,
    tellTheUser: `הקישור מבקש: ${parts.join(', ')}. במסך של גוגל אפשר לבטל סימון לכל אחד מהם בנפרד — עולמה תחבר בדיוק את מה שסומן.`,
  }));
}

// ---- persistence (mirrors calendar.js / google-contacts.js) -----------------

async function upsertIntegration(client, { userId, provider, scopes, accessLevel, tokens, label }) {
  await client.query(
    `INSERT INTO integrations
       (user_id, provider, status, scopes, access_level, credential_enc, refresh_enc,
        expires_at, account_label, connected_at)
     VALUES ($1, $2, 'connected', $3, $4, $5, $6, now() + make_interval(secs => $7), $8, now())
     ON CONFLICT (user_id, provider) DO UPDATE SET
       status = 'connected',
       scopes = excluded.scopes,
       access_level = excluded.access_level,
       credential_enc = excluded.credential_enc,
       refresh_enc = COALESCE(excluded.refresh_enc, integrations.refresh_enc),
       expires_at = excluded.expires_at,
       account_label = excluded.account_label,
       connected_at = excluded.connected_at,
       last_error = NULL`,
    [userId, provider, scopes, accessLevel,
     cryptoStore.encrypt(tokens.access_token),
     tokens.refresh_token ? cryptoStore.encrypt(tokens.refresh_token) : null,
     Number(tokens.expires_in) || 3600, label]
  );
}

// Called by the public dashboard callback. Same redeem-first shape as the
// other three flows, filtered to THIS provider.
async function completeOAuth(client, { state, code, error }, opts = {}) {
  if (!state) return err('invalid', 'missing state');

  const { rows } = await client.query(
    `UPDATE oauth_states SET used_at = now()
     WHERE state = $1 AND provider = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id, requested_services`,
    [state, PROVIDER]
  );
  const st = rows[0];
  if (!st) return err('invalid', 'this link has expired or was already used', { reason: 'bad_state' });
  const userId = Number(st.user_id);
  const requested = st.requested_services || {};

  if (error) {
    await audit.record(client, userId, 'google_connect.auth_declined', { error: String(error).slice(0, 60) });
    return err('forbidden', 'the user declined', { reason: 'declined', userId });
  }
  if (!code) return err('invalid', 'missing code', { reason: 'bad_state', userId });

  let tokens;
  try {
    tokens = await google.exchangeCode(code, opts);
  } catch (e) {
    await audit.record(client, userId, 'google_connect.auth_failed', { code: e.code || 'unknown' });
    return err('invalid', 'could not complete the connection', { reason: 'exchange_failed', userId });
  }

  // The same reissue guarantee the single-purpose flows rely on
  // (access_type=offline + prompt=consent in buildConsentUrl): if Google
  // somehow answered without one, there is nothing safe to store for ANY of
  // the requested services, so this is treated as a total failure rather
  // than guessing which piece is trustworthy.
  if (!tokens.refresh_token) {
    await audit.record(client, userId, 'google_connect.auth_failed', { reason: 'no_refresh_token' });
    const secret = tokens.access_token;
    if (secret) await google.revoke(secret, opts);
    return err('invalid', 'could not complete the connection', { reason: 'exchange_failed', userId });
  }

  const granted = String(tokens.scope || '');
  const connected = { calendar: null, contacts: false };
  const missing = [];

  if (requested.calendar) {
    if (granted.includes('calendar.events')) connected.calendar = 'read_write';
    else if (granted.includes('calendar.readonly')) connected.calendar = 'read_only';
    else missing.push('calendar');
  }
  if (requested.contacts) {
    if (granted.includes('contacts.readonly')) connected.contacts = true;
    else missing.push('contacts');
  }

  const gotAnything = connected.calendar || connected.contacts;
  if (!gotAnything) {
    await audit.record(client, userId, 'google_connect.auth_incomplete', {
      reason: 'nothing_granted', granted: granted.slice(0, 200),
    });
    await google.revoke(tokens.refresh_token, opts);
    await enqueue(client, {
      userId, kind: 'google_connect_incomplete', urgency: 'urgent', payload: { connected: [], missing },
    });
    return err('forbidden', 'no permission was granted', { reason: 'no_scope_granted', userId, missing });
  }

  const label = await google.whoAmI(tokens.access_token, opts);
  const connectedLabel = [];

  if (connected.calendar) {
    await upsertIntegration(client, {
      userId, provider: calendar.PROVIDER, scopes: granted, accessLevel: connected.calendar, tokens, label,
    });
    await audit.record(client, userId, 'calendar.connected', { accessLevel: connected.calendar, account: label, via: 'google_connect' });
    await enqueue(client, { userId, kind: 'calendar_connected', urgency: 'urgent', payload: { accessLevel: connected.calendar, account: label } });
    connectedLabel.push(connected.calendar === 'read_write' ? 'יומן (צפייה + עריכה)' : 'יומן (צפייה בלבד)');
  }
  if (connected.contacts) {
    await upsertIntegration(client, {
      userId, provider: googleContacts.PROVIDER, scopes: granted, accessLevel: 'read_only', tokens, label,
    });
    await audit.record(client, userId, 'contacts.connected', { account: label, via: 'google_connect' });
    await enqueue(client, { userId, kind: 'contacts_connected', urgency: 'urgent', payload: { account: label } });
    connectedLabel.push('אנשי קשר');
  }

  // Whatever succeeded already got its own familiar notice above
  // (calendar_connected etc, handled where those already are). This one is
  // ONLY for the pieces that were requested and did not come through — a
  // person who asked for calendar+contacts and unticked contacts on Google's
  // screen is owed a plain sentence about contacts, not silence.
  if (missing.length) {
    await enqueue(client, {
      userId, kind: 'google_connect_incomplete', urgency: 'urgent', payload: { connected: connectedLabel, missing },
    });
  }

  return ok({ userId, connected, missing, account: label, connectedLabel });
}

module.exports = { PROVIDER, beginConnection, completeOAuth };
