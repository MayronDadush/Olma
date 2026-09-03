'use strict';
// The Gmail adapter — the first of the three providers behind domain/mail.js.
//
// It owns HTTP and Gmail's own shapes; it owns no persistence and no policy.
// Everything above this file (consent bookkeeping, encrypted credentials, the
// refresh-once-on-401 dance, audit, what the agent is allowed to see) is
// provider-agnostic and lives in mail.js — which is what makes Outlook a
// second file of roughly this size and nothing else.
//
// TWO RULES THE INTERFACE EXISTS TO ENFORCE, both from the plan
// (docs/email-integration-plan.md):
//
//   1. `search` returns HEADERS ONLY. There is no field for a body, because
//      the single most expensive mistake available in this feature is a path
//      that quietly pulls full text for a thousand messages. A body comes
//      back from exactly one function, one message at a time.
//   2. Everything returned here is text a stranger wrote. This file never
//      interprets it, and mail.js labels it as data before it reaches a
//      model. Knowing the user's email address is enough to put text into
//      Olma's context — no other integration has that property.
const google = require('./google-oauth');

const PROVIDER = 'gmail';
const API = 'https://gmail.googleapis.com/gmail/v1';

// Read-only, and the smallest scope that can do the job: gmail.metadata
// cannot serve a search query or a body, which is Phase 1's whole feature.
// Drafting and sending are a SEPARATE consent (gmail.compose/gmail.send),
// deliberately not requested until the phase that uses them — a scope we
// cannot use today is a scope we must not ask for today.
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

// Caps are the cost control, not a display choice: every character here is
// injected into an agent turn. A body is truncated rather than refused —
// the first 4k characters of an email answer "what does it say" essentially
// always, and the truncation is reported so nothing pretends to be complete.
const MAX_BODY_CHARS = 4000;
const MAX_SUBJECT_CHARS = 200;
const MAX_SNIPPET_CHARS = 300;
const SEARCH_LIMIT_DEFAULT = 8;
const SEARCH_LIMIT_MAX = 15;

// ---- HTTP -------------------------------------------------------------------

// A third near-copy of calendarFetch/peopleFetch, and deliberately so: the
// house rule stated in google-contacts.js is that copying the Google plumbing
// beats threading a fourth parameter through the live, working calendar path.
// The 401 → 'unauthorized' contract is the load-bearing part — mail.js's
// refresh-once-and-retry depends on it exactly as calendar.js's does.
async function gmailFetch(token, path, { budget, fetchImpl, ...init } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const b = budget || google.createBudget();
  let res;
  try {
    res = await doFetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers) },
      signal: b.signal(),
    });
  } catch (e) {
    if (e instanceof google.GoogleError) throw e;
    throw new google.GoogleError('timeout', 'the mailbox did not answer in time');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new google.GoogleError('unauthorized', 'the mailbox rejected our access');
    // 404 on a message id is the ordinary "they deleted it" case, and it must
    // read as that rather than as a broken connection.
    if (res.status === 404) throw new google.GoogleError('not_found', 'that message is not in the mailbox any more');
    const msg = (body.error && body.error.message) || `Gmail API returned ${res.status}`;
    throw new google.GoogleError('http', String(msg).slice(0, 200));
  }
  return body;
}

// ---- parsing ----------------------------------------------------------------

function headerValue(headers, name) {
  const h = (headers || []).find((x) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value) : '';
}

// "Dana Levi <dana@example.com>" → { name, address }. A display name is
// chosen by the SENDER, so it is never treated as identity: it is shown
// beside the address, never instead of it.
function parseAddress(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    return {
      name: m[1].replace(/^"|"$/g, '').trim().slice(0, 100) || null,
      address: m[2].trim().toLowerCase().slice(0, 200),
    };
  }
  return { name: null, address: s.toLowerCase().slice(0, 200) };
}

function countRecipients(raw) {
  // Good enough on purpose: an exact RFC 5322 address-list parse is a parser,
  // and this number only ever decides "was this written to me or to a list".
  const s = String(raw || '').trim();
  if (!s) return 0;
  return s.split(',').filter((p) => p.trim()).length;
}

function addressedTo(raw, self) {
  if (!self) return null; // unknown own address — say nothing rather than guess
  return String(raw || '').toLowerCase().includes(String(self).toLowerCase());
}

