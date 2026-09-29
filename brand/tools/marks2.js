// Round 2 of the lens mark: each concept returns inner SVG for a 120x120 box (wordmark: 200x100).
// Colours are CSS custom-property friendly: ring = currentColor via {R}, lens via {L}, paper via {P}.
const d2 = (n) => +n.toFixed(2);
const pt = (cx, cy, r, deg) => [d2(cx + r * Math.cos(deg * Math.PI / 180)), d2(cy + r * Math.sin(deg * Math.PI / 180))];

// lens between two points: two arcs of radius R bulging to each side of the chord
function lensPath([x1, y1], [x2, y2], sag) {
  const c = Math.hypot(x2 - x1, y2 - y1), R = d2((sag * sag + (c / 2) ** 2) / (2 * sag));
  return `M${x1} ${y1}A${R} ${R} 0 0 1 ${x2} ${y2}A${R} ${R} 0 0 1 ${x1} ${y1}Z`;
}
// intersection of two discs, filled
let n = 0;
function discAnd(a, b, fill = '{L}') {
  const id = 'k' + (++n);
  return `<clipPath id="${id}"><circle cx="${a[0]}" cy="${a[1]}" r="${a[2]}"/></clipPath><circle cx="${b[0]}" cy="${b[1]}" r="${b[2]}" fill="${fill}" clip-path="url(#${id})"/>`;
}
const ring = (cx, cy, r, sw, extra = '') => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="{R}" stroke-width="${sw}" stroke-linecap="round"${extra}/>`;
function openRing(cx, cy, r, sw, gapDeg, gapAt) {
  const C = 2 * Math.PI * r, g = C * gapDeg / 360;
  return ring(cx, cy, r, sw, ` stroke-dasharray="${d2(C - g)} ${d2(g)}" transform="rotate(${d2(gapAt + gapDeg / 2)} ${cx} ${cy})"`);
}

const M = {};

// ---- A ----
M.a_bowl = () => { // single-storey a: bowl + stem, the lens is where the bowl meets the stem
  return discAnd([52, 66, 27], [88, 66, 27]) + ring(52, 66, 27, 12) + `<path d="M84 34V96" stroke="{R}" stroke-width="12" stroke-linecap="round"/>`;
};
M.A_cap = () => { // capital A, the crossbar is the lens
  const R = 31.4, d = 22.4;
  const id = 'kA' + (++n);
  return `<path d="M26 102L60 20L94 102" fill="none" stroke="{R}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<clipPath id="${id}"><circle cx="60" cy="${70 - d}" r="${R}"/></clipPath><circle cx="60" cy="${70 + d}" r="${R}" fill="{L}" clip-path="url(#${id})"/>`;
};
M._A_rings = () => { // two B4 rings stacked into an A: small ring on top, legs from the big one
  return discAnd([60, 40, 20], [60, 76, 30]) + ring(60, 40, 20, 11) + openRing(60, 76, 30, 11, 110, 90);
};

// ---- ayin ----
M._ayin_rings = () => { // B4 turned into ע: big cup open at the top, small ring as the left arm
  return discAnd([40, 38, 20], [66, 64, 34]) + openRing(66, 64, 34, 12, 100, 225) + ring(40, 38, 20, 12);
};
M.ayin_leaf = () => { // ע: one long ink stroke, and the short arm is the lens that lands on it
  return `<path d="${lensPath([26, 18], [84, 80], 10)}" fill="{L}"/>`
    + `<path d="M88 18V58Q88 100 48 100H28" fill="none" stroke="{R}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>`;
};

