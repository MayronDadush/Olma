'use strict';
// The personal dashboard: the page a user opens for themselves, as opposed to
// the operator dashboard this file is mounted from.
//
// Everything here follows the picker's precedent — public by token, no admin
// password, because the person taps it from WhatsApp on their phone — with one
// deliberate difference. The picker's token IS the credential and stays valid
// for a week; that is right for one meeting's form and wrong for a page showing
// somebody's whole list, their friends and their connected accounts. Here the
// link is a one-time key exchanged for a session (domain/dashboard-auth.js),
// and the link dies the moment it is used.
//
// Five routes, and the split between them is the security model:
//
//   GET  /d/<token>   show a button. Spends nothing. Already signed in as the
//                     same person: straight to where the link points, and the
//                     link is left unspent.
//   POST /d/<token>   spend the key, open the session, redirect to where the
//                     link points (its row says — domain/dashboard-auth.js).
//   GET  /me          the page itself. Session required.
//   GET  /me/data     everything on it, as JSON. Session required.
//   GET  /me/events   their calendar, fetched from Google. Session required.
//   POST /me/act      one write. Session required.
//   POST /me/out      sign out.
//   POST /me/code     spend an eight-digit code from Olma and open a session —
//                     the way into the home-screen app on an iPhone, whose
//                     cookies are its own and which no link can reach.
//
// GET never changes anything, and that is not tidiness — WhatsApp fetches every
// link it delivers to build a preview, so a key redeemed on GET would be burned
// by the crawler before the person ever touched it.
const fs = require('node:fs');
const path = require('node:path');
const { FONT_STYLE } = require('./fonts');
const { withTx } = require('../../db/pool');
const auth = require('../../domain/dashboard-auth');
const dash = require('../../domain/user-dashboard');
const experiments = require('../../domain/experiments');
const events = require('../../domain/user-dashboard-events');
const opens = require('../../domain/dashboard-opens');
const write = require('../../domain/user-dashboard-write');
const { refreshUserCard } = require('../../intake/user-card');

// The short shape every link has had since 2026-09-15, or the 64-hex shape of
// the links sent before it. Exact either way, never a prefix: a truncated link
// must fall through to the not-ours path, which is why Caddy matches the same
// two shapes (.claude/rules/dashboard-and-domains.md).
const LINK_RE = /^\/d\/([A-Za-z0-9]{22}|[a-f0-9]{64})$/;
const PAGE_PATH = path.join(__dirname, '..', '..', '..', 'docs', 'design', 'user-dashboard.html');

// The page is one file and this serves that exact file — the design and what
// users get can never drift, because there is only one copy.
let cached = null;
function pageHtml() {
  const st = fs.statSync(PAGE_PATH);
  if (!cached || cached.mtime !== st.mtimeMs) {
    cached = { mtime: st.mtimeMs, html: fs.readFileSync(PAGE_PATH, 'utf8') };
  }
  return cached.html;
}

// Every page the server hands out is stamped on its root element. The file has
// no <html> tag of its own — a leading one merges its attributes onto the root
// element the parser was going to create anyway — so this marks the page
// without it carrying a second copy of itself for the case.
//
// `data-served` is what hides the preview scaffolding: the language pair, the
// theme moon and the two replay buttons are there so the design can be checked
// in both languages, both themes and from a stranger's first screen without
// reloading. They are not product UI. Stamping the root here rather than
// letting hydrate() do it means they are gone before a single rule is applied,
// instead of flashing on and then vanishing — and opening the same file from
// disk leaves the stamp off, which is precisely when those buttons are wanted.
//
// The fonts are put in here too, since 2026-09-29, and only here: the file
// used to link Google Fonts, which gave Google every visitor's IP (fonts.js).
// Opened from disk it has no font of its own and draws in the fallback stack
// its CSS already names — a design preview can live with that, and it keeps
// ~90KB of base64 out of a file people read and diff. The <style> lands
// ahead of the <meta charset>, which is harmless: the charset is in the
// Content-Type header, and the parser files the element into <head> anyway.
function servedPageHtml(extra = '') {
  return '<html data-served="1"' + extra + '>\n' + FONT_STYLE + '\n' + pageHtml();
}

// The language the page draws in. The page reads `data-locale` off the root
// element and falls back to the house language when it is missing — which is
// what every signed-in visitor got until 2026-09-07, because nothing ever put
// it there: `users.locale` said `en` for two people and the page never heard.
// Only the two languages the page has strings for are stamped; anything else
// on file (or nothing) reads as Hebrew, exactly the rule the page itself uses.
function pageLocale(locale) {
  return String(locale || '').trim().toLowerCase().startsWith('en') ? 'en' : 'he';
}

