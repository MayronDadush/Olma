'use strict';
// The Google OAuth + Calendar HTTP client. Knows nothing about our database —
// it builds consent URLs, exchanges codes, refreshes and revokes tokens, and
// calls the Calendar API. `domain/calendar.js` owns all the persistence.
//
// Ported from v1's /opt/olma/broker/google-oauth.js, reusing the same client
// credentials, so the redirect URI already registered with Google keeps working.
const fs = require('node:fs');
const crypto = require('node:crypto');

const CLIENT_PATH = process.env.OLMA_GOOGLE_OAUTH_PATH || '/opt/olma/google-oauth.json';
const REDIRECT_PATH = '/oauth/google/callback';

// The access level the user picks is baked into the consent URL, so GOOGLE
// enforces it at the account level. A read_only user's token is physically
// incapable of writing, independently of any check in our code — the checks on
// our side exist only so the refusal is a clear sentence rather than a
// surprise 403 from a call they never expected us to make.
// userinfo.email rides along with both levels because a shared meeting event
// needs each participant's address to invite them, and the calendar scopes do
// not reliably carry it: calendar.events is write-only in practice, and a live
// read_write user's /calendars/primary lookup answered 403 "insufficient
// authentication scopes" — which is why their stored address was empty. It
// grants no calendar access of its own; it identifies the account being
// connected, which is the least Google will tell us for an invitation to work.
const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
const SCOPES = {
  read_only: `https://www.googleapis.com/auth/calendar.readonly ${EMAIL_SCOPE}`,
  read_write: `https://www.googleapis.com/auth/calendar.events ${EMAIL_SCOPE}`,
};

// Contacts is its own sensitive scope, deliberately NOT a member of SCOPES
// above: start_calendar_connection validates access against SCOPES[access],
// and adding a 'contacts' key there would let that call request it too, only
// to explode later on oauth_states.requested_access's CHECK (read_only |
// read_write). Contacts has exactly one shape — read-only, always — so it
// gets its own constant and its own consent-URL builder instead.
const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';

const STATE_TTL_MS = 15 * 60 * 1000;

// Total outbound HTTP budget for one tool call, covering a token refresh AND
// the API call that follows it. The ceiling that matters is the MCP shim's
// CALL_TIMEOUT_MS (30s, bin/olma-mcp.js): if a tool can outlast it, the shim
// rejects, the agent reports failure — and brokerd commits anyway. For
// create_calendar_event that means a retry putting a SECOND event on someone's
// calendar. Staying well under the shim's ceiling is what prevents that.
const TOTAL_HTTP_BUDGET_MS = 8000;

class GoogleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'not_configured' | 'invalid_grant' | 'unauthorized' | 'timeout' | 'http'
  }
}

// Tracks one tool call's shared budget across however many requests it makes.
function createBudget(totalMs = TOTAL_HTTP_BUDGET_MS) {
  const deadline = Date.now() + totalMs;
  return {
    remaining: () => deadline - Date.now(),
    // fetch has NO default timeout — without this the "8 second budget" would
    // be a comment describing something that does not exist.
    signal() {
      const left = deadline - Date.now();
      if (left <= 0) throw new GoogleError('timeout', 'ran out of time talking to Google');
      return AbortSignal.timeout(left);
    },
  };
}

// Read lazily and cache. This module is reachable from the MCP registry, which
// the shim requires on EVERY agent turn — reading config at require time would
// mean a missing file breaks every turn on any box without /opt/olma.
let cachedConfig;
function clientConfig() {
  if (cachedConfig !== undefined) {
    if (cachedConfig === null) throw new GoogleError('not_configured', 'Google Calendar is not configured on this server');
    return cachedConfig;
  }
  let parsed = null;
  try {
    const raw = JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf8'));
    if (raw.client_id && raw.client_secret && raw.public_base_url) parsed = raw;
  } catch { /* absent or unreadable — treated as "not configured" */ }
  cachedConfig = parsed;
  if (!parsed) throw new GoogleError('not_configured', 'Google Calendar is not configured on this server');
  return parsed;
}

function isConfigured() {
  try { clientConfig(); return true; } catch { return false; }
}

// Built by concatenation, never hand-written: it must match the string
// registered in the Google console byte for byte, and a mismatch surfaces only
// AFTER the consent state has been burned — sending the user back to square one.
function redirectUri() {
  return clientConfig().public_base_url.replace(/\/$/, '') + REDIRECT_PATH;
}

function newState() {
  return crypto.randomBytes(24).toString('base64url');
}

