'use strict';
// Per-user Google Contacts — a separate `integrations` row from calendar
// (UNIQUE(user_id, provider) already admits a second provider for the same
// user), with its own independent token. Modelled line-for-line on
// calendar.js rather than parameterising it: this is simpler than calendar
// (one scope, always read_only, no narrowing case) and copying the token
// plumbing keeps the live, working calendar path byte-identical instead of
// threading a second provider through it.
//
// Importing is silent bookkeeping. It never messages anyone, never creates a
// connection, and never reveals to a third party that this user exists on
// Olma — see domain/contacts.js#importContacts for where the actual rows
// land.
const { ok, err } = require('./results');
const audit = require('./audit');
const cryptoStore = require('./crypto-store');
const google = require('./google-oauth');
const { enqueue } = require('../outbox/enqueue');
const contacts = require('./contacts');

const PROVIDER = 'google_contacts';
const PEOPLE_PAGE_SIZE = 1000;
const MAX_PAGES = 10; // hard bound: 10k contacts, well past any real address book

// ---- consent ----------------------------------------------------------------

async function beginConnection(client, userId) {
  if (!google.isConfigured()) {
    return err('invalid', 'Google is not configured on this server');
  }
  const state = google.newState();
  await client.query(
    `INSERT INTO oauth_states (state, user_id, provider, requested_access, expires_at)
     VALUES ($1, $2, $3, 'read_only', now() + make_interval(secs => $4))`,
    [state, userId, PROVIDER, google.STATE_TTL_MS / 1000]
  );
  await audit.record(client, userId, 'contacts.auth_started', {});
  return ok({
    url: google.contactsConsentUrl(state),
    validForMinutes: google.STATE_TTL_MS / 60000,
    tellTheUser: 'הקישור מבקש הרשאת קריאה בלבד לאנשי הקשר בגוגל. הייבוא פרטי לחלוטין — אף אחד לא מקבל הודעה, ואף אחד לא רואה שהם קשורים לאולמה.',
  });
}