function decodeBody(data) {
  if (!data) return '';
  try {
    return Buffer.from(String(data), 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

// Marketing mail is often HTML-only. A stripped-tags version is far from
// pretty and is exactly right for "what does this say" — and it keeps a
// dependency out of the tree for something used a handful of times a day.
function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Depth-first through the MIME tree for the first text/plain; text/html is
// the fallback, never the preference — the plain part is what the sender
// wrote, the HTML part is what their mail client built around it.
function extractBody(payload) {
  if (!payload) return '';
  const plain = findPart(payload, 'text/plain');
  if (plain) return decodeBody(plain.body && plain.body.data);
  const html = findPart(payload, 'text/html');
  if (html) return htmlToText(decodeBody(html.body && html.body.data));
  if (payload.body && payload.body.data) return decodeBody(payload.body.data);
  return '';
}

function findPart(part, mime) {
  if (!part) return null;
  if (String(part.mimeType || '').toLowerCase().startsWith(mime) && part.body && part.body.data) return part;
  for (const child of part.parts || []) {
    const hit = findPart(child, mime);
    if (hit) return hit;
  }
  return null;
}

function attachmentNames(payload, acc = []) {
  for (const part of (payload && payload.parts) || []) {
    if (part.filename) acc.push(String(part.filename).slice(0, 80));
    attachmentNames(part, acc);
  }
  return acc.slice(0, 10);
}

function isoDate(internalDate, headers) {
  const ms = Number(internalDate);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  const parsed = Date.parse(headerValue(headers, 'Date'));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// ---- the provider interface -------------------------------------------------

function consentUrl(state) {
  return google.buildConsentUrl(state, `${READ_SCOPE} ${EMAIL_SCOPE}`);
}

// Google's consent screen carries a checkbox per sensitive scope, and
// pressing Continue without ticking it still completes the token exchange —
// with a token that 403s on every real call. Live incident on calendar
// (user 8, 2026-08-20) and pre-empted on contacts; this is the same guard.
function grantsMail(scopeString) {
  return String(scopeString || '').includes('gmail.readonly');
}

async function search(token, { query, limit }, opts = {}) {
  const n = Math.min(Math.max(Number(limit) || SEARCH_LIMIT_DEFAULT, 1), SEARCH_LIMIT_MAX);
  const params = new URLSearchParams({ q: String(query).slice(0, 200), maxResults: String(n) });
  const list = await gmailFetch(token, `/users/me/messages?${params}`, opts);
  const ids = (list.messages || []).slice(0, n).map((m) => m.id);
  if (!ids.length) return [];

  // Gmail has no bulk header read, so this is N+1 by construction — run
  // concurrently under the ONE shared budget, so the whole search still
  // obeys the single deadline the tool call was given. `metadata` format is
  // load-bearing: it cannot return a body even if a future edit asks for one.
  const params2 = new URLSearchParams({ format: 'metadata' });
  for (const h of ['From', 'Subject', 'Date', 'To']) params2.append('metadataHeaders', h);
  const msgs = await Promise.all(ids.map((id) =>
    gmailFetch(token, `/users/me/messages/${encodeURIComponent(id)}?${params2}`, opts)));

  return msgs.map((m) => {
    const headers = (m.payload && m.payload.headers) || [];
    return {
      id: m.id,
      threadId: m.threadId,
      from: parseAddress(headerValue(headers, 'From')),
      subject: headerValue(headers, 'Subject').slice(0, MAX_SUBJECT_CHARS) || null,
      date: isoDate(m.internalDate, headers),
      snippet: String(m.snippet || '').slice(0, MAX_SNIPPET_CHARS) || null,
      unread: (m.labelIds || []).includes('UNREAD'),
    };
  });
}

async function fetchMessage(token, id, { selfAddress } = {}, opts = {}) {
  const m = await gmailFetch(token, `/users/me/messages/${encodeURIComponent(id)}?format=full`, opts);
  const headers = (m.payload && m.payload.headers) || [];
  const raw = extractBody(m.payload);
  const body = raw.slice(0, MAX_BODY_CHARS);
  return {
    id: m.id,
    threadId: m.threadId,
    from: parseAddress(headerValue(headers, 'From')),
    subject: headerValue(headers, 'Subject').slice(0, MAX_SUBJECT_CHARS) || null,
    date: isoDate(m.internalDate, headers),
    // Projected exactly as calendar.listEvents projects attendees away: the
    // To/Cc lines are other people's addresses, this object goes verbatim into
    // an agent's context, and the only question anyone actually asks of them
    // is "was this written to me, or to a list?".
    addressedToUser: addressedTo(headerValue(headers, 'To'), selfAddress),
    recipients: countRecipients(headerValue(headers, 'To')) + countRecipients(headerValue(headers, 'Cc')),
    attachments: attachmentNames(m.payload),
    body,
    truncated: raw.length > body.length,
    unread: (m.labelIds || []).includes('UNREAD'),
  };
}

module.exports = {
  provider: PROVIDER,
  label: 'Gmail',
  // What the agent may be told this connection can do. Drafting and sending
  // are Phase 4 and need their own consent — the flags exist now so nothing
  // above this file has to know which phase it is living in.
  supports: { search: true, read: true, drafts: false, send: false },
  isConfigured: google.isConfigured,
  consentUrl,
  grantsMail,
  exchangeCode: google.exchangeCode,
  refreshAccessToken: google.refreshAccessToken,
  revoke: google.revoke,
  whoAmI: google.whoAmI,
  createBudget: google.createBudget,
  isUnauthorized: (e) => e && e.code === 'unauthorized',
  isInvalidGrant: (e) => e && e.code === 'invalid_grant',
  isTransport: (e) => e instanceof google.GoogleError,
  search,
  fetchMessage,
  // exported for tests
  parseAddress, htmlToText, extractBody, MAX_BODY_CHARS, SEARCH_LIMIT_MAX, READ_SCOPE,
};