// Every Google consent URL this system builds is identical except for the
// scope string — so there is ONE builder. The third caller (mail) is what
// made a shared one worth having: three hand-copied parameter blocks are
// three places for `access_type: 'offline'` to go missing, and a consent
// without it yields no refresh token at all — a connection that works
// perfectly for one hour and then dies.
function buildConsentUrl(state, scope) {
  const c = clientConfig();
  const params = new URLSearchParams({
    client_id: c.client_id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope,
    access_type: 'offline', // we need a refresh token to keep working
    prompt: 'consent',      // force a fresh refresh_token even on re-consent
    include_granted_scopes: 'false',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function consentUrl(state, access) {
  return buildConsentUrl(state, SCOPES[access]);
}

// The one-scope contacts grant.
function contactsConsentUrl(state) {
  return buildConsentUrl(state, `${CONTACTS_SCOPE} ${EMAIL_SCOPE}`);
}

// Google's token endpoint answers errors as {error, error_description}. Only
// the `error` code is propagated: it is a fixed enum, whereas the description
// is free text we have no reason to carry into agent context.
async function tokenRequest(body, budget, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await doFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: budget.signal(),
    });
  } catch (e) {
    if (e instanceof GoogleError) throw e;
    throw new GoogleError('timeout', 'could not reach Google in time');
  }
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(parsed.error || '');
    // The one error worth naming: the grant is dead (revoked at Google,
    // password changed, or six months idle). It never recovers by retrying —
    // only re-consent fixes it, so the caller has to react differently.
    if (code === 'invalid_grant') throw new GoogleError('invalid_grant', 'Google no longer accepts this authorisation');
    throw new GoogleError('http', `Google rejected the request (${code || res.status})`);
  }
  return parsed;
}

function exchangeCode(code, { budget = createBudget(), fetchImpl } = {}) {
  const c = clientConfig();
  return tokenRequest({
    code,
    client_id: c.client_id,
    client_secret: c.client_secret,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  }, budget, fetchImpl);
}

function refreshAccessToken(refreshToken, { budget = createBudget(), fetchImpl } = {}) {
  const c = clientConfig();
  return tokenRequest({
    refresh_token: refreshToken,
    client_id: c.client_id,
    client_secret: c.client_secret,
    grant_type: 'refresh_token',
  }, budget, fetchImpl);
}

// Best effort by design: the local row is deleted whether or not Google
// answers. A disconnect that fails because Google is briefly unreachable must
// not leave the user still connected on our side.
async function revoke(token, { budget = createBudget(3000), fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  try {
    await doFetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: budget.signal(),
    });
    return true;
  } catch {
    return false;
  }
}

// Which Google account this is, for showing back to the user ("connected as
// …"). Never fatal: not knowing the label is not a reason to fail a connection.
// The connected account's own address. userinfo first (it is what the email
// scope above answers); the primary-calendar id is kept as a fallback because
// it is the same value and still works for grants issued before that scope
// existed. Best effort by contract — a null here must never fail a connection.
async function whoAmI(accessToken, { budget = createBudget(3000), fetchImpl } = {}) {
  const get = async (url, pick) => {
    try {
      const res = await (fetchImpl || globalThis.fetch)(url, {
        headers: { Authorization: `Bearer ${accessToken}` }, signal: budget.signal(),
      });
      if (!res.ok) return null;
      return pick(await res.json()) || null;
    } catch {
      return null;
    }
  };
  return (await get('https://www.googleapis.com/oauth2/v2/userinfo', (b) => b.email))
    || (await get('https://www.googleapis.com/calendar/v3/calendars/primary', (b) => b.id));
}

async function calendarFetch(token, path, { budget = createBudget(), fetchImpl, ...init } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await doFetch(`https://www.googleapis.com/calendar/v3${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers) },
      signal: budget.signal(),
    });
  } catch (e) {
    if (e instanceof GoogleError) throw e;
    throw new GoogleError('timeout', 'the calendar did not answer in time');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 401 is its own code so the caller can refresh once and retry — an access
    // token can be rejected before our stored expiry says it should be
    // (clock skew, a revoked session), and expires_at alone is never proof.
    if (res.status === 401) throw new GoogleError('unauthorized', 'the calendar rejected our access');
    const msg = (body.error && body.error.message) || `calendar API returned ${res.status}`;
    throw new GoogleError('http', String(msg).slice(0, 200));
  }
  return body;
}

// Same 401→GoogleError('unauthorized') contract as calendarFetch, so
// withAccessToken's one-retry-on-401 logic works unchanged against People API
// calls too — only the base URL differs.
async function peopleFetch(token, path, { budget = createBudget(), fetchImpl, ...init } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await doFetch(`https://people.googleapis.com/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers) },
      signal: budget.signal(),
    });
  } catch (e) {
    if (e instanceof GoogleError) throw e;
    throw new GoogleError('timeout', 'the contacts service did not answer in time');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new GoogleError('unauthorized', 'the contacts service rejected our access');
    const msg = (body.error && body.error.message) || `People API returned ${res.status}`;
    throw new GoogleError('http', String(msg).slice(0, 200));
  }
  return body;
}

module.exports = {
  SCOPES, CONTACTS_SCOPE, STATE_TTL_MS, REDIRECT_PATH, TOTAL_HTTP_BUDGET_MS, GoogleError,
  isConfigured, clientConfig, redirectUri, newState, buildConsentUrl, consentUrl, contactsConsentUrl,
  exchangeCode, refreshAccessToken, revoke, whoAmI, calendarFetch, peopleFetch, createBudget,
};
