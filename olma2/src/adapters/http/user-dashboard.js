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
//
// GET never changes anything, and that is not tidiness — WhatsApp fetches every
// link it delivers to build a preview, so a key redeemed on GET would be burned
// by the crawler before the person ever touched it.
const fs = require('node:fs');
const path = require('node:path');
const { withTx } = require('../../db/pool');
const auth = require('../../domain/dashboard-auth');
const dash = require('../../domain/user-dashboard');
const events = require('../../domain/user-dashboard-events');
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
function servedPageHtml(extra = '') {
  return '<html data-served="1"' + extra + '>\n' + pageHtml();
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
function newPageHtml() {
  return servedPageHtml(' data-new="1"');
}

const { esc } = require('./html');

// The page is one inline script and one inline stylesheet, so 'unsafe-inline'
// is unavoidable and blocking it would only break the page. What this policy is
// actually for is the other direction: `connect-src 'self'` and `form-action
// 'self'` mean a script that somehow got onto this page still has nowhere to
// send what it can see, and `frame-ancestors 'none'` keeps it out of somebody
// else's iframe. Google Fonts is named because the page asks for it; nothing
// else may be fetched at all.
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com data:",
  "img-src data:",
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
const OWN = new Set(['/me', '/me/data', '/me/events', '/me/act', '/me/out']);
function matches(pathname) {
  return OWN.has(pathname) || LINK_RE.test(pathname);
}

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
      // failure. The status stays 401: nothing of theirs is being served.
      res.writeHead(401, headers(HTML, { 'Set-Cookie': auth.clearCookieHeader() }));
      return res.end(newPageHtml());
    }
    res.writeHead(200, headers(HTML));
    return res.end(ownPageHtml(who.locale));
  }

  // Past this point everything is JSON, including the refusals — the page is
  // fetching, and an HTML error body would surface to it as a parse failure
  // rather than as the 401 it actually is.
  if (!userId) return sendJson(res, 401, { ok: false, error: { code: 'unauthorized' } });

  if (pathname === '/me/data') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: { code: 'invalid' } }, { Allow: 'GET' });
    const page = await withTx(pool, (c) => dash.load(c, userId));
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

module.exports = { handle, matches, LINK_RE, PAGE_PATH };
