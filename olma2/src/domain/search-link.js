'use strict';
// "I can't do that" is honest and useless. This makes it useful.
//
// Olma has no web access, so a request to look something up ends in a refusal
// — and the doctrine already stops that refusal from being the whole reply
// (say it once, offer to save the errand, log the gap). What it could not do
// was hand back anything the person could actually USE. Five people asked for
// help writing a school essay in four days; two asked about finance. Every one
// of them got a polite no.
//
// A search they could have typed themselves is not a lookup. That distinction
// is the entire safety argument, and it is why this can exist beside the
// hallucination guard rather than weakening it:
//
//   a link to a RESULT   asserts "I looked" — a price, an article, a product.
//                        Olma did not look. Still forbidden, always.
//   a link to a SEARCH   asserts nothing at all. It IS the question, handed
//                        over unanswered, for them to open.
//
// ---- why this is a tool and not a sentence in the doctrine ----
//
// Because the model must never type a URL. Twice now this system has learned
// that a rule living only in prose does not hold: DeepSeek skipped `turn_start`
// under two different models and two rewordings until the SERVER started doing
// the bookkeeping itself. A model asked to write URLs will eventually write
// `https://www.ynet.co.il/article/12345` — a link to a page that may not exist,
// which is exactly the fabricated-lookup failure wearing a different hat.
//
// So the model supplies WORDS. The URL is built here, from a base it cannot
// influence, and the only thing it can put in is the query string. There is no
// argument that reaches the host, the path, or a second parameter.
//
// The audit row carries the query on purpose. Nothing else in this system can
// answer "what do people keep asking for that we cannot do" — the free-text
// issue rows tried and sat unread. This is the same signal, structured.
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
