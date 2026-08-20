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
const SCOPES = {
  read_only: 'https://www.googleapis.com/auth/calendar.readonly',
  read_write: 'https://www.googleapis.com/auth/calendar.events',
};

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

function consentUrl(state, access) {
  const c = clientConfig();
  const params = new URLSearchParams({
    client_id: c.client_id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES[access],
    access_type: 'offline', // we need a refresh token to keep working
    prompt: 'consent',      // force a fresh refresh_token even on re-consent
    include_granted_scopes: 'false',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
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
async function whoAmI(accessToken, { budget = createBudget(3000), fetchImpl } = {}) {
  try {
    const res = await (fetchImpl || globalThis.fetch)(
      'https://www.googleapis.com/calendar/v3/calendars/primary',
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: budget.signal() }
    );
    if (!res.ok) return null;
    const body = await res.json();
    return body.id || null;
  } catch {
    return null;
  }
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

module.exports = {
  SCOPES, STATE_TTL_MS, REDIRECT_PATH, TOTAL_HTTP_BUDGET_MS, GoogleError,
  isConfigured, clientConfig, redirectUri, newState, consentUrl,
  exchangeCode, refreshAccessToken, revoke, whoAmI, calendarFetch, createBudget,
};