// A signed-in person's own page, in their language.
function ownPageHtml(locale) {
  return servedPageHtml(` data-locale="${pageLocale(locale)}"`);
}

// The same page, told it is speaking to somebody it does not know.
//
// Deliberately the answer for an EXPIRED link too, not only for a stranger.
// Both people need the same next step (write to her), the screen says so
// without claiming to know which of the two you are, and it leaks nothing
// about whether a number is on file.
//
// Since 2026-09-29 it is also allma.world's front page, and the app is drawn
// behind the card from the file's own example data (the owner: "the landing
// page is the dashboard, locked"). What Allma is — the text Google's reviewer
// reads to match our scopes to the product — is put under it here, from
// public-pages, so the two front doors can never say different things. In
// English whatever the page's language: that is who reads it for Google, and
// the Hebrew follows it in the same section.
//
// And the one page here that can be ZOOMED (the owner, 2026-09-29). The file
// forbids pinch-zoom for the signed-in app, and this same file is allma.world's
// front door, where a stranger reading "what Allma is" has every reason to
// enlarge it. WCAG 1.4.4 fails a page that disables zoom — the one finding an
// axe run on the live pages turned up — so the locked copy gets a viewport that
// allows it, and the signed-in one is unchanged (the accessibility statement
// says so: public-pages.PINCH_ZOOM_DISABLED).
const APP_VIEWPORT = /<meta name="viewport" content="[^"]*user-scalable=no[^"]*">/;
const ZOOMABLE_VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
function newPageHtml() {
  // A miss leaves the page as it was rather than failing the front door;
  // tests/public-pages.test.js is what goes red if the file's meta drifts.
  return servedPageHtml(' data-new="1"').replace(APP_VIEWPORT, ZOOMABLE_VIEWPORT) + '\n<section class="about" id="about" lang="en" dir="ltr">'
    + `<h1>${esc(publicPages.BRAND)}</h1><p class="ab-lede">${esc(publicPages.HOME_LEDE)}</p>`
    + publicPages.homeSections((n) => 'ab-' + n) + '</section>\n';
}

const { esc } = require('./html');
const publicPages = require('./public-pages');
const { linkCard, withLinkCard } = require('./link-card');

// The page is one inline script and one inline stylesheet, so 'unsafe-inline'
// is unavoidable and blocking it would only break the page. What this policy is
// actually for is the other direction: `connect-src 'self'` and `form-action
// 'self'` mean a script that somehow got onto this page still has nowhere to
// send what it can see, and `frame-ancestors 'none'` keeps it out of somebody
// else's iframe. Nothing may be fetched from anywhere else: until 2026-09-29
// Google Fonts was named here because the page asked for it, and the fonts now
// arrive inline as data: URIs (fonts.js) — so a page that grows a Google link
// again is refused by the browser, not merely frowned on by a test.
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "font-src data:",
  // 'self' for the home-screen icon the <head> names; the manifest is the
  // installable app's (pwa.js). Nothing else of ours is fetched as either.
  "img-src 'self' data:",
  "manifest-src 'self'",
  // The one worker the page registers, /sw.js (pwa.js): it only draws the
  // offline screen. Without this `default-src 'none'` refuses it silently.
  "worker-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

function headers(type, extra = {}) {
  return {
    'Content-Type': type,
    // A page of somebody's private list must not sit in a shared cache, or in
    // the back-button cache after they sign out.
    'Cache-Control': 'no-store, private',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP,
    ...extra,
  };
}

const HTML = 'text/html; charset=utf-8';
const JSONT = 'application/json; charset=utf-8';

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, headers(JSONT, extra));
  return res.end(JSON.stringify(body));
}

// The assistant's name in each page language — the tab title of every page
// this file draws. עולמה / Allma, never a translation (rules/doctrine.md).
const PAGE_NAME = { he: 'עולמה', en: 'Allma' };

