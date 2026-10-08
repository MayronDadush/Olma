'use strict';
// The personal dashboard as an app on the phone's home screen: the manifest
// that makes it installable, and the icons that manifest and the page's
// <head> name. A Progressive Web App and nothing more — no store, no wrapper,
// no second pipeline (the plan, 2026-09-14; built 2026-09-27).
//
//   GET /manifest.webmanifest       per-session: the name follows the language
//   GET /icons/icon-192.png         the mark, edge to edge
//   GET /icons/icon-512.png
//   GET /icons/icon-512-maskable.png  the mark set inside Android's safe circle
//   GET /icons/apple-touch-icon.png   180x180, what iOS puts on the home screen
//
// Exact paths, never `/icons/*` — the same rule as `/pick/` and `/d/`
// (rules/dashboard-and-domains.md): anything nearly ours falls through to
// Basic Auth, and Caddy on allma.world names these six one by one.
//
//   GET /sw.js                      the offline screen, and nothing else
//
// The service worker CACHES NOTHING. Everything the page shows is `no-store,
// private`, so an offline shell could only ever show a stale life or a blank
// one — and a phone that kept somebody's list on disk would be keeping it
// after they signed out. What it does is smaller: when opening the page FAILS
// (no network at all), it answers with one screen of its own that says so,
// instead of the phone's own error page (owner, 2026-09-28). The screen is a
// string inside the worker, so there is nothing to fetch and nothing to store;
// every request that reaches the network goes to the network untouched.
//
// The icons are drawn from brand-mark.js with resvg (already a dependency, for
// the schedule card) the first time each size is asked for, and kept. They
// are never committed as binaries: changing the mark is one file.
const crypto = require('node:crypto');
const mark = require('./brand-mark');

const MANIFEST_PATH = '/manifest.webmanifest';
const ICONS = Object.freeze({
  '/icons/icon-192.png': { size: 192, variant: 'square' },
  '/icons/icon-512.png': { size: 512, variant: 'square' },
  '/icons/icon-512-maskable.png': { size: 512, variant: 'maskable' },
  '/icons/apple-touch-icon.png': { size: 180, variant: 'square' },
});
const SW_PATH = '/sw.js';
const PATHS = new Set([MANIFEST_PATH, SW_PATH, ...Object.keys(ICONS)]);

function matches(pathname) {
  return PATHS.has(pathname);
}

// The ground the app opens on before the page has painted. It is the page's
// own light `--bg`, so the splash and the first frame are one colour.
const BACKGROUND = '#F0EDE5';

// Name, description and the long-press shortcuts, in the two languages the
// page itself speaks. The name is the assistant's, never translated beyond
// its own two spellings (rules/doctrine.md, "A display name is not a word to
// be translated").
const COPY = {
  he: {
    name: 'עולמה', dir: 'rtl',
    description: 'המשימות, התיאומים והחברים שעולמה מחזיקה בשבילך.',
    shortcuts: [
      { name: 'משימה חדשה', url: '/me#new-task' },
      { name: 'תיאום פגישה', url: '/me#new-meeting' },
      { name: 'המשימות שלי', url: '/me#tasks' },
    ],
  },
  en: {
    name: 'Allma', dir: 'ltr',
    description: 'The tasks, plans and friends Allma keeps for you.',
    shortcuts: [
      { name: 'New task', url: '/me#new-task' },
      { name: 'Plan a meeting', url: '/me#new-meeting' },
      { name: 'My tasks', url: '/me#tasks' },
    ],
  },
};

function manifestFor(lang) {
  const c = COPY[lang === 'en' ? 'en' : 'he'];
  return {
    // `id` is what the browser remembers the installed app BY; it must never
    // change, or every installed copy becomes a stranger to its own updates.
    id: '/me',
    name: c.name,
    short_name: c.name,
    description: c.description,
    lang: lang === 'en' ? 'en' : 'he',
    dir: c.dir,
    // The language rides the start address, so the signed-out screen of a
    // freshly installed app (on an iPhone its storage is empty) opens in the
    // language of the person who installed it rather than the stranger's
    // default. `hl` is read ONLY on that screen; a session's own locale wins
    // everywhere else. `id` above never changes with it.
    start_url: lang === 'en' ? '/me?hl=en' : '/me?hl=he',
    // The whole origin, so a `/d/<token>` link tapped in WhatsApp opens inside
    // the installed app on Android instead of in a browser tab.
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: BACKGROUND,
    theme_color: BACKGROUND,
    launch_handler: { client_mode: 'navigate-existing' },
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: c.shortcuts.map((s) => ({
      name: s.name, url: s.url,
      icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    })),
  };
}

