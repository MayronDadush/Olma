'use strict';
// "I can't do that" is honest and useless. This makes it useful: a Google
// SEARCH link for words the model supplies.
//
// The safety argument in one line: a link to a RESULT asserts "I looked"
// (forbidden, always); a link to a SEARCH asserts nothing — it is the
// question, handed over. A tool and not a doctrine sentence because the model
// must never type a URL: it supplies WORDS, the URL is built here from a base
// it cannot influence, and nothing it passes reaches the host or the path.
// The audit row carries the query on purpose — the one structured signal of
// what people keep asking for that we cannot do. Story: docs/incidents.md,
// "\"I can't do that\" was the whole answer (fixed 2026-08-21)".
const { ok, err } = require('./results');
const audit = require('./audit');
const flags = require('./flags');

const DEFAULT_BASE = 'https://www.google.com/search?q=';
const MAX_QUERY = 200;

// Percent-encoding the whole query is CORRECT and unusable: a Hebrew search
// comes out as 179 characters of %D7%A2%D7%91, which in WhatsApp reads as
// spam and does not get tapped. Letters are left as themselves and only the
// characters that would change the URL's SHAPE are escaped. Same query, 59
// characters, legible to the person deciding whether to open it.
//
// **The raw letters are safe because the BROWSER encodes them, not because
// the URL is already valid on the wire** — and that was checked rather than
// assumed. `curl` hands the bytes to Google verbatim and gets a flat HTTP 400;
// a real browser given the identical link rewrote it to
// `?q=%D7%A2%D7%91%D7%95%D7%93%D7%94+...` before the request left, per the URL
// standard's query percent-encode set. So this depends on the client
// normalising, every browser does, and no client should ever be handed this
// string as an HTTP request line directly.
//
// `+` is the space, so a literal + has to be escaped or two different queries
// would produce the same URL.
const MUST_ESCAPE = new Set(['%', '#', '&', '?', '+', '/', '\\', '"', "'", '<', '>', '=']);

function encodeQuery(query) {
  let out = '';
  for (const ch of String(query)) {
    const code = ch.codePointAt(0);
    if (ch === ' ') out += '+';
    else if (MUST_ESCAPE.has(ch) || code < 0x20 || code === 0x7f) out += encodeURIComponent(ch);
    else out += ch;
  }
  return out;
}

async function baseUrl(client) {
  const configured = await flags.getFlag(client, 'search_link_base');
  const base = typeof configured === 'string' ? configured.trim() : '';
  // A misconfigured flag must not become a link to nowhere, or worse, to
  // somewhere. Anything that is not a plain https base falls back.
  return /^https:\/\/[^\s]+$/.test(base) ? base : DEFAULT_BASE;
}

// Builds the link. `query` is the person's own words, in their own language.
async function buildSearchLink(client, userId, query) {
  const q = String(query == null ? '' : query).replace(/\s+/g, ' ').trim();
  if (!q) return err('invalid', 'query required — the words to search for');
  if (q.length > MAX_QUERY) {
    return err('invalid', `query too long (max ${MAX_QUERY} chars) — search terms, not a paragraph`, { got: q.length });
  }
  // A model handing over a URL is a model trying to pass off a destination as
  // a search. Refused rather than escaped: escaping it would produce a search
  // FOR the url, which is nonsense the person would have to decode.
  if (q.includes('://')) {
    return err('invalid', 'query must be search words, never a URL — Olma cannot link to a page it has not seen');
  }

  const url = (await baseUrl(client)) + encodeQuery(q);
  // The demand signal. Not the point of the feature, and the only reason this
  // question is answerable at all.
  await audit.record(client, userId, 'search_link.offered', { query: q });
  return ok({ url, query: q });
}

module.exports = { buildSearchLink, encodeQuery, DEFAULT_BASE, MAX_QUERY };
