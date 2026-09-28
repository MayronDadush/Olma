# assets/

Vendored, not fetched at runtime — the renderer must produce byte-identical
output on any box, and the droplet has no Hebrew font installed (only DejaVu).

## fonts/

[IBM Plex Sans Hebrew](https://fonts.google.com/specimen/IBM+Plex+Sans+Hebrew),
the brand face since 2026-09-28 (it replaced Heebo), four static weights
(Regular 400 / Medium 500 / SemiBold 600 / Bold 700). SIL Open Font License 1.1,
text in `IBMPlexSansHebrew-OFL.txt`. It carries Latin as well, so one family
draws both languages. Nothing heavier than 700 exists, so the card never asks
for it.

resvg is given exactly these files with `loadSystemFonts: false`, so a font
installed or removed on the server can never change what a card looks like.

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