// resvg is loaded lazily, exactly like schedule-card.js does it: a box without
// the native binary still serves every page, and only an icon request fails.
let Resvg = null;
function loadResvg() {
  if (!Resvg) Resvg = require('@resvg/resvg-js').Resvg;
  return Resvg;
}

const rendered = new Map();
function iconBytes(pathname) {
  const spec = ICONS[pathname];
  if (!spec) return null;
  if (!rendered.has(pathname)) {
    const R = loadResvg();
    const png = new R(mark.markSvg({ variant: spec.variant }), {
      fitTo: { mode: 'width', value: spec.size },
      font: { loadSystemFonts: false },
    }).render().asPng();
    const bytes = Buffer.from(png);
    rendered.set(pathname, {
      bytes,
      etag: '"' + crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32) + '"',
    });
  }
  return rendered.get(pathname);
}

// ── the offline screen ──────────────────────────────────────────────────────
// The two languages the page speaks. Plural address, like the rest of the
// page's own copy.
const OFFLINE_COPY = {
  he: {
    dir: 'rtl', title: 'אין חיבור',
    h: 'אין חיבור כרגע',
    p: 'המשימות שלכם שמורות אצל עולמה. ברגע שיחזור האינטרנט, הכל פה.',
    retry: 'לנסות שוב',
  },
  en: {
    dir: 'ltr', title: 'No connection',
    h: 'No connection right now',
    p: 'Your tasks are safe with Allma. As soon as the internet is back, everything is here.',
    retry: 'Try again',
  },
};

// Self-contained on purpose: no font, no image, no script of ours to fetch,
// because by definition nothing can be fetched when this is on screen. It
// reloads itself when the phone says it is back online, so the person does
// not have to find the button.
function offlineHtml(lang) {
  const c = OFFLINE_COPY[lang === 'en' ? 'en' : 'he'];
  return '<!doctype html><html lang="' + (lang === 'en' ? 'en' : 'he') + '" dir="' + c.dir + '"><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="theme-color" content="' + BACKGROUND + '"><title>' + c.title + '</title><style>' +
    // The page's own tokens (Cypress + Mustard, 2026-09-28): the one button
    // is the ACTION colour, as it is on the page.
    ':root{--bg:#F0EDE5;--text:#0E1F1E;--text-2:#44504E;--action:#F9C23C;--on-action:#004643;color-scheme:light dark}' +
    '@media (prefers-color-scheme:dark){:root{--bg:#1B1A18;--text:#EDE9DF;--text-2:#B9B5AC;--on-action:#0E1F1E}}' +
    'html,body{height:100%;margin:0}' +
    'body{background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;' +
    'padding:env(safe-area-inset-top,0px) 24px env(safe-area-inset-bottom,0px)}' +
    'svg{width:72px;height:72px;border-radius:18px}' +
    'h1{font-size:22px;margin:6px 0 0;letter-spacing:-.01em}' +
    'p{margin:0;max-width:30ch;color:var(--text-2)}' +
    'button{margin-top:10px;border:0;border-radius:999px;padding:12px 26px;font:600 16px system-ui,-apple-system,sans-serif;' +
    'background:var(--action);color:var(--on-action);min-height:44px}' +
    '</style></head><body>' +
    mark.markSvg({ variant: 'square', id: 'off' }) +
    '<h1>' + c.h + '</h1><p>' + c.p + '</p>' +
    '<button type="button" onclick="location.reload()">' + c.retry + '</button>' +
    '<script>addEventListener("online",function(){location.reload()})</script>' +
    '</body></html>';
}

