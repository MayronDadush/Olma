'use strict';
// The day as one picture to share: what was on the plates, never a calorie.
// People share plates, not numbers, and a card with a number on it is one a
// person thinks twice about forwarding.
//
// Drawn as SVG here and rasterised by brokerd (olma2 `pack_card`), which owns
// the fonts and the person's workspace, where the gateway attaches media from.
// The same rules as olma2's schedule-card.js, for the same renderer (resvg):
// every <text> opens with an RLM so a line starting with a digit stays right
// (and carries no `direction`: resvg draws the same without it, and a browser
// previewing the SVG on the page would flip the anchor with it),
// no emoji (resvg draws them as nothing), and the brand mark as shapes.
const N = require('./nutrition');
const D = require('./days');

const W = 1080;
const M = 64;
const CYPRESS = '#004643', SAND = '#F0EDE5', MUSTARD = '#F9C23C', INK = '#0E1F1E', INK2 = '#56615E';
const DOT = { protein: '#009488', veg: '#5E9E4A', grain: '#C98A0E' };
const FONT = 'IBM Plex Sans Hebrew';
const RLM = '‏';
const MAX_MEALS = 6;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// No emoji and no other symbol resvg cannot draw: letters, digits, punctuation.
const plain = s => String(s).replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const text = (x, y, { size, weight = 400, fill = INK, anchor = 'end' }, s) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${RLM}${esc(s)}</text>`;

function mark(x, y, size) {
  const k = size / 120;
  return `<g transform="translate(${x} ${y}) scale(${k})"><defs><clipPath id="mk-c"><circle cx="60" cy="60" r="60"/></clipPath><clipPath id="mk-a"><circle cx="44" cy="60" r="24"/></clipPath></defs>`
    + `<g clip-path="url(#mk-c)"><rect width="60" height="120" fill="${CYPRESS}"/><rect x="60" width="60" height="120" fill="${SAND}"/>`
    + `<circle cx="44" cy="60" r="24" fill="${SAND}"/><circle cx="76" cy="60" r="24" fill="${CYPRESS}"/><circle cx="76" cy="60" r="24" fill="${MUSTARD}" clip-path="url(#mk-a)"/></g>`
    + `<circle cx="60" cy="60" r="58.25" fill="none" stroke="${SAND}" stroke-width="3.5"/></g>`;
}

// `view` is store.dayView's answer for the day.
function buildSvg(view) {
  const meals = view.meals.slice(0, MAX_MEALS);
  const more = view.meals.length - meals.length;
  const parts = [];
  const top = 220;
  const row = 132;
  const listH = Math.max(1, meals.length) * row + (more > 0 ? 60 : 0);
  const H = top + listH + 300;

  parts.push(`<rect width="${W}" height="${H}" fill="${SAND}"/>`);
  parts.push(`<rect width="${W}" height="176" fill="${CYPRESS}"/><rect y="176" width="${W}" height="8" fill="${MUSTARD}"/>`);
  parts.push(mark(M, 52, 76));
  parts.push(text(W - M, 92, { size: 54, weight: 700, fill: SAND }, `הצלחת של ${D.HE_DAYS[D.weekday(view.day)]}`));
  parts.push(text(W - M, 140, { size: 30, weight: 500, fill: '#BFD3CF' }, view.date_he.replace(/^יום \S+, /, '')));

  let y = top;
  if (!meals.length) parts.push(text(W / 2, y + 70, { size: 34, fill: INK2, anchor: 'middle' }, 'עוד לא נרשמה ארוחה היום'));
  for (const m of meals) {
    parts.push(`<rect x="${M}" y="${y}" width="${W - 2 * M}" height="${row - 20}" rx="26" fill="#FFFFFF"/>`);
    parts.push(text(W - M - 36, y + 46, { size: 26, weight: 500, fill: INK2 }, m.slot_he));
    parts.push(text(W - M - 36, y + 88, { size: 36, weight: 600 }, clip(plain(m.title), 30)));
    // The plate's balance, as three dots on the left: filled when it had it.
    ['grain', 'veg', 'protein'].forEach((b, i) => {
      const cx = M + 52 + i * 46, cy = y + (row - 20) / 2;
      parts.push(m.balance.includes(b)
        ? `<circle cx="${cx}" cy="${cy}" r="15" fill="${DOT[b]}"/>`
        : `<circle cx="${cx}" cy="${cy}" r="13.5" fill="none" stroke="#D2CFC5" stroke-width="3"/>`);
    });
    y += row;
  }
  if (more > 0) { parts.push(text(W - M - 36, y + 34, { size: 30, fill: INK2 }, `ועוד ${more}`)); y += 60; }

  const veg = view.meals.filter(m => m.balance.includes('veg')).length;
  y += 40;
  parts.push(text(W / 2, y + 30, { size: 38, weight: 700, anchor: 'middle' }, `${view.meals.length} ארוחות · ירקות ב-${veg} · ${view.water_ml >= 1000 ? `${Math.round(view.water_ml / 100) / 10} ליטר` : `${view.water_ml || 0} מ״ל`} מים`));
  // The legend, so three dots mean something to whoever it was forwarded to.
  const leg = [['protein', N.BALANCE_HE.protein], ['veg', N.BALANCE_HE.veg], ['grain', N.BALANCE_HE.grain]];
  let lx = W / 2 + 250;
  for (const [b, he] of leg) {
    parts.push(`<circle cx="${lx}" cy="${y + 92}" r="11" fill="${DOT[b]}"/>`);
    parts.push(text(lx - 22, y + 101, { size: 26, fill: INK2 }, he));
    lx -= 230;
  }
  if (view.challenge) parts.push(text(W / 2, y + 168, { size: 28, fill: INK2, anchor: 'middle' }, `${view.challenge.he}: ${view.challenge.score} מתוך 7 השבוע`));

  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`, width: W, height: H };
}

