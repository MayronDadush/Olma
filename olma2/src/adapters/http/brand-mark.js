'use strict';
// The mark, as SVG, in ONE place — the home-screen icon is drawn from it, and
// so is anything else that needs the brand as a picture.
//
// The old speech-bubble globe (`LOGO` in public-pages.js, `#i-logo` in the
// dashboard's sprite) is "not an option" (the owner, 2026-09-26) and is not
// used for anything new. This is "חצי־חצי", the mark the owner liked on
// 2026-09-27: a square split into ink and paper, two discs that each take the
// other side's colour, and a coral lens where they overlap, on the split line.
//
// The FINAL mark and the font pair were still open when this was written (the
// brand lab, https://claude.ai/artifact/LH1pr4k84UDjuPARPv7bGi). So the
// geometry below is the lab's own `split` / `round` drawings, copied exactly
// (viewBox 0 0 120 120), and the palette is the one that was decided: "coral
// on ink", the day system. Changing the mark is this file and nothing else;
// the icons are rendered from it on first request, never committed as PNGs.

// Cypress + Mustard (the owner, 2026-09-28), the same four colours the
// dashboard's own mark reads (--logo-d / --logo-l / --logo-lens). The keys
// kept their old names: `coral` is the lens, whatever colour the lens is.
const PALETTE = Object.freeze({
  ink: '#004643',
  paper: '#F0EDE5',
  coral: '#F9C23C',
});

// `id` keeps clip-path ids unique when several copies share a document.
function lens(id, a, b, fill) {
  return `<clipPath id="${id}"><circle cx="${a[0]}" cy="${a[1]}" r="${a[2]}"/></clipPath>`
    + `<circle cx="${b[0]}" cy="${b[1]}" r="${b[2]}" fill="${fill}" clip-path="url(#${id})"/>`;
}

// The square mark, edge to edge. Its discs reach 14 units from the sides, so
// it is only for a canvas nothing will crop: the iOS icon (Apple rounds the
// corners itself) and the plain `any` icon.
function splitBody(p = PALETTE, id = 'bm') {
  return `<rect width="60" height="120" fill="${p.ink}"/>`
    + `<rect x="60" width="60" height="120" fill="${p.paper}"/>`
    + `<circle cx="42" cy="60" r="28" fill="${p.paper}"/>`
    + `<circle cx="78" cy="60" r="28" fill="${p.ink}"/>`
    + lens(`${id}l`, [42, 60, 28], [78, 60, 28], p.coral);
}

// The same mark drawn for a round frame: smaller discs, set in from the edge.
// Every disc point sits within 40 units of the centre, inside the 48-unit
// circle (40% of the canvas) that Android promises never to cut from a
// MASKABLE icon — so any launcher shape shows the whole of it.
function roundBody(p = PALETTE, id = 'bm') {
  return `<rect width="60" height="120" fill="${p.ink}"/>`
    + `<rect x="60" width="60" height="120" fill="${p.paper}"/>`
    + `<circle cx="44" cy="60" r="24" fill="${p.paper}"/>`
    + `<circle cx="76" cy="60" r="24" fill="${p.ink}"/>`
    + lens(`${id}l`, [44, 60, 24], [76, 60, 24], p.coral);
}

function svg(body, size) {
  const dim = size ? ` width="${size}" height="${size}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"${dim}>${body}</svg>`;
}

// `variant`: 'square' (edge to edge) or 'maskable' (safe for any crop).
function markSvg({ variant = 'square', size, palette = PALETTE, id } = {}) {
  const body = variant === 'maskable' ? roundBody(palette, id) : splitBody(palette, id);
  return svg(body, size);
}

module.exports = { PALETTE, markSvg };
