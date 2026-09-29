'use strict';
// The card WhatsApp (and every other chat app) draws under a link to allma.world:
// Open Graph tags in the page's <head>.
//
// Who actually reads them matters, because it is not who you would guess. On
// WhatsApp the SENDING phone fetches the link and attaches the card; the
// recipient never fetches anything. So this helps whenever a PERSON shares
// allma.world from their own phone. It does NOT put a card under the links
// Olma sends: those leave through the gateway's Baileys, which builds a preview
// only with `link-preview-js` installed, and OpenClaw deliberately ships
// without it (checked 2026-09-29 against openclaw 2026.9.6). Making her own
// links carry a card means the gateway fetching every URL that passes through
// it, including the ones people send her — a separate decision, not taken.
//
// The image is the app icon pwa.js already renders and Caddy already passes on
// allma.world (`/icons/icon-512.png`, the mark edge to edge), so the card needs
// no new public route. It is square, so WhatsApp draws it as the small
// thumbnail beside the title rather than a banner over it — the mark reads at
// that size, a wide poster would not.
//
// Absolute URLs are required by the protocol, and they name the PUBLIC host
// only: the admin hostname is never a link anybody shares, and a card pointing
// at it would 404 through Caddy the day it was.
const { esc } = require('./html');

const ORIGIN = 'https://allma.world';
const IMAGE_PATH = '/icons/icon-512.png';
const IMAGE_SIZE = 512;

const SITE_NAME = 'עולמה · Allma';
// Said in her voice (brand book, 09): one sentence, full stops, no exclamation,
// and no gendered address, because a shared link reaches anyone.
const DEFAULTS = {
  he: {
    title: 'עולמה',
    description: 'עוזרת אישית בתוך וואטסאפ. כותבים לה הכל, והיא מסדרת, מזכירה ומתאמת.',
    locale: 'he_IL',
  },
  en: {
    title: 'Allma',
    description: 'A personal assistant inside WhatsApp. Write it everything. It sorts, reminds and coordinates.',
    locale: 'en_US',
  },
};

// The <meta> lines for one page. `path` is the page's own path on the public
// host; a title or description left out falls back to the house line in that
// language. Everything is escaped: a title may one day carry a user's words.
function linkCard({ lang = 'he', title, description, path = '/' } = {}) {
  const d = DEFAULTS[lang === 'en' ? 'en' : 'he'];
  const alt = d === DEFAULTS.he ? DEFAULTS.en : DEFAULTS.he;
  const url = ORIGIN + (String(path).startsWith('/') ? path : '/');
  const tags = [
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', SITE_NAME],
    ['property', 'og:title', title || d.title],
    ['property', 'og:description', description || d.description],
    ['property', 'og:url', url],
    ['property', 'og:locale', d.locale],
    ['property', 'og:locale:alternate', alt.locale],
    ['property', 'og:image', ORIGIN + IMAGE_PATH],
    ['property', 'og:image:width', String(IMAGE_SIZE)],
    ['property', 'og:image:height', String(IMAGE_SIZE)],
    ['property', 'og:image:alt', d === DEFAULTS.he ? 'הסימן של עולמה' : 'The Allma mark'],
    ['name', 'twitter:card', 'summary'],
    ['name', 'description', description || d.description],
  ];
  return tags.map(([k, n, v]) => `<meta ${k}="${n}" content="${esc(v)}">`).join('\n');
}

// Puts the card into a page that already has its own <head>, right before the
// <title>. A page with no <title> is returned untouched rather than broken:
// tests/link-card.test.js is what goes red if a page loses its card.
function withLinkCard(html, opts) {
  const at = html.indexOf('<title>');
  if (at < 0) return html;
  return html.slice(0, at) + linkCard(opts) + '\n' + html.slice(at);
}

module.exports = { linkCard, withLinkCard, ORIGIN, IMAGE_PATH, DEFAULTS };