// The words under the picture, in the same message, so a forward carries the
// way in: their own invite link when brokerd has one for them.
function caption(link) {
  return link ? `הצלחת שלי היום, מעולמה.\nרוצה גם? כתבו לעולמה:\n${link}` : 'הצלחת שלי היום, מעולמה.';
}

// The week as one picture: its plates, photographed ones first, and three
// counts that carry no calorie (the owner's pick, 2026-10-08). `week` is
// { from, to, meals, water_ml: [per day], challenge }, and `photoOf(meal)`
// answers { mime, body } or null; a plate with no photo is drawn as its name.
const TILES = 9;
function buildWeekSvg(week, photoOf) {
  const plates = week.meals.filter(m => !m.rough);
  const shown = [...plates.filter(m => m.photo).reverse(), ...plates.filter(m => !m.photo).reverse()].slice(0, TILES);
  const more = plates.length - shown.length;
  const cols = 3, gap = 24, tile = Math.floor((W - 2 * M - gap * (cols - 1)) / cols);
  const rows = Math.max(1, Math.ceil(shown.length / cols));
  const top = 230;
  const H = top + rows * (tile + gap) + (more > 0 ? 50 : 0) + 260;
  const parts = [`<rect width="${W}" height="${H}" fill="${SAND}"/>`,
    `<rect width="${W}" height="176" fill="${CYPRESS}"/><rect y="176" width="${W}" height="8" fill="${MUSTARD}"/>`, mark(M, 52, 76),
    text(W - M, 92, { size: 54, weight: 700, fill: SAND }, 'השבוע שלי'),
    text(W - M, 140, { size: 30, weight: 500, fill: '#BFD3CF' }, `${Number(week.from.slice(8))}-${D.heDate(week.to).replace(/^יום \S+, /, '')}`)];
  const defs = [];
  if (!shown.length) parts.push(text(W / 2, top + tile / 2, { size: 34, fill: INK2, anchor: 'middle' }, 'השבוע עוד לא נרשמה ארוחה'));
  shown.forEach((m, i) => {
    // Right to left, like the page: the first plate in the top right corner.
    const x = W - M - tile - (i % cols) * (tile + gap), y = top + Math.floor(i / cols) * (tile + gap);
    const ph = m.photo ? photoOf(m) : null;
    if (ph) {
      defs.push(`<clipPath id="t${i}"><rect x="${x}" y="${y}" width="${tile}" height="${tile}" rx="28"/></clipPath>`);
      parts.push(`<image x="${x}" y="${y}" width="${tile}" height="${tile}" preserveAspectRatio="xMidYMid slice" clip-path="url(#t${i})" href="data:${ph.mime};base64,${ph.body.toString('base64')}"/>`);
    } else {
      parts.push(`<rect x="${x}" y="${y}" width="${tile}" height="${tile}" rx="28" fill="#FFFFFF"/>`);
      parts.push(text(x + tile - 28, y + 60, { size: 24, weight: 500, fill: INK2 }, D.HE_DAYS[D.weekday(m.day)]));
      parts.push(text(x + tile - 28, y + 104, { size: 32, weight: 600 }, clip(plain(m.title), 14)));
      ['grain', 'veg', 'protein'].forEach((b, k) => { if (m.balance.includes(b)) parts.push(`<circle cx="${x + 40 + k * 34}" cy="${y + tile - 40}" r="11" fill="${DOT[b]}"/>`); });
    }
  });
  let y = top + rows * (tile + gap);
  if (more > 0) { parts.push(text(W - M, y + 20, { size: 28, fill: INK2 }, `ועוד ${more} צלחות`)); y += 50; }
  const days = new Set(plates.map(m => m.day)).size;
  const veg = plates.filter(m => m.balance.includes('veg')).length;
  const water = week.water_ml.filter(Boolean);
  const avg = water.length ? water.reduce((a, b) => a + b, 0) / water.length : 0;
  parts.push(text(W / 2, y + 50, { size: 38, weight: 700, anchor: 'middle' }, `${days} ימים · ${plates.length} צלחות · ירקות ב-${veg}`));
  if (avg) parts.push(text(W / 2, y + 104, { size: 30, fill: INK2, anchor: 'middle' }, `בממוצע ${avg >= 1000 ? `${Math.round(avg / 100) / 10} ליטר` : `${Math.round(avg / 50) * 50} מ״ל`} מים ביום`));
  if (week.challenge) parts.push(text(W / 2, y + 156, { size: 28, fill: INK2, anchor: 'middle' }, `${week.challenge.he}: ${week.challenge.score} מתוך 7`));
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs.join('')}</defs>${parts.join('')}</svg>`, width: W, height: H };
}

module.exports = { buildSvg, buildWeekSvg, caption, MAX_MEALS, TILES };
