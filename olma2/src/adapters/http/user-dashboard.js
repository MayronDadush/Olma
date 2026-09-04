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
//   GET  /d/<token>   show a button. Spends nothing.
//   POST /d/<token>   spend the key, open the session, redirect.
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

const LINK_RE = /^\/d\/([a-f0-9]{64})$/;
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

// The same page, told it is speaking to somebody it does not know. The file
// has no <html> tag of its own — a leading one merges its attributes onto the
// root element the parser was going to create anyway — so this stamps the flag
// without the page carrying a second copy of itself for the case.
//
// Deliberately the answer for an EXPIRED link too, not only for a stranger.
// Both people need the same next step (write to her), the screen says so
// without claiming to know which of the two you are, and it leaks nothing
// about whether a number is on file.
function newPageHtml() {
  return '<html data-new="1">\n' + pageHtml();
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

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

function messagePage(res, status, title, body, extra = {}) {
  res.writeHead(status, headers(HTML, extra));
  return res.end(`<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>עולמה</title><style>
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
</style></head><body><div class="card"><h1>${esc(title)}</h1><p>${esc(body)}</p></div></body></html>`);
}

// The sign-in page. One button, and the button is the whole point: pressing it
// is a POST, and only a POST spends the key.
function signInPage(res, token, firstName) {
  const hi = firstName ? `שלום ${esc(firstName)}` : 'שלום';
  res.writeHead(200, headers(HTML));
  return res.end(`<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>עולמה</title><style>
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
<p>הקישור הזה נפתח פעם אחת. אחרי שתיכנס הוא כבר לא יעבוד — הדף עצמו יישאר פתוח.</p>
<form method="POST" action="/d/${esc(token)}"><button type="submit">כניסה</button></form>
<small>הקישור תקף ל־${auth.LINK_TTL_MINUTES} דקות</small>
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

async function currentUser(pool, req) {
  const sid = auth.readCookie(req.headers.cookie);
  if (!sid) return null;
  const res = await withTx(pool, (c) => auth.resolveSession(c, sid));
  return res.ok ? res.data.userId : null;
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
        return messagePage(res, 410, 'הקישור כבר לא פעיל',
          'קישורי כניסה תקפים לזמן קצר ולשימוש אחד. אפשר לבקש מעולמה קישור חדש בוואטסאפ.');
      }
      return signInPage(res, token, peek.data.firstName);
    }
    if (req.method === 'POST') {
      const opened = await withTx(pool, (c) => auth.redeemLink(c, token));
      if (!opened.ok) {
        return messagePage(res, 410, 'הקישור כבר לא פעיל',
          'ייתכן שכבר נכנסת איתו. אפשר לבקש מעולמה קישור חדש בוואטסאפ.');
      }
      res.writeHead(303, headers(HTML, {
        Location: '/me',
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

  const userId = await currentUser(pool, req);

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
    return res.end(pageHtml());
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
  // A refusal is a 200-shaped envelope at the HTTP layer only when it succeeded;
  // otherwise the status carries the same meaning the code does, so a network
  // panel and the page agree about what happened.
  const status = done.ok ? 200
    : done.error.code === 'not_found' ? 404
      : done.error.code === 'forbidden' ? 403 : 400;
  return sendJson(res, status, done);
}

module.exports = { handle, matches, LINK_RE, PAGE_PATH };
