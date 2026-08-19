#!/usr/bin/env node
'use strict';
// Measures what schedule-card.js's tw() only estimates.
//
// resvg exposes no text-measurement API to the layout code, but it DOES expose
// getBBox() on a parsed tree — so the coefficients in tw() can be measured once,
// here, instead of guessed. Run this after changing the font, the weights, or
// any WIDTH_* constant:
//
//   node olma2/scripts/calibrate-card-metrics.js
//
// It prints the measured coefficient per character class, then checks the
// estimator against real card strings and reports the worst error. tw() is
// only ever used where an underestimate degrades gracefully (column sizing,
// ellipsis), so the bar is "within a few percent", not "exact".
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const { tw } = require('../src/domain/schedule-card');

const ASSETS = path.join(__dirname, '..', 'assets');
const FONT_FILES = ['Regular', 'Medium', 'Bold', 'Black']
  .map((w) => path.join(ASSETS, 'fonts', `Heebo-${w}.ttf`));

const SIZE = 100; // large, so quantisation is a rounding error

function measure(str, { weight = 400 } = {}) {
  const esc = str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="400">`
    + `<text x="100" y="200" font-family="Heebo" font-size="${SIZE}" font-weight="${weight}"`
    + ` direction="rtl">‏${esc}</text></svg>`;
  const bbox = new Resvg(svg, {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Heebo' },
  }).getBBox();
  return bbox ? bbox.width : 0;
}

// Repeat each class so per-glyph side bearings average out instead of
// dominating the way they would in a one-character sample.
const CLASSES = [
  ['WIDTH_HEBREW', 'אבגדהוזחטיכלמנסעפצקרשת'.repeat(3)],
  ['WIDTH_DIGIT', '0123456789'.repeat(6)],
  ['WIDTH_LATIN', 'abcdefghijklmnopqrstuvwxyz'.repeat(2)],
  ['WIDTH_NARROW', '()[]{}|:,.\'!/'.repeat(4)],
  ['WIDTH_DASH', '—–-'.repeat(10)],
];

console.log('measured coefficients (px per font-size unit, per character):\n');
for (const [name, sample] of CLASSES) {
  const n = [...sample].length;
  const coeff = measure(sample) / (n * SIZE);
  console.log(`  ${name.padEnd(14)} ${coeff.toFixed(3)}   (${n} chars)`);
}

// Space has no ink, so it cannot be measured directly — bracket it instead.
const withSpaces = measure('א א א א א א א א א א');
const withoutSpaces = measure('אאאאאאאאאא');
console.log(`  ${'WIDTH_SPACE'.padEnd(14)} ${((withSpaces - withoutSpaces) / (9 * SIZE)).toFixed(3)}   (by difference)`);

const SAMPLES = [
  'יום הולדת רועי מורן',
  'פגישה אצל אביב זוזוט (17:30, הוד השרון)',
  'קפריסין חיימי',
  'העברות + סיבוב bit',
  'לסגור מלון וספא בירושלים',
  'משכורת + להעביר ועד בית (11:00)',
  '9–14 בספט׳',
  '19 באוג׳',
  'משימות גדולות בתור',
  'תמונת מצב',
];

console.log('\nestimator vs measured ink, at the sizes the card actually uses:\n');
let worst = 0;
for (const s of SAMPLES) {
  for (const [size, weight] of [[26, 400], [26, 800], [30, 800]]) {
    const real = measure(s, { weight }) * (size / SIZE);
    const est = tw(s, size);
    const errPct = ((est - real) / real) * 100;
    if (Math.abs(errPct) > Math.abs(worst)) worst = errPct;
    if (Math.abs(errPct) > 8) {
      console.log(`  ${errPct > 0 ? '+' : ''}${errPct.toFixed(1)}%  ${size}/${weight}  "${s}"`);
    }
  }
}
console.log(`\nworst error: ${worst > 0 ? '+' : ''}${worst.toFixed(1)}% `
  + `(positive = tw() overestimates, which is the safe direction)`);
