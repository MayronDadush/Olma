# assets/

Vendored, not fetched at runtime — the renderer must produce byte-identical
output on any box, and the droplet has no Hebrew font installed (only DejaVu).

## fonts/

[Heebo](https://fonts.google.com/specimen/Heebo), four static weights
(Regular 400 / Medium 500 / Bold 700 / Black 900). SIL Open Font License 1.1.

resvg is given exactly these files with `loadSystemFonts: false`, so a font
installed or removed on the server can never change what a card looks like.

## fonts/web/

[Assistant](https://fonts.google.com/specimen/Assistant) (wght 400–700) and
[Rubik](https://fonts.google.com/specimen/Rubik) (wght 500–700), variable
woff2, Hebrew and Latin subsets only, exactly as fonts.gstatic.com serves them
(2026-09-28). SIL Open Font License 1.1 — `OFL-Assistant.txt`, `OFL-Rubik.txt`.

These are the allma.world pages' fonts, inlined into every page as data: URIs
by `src/adapters/http/fonts.js` so a visitor's browser never asks Google for
them (GDPR: that request hands Google the visitor's IP). Not used by resvg.

## icons/

[Twemoji](https://github.com/jdecked/twemoji) 15.1.0, 72×72 PNG. Graphics are
CC-BY 4.0 (Twitter, Inc. and other contributors).

These are PNGs rather than glyphs because **resvg cannot rasterise colour emoji
from a font** — a `<text>` containing 🎂 renders as nothing at all. Each file is
inlined into the SVG as a data URI at render time.

Filenames are the semantic vocabulary the agent picks from (`birthday`,
`travel`, `money`…), never raw emoji. That indirection is what makes an
unrecognised name fall back to `generic.png` instead of silently drawing
empty space. Adding an icon = dropping a 72×72 PNG here and naming it in
`ICON_NAMES` in `src/domain/schedule-card.js`.
