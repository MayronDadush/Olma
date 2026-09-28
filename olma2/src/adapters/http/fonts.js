'use strict';
// The two typefaces allma.world draws in, served from allma.world itself.
//
// Until 2026-09-28 every public page and the personal dashboard linked
// fonts.googleapis.com, which means every visitor's browser told Google its IP
// address before it could draw a letter — a transfer of personal data to a
// third party that nobody consented to and nothing required (LG München I,
// 3 O 17493/20, fined a site for exactly this; finding 13 of the 2026-09-28
// compliance review). The fonts are SIL OFL, so we may carry them ourselves.
//
// Inlined as data: URIs rather than served from a `/fonts/` route because
// allma.world is an ALLOWLIST in Caddy (.claude/rules/dashboard-and-domains.md):
// a new route 404s there until the Caddyfile learns it, and the Caddyfile is
// not in this repo. Inlining needs no Caddy change and no deploy ordering, and
// the CSP already allows `font-src data:`. The price is size: four variable
// woff2 files, Hebrew and Latin subsets only (the only scripts any page here
// is written in), ~74KB on disk and ~99KB as base64 on every page. Measured
// against a 724KB dashboard, that was judged cheaper than a Caddy prerequisite.
// If a third family or a third script ever joins, revisit — a route with long
// cache headers is the other answer, and it needs Caddy FIRST.
//
// The unicode-range lines are Google's own for these subsets, copied from the
// css2 API response, so a browser still skips the Latin file on a Hebrew-only
// page it has not rendered any Latin on. Both families are VARIABLE fonts, so
// the odd weights the dashboard uses (550, 650) are real, not synthesised.
//
// Read once at require time: the files never change while the process runs,
// and a missing file should fail the boot, loudly, rather than a page later.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts', 'web');

const HEBREW = 'U+0307-0308, U+0590-05FF, U+200C-2010, U+20AA, U+25CC, U+FB1D-FB4F';
const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, '
  + 'U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

// [family, weight range, file, unicode-range]
const FACES = [
  ['Assistant', '400 700', 'Assistant-hebrew.woff2', HEBREW],
  ['Assistant', '400 700', 'Assistant-latin.woff2', LATIN],
  ['Rubik', '500 700', 'Rubik-hebrew.woff2', HEBREW],
  ['Rubik', '500 700', 'Rubik-latin.woff2', LATIN],
];

const FONT_CSS = FACES.map(([family, weight, file, range]) => {
  const b64 = fs.readFileSync(path.join(DIR, file)).toString('base64');
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;`
    + `src:url(data:font/woff2;base64,${b64}) format('woff2');unicode-range:${range}}`;
}).join('\n');

// The same thing as a <style> element, for a page that has no stylesheet of
// its own to prepend it to.
const FONT_STYLE = `<style>${FONT_CSS}</style>`;

module.exports = { FONT_CSS, FONT_STYLE, FONT_DIR: DIR };
