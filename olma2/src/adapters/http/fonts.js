'use strict';
// The typefaces allma.world draws in, served from allma.world itself.
//
// Until 2026-09-29 every public page and the personal dashboard linked
// fonts.googleapis.com, which means every visitor's browser told Google its IP
// address before it could draw a letter — a transfer of personal data to a
// third party that nobody consented to and nothing required (LG München I,
// 3 O 17493/20, fined a site for exactly this; finding 13 of the 2026-09-28
// compliance review). IBM Plex is SIL OFL, so we may carry it ourselves.
//
// Inlined as data: URIs rather than served from a `/fonts/` route because
// allma.world is an ALLOWLIST in Caddy (.claude/rules/dashboard-and-domains.md):
// a new route 404s there until the Caddyfile learns it, and the Caddyfile is
// not in this repo. Inlining needs no Caddy change and no deploy ordering. The
// price is size: six woff2 files, ~67KB on disk and ~90KB as base64 on every
// page. If the set grows much, a route with long cache headers is the other
// answer, and it needs Caddy FIRST.
//
// What is carried, and why that is enough. The pages' stack is
// 'IBM Plex Sans Hebrew', 'IBM Plex Sans', …: the Hebrew family is carried for
// its HEBREW subset only (four static weights — it is not a variable font on
// Google), so Latin text falls through to IBM Plex Sans, whose Latin is the
// same design, carried once as a variable file covering 400–700. Mono is the
// public pages' code spans, weight 500. The unicode-range lines are Google's
// own for these subsets (css2 API, 2026-09-29), so a browser still skips a
// file for a script the page has not drawn.
//
// Read once at require time: the files never change while the process runs,
// and a missing file should fail the boot, loudly, rather than a page later.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts', 'web');

const HEBREW = 'U+0307-0308, U+0590-05FF, U+200C-2010, U+20AA, U+25CC, U+FB1D-FB4F';
const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, '
  + 'U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

// [family, weight (a range for a variable file), file, unicode-range]
const FACES = [
  ['IBM Plex Sans Hebrew', '400', 'IBMPlexSansHebrew-400-hebrew.woff2', HEBREW],
  ['IBM Plex Sans Hebrew', '500', 'IBMPlexSansHebrew-500-hebrew.woff2', HEBREW],
  ['IBM Plex Sans Hebrew', '600', 'IBMPlexSansHebrew-600-hebrew.woff2', HEBREW],
  ['IBM Plex Sans Hebrew', '700', 'IBMPlexSansHebrew-700-hebrew.woff2', HEBREW],
  ['IBM Plex Sans', '400 700', 'IBMPlexSans-latin.woff2', LATIN],
  ['IBM Plex Mono', '500', 'IBMPlexMono-500-latin.woff2', LATIN],
];

const FONT_CSS = FACES.map(([family, weight, file, range]) => {
  const b64 = fs.readFileSync(path.join(DIR, file)).toString('base64');
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;`
    + `src:url(data:font/woff2;base64,${b64}) format('woff2');unicode-range:${range}}`;
}).join('\n');

// The same thing as a <style> element, for a page that has no stylesheet of
// its own to prepend it to.
const FONT_STYLE = `<style>${FONT_CSS}</style>`;

module.exports = { FONT_CSS, FONT_STYLE, FONT_DIR: DIR, FACES };