// What a dead link says, in both languages. A page that cannot tell who is
// holding the link (see the GET below) says it in both, Hebrew first — it
// names nobody and reads right to either person.
const MESSAGE_COPY = {
  linkDead: {
    he: { title: 'הקישור כבר לא פעיל',
      body: 'קישורי כניסה תקפים לזמן קצר ולשימוש אחד. אפשר לבקש מעולמה קישור חדש בוואטסאפ.' },
    en: { title: 'This link has expired',
      body: 'Sign-in links are short-lived and work once. You can ask Allma for a new one on WhatsApp.' },
  },
  linkUsed: {
    he: { title: 'הקישור כבר לא פעיל',
      body: 'ייתכן שכבר נכנסת איתו. אפשר לבקש מעולמה קישור חדש בוואטסאפ.' },
    en: { title: 'This link has expired',
      body: 'You may already have signed in with it. You can ask Allma for a new one on WhatsApp.' },
  },
};

// `lang` is 'he', 'en', or null for "nobody is known — say both".
function messagePage(res, status, key, lang, extra = {}) {
  const copy = MESSAGE_COPY[key];
  const langs = lang ? [pageLocale(lang)] : ['he', 'en'];
  const first = langs[0];
  const blocks = langs.map((l) => `<div lang="${l}" dir="${l === 'he' ? 'rtl' : 'ltr'}">`
    + `<h1>${esc(copy[l].title)}</h1><p>${esc(copy[l].body)}</p></div>`).join('<hr>');
  res.writeHead(status, headers(HTML, extra));
  return res.end(`<!doctype html><html dir="${first === 'he' ? 'rtl' : 'ltr'}" lang="${first}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${langs.map((l) => PAGE_NAME[l]).join(' · ')}</title><style>
:root{color-scheme:light dark}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;
background:#f2f2f7;color:#1c1c1e}
@media (prefers-color-scheme:dark){body{background:#000;color:#f2f2f7}
.card{background:#1c1c1e!important}}
.card{background:#fff;border-radius:20px;padding:28px 24px;max-width:360px;width:100%;text-align:center}
h1{font-size:20px;margin:0 0 8px;font-weight:650;letter-spacing:-.01em}
p{font-size:15px;line-height:1.55;margin:0;opacity:.62}
button{margin-top:22px;width:100%;border:0;border-radius:14px;padding:15px;
font:inherit;font-weight:600;font-size:16px;background:#0a84ff;color:#fff}
button:active{opacity:.75}
hr{border:0;height:1px;background:currentColor;opacity:.12;margin:20px 0}
</style></head><body><div class="card">${blocks}</div></body></html>`);
}

// The sign-in page. One button, and the button is the whole point: pressing it
// is a POST, and only a POST spends the key.
// The meeting a LEGACY link was minted for, if any. Until 2026-09-15 the
// meeting rode the sign-in URL as `?meeting=<id>`; a link's row says where it
// lands now, and this is read only for a row that says nothing more than the
// front page — which is exactly what a pre-migration row says. Echoed into the
// form's action so the POST still knows it. Anything but a plain positive
// integer is treated as absent: the page decides whether the number names a
// meeting of theirs, and a number that does not simply opens the page.
function meetingParam(reqUrl) {
  const q = new URL(String(reqUrl || ''), 'http://x').searchParams.get('meeting');
  return q && /^[1-9][0-9]{0,11}$/.test(q) ? q : null;
}

// The front door is drawn in the person's language too: the link was minted
// for a known user, so `peekLink` knows what they have on file, and a page that
// greets Sarah in Hebrew before an English dashboard is the same bug twice.
// Where to open the page: the link's own row first, and only for a row that
// names nothing but the front page, a legacy `?meeting=`.
function landingFragment(link, reqUrl) {
  const own = auth.destinationFragment(link);
  if (own) return own;
  const legacy = meetingParam(reqUrl);
  return legacy ? `#meeting=${legacy}` : '';
}

const SIGN_IN_COPY = {
  he: {
    dir: 'rtl',
    hi: (name) => (name ? `שלום ${esc(name)}` : 'שלום'),
    body: 'הקישור הזה נפתח פעם אחת. אחרי שתיכנס הוא כבר לא יעבוד — הדף עצמו יישאר פתוח.',
    button: 'כניסה',
    ttl: (h) => `הקישור תקף ל־${h} שעות`,
  },
  en: {
    dir: 'ltr',
    hi: (name) => (name ? `Hi ${esc(name)}` : 'Hi'),
    body: 'This link opens once. After you sign in it stops working — the page itself stays open.',
    button: 'Sign in',
    ttl: (h) => `The link is valid for ${h} hours`,
  },
};

