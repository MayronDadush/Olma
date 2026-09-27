"""Builds the Allma brand kit: colour files, sky backgrounds, grain, overprint shapes, safe-zone guides."""
import json, os, struct
import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), 'allma-brand-kit')
rng = np.random.default_rng(20260926)

def hexrgb(h):
    h = h.lstrip('#'); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

# ---- palette -------------------------------------------------------------
CORE = [
    ('Ink', 'דיו', '#221C3A', 'All text on light grounds'),
    ('Paper', 'נייר', '#F7F1E6', 'Neutral ground, outside the clock'),
    ('Moonlight', 'אור ירח', '#EDEAFB', 'Text on night and Shabbat'),
    ('Lilac', 'לילך', '#B9AEFF', 'Secondary text on dark, 8.4:1'),
]
INKS = [
    ('Coral', 'אלמוג', '#FF8A6B', 'Overprint ink A, large shapes only'),
    ('Violet', 'סגול', '#7C6CF2', 'Overprint ink B, large shapes only'),
    ('Meeting', 'מפגש', '#7C3A66', 'Where Coral and Violet overlap, for flat use'),
]
SLOTS = [  # key, en, he, bottom(g1), top(g2), light, light-alpha, light pos, dark?
    ('morning', 'Morning', 'בוקר', '#FFE6CF', '#FFF4E8', '#FFD0A8', .80, (.92, .00), False, '07:00-11:00'),
    ('day', 'Day', 'יום', '#E4ECF7', '#F5F8FC', '#CFDDF2', .80, (.50, .00), False, '11:00-17:00'),
    ('evening', 'Evening', 'ערב', '#EFD3E0', '#F8EAF0', '#E3B9D8', .80, (.10, 1.0), False, '17:00-21:00'),
    ('night', 'Night', 'לילה', '#1C1A38', '#2A2752', '#3A3470', .33, (.85, .08), True, '21:00-07:00'),
    ('shabbat', 'Shabbat', 'שבת', '#2B1F3F', '#3A2A4E', '#F2C46D', .33, (.85, .08), True, 'candles to havdalah'),
]
FORMATS = [('16x9', 1920, 1080), ('9x16', 1080, 1920), ('1x1', 1080, 1080)]

def swatches():
    rows = []
    for en, he, h, use in CORE: rows.append(('Core', en, he, h, use))
    for k, en, he, g1, g2, li, a, p, d, when in SLOTS:
        rows.append((en, f'{en} ground', f'{he} · רקע', g1, f'{when} · bottom of the sky'))
        rows.append((en, f'{en} sky', f'{he} · שמיים', g2, 'top of the sky'))
        rows.append((en, f'{en} light', f'{he} · אור', li, f'soft light, {int(a*100)}% at the centre'))
    for en, he, h, use in INKS: rows.append(('Overprint', en, he, h, use))
    return rows

def write_ase(path, rows):
    blocks = []
    def name_bytes(s):
        s = s + '\0'; return struct.pack('>H', len(s)) + s.encode('utf-16-be')
    groups = {}
    for g, en, he, h, use in rows: groups.setdefault(g, []).append((en, h))
    for g, items in groups.items():
        nb = name_bytes('Allma ' + g)
        blocks.append(struct.pack('>HI', 0xC001, len(nb)) + nb)
        for en, h in items:
            r, gg, b = (c / 255 for c in hexrgb(h))
            body = name_bytes(en) + b'RGB ' + struct.pack('>fffH', r, gg, b, 2)
            blocks.append(struct.pack('>HI', 0x0001, len(body)) + body)
        blocks.append(struct.pack('>HI', 0xC002, 0))
    with open(path, 'wb') as f:
        f.write(b'ASEF' + struct.pack('>HHI', 1, 0, len(blocks)) + b''.join(blocks))

# ---- images --------------------------------------------------------------
def grain(h, w, sigma):
    return rng.normal(0, sigma, (h, w)).astype(np.float32)