// Only a NAVIGATION to the page itself (or to a sign-in link, which is the
// page by another door) is ever answered, and only when the network threw.
// A 500, a 404, a sign-in screen — anything the server actually SAID — goes
// through exactly as it came. Everything else (/me/data, /me/act, icons) is
// never intercepted at all, so a write that fails offline fails the way it
// already does, in the page, with its own toast.
//
// The language is the one the page registered it with (`/sw.js?hl=`), which
// is the person's own; a phone whose setting says English does not make a
// Hebrew speaker's offline screen English.
const SW_SOURCE = [
  "'use strict';",
  'var HL = new URL(self.location.href).searchParams.get("hl") === "en" ? "en" : "he";',
  'var PAGES = ' + JSON.stringify({ he: offlineHtml('he'), en: offlineHtml('en') }) + ';',
  'var CSP = "default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; base-uri \'none\'";',
  'self.addEventListener("install", function(){ self.skipWaiting(); });',
  'self.addEventListener("activate", function(e){ e.waitUntil(self.clients.claim()); });',
  'self.addEventListener("fetch", function(e){',
  '  var r = e.request;',
  '  if(r.mode !== "navigate" || r.method !== "GET") return;',
  '  var p = new URL(r.url).pathname;',
  '  if(p !== "/me" && p.indexOf("/d/") !== 0) return;',
  '  e.respondWith(fetch(r).catch(function(){',
  '    return new Response(PAGES[HL], {status: 503, headers: {',
  '      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",',
  '      "Content-Security-Policy": CSP}});',
  '  }));',
  '});',
  // Notifications (domain/push.js). The payload is the server's own JSON:
  // a title, one line, the page to open and a tag that replaces an older
  // notification about the same coordination. Anything unreadable shows
  // nothing rather than an empty card — iOS counts a push that shows no
  // notification against the subscription.
  'self.addEventListener("push", function(e){',
  '  var d = null;',
  '  try { d = e.data ? e.data.json() : null; } catch (x) { d = null; }',
  '  if(!d || !d.title) d = {title: HL === "en" ? "Allma" : "עולמה", body: "", url: "/me"};',
  '  e.waitUntil(self.registration.showNotification(String(d.title), {',
  '    body: String(d.body || ""), tag: d.tag || undefined, renotify: Boolean(d.tag),',
  '    icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", lang: HL, dir: HL === "en" ? "ltr" : "rtl",',
  '    data: {url: typeof d.url === "string" && d.url.indexOf("/me") === 0 ? d.url : "/me"}}));',
  '});',
  // A tap opens the coordination: an open window is navigated and brought
  // forward, otherwise a new one is opened. Only a path under /me is ever
  // followed, whatever the payload said.
  'self.addEventListener("notificationclick", function(e){',
  '  e.notification.close();',
  '  var url = (e.notification.data && e.notification.data.url) || "/me";',
  '  e.waitUntil(self.clients.matchAll({type: "window", includeUncontrolled: true}).then(function(list){',
  '    for (var i = 0; i < list.length; i++) {',
  '      var c = list[i];',
  '      if (new URL(c.url).pathname === "/me" && "focus" in c) {',
  '        return c.focus().then(function(w){ return (w || c).navigate ? (w || c).navigate(url) : null; });',
  '      }',
  '    }',
  '    return self.clients.openWindow(url);',
  '  }));',
  '});',
].join('\n');

const COMMON = {
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
};

// `lang` comes from the caller, which knows the session (user-dashboard.js
// `currentUser`); an anonymous request gets Hebrew, the house language.
function handle(req, res, pathname, { lang } = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...COMMON, Allow: 'GET, HEAD' });
    return res.end();
  }
  if (pathname === MANIFEST_PATH) {
    // Per session (the name follows the language), so never shared.
    res.writeHead(200, {
      ...COMMON,
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(req.method === 'HEAD' ? undefined : JSON.stringify(manifestFor(lang)));
  }
  if (pathname === SW_PATH) {
    // `no-cache`, not a long max-age: the browser checks a worker for updates
    // on every navigation anyway, and a stale one is how a fix never arrives.
    res.writeHead(200, {
      ...COMMON,
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    return res.end(req.method === 'HEAD' ? undefined : SW_SOURCE);
  }
  let icon;
  try { icon = iconBytes(pathname); } catch (e) {
    res.writeHead(500, { ...COMMON, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('icon unavailable');
  }
  if (!icon) {
    res.writeHead(404, { ...COMMON, 'Cache-Control': 'no-store' });
    return res.end();
  }
  const head = {
    ...COMMON,
    'Content-Type': 'image/png',
    // A day, not a year: the mark is still being decided, and a phone that
    // cached last week's for a year would keep it.
    'Cache-Control': 'public, max-age=86400',
    ETag: icon.etag,
  };
  if (req.headers['if-none-match'] === icon.etag) {
    res.writeHead(304, head);
    return res.end();
  }
  res.writeHead(200, { ...head, 'Content-Length': icon.bytes.length });
  return res.end(req.method === 'HEAD' ? undefined : icon.bytes);
}

module.exports = {
  matches, handle, manifestFor, iconBytes, offlineHtml,
  PATHS, ICONS, MANIFEST_PATH, SW_PATH, SW_SOURCE, BACKGROUND,
};