function signInPage(res, token, firstName, meeting, locale) {
  const lang = pageLocale(locale);
  const t = SIGN_IN_COPY[lang];
  const hi = t.hi(firstName);
  res.writeHead(200, headers(HTML));
  return res.end(`<!doctype html><html dir="${t.dir}" lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
${linkCard({ lang, path: '/' })}
<title>${PAGE_NAME[lang]}</title><style>
:root{color-scheme:light dark}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;
background:#f2f2f7;color:#1c1c1e}
@media (prefers-color-scheme:dark){body{background:#000;color:#f2f2f7}
.card{background:#1c1c1e!important}}
.card{background:#fff;border-radius:20px;padding:28px 24px;max-width:360px;width:100%;text-align:center}
h1{font-size:22px;margin:0 0 8px;font-weight:650;letter-spacing:-.01em}
p{font-size:15px;line-height:1.55;margin:0;opacity:.62}
button{margin-top:24px;width:100%;border:0;border-radius:14px;padding:15px;
font:inherit;font-weight:600;font-size:16px;background:#0a84ff;color:#fff}
button:active{opacity:.75}
small{display:block;margin-top:14px;font-size:12.5px;opacity:.45}
</style></head><body><div class="card">
<h1>${hi}</h1>
<p>${t.body}</p>
<form method="POST" action="/d/${esc(token)}${meeting ? `?meeting=${meeting}` : ''}"><button type="submit">${t.button}</button></form>
<small>${t.ttl(auth.LINK_TTL_MINUTES / 60)}</small>
</div></body></html>`);
}

async function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // Refuse rather than truncate: a body cut in half parses as different
      // JSON, not as an error, which is the worst of both.
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// SameSite=Lax already keeps the session cookie off a cross-site POST, which is
// the CSRF defence. This is the second lock: a form on another origin cannot
// set Content-Type to application/json without a preflight, and a preflight to
// an origin we never allow does not happen. Both have to fail for a forged
// write to land.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;              // same-origin fetches may omit it
  const host = req.headers.host;
  return Boolean(host) && origin === 'https://' + host;
}

// Who this cookie is — `{ userId, locale }` — or null for nobody.
async function currentUser(pool, req) {
  const sid = auth.readCookie(req.headers.cookie);
  if (!sid) return null;
  const res = await withTx(pool, (c) => auth.resolveSession(c, sid));
  return res.ok ? res.data : null;
}

// The mount asks this before handing anything over, so the operator dashboard
// never has to know the route list — and so a path that is nearly one of ours
// (`/mesh`, `/me/x`) falls through to Basic Auth instead of being answered here.
const OWN = new Set(['/me', '/me/data', '/me/events', '/me/act', '/me/out', '/me/code']);
function matches(pathname) {
  return OWN.has(pathname) || LINK_RE.test(pathname);
}