def sky(w, h, s, sigma=None):
    k, en, he, g1, g2, li, a, (fx, fy), dark, when = s
    t = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
    top, bot = np.array(hexrgb(g2), np.float32), np.array(hexrgb(g1), np.float32)
    img = top * (1 - t) + bot * t
    img = np.broadcast_to(img, (h, w, 3)).copy()
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    sx, sy = (0.42, 0.42 * w / h) if k == 'shabbat' else (0.9, 0.8)  # a candle is a point of light, not a wash
    if k == 'shabbat': a = 0.55
    d = np.sqrt(((xs - fx * w) / (sx * w)) ** 2 + ((ys - fy * h) / (sy * h)) ** 2)
    m = np.clip(1 - d / 0.7, 0, 1)
    m = (m * m * (3 - 2 * m)) * a  # smoothstep, so the light has no visible edge
    img = img * (1 - m[..., None]) + np.array(hexrgb(li), np.float32) * m[..., None]
    img += grain(h, w, sigma if sigma is not None else (2.0 if dark else 2.6))[..., None]
    return Image.fromarray(np.clip(np.rint(img), 0, 255).astype(np.uint8), 'RGB')

def grain_overlay(w, h, sigma=14):
    g = 128 + grain(h, w, sigma)
    return Image.fromarray(np.clip(np.rint(g), 0, 255).astype(np.uint8), 'L')

def riso_disc(size, color, alpha=1.0):
    """A flat disc whose edge and body carry a little grain, like a riso print."""
    h = w = size
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    r = size / 2 - 2
    d = np.sqrt((xs - w / 2 + .5) ** 2 + (ys - h / 2 + .5) ** 2)
    edge = np.clip(r - d + 0.5, 0, 1)
    speck = np.clip(1 - np.abs(grain(h, w, 0.10)), 0.72, 1)
    a = edge * speck * alpha
    rgb = np.broadcast_to(np.array(hexrgb(color), np.uint8), (h, w, 3))
    return Image.fromarray(np.dstack([rgb, np.rint(a * 255).astype(np.uint8)]), 'RGBA')

def meeting_pair(size=1600):
    """Two overprinted discs, multiplied, on transparency: usable without a blend mode."""
    w, h = int(size * 1.56), size
    c = riso_disc(size, '#FF8A6B'); v = riso_disc(size, '#7C6CF2')
    ca = np.zeros((h, w, 4), np.float32); va = np.zeros((h, w, 4), np.float32)
    ca[:, w - size:] = np.asarray(c, np.float32) / 255
    va[:, :size] = np.asarray(v, np.float32) / 255
    a1, a2 = ca[..., 3:], va[..., 3:]
    # multiply where both are present, each alone elsewhere
    both = a1 * a2
    rgb = ca[..., :3] * a1 * (1 - a2) + va[..., :3] * a2 * (1 - a1) + (ca[..., :3] * va[..., :3]) * both
    a = a1 + a2 - both
    rgb = np.where(a > 0, rgb / np.maximum(a, 1e-6), 0)
    out = np.dstack([rgb, a])
    return Image.fromarray(np.rint(out * 255).astype(np.uint8), 'RGBA')

def font(sz):
    for p in ('/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf'):
        if os.path.exists(p): return ImageFont.truetype(p, sz)
    return ImageFont.load_default()

def safe_916():
    W, H = 1080, 1920
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    red = (255, 70, 70, 70)
    top, bot, right, left = 250, 380, 130, 60
    d.rectangle([0, 0, W, top], fill=red); d.rectangle([0, H - bot, W, H], fill=red)
    d.rectangle([W - right, top, W, H - bot], fill=red); d.rectangle([0, top, left, H - bot], fill=red)
    d.rectangle([left, top, W - right, H - bot], outline=(255, 70, 70, 230), width=3)
    f = font(30)
    d.text((W / 2, top / 2), 'platform header', fill=(255, 255, 255, 230), font=f, anchor='mm')
    d.text((W / 2, H - bot / 2), 'caption, username, audio', fill=(255, 255, 255, 230), font=f, anchor='mm')
    d.text((W - right / 2, H / 2), 'buttons', fill=(255, 255, 255, 230), font=f, anchor='mm')
    return im

def safe_169():
    W, H = 1920, 1080
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    for frac, col, label in ((.9, (255, 170, 60, 220), 'action safe 90%'), (.8, (255, 70, 70, 230), 'title safe 80%')):
        mx, my = W * (1 - frac) / 2, H * (1 - frac) / 2
        d.rectangle([mx, my, W - mx, H - my], outline=col, width=3)
        d.text((mx + 14, my + 10), label, fill=col, font=font(26))
    d.line([W / 2 - 20, H / 2, W / 2 + 20, H / 2], fill=(255, 70, 70, 200), width=2)
    d.line([W / 2, H / 2 - 20, W / 2, H / 2 + 20], fill=(255, 70, 70, 200), width=2)
    return im

