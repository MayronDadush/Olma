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
// Basic Auth, and Caddy on allma.world names these five one by one.
//
// No service worker, on purpose. Everything the page shows is `no-store,
// private`, so an offline shell could only ever show a stale life or a blank
// one, and Chrome has not needed one to install since 2024.
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
const PATHS = new Set([MANIFEST_PATH, ...Object.keys(ICONS)]);

function matches(pathname) {
  return PATHS.has(pathname);
}

// The ground the app opens on before the page has painted. It is the page's
// own light `--bg`, so the splash and the first frame are one colour.
const BACKGROUND = '#F4F3F8';

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

module.exports = { matches, handle, manifestFor, iconBytes, PATHS, ICONS, MANIFEST_PATH, BACKGROUND };
