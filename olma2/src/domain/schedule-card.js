'use strict';
// A long schedule, rendered as one PNG card instead of a wall of WhatsApp text.
//
// Why an image at all: a real user asked for his schedule and got 17 tasks, 5
// reminders and a run of calendar events as one long message with asterisks and
// divider lines. Every fact in it was correct and none of it was scannable — it
// had to be read, not glanced at. Same content, laid out, is a glance.
//
// Three constraints shaped everything here:
//
//  1. RTL needs an explicit RLM. Without U+200F, a line that opens with a digit
//     ("19 באוג׳") renders with the number flung to the far end — the paragraph
//     direction is decided by the first strong character, and a digit is not
//     one. Every <text> below opens with RLM; do not "clean that up".
//  2. resvg cannot draw colour emoji from a font — a <text> holding 🎂 renders
//     as empty space, silently. Icons are therefore PNGs inlined as data URIs,
//     addressed by semantic name (see assets/README.md).
//  3. There is no text measurement. tw() below estimates advance widths from
//     per-character coefficients calibrated against real rendered ink, so the
//     layout leans on it only where a bad estimate degrades gracefully:
//     column widths (shifts a column) and ellipsis (clips a word early), never
//     a position that could collide with another element.
const fs = require('node:fs');
const path = require('node:path');
const { ok, err } = require('./results');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const FONT_FILES = ['Regular', 'Medium', 'Bold', 'Black']
  .map((w) => path.join(ASSETS, 'fonts', `Heebo-${w}.ttf`));

const RLM = '‏';

// Structural ceilings. Overflow is an ERROR, not a truncation: forty rows in
// one image is unreadable at any size, and the agent's actionable move is to
// narrow the range and render again — silently dropping rows would hand the
// person a schedule that is quietly missing things.
const LIMITS = {
  sections: 8,
  itemsPerSection: 15,
  totalItems: 36,
  stats: 4,
  chips: 6,
  height: 4200,
};

// String ceilings, by contrast, TRUNCATE. An over-long title is cosmetic; the
// card is still correct and still worth sending.
const MAXLEN = {
  title: 40, subtitle: 48, sectionTitle: 48,
  date: 22, text: 88, tag: 22, chip: 22, footer: 64,
};

const ICON_NAMES = new Set(
  fs.readdirSync(path.join(ASSETS, 'icons'))
    .filter((f) => f.endsWith('.png'))
    .map((f) => f.slice(0, -4))
);

const iconCache = new Map();
function iconDataUri(name) {
  const key = ICON_NAMES.has(name) ? name : 'generic';
  if (!iconCache.has(key)) {
    const b64 = fs.readFileSync(path.join(ASSETS, 'icons', `${key}.png`)).toString('base64');
    iconCache.set(key, `data:image/png;base64,${b64}`);
  }
  return iconCache.get(key);
}