def palette_sheet(rows):
    W, pad, sw, cols = 2400, 80, 260, 6
    groups = []
    for r in rows:
        if not groups or groups[-1][0] != r[0]: groups.append((r[0], []))
        groups[-1][1].append(r)
    H = pad * 2 + sum(90 + ((len(g[1]) + cols - 1) // cols) * (sw + 110) for g in groups)
    im = Image.new('RGB', (W, H), hexrgb('#F7F1E6')); d = ImageDraw.Draw(im)
    y = pad; ink = hexrgb('#221C3A')
    for g, items in groups:
        d.text((pad, y), g.upper(), fill=ink, font=font(40)); y += 90
        for i, (_, en, he, h, use) in enumerate(items):
            cx = pad + (i % cols) * ((W - 2 * pad) // cols)
            cy = y + (i // cols) * (sw + 110)
            d.rounded_rectangle([cx, cy, cx + sw, cy + sw * .62], radius=22, fill=hexrgb(h), outline=(214, 206, 196), width=2)
            d.text((cx, cy + sw * .62 + 18), en, fill=ink, font=font(30))
            d.text((cx, cy + sw * .62 + 58), h, fill=(95, 88, 115), font=font(26))
        y += ((len(items) + cols - 1) // cols) * (sw + 110)
    return im

def main():
    for sub in ('colors', 'backgrounds', 'textures', 'shapes', 'guides'):
        os.makedirs(os.path.join(OUT, sub), exist_ok=True)
    rows = swatches()
    write_ase(os.path.join(OUT, 'colors', 'allma-colors.ase'), rows)
    tokens = {'color': {}}
    for g, en, he, h, use in rows:
        tokens['color'].setdefault(g.lower(), {})[en.lower().replace(' ', '-')] = {'value': h, 'type': 'color', 'description': f'{he} · {use}'}
    json.dump(tokens, open(os.path.join(OUT, 'colors', 'allma-tokens.json'), 'w'), ensure_ascii=False, indent=2)
    with open(os.path.join(OUT, 'colors', 'allma-colors.css'), 'w') as f:
        f.write(':root{\n' + ''.join(f'  --allma-{en.lower().replace(" ", "-")}: {h}; /* {he} */\n' for g, en, he, h, use in rows) + '}\n')
    with open(os.path.join(OUT, 'colors', 'allma-colors.txt'), 'w') as f:
        for g, en, he, h, use in rows:
            r, gg, b = hexrgb(h); f.write(f'{g:10} {en:16} {h}  rgb({r},{gg},{b})  {he} · {use}\n')
    palette_sheet(rows).save(os.path.join(OUT, 'colors', 'allma-palette.png'), optimize=True)

    for s in SLOTS:
        for fk, w, h in FORMATS:
            sky(w, h, s).save(os.path.join(OUT, 'backgrounds', f'{s[0]}-{fk}.png'), optimize=True)
        print('sky', s[0])

    grain_overlay(1920, 1080).save(os.path.join(OUT, 'textures', 'grain-overlay-16x9.png'), optimize=True)
    grain_overlay(1080, 1920).save(os.path.join(OUT, 'textures', 'grain-overlay-9x16.png'), optimize=True)
    grain_overlay(1024, 1024).save(os.path.join(OUT, 'textures', 'grain-tile-1024.png'), optimize=True)

    riso_disc(1200, '#FF8A6B').save(os.path.join(OUT, 'shapes', 'disc-coral.png'), optimize=True)
    riso_disc(1200, '#7C6CF2').save(os.path.join(OUT, 'shapes', 'disc-violet.png'), optimize=True)
    riso_disc(1200, '#F2C46D').save(os.path.join(OUT, 'shapes', 'disc-candle.png'), optimize=True)
    meeting_pair(1200).save(os.path.join(OUT, 'shapes', 'meeting-pair.png'), optimize=True)

    safe_916().save(os.path.join(OUT, 'guides', 'safe-zones-9x16.png'), optimize=True)
    safe_169().save(os.path.join(OUT, 'guides', 'safe-zones-16x9.png'), optimize=True)

if __name__ == '__main__':
    main()