// ---- guessing a code -------------------------------------------------------
// A code is eight digits, not a link's 128 bits, so the guesses are counted
// where they arrive. Per address, five wrong in a quarter of an hour closes
// that address for the rest of it; in total, sixty wrong closes the door for
// everybody until the window rolls. With a handful of codes alive at once, a
// full window of guesses finds one about once in a million windows, and each
// code dies in ten minutes anyway. In memory, on purpose: the dashboard is one
// process, and a restart forgiving a quarter of an hour costs nothing.
const CODE_WINDOW_MS = 15 * 60 * 1000;
const CODE_MAX_PER_ADDRESS = 5;
const CODE_MAX_TOTAL = 60;
const codeMisses = new Map();   // address -> [ms, ...]
let codeMissesAll = [];
function recent(list, now) { return list.filter((t) => now - t < CODE_WINDOW_MS); }
// Caddy is the only thing in front of this and sets X-Forwarded-For; the socket
// is the fallback for a request that reached the port directly.
function clientAddress(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function codeBlocked(addr, now = Date.now()) {
  codeMissesAll = recent(codeMissesAll, now);
  const mine = recent(codeMisses.get(addr) || [], now);
  if (mine.length) codeMisses.set(addr, mine); else codeMisses.delete(addr);
  return mine.length >= CODE_MAX_PER_ADDRESS || codeMissesAll.length >= CODE_MAX_TOTAL;
}
function codeMissed(addr, now = Date.now()) {
  codeMisses.set(addr, [...(codeMisses.get(addr) || []), now]);
  codeMissesAll.push(now);
}
function resetCodeLimits() { codeMisses.clear(); codeMissesAll = []; }

async function handle(req, res, pool, pathname) {
  // ---- sign-in ------------------------------------------------------------
  const link = pathname.match(LINK_RE);
  if (link) {
    const token = link[1];
    if (req.method === 'GET') {
      const peek = await withTx(pool, (c) => auth.peekLink(c, token));
      if (!peek.ok) {
        // A dead link names nobody, so its language is the phone's own
        // session when there is one, and both languages when there is not.
        const holder = await currentUser(pool, req);
        return messagePage(res, 410, 'linkDead', holder ? holder.locale || 'he' : null);
      }
      // Somebody already signed in on this device, as the person the link is
      // for, does not need a key: they are taken where it points and the link
      // stays unspent. Now that links go out on their own — an invite, a long
      // list — most of them arrive on a phone that is already signed in, and a
      // button that spends a key to open a session they already have is a tap
      // for nothing. Still nothing changes on a GET: no link is spent and no
      // session is opened. A crawler carries no cookie and gets the button; a
      // DIFFERENT person's cookie gets the button too, because pressing it is
      // what switches whose page this is.
      const who = await currentUser(pool, req);
      if (who && who.userId === peek.data.userId) {
        res.writeHead(303, headers(HTML, { Location: '/me' + landingFragment(peek.data, req.url) }));
        return res.end();
      }
      return signInPage(res, token, peek.data.firstName, meetingParam(req.url), peek.data.locale);
    }
    if (req.method === 'POST') {
      const opened = await withTx(pool, (c) => auth.redeemLink(c, token));
      if (!opened.ok) {
        const holder = await currentUser(pool, req);
        return messagePage(res, 410, 'linkUsed', holder ? holder.locale || 'he' : null);
      }
      res.writeHead(303, headers(HTML, {
        Location: '/me' + landingFragment(opened.data, req.url),
        'Set-Cookie': auth.cookieHeader(opened.data.sessionId),
      }));
      return res.end();
    }
    res.writeHead(405, headers(HTML, { Allow: 'GET, POST' }));
    return res.end();
  }

  // ---- signing out --------------------------------------------------------
  // Clears the cookie whatever happens: a session that could not be resolved is
  // one the person wants gone even more.
  if (pathname === '/me/out' && req.method === 'POST') {
    const sid = auth.readCookie(req.headers.cookie);
    if (sid) await withTx(pool, (c) => auth.endSession(c, sid));
    res.writeHead(303, headers(HTML, { Location: '/me', 'Set-Cookie': auth.clearCookieHeader() }));
    return res.end();
  }

  // ---- a code from Olma ---------------------------------------------------
  // JSON in and out: the app's own sign-in form posts it and reloads on ok.
  if (pathname === '/me/code') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'invalid' } }, { Allow: 'POST' });
    if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'cross-origin' } });
    const addr = clientAddress(req);
    if (codeBlocked(addr)) return sendJson(res, 429, { ok: false, error: { code: 'rate_limited' } });
    const body = await readJsonBody(req, 1024);
    const opened = await withTx(pool, (c) => auth.redeemCode(c, body && body.code));
    if (!opened.ok) {
      if (opened.error.code === 'not_found') codeMissed(addr);
      return sendJson(res, opened.error.code === 'forbidden' ? 403 : 400, { ok: false, error: { code: opened.error.code } });
    }
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(opened.data.sessionId) });
  }

  if (pathname !== '/me' && pathname !== '/me/data'
      && pathname !== '/me/events' && pathname !== '/me/act') {
    // Only reachable if `matches` and this list ever disagree. Say so rather
    // than falling through to a 200 with no body.
    return sendJson(res, 404, { ok: false, error: { code: 'not_found' } });
  }

  const who = await currentUser(pool, req);
  const userId = who ? who.userId : null;

  // ---- the page -----------------------------------------------------------
  if (pathname === '/me') {
    if (req.method !== 'GET') {
      res.writeHead(405, headers(HTML, { Allow: 'GET' }));
      return res.end();
    }
    if (!userId) {
      // A stale cookie that resolves to nobody is cleared on the way out, so
      // the next visit starts clean rather than repeating the same silent
      // failure. 200 since 2026-09-29, not 401: this is the same locked page
      // allma.world's `/` serves, nothing of theirs is in it (the data-new
      // stamp decides that, never the status), and Caddy compressed the 200
      // and sent the 401 whole — 767KB to a phone whose cookie had expired.
      // The JSON routes below still answer 401.
      res.writeHead(200, headers(HTML, { 'Set-Cookie': auth.clearCookieHeader() }));
      return res.end(newPageHtml());
    }
    // Counted for the admin page (domain/dashboard-opens.js), and never at
    // the page's expense: a failed write is a visit not counted, nothing more.
    await withTx(pool, (c) => opens.record(c, userId, { byAdmin: who.byAdmin })).catch(() => {});
    res.writeHead(200, headers(HTML));
    return res.end(ownPageHtml(who.locale));
  }

  // Past this point everything is JSON, including the refusals — the page is
  // fetching, and an HTML error body would surface to it as a parse failure
  // rather than as the 401 it actually is.
  if (!userId) return sendJson(res, 401, { ok: false, error: { code: 'unauthorized' } });

  if (pathname === '/me/data') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: { code: 'invalid' } }, { Allow: 'GET' });
    // The address book on its own, asked for by the one sheet that shows it
    // (domain/user-dashboard.contactsPage). A query on the same path rather
    // than a route of its own, so Caddy's allowlist — which matches /me/data
    // by path — needs nothing new to pass it.
    if (new URL(String(req.url || ''), 'http://x').searchParams.get('part') === 'contacts') {
      const book = await withTx(pool, (c) => dash.contactsPage(c, userId));
      return sendJson(res, book.ok ? 200 : 404, book);
    }
    const page = await withTx(pool, async (c) => {
      const loaded = await dash.load(c, userId);
      // Opening the page IS the exposure, in both arms — including the arm
      // that drew no card — so the two groups are the same kind of people
      // (domain/experiments.js). Once per person; a no-op once it is locked.
      if (loaded.ok) await experiments.expose(c, 'invite_card_moment', userId);
      return loaded;
    });
    return sendJson(res, page.ok ? 200 : 404, page);
  }

  // Its own route because it is the one thing here that leaves the building.
  // Every event comes from Google on this request, so a slow or dead calendar
  // delays the days and nothing else — the list, the friends and the settings
  // have already been served by /me/data and are on screen.
  if (pathname === '/me/events') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: { code: 'invalid' } }, { Allow: 'GET' });
    const days = await withTx(pool, (c) => events.loadEvents(c, userId));
    return sendJson(res, days.ok ? 200 : 404, days);
  }

  // ---- one write ----------------------------------------------------------
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'invalid' } }, { Allow: 'POST' });
  if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'cross-origin write' } });
  const body = await readJsonBody(req);
  if (!body || typeof body.action !== 'string') {
    return sendJson(res, 400, { ok: false, error: { code: 'invalid', message: 'action required' } });
  }
  const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
    ? body.payload : {};
  const done = await withTx(pool, (c) => write.perform(c, userId, body.action, payload));
  // After the commit, never inside it (refreshUserCard is best-effort and
  // never throws), so the card the agent reads next turn says what this page
  // just saved.
  if (done.ok && write.CARD_ACTIONS.has(body.action)) await refreshUserCard(pool, userId);
  // A refusal is a 200-shaped envelope at the HTTP layer only when it succeeded;
  // otherwise the status carries the same meaning the code does, so a network
  // panel and the page agree about what happened.
  const status = done.ok ? 200
    : done.error.code === 'not_found' ? 404
      : done.error.code === 'forbidden' ? 403 : 400;
  return sendJson(res, status, done);
}