// ---------------------------------------------------------------- text utils

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function esc(s) {
  return String(s)
    // Tabs and newlines are legal XML but meaningless inside a single-line
    // <text>; every other control character would break the parse outright.
    .replace(/[\t\n\r]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[&<>"]/g, (c) => XML_ESC[c]);
}

// Width estimate in px, as a multiple of font size. These are MEASURED against
// real rendered ink by scripts/calibrate-card-metrics.js, not guessed — rerun
// it after touching the font, the weights, or any value here.
//
// They sit a little above the measured regular-weight numbers on purpose: the
// card draws dates and headings at weight 800, whose glyphs are wider, and an
// overestimate only ever costs a few px of slack while an underestimate is
// what puts two strings on top of each other.
const WIDTH_HEBREW = 0.545;
const WIDTH_DIGIT = 0.565;
const WIDTH_LATIN = 0.510;
const WIDTH_SPACE = 0.250;
const WIDTH_NARROW = 0.290;
const WIDTH_DASH = 0.600;
const WIDTH_OTHER = 0.500;

function tw(s, size) {
  let units = 0;
  for (const ch of String(s)) {
    if (ch === ' ') units += WIDTH_SPACE;
    else if (ch >= '0' && ch <= '9') units += WIDTH_DIGIT;
    else if (ch >= '֐' && ch <= '׿') units += WIDTH_HEBREW;
    else if (/[a-zA-Z]/.test(ch)) units += WIDTH_LATIN;
    else if ('()[]{}|:,.\'’!/'.includes(ch)) units += WIDTH_NARROW;
    else if (ch === '—' || ch === '–' || ch === '-') units += WIDTH_DASH;
    else if (ch === RLM) units += 0;
    else units += WIDTH_OTHER;
  }
  return units * size;
}

function clip(s, max) {
  const t = String(s).trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

// Shrink to fit a pixel budget. Used where a long line would otherwise run off
// the card edge; character-level so it works the same in Hebrew and Latin.
function ellipsize(s, size, maxWidth) {
  if (tw(s, size) <= maxWidth) return s;
  let out = String(s);
  while (out.length > 1 && tw(out + '…', size) > maxWidth) out = out.slice(0, -1);
  return out.trimEnd() + '…';
}

// ---------------------------------------------------------------- validation

function normalizeCard(input) {
  const c = input || {};
  const sections = Array.isArray(c.sections) ? c.sections : [];
  if (!sections.length) return err('invalid', 'a card needs at least one section');
  if (sections.length > LIMITS.sections) {
    return err('invalid', `too many sections (${sections.length} > ${LIMITS.sections}) — narrow the date range and render again`);
  }

  let total = 0;
  const outSections = [];
  for (const s of sections) {
    const items = Array.isArray(s.items) ? s.items : [];
    if (!items.length) continue; // an empty section is a heading over nothing
    if (items.length > LIMITS.itemsPerSection) {
      return err('invalid', `section "${clip(s.title || '', 20)}" has ${items.length} items (max ${LIMITS.itemsPerSection}) — split it or narrow the range`);
    }
    total += items.length;
    outSections.push({
      title: clip(s.title || '', MAXLEN.sectionTitle),
      items: items.map((it) => ({
        date: clip(it.date || '', MAXLEN.date),
        text: clip(it.text || '', MAXLEN.text),
        icon: ICON_NAMES.has(it.icon) ? it.icon : 'generic',
        tag: it.tag ? clip(it.tag, MAXLEN.tag) : null,
      })),
    });
  }
  if (!outSections.length) return err('invalid', 'every section was empty — nothing to draw');
  if (total > LIMITS.totalItems) {
    return err('invalid', `${total} items is past what one card can show (max ${LIMITS.totalItems}) — narrow the date range and render again`);
  }

  const stats = (Array.isArray(c.stats) ? c.stats : []).slice(0, LIMITS.stats).map((s) => ({
    text: clip(s.text || '', 28),
    icon: ICON_NAMES.has(s.icon) ? s.icon : 'target',
  }));

  const chipsIn = c.big_tasks && Array.isArray(c.big_tasks.chips) ? c.big_tasks.chips : [];
  const bigTasks = chipsIn.length ? {
    title: clip((c.big_tasks.title) || '', MAXLEN.sectionTitle) || 'משימות גדולות בתור',
    chips: chipsIn.slice(0, LIMITS.chips).map((ch) => ({
      text: clip(ch.text || '', MAXLEN.chip),
      icon: ICON_NAMES.has(ch.icon) ? ch.icon : 'generic',
    })),
  } : null;

  return ok({
    title: clip(c.title || '', MAXLEN.title) || 'תמונת מצב',
    subtitle: clip(c.subtitle || '', MAXLEN.subtitle),
    stats, sections: outSections, bigTasks,
    footer: clip(c.footer_note || '', MAXLEN.footer),
  });
}

// ------------------------------------------------------------------- drawing

const W = 1080;
const M = 48;          // page margin
const PAD = 32;        // card inner padding
const ROW_H = 54;
const RAIL_W = 6;      // the coloured spine on each section card

const INK = '#431407';
const INK_SOFT = '#57534E';
const ACCENTS = ['#F59E0B', '#EC4899', '#6366F1', '#0EA5E9', '#10B981'];
const TINTS = ['#FEF3C7', '#FCE7F3', '#E0E7FF', '#E0F2FE', '#D1FAE5'];

function text(x, y, o, s) {
  const anchor = o.anchor || 'end';
  return `<text x="${x}" y="${y}" font-family="Heebo" font-size="${o.size}" font-weight="${o.weight || 400}"`
    + ` fill="${o.fill}" text-anchor="${anchor}" direction="rtl">${RLM}${esc(s)}</text>`;
}

function icon(name, x, y, size) {
  return `<image href="${iconDataUri(name)}" x="${x}" y="${y}" width="${size}" height="${size}"/>`;
}

function roundedCard(x, y, w, h) {
  // Drop shadow first, then the face — resvg has filters but a solid offset
  // rect is a fraction of the cost and reads the same at this scale.
  return `<rect x="${x + 3}" y="${y + 5}" width="${w}" height="${h}" rx="24" fill="#00000014"/>`
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24" fill="#FFFFFF"/>`;
}

function pill(x, y, w, h, fill, stroke) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"`
    + (stroke ? ` stroke="${stroke}" stroke-width="2.5"` : '') + '/>';
}

// Chips laid out right-to-left from `startX`, each sized to its own label:
// [ padRight | icon | gap | label | padLeft ], mirrored for RTL. Written as
// explicit padding rather than one lumped constant so the pill can never come
// out narrower than what it has to contain.
//
// Wraps at `minX`. It has to: the first live card drew four stat pills off the
// left edge of the canvas, clipping the last one to a sliver, because the row
// only ever counted rightwards from startX and nothing checked the far side.
// Returns the height actually consumed so callers advance past every row drawn,
// not just the first.
function chipRow(items, startX, y, h, sizes, colorFor, minX) {
  const { font, icon: iconSize, padRight = 20, gap = 10, padLeft = 22 } = sizes;
  const GAP_X = 16, GAP_Y = 12;
  const parts = [];
  let x = startX, rowTop = y;
  items.forEach((it, i) => {
    const w = padRight + iconSize + gap + tw(it.text, font) + padLeft;
    if (x - w < minX && x !== startX) { // full row behind us; drop to the next
      rowTop += h + GAP_Y;
      x = startX;
    }
    const c = colorFor(i);
    parts.push(pill(x - w, rowTop, w, h, c.fill, c.stroke));
    parts.push(icon(it.icon, x - padRight - iconSize, rowTop + (h - iconSize) / 2, iconSize));
    parts.push(text(x - padRight - iconSize - gap, rowTop + h / 2 + font * 0.36,
      { size: font, weight: 700, fill: c.text }, it.text));
    x -= w + GAP_X;
  });
  return { svg: parts.join('\n'), height: rowTop - y + h };
}

function buildSvg(card) {
  const parts = [];
  let y = 78;

  // ---- header
  parts.push(icon('chart', W - M - 58, y - 47, 58));
  parts.push(text(W - M - 74, y, { size: 52, weight: 900, fill: INK }, card.title));
  if (card.subtitle) {
    y += 42;
    parts.push(text(W - M, y, { size: 28, weight: 500, fill: '#B45309' }, card.subtitle));
  }
  y += 38;

  // ---- stat pills
  if (card.stats.length) {
    const h = 62;
    const row = chipRow(card.stats, W - M, y, h,
      { font: 27, icon: 32, padRight: 22, gap: 12, padLeft: 26 },
      () => ({ fill: '#FFFFFF', stroke: '#F59E0B', text: '#78350F' }), M);
    parts.push(row.svg);
    y += row.height + 34;
  }

  // ---- section cards
  const cardW = W - 2 * M;
  card.sections.forEach((sec, si) => {
    const accent = ACCENTS[si % ACCENTS.length];
    const tint = TINTS[si % TINTS.length];
    const h = 30 + 44 + sec.items.length * ROW_H + 12;
    parts.push(roundedCard(M, y, cardW, h));
    parts.push(`<rect x="${W - M - 10}" y="${y + 18}" width="${RAIL_W}" height="${h - 36}" rx="3" fill="${accent}"/>`);
    parts.push(text(W - M - PAD, y + 52, { size: 30, weight: 800, fill: accent }, sec.title));

    // One date column for the whole section, sized to its longest date, so a
    // width misestimate shifts the column instead of overlapping the text.
    // No safety factor on top: tw() already runs ~12% over real ink at this
    // weight (see scripts/calibrate-card-metrics.js), which IS the margin.
    const dateW = Math.min(200, Math.max(...sec.items.map((it) => tw(it.date, 26))));
    const iconX = W - M - PAD - 34;
    const dateRight = iconX - 14;
    const textRight = dateRight - dateW - 18;

    let ry = y + 70;
    for (const it of sec.items) {
      const mid = ry + ROW_H / 2;
      const tagW = it.tag ? tw(it.tag, 20) + 30 : 0;
      const textLeftLimit = M + PAD - 8 + (it.tag ? tagW + 20 : 0);
      parts.push(icon(it.icon, iconX, mid - 22, 34));
      parts.push(text(dateRight, mid + 5, { size: 26, weight: 800, fill: INK }, it.date));
      parts.push(text(textRight, mid + 5, { size: 26, fill: INK_SOFT },
        ellipsize(it.text, 26, textRight - textLeftLimit)));
      if (it.tag) {
        parts.push(pill(M + PAD - 8, mid - 17, tagW, 34, tint));
        parts.push(text(M + PAD - 8 + tagW / 2, mid + 6,
          { size: 20, weight: 700, fill: accent, anchor: 'middle' }, it.tag));
      }
      ry += ROW_H;
    }
    y += h + 26;
  });

  // ---- big tasks
  // The chips are laid out BEFORE the card behind them, because with wrapping
  // their height is not known until they are placed — and a fixed height here
  // is what would clip a second row.
  if (card.bigTasks) {
    const row = chipRow(card.bigTasks.chips, W - M - PAD, y + 78, 48,
      { font: 24, icon: 26, padRight: 18, gap: 10, padLeft: 22 },
      (i) => ({ fill: TINTS[i % TINTS.length], text: '#44403C' }), M + PAD);
    const h = 30 + 44 + row.height + 12;
    parts.push(roundedCard(M, y, cardW, h));
    parts.push(`<rect x="${W - M - 10}" y="${y + 18}" width="${RAIL_W}" height="${h - 36}" rx="3" fill="#10B981"/>`);
    parts.push(text(W - M - PAD, y + 52, { size: 30, weight: 800, fill: '#10B981' }, card.bigTasks.title));
    parts.push(row.svg);
    y += h + 30;
  }

  if (card.footer) {
    parts.push(text(W / 2, y + 14, { size: 21, weight: 500, fill: '#B45309', anchor: 'middle' }, card.footer));
    y += 20;
  }
  const H = Math.round(y + 34);

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#FFF8EF"/><stop offset="1" stop-color="#FFE8CC"/>
</linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
${parts.join('\n')}
</svg>`,
    width: W,
    height: H,
  };
}

// --------------------------------------------------------------- rasterising

// Required lazily so that importing this module (registry.js does, on every
// brokerd boot) never depends on the native binary being installed — the tests
// that only exercise validation and SVG shape run without it.
function loadResvg() {
  return require('@resvg/resvg-js').Resvg;
}

// Synchronous: resvg-js exposes no async render, so brokerd's event loop is
// blocked for the whole call and every other user's tool calls wait behind it.
// Measured on the live droplet's single core: 57ms for 3 items, 104ms for 12,
// 156ms for 24. That is what LIMITS.totalItems is really protecting — the
// ceiling on items is a ceiling on how long everyone else is stalled.
function renderPng(input) {
  const norm = normalizeCard(input);
  if (!norm.ok) return norm;
  const { svg, width, height } = buildSvg(norm.data);
  if (height > LIMITS.height) {
    return err('invalid', `card would be ${height}px tall (max ${LIMITS.height}) — fewer items per card`);
  }
  const Resvg = loadResvg();
  const png = new Resvg(svg, {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Heebo' },
  }).render().asPng();
  return ok({ png, width, height });
}

module.exports = {
  normalizeCard, buildSvg, renderPng, tw, ellipsize,
  LIMITS, ICON_NAMES, W,
};