// ---- coordination ----
M.meet_point = () => { // B2 rings, no fill: one dot where they meet
  return ring(40, 60, 34, 11) + ring(80, 60, 34, 11) + `<circle cx="60" cy="${d2(60 - Math.sqrt(34 * 34 - 400))}" r="10" fill="{L}"/>`;
};
M.meet_chain = () => { // two rings woven like links, the lens coloured
  const top = d2(60 - Math.sqrt(34 * 34 - 400));
  return discAnd([40, 60, 34], [80, 60, 34]) + ring(80, 60, 34, 11)
    // ring A passes OVER ring B at the top crossing: paper knock-out, then A
    + `<path d="M${pt(40, 60, 34, -60).join(' ')}A34 34 0 0 1 ${pt(40, 60, 34, -20).join(' ')}" fill="none" stroke="{P}" stroke-width="19"/>`
    + ring(40, 60, 34, 11)
    // and UNDER it at the bottom crossing: redraw B over A there
    + `<path d="M${pt(80, 60, 34, 105).join(' ')}A34 34 0 0 1 ${pt(80, 60, 34, 145).join(' ')}" fill="none" stroke="{P}" stroke-width="19"/>`
    + `<path d="M${pt(80, 60, 34, 100).join(' ')}A34 34 0 0 1 ${pt(80, 60, 34, 150).join(' ')}" fill="none" stroke="{R}" stroke-width="11" stroke-linecap="round"/>`;
};
M._meet_sizes = () => { // B4 grown to a room: three sizes, only the shared middle coloured
  const a = [42, 70, 30], b = [76, 70, 26], c = [58, 40, 20], id = 'k3' + (++n);
  return `<clipPath id="${id}a"><circle cx="${a[0]}" cy="${a[1]}" r="${a[2]}"/></clipPath><clipPath id="${id}b"><circle cx="${b[0]}" cy="${b[1]}" r="${b[2]}"/></clipPath>`
    + `<g clip-path="url(#${id}a)"><g clip-path="url(#${id}b)"><circle cx="${c[0]}" cy="${c[1]}" r="${c[2]}" fill="{L}"/></g></g>`
    + ring(...a, 9) + ring(...b, 9) + ring(...c, 9);
};

// ---- tasks ----
M.task_loop = () => { // B5 alone: one open ring, the lens closes the gap
  const cap = 13 / 2 / 36 * 180 / Math.PI, p1 = pt(60, 60, 36, -131 + cap), p2 = pt(60, 60, 36, -45 - cap);
  return openRing(60, 60, 36, 13, 86, -88) + `<path d="${lensPath(p1, p2, 7.5)}" fill="{L}"/>`;
};
M.task_hand = () => { // a ring with a lens for a clock hand: the hour you named
  return ring(60, 60, 38, 12) + `<path d="${lensPath([60, 60], pt(60, 60, 26, -50), 5.5)}" fill="{L}"/>` + `<circle cx="60" cy="60" r="5" fill="{R}"/>`;
};

// ---- wordmark ----
M.word_ll = () => { // allma, the two l's are loops that overlap: the shared part is the lens
  const sw = 8, a = (cx) => ring(cx, 64, 16, sw) + `<path d="M${cx + 16} 46V80" stroke="{R}" stroke-width="${sw}" stroke-linecap="round"/>`;
  const e1 = [64, 44, 12, 34], e2 = [78, 44, 12, 34], id = 'kw' + (++n);
  return a(22)
    + `<ellipse cx="${e1[0]}" cy="${e1[1]}" rx="${e1[2]}" ry="${e1[3]}" fill="none" stroke="{R}" stroke-width="${sw}"/>`
    + `<ellipse cx="${e2[0]}" cy="${e2[1]}" rx="${e2[2]}" ry="${e2[3]}" fill="none" stroke="{R}" stroke-width="${sw}"/>`
    + `<clipPath id="${id}"><ellipse cx="${e1[0]}" cy="${e1[1]}" rx="${e1[2] + 4}" ry="${e1[3] + 4}"/></clipPath><ellipse cx="${e2[0]}" cy="${e2[1]}" rx="${e2[2] + 4}" ry="${e2[3] + 4}" fill="{L}" clip-path="url(#${id})"/>`
    + `<path d="M98 80V60a12 12 0 0 1 24 0V80M122 60a12 12 0 0 1 24 0V80" fill="none" stroke="{R}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`
    + a(166);
};

// ---- the three the owner liked, redrawn at 120 so everything compares ----
M.B2 = () => discAnd([40.8, 60, 32], [79.2, 60, 32]) + ring(40.8, 60, 32, 9.6) + ring(79.2, 60, 32, 9.6);
M.B4 = () => discAnd([31.5, 60, 27], [73.5, 60, 42]) + ring(31.5, 60, 27, 7) + ring(73.5, 60, 42, 7);
M.B5 = () => discAnd([40.8, 60, 32], [79.2, 60, 32]) + openRing(40.8, 60, 32, 8, 64, 225) + openRing(79.2, 60, 32, 8, 64, 45);
const VIEW = { word_ll: '0 0 200 100' };
function svg(key, { R = '#221C3A', L = '#FF8A6B', P = '#F7F1E6' } = {}) {
  const inner = M[key]().replace(/\{R\}/g, R).replace(/\{L\}/g, L).replace(/\{P\}/g, P);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW[key] || '0 0 120 120'}">${inner}</svg>`;
}
module.exports = { M, svg, VIEW };