// allma.world's `/` — dashboard.js hands it over for the public hostnames
// only, so the admin root on duckdns is untouched. A visitor we can see is
// sent to their own page: the lock is for somebody we cannot see, never for
// somebody we can. 200, not /me's 401, because this IS the page asked for;
// and indexable, unlike everything else here, because it is the front door
// and holds nothing of anybody's. `Vary: Cookie` because the same URL answers
// two ways.
async function frontPage(req, res, pool) {
  const who = await currentUser(pool, req).catch(() => null);
  if (who && who.userId) {
    res.writeHead(303, headers(HTML, { Location: '/me', Vary: 'Cookie' }));
    return res.end();
  }
  const h = headers(HTML, { Vary: 'Cookie' });
  delete h['X-Robots-Tag'];
  res.writeHead(200, h);
  // The card a shared allma.world link shows (link-card.js). Added here, where
  // the front door is served, rather than in newPageHtml: the same locked page
  // also answers an expired cookie on /me, which nobody shares.
  return res.end(withLinkCard(newPageHtml(), { lang: 'he', path: '/' }));
}

module.exports = {
  handle, matches, currentUser, frontPage, pageLocale, resetCodeLimits, LINK_RE, PAGE_PATH,
  CODE_MAX_PER_ADDRESS, CODE_MAX_TOTAL,
};