// Same redeem-first shape as calendar.completeOAuth, filtered to THIS
// provider — a state minted for google_calendar can never be redeemed here
// and vice versa (see the dashboard callback's peek-dispatch).
async function completeOAuth(client, { state, code, error }, opts = {}) {
  if (!state) return err('invalid', 'missing state');

  const { rows } = await client.query(
    `UPDATE oauth_states SET used_at = now()
     WHERE state = $1 AND provider = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [state, PROVIDER]
  );
  const st = rows[0];
  if (!st) return err('invalid', 'this link has expired or was already used', { reason: 'bad_state' });
  const userId = Number(st.user_id);

  if (error) {
    await audit.record(client, userId, 'contacts.auth_declined', { error: String(error).slice(0, 60) });
    return err('forbidden', 'the user declined', { reason: 'declined', userId });
  }
  if (!code) return err('invalid', 'missing code', { reason: 'bad_state' });

  let tokens;
  try {
    tokens = await google.exchangeCode(code, opts);
  } catch (e) {
    await audit.record(client, userId, 'contacts.auth_failed', { code: e.code || 'unknown' });
    return err('invalid', 'could not complete the connection', { reason: 'exchange_failed', userId });
  }

  // Same live lesson as calendar (D-024, user 8, 2026-08-20): Google's
  // consent screen has a checkbox per sensitive scope, and pressing Continue
  // without ticking it still completes the token exchange — with only
  // email/openid granted. A token like that 403s on every real call.
  const granted = String(tokens.scope || '');
  if (!granted.includes('contacts.readonly')) {
    await audit.record(client, userId, 'contacts.auth_incomplete', {
      reason: 'no_contacts_scope', granted: granted.slice(0, 200),
    });
    const secret = tokens.refresh_token || tokens.access_token;
    if (secret) await google.revoke(secret, opts);
    await enqueue(client, {
      userId, kind: 'contacts_scope_missing', urgency: 'urgent', payload: {},
    });
    return err('forbidden', 'contacts permission was not granted', { reason: 'no_contacts_scope', userId });
  }

  const label = await google.whoAmI(tokens.access_token, opts);
  const isChange = Boolean(await loadIntegration(client, userId));

  await client.query(
    `INSERT INTO integrations
       (user_id, provider, status, scopes, access_level, credential_enc, refresh_enc,
        expires_at, account_label, connected_at)
     VALUES ($1, $2, 'connected', $3, 'read_only', $4, $5, now() + make_interval(secs => $6), $7, now())
     ON CONFLICT (user_id, provider) DO UPDATE SET
       status = 'connected',
       scopes = excluded.scopes,
       credential_enc = excluded.credential_enc,
       refresh_enc = COALESCE(excluded.refresh_enc, integrations.refresh_enc),
       expires_at = excluded.expires_at,
       account_label = excluded.account_label,
       connected_at = excluded.connected_at,
       last_error = NULL`,
    [userId, PROVIDER, granted,
     cryptoStore.encrypt(tokens.access_token),
     tokens.refresh_token ? cryptoStore.encrypt(tokens.refresh_token) : null,
     Number(tokens.expires_in) || 3600, label]
  );
  await audit.record(client, userId, isChange ? 'contacts.reconnected' : 'contacts.connected', { account: label });

  // Deliberately no idempotency key: the state was burned above, so this runs
  // at most once per consent. The agent's own turn (triggered by this row)
  // is what actually calls import_google_contacts — see channels/openclaw.js.
  await enqueue(client, {
    userId, kind: 'contacts_connected', urgency: 'urgent', payload: { account: label },
  });

  return ok({ userId, account: label });
}

// ---- token plumbing (mirrors calendar.js, PROVIDER-scoped) ------------------

async function loadIntegration(client, userId) {
  const { rows } = await client.query(
    `SELECT * FROM integrations WHERE user_id = $1 AND provider = $2`, [userId, PROVIDER]
  );
  return rows[0] || null;
}

async function markNeedsReauth(client, userId, reason) {
  await client.query(
    `UPDATE integrations SET status = 'needs_reauth', last_error = $3
     WHERE user_id = $1 AND provider = $2`,
    [userId, PROVIDER, String(reason).slice(0, 200)]
  );
  await audit.record(client, userId, 'contacts.needs_reauth', { reason: String(reason).slice(0, 120) });
  await enqueue(client, {
    userId, kind: 'contacts_needs_reauth', urgency: 'normal', payload: {},
    idempotencyKey: `contactsreauth:${userId}`,
  });
}

const REAUTH_HINT = 'the Google contacts connection is no longer valid — offer to reconnect with start_contacts_connection';

async function usableAccessToken(client, userId, opts = {}) {
  const row = await loadIntegration(client, userId);
  if (!row) return err('not_found', 'no Google contacts connected — use start_contacts_connection first', { reason: 'not_connected' });
  if (row.status === 'needs_reauth') return err('forbidden', REAUTH_HINT, { reason: 'needs_reauth' });

  const fresh = row.expires_at && new Date(row.expires_at).getTime() > Date.now() + 60_000;
  if (fresh) {
    const token = cryptoStore.decrypt(row.credential_enc);
    if (token) return ok({ token, row });
    await markNeedsReauth(client, userId, 'stored credentials could not be read');
    return err('forbidden', REAUTH_HINT, { reason: 'needs_reauth' });
  }

  const refresh = row.refresh_enc && cryptoStore.decrypt(row.refresh_enc);
  if (!refresh) {
    await markNeedsReauth(client, userId, 'no refresh token stored');
    return err('forbidden', REAUTH_HINT, { reason: 'needs_reauth' });
  }

  let tokens;
  try {
    tokens = await google.refreshAccessToken(refresh, opts);
  } catch (e) {
    if (e.code === 'invalid_grant') {
      await markNeedsReauth(client, userId, 'Google rejected the stored authorisation');
      return err('forbidden', REAUTH_HINT, { reason: 'needs_reauth' });
    }
    return err('conflict', 'could not reach Google to refresh access', { reason: e.code || 'http' });
  }

  await client.query(
    `UPDATE integrations SET credential_enc = $3,
            expires_at = now() + make_interval(secs => $4),
            last_refresh_at = now(), last_error = NULL
     WHERE user_id = $1 AND provider = $2`,
    [userId, PROVIDER, cryptoStore.encrypt(tokens.access_token), Number(tokens.expires_in) || 3600]
  );
  return ok({ token: tokens.access_token, row });
}

async function withAccessToken(client, userId, opts, fn) {
  const o = { ...opts, budget: opts.budget || google.createBudget() };
  try {
    const first = await usableAccessToken(client, userId, o);
    if (!first.ok) return first;
    try {
      return await fn(first.data.token, o);
    } catch (e) {
      if (e.code !== 'unauthorized') throw e;
      await client.query(
        `UPDATE integrations SET expires_at = now() WHERE user_id = $1 AND provider = $2`,
        [userId, PROVIDER]
      );
      const second = await usableAccessToken(client, userId, o);
      if (!second.ok) return second;
      return await fn(second.data.token, o);
    }
  } catch (e) {
    if (e instanceof google.GoogleError) {
      return err('conflict', 'could not finish talking to Google in time', { reason: e.code });
    }
    throw e;
  }
}

// ---- tools -------------------------------------------------------------------

async function getStatus(client, userId) {
  const row = await loadIntegration(client, userId);
  if (!row || row.status === 'disconnected') return ok({ connected: false });
  return ok({
    connected: row.status === 'connected',
    needsReauth: row.status === 'needs_reauth',
    account: row.account_label,
    connectedAt: row.connected_at,
  });
}

async function disconnect(client, userId, opts = {}) {
  const row = await loadIntegration(client, userId);
  if (!row) return ok({ connected: false });
  const secret = (row.refresh_enc && cryptoStore.decrypt(row.refresh_enc))
    || (row.credential_enc && cryptoStore.decrypt(row.credential_enc));
  const revoked = secret ? await google.revoke(secret, opts) : false;

  await client.query(`DELETE FROM integrations WHERE user_id = $1 AND provider = $2`, [userId, PROVIDER]);
  // The already-imported address book rows are NOT deleted — disconnecting
  // the live sync is not the same decision as deleting the contacts already
  // saved. If the user wants those gone too, forget_contact is the tool.
  await audit.record(client, userId, 'contacts.disconnected', { revokedAtGoogle: revoked });
  return ok({ connected: false, revokedAtGoogle: revoked });
}

// Prefer canonicalForm (Google's own E.164) over the free-text value —
// contacts.importContacts still normalises whatever comes through, so a
// missing canonicalForm just falls back to the same national-number handling
// every other source gets.
function phonesOf(person) {
  return (person.phoneNumbers || []).map((p) => ({
    value: p.canonicalForm || p.value,
    type: /mobile|cell/i.test(p.type || '') ? 'mobile'
      : /work/i.test(p.type || '') ? 'work'
      : /home/i.test(p.type || '') ? 'home' : 'other',
  }));
}

async function importFromGoogle(client, userId, opts = {}) {
  const budget = opts.budget || google.createBudget(20000);
  const entries = [];
  let pageToken, pages = 0;
  // Each page is its own withAccessToken call so a 401 partway through a
  // large address book only retries the page that failed, not the whole
  // paginated fetch from scratch (a shared budget still bounds the total
  // work across pages and retries).
  do {
    const params = new URLSearchParams({
      personFields: 'names,phoneNumbers', pageSize: String(PEOPLE_PAGE_SIZE),
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await withAccessToken(client, userId, { ...opts, budget }, async (token, o) => {
      try {
        return ok(await google.peopleFetch(token, `/people/me/connections?${params}`, o));
      } catch (e) {
        if (e.code === 'unauthorized') throw e;
        return err('conflict', e.message, { reason: e.code || 'http' });
      }
    });
    if (!page.ok) return page;
    for (const person of page.data.connections || []) {
      const name = person.names && person.names[0] && person.names[0].displayName;
      if (!name) continue; // no importContacts entry — nothing to save it under
      entries.push({ name, phones: phonesOf(person) });
    }
    pageToken = page.data.nextPageToken;
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  const res = await contacts.importContacts(client, userId, entries, 'google');
  if (!res.ok) return res;
  const row = await loadIntegration(client, userId);
  return ok({ ...res.data, account: row ? row.account_label : null });
}

module.exports = {
  PROVIDER,
  beginConnection, completeOAuth, getStatus, disconnect, importFromGoogle,
};
