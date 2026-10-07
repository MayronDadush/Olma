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
  parts.push(text(W / 2, y + 30, { size: 38, weight: 700, anchor: 'middle' }, `${view.meals.length} ארוחות · ירקות ב-${veg} · ${view.water} כוסות מים`));
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

module.exports = { buildSvg, caption, MAX_MEALS };
