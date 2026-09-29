// The four motion options for the Allma mark, as pure functions of time.
// frame(option, ms, colours) returns the mark's SVG at that instant, so the same
// code plays live in the brand book and renders frame-exact video in render.js.
// Geometry is the round mark: viewBox 120, halves at x=60, circles r24 at 44/76.
(function (root) {
  const EASE = bezier(0.22, 1, 0.36, 1); // the brand curve: a long, soft landing, never a bounce
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const seg = (ms, from, to) => clamp((ms - from) / (to - from));

  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = (t) => ((ax * t + bx) * t + cx) * t, Y = (t) => ((ay * t + by) * t + cy) * t;
    return (x) => {
      if (x <= 0) return 0; if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) { const d = (3 * ax * t + 2 * bx) * t + cx; if (Math.abs(d) < 1e-6) break; t -= (X(t) - x) / d; }
      return Y(clamp(t));
    };
  }
  const hex = (h) => h.slice(1).match(/../g).map((x) => parseInt(x, 16));
  const mix = (a, b, t) => '#' + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');

  const OPTIONS = {
    meet:  { he: 'המפגש', ms: 1100 },
    close: { he: 'הסגירה', ms: 1500 },
    light: { he: 'נדלק', ms: 450 },
    rise:  { he: 'זריחה', ms: 900 },
  };

  // s: dx (the two circles apart; the halves behind them never move), ring (0..1 drawn), fill (mark opacity), lens (lens colour),
  // lensA (lens opacity), reveal (0..1 bottom-up), dot {y, r, a}, scale.
  function draw(s, c, id) {
    const dx = s.dx || 0, h = Math.sqrt(24 * 24 - ((32 + 2 * dx) / 2) ** 2) || 0;
    const top = 60 - h, bottom = 60 + h, revealY = bottom - (s.reveal ?? 1) * (bottom - top);
    const circ = 2 * Math.PI * 58.25, ring = s.ring ?? 1;
    const lensShown = 32 + 2 * dx < 48 && (s.lensA ?? 1) > 0;
    return `<svg viewBox="0 0 120 120" aria-hidden="true" style="display:block;width:100%;height:100%;overflow:visible">
<defs><clipPath id="${id}c"><circle cx="60" cy="60" r="60"/></clipPath><clipPath id="${id}a"><circle cx="${44 - dx}" cy="60" r="24"/></clipPath><clipPath id="${id}r"><rect x="0" y="${revealY.toFixed(2)}" width="120" height="120"/></clipPath></defs>
<g transform="translate(60 60) scale(${s.scale ?? 1}) translate(-60 -60)">
<g clip-path="url(#${id}c)" opacity="${s.fill ?? 1}">
<rect width="60" height="120" fill="${c.d}"/><rect x="60" width="60" height="120" fill="${c.l}"/>
<circle cx="${44 - dx}" cy="60" r="24" fill="${c.l}"/><circle cx="${76 + dx}" cy="60" r="24" fill="${c.d}"/>
${lensShown ? `<g clip-path="url(#${id}r)" opacity="${s.lensA ?? 1}"><circle cx="${76 + dx}" cy="60" r="24" fill="${s.lens || c.a}" clip-path="url(#${id}a)"/></g>` : ''}
</g>
${c.ring ? `<circle cx="60" cy="60" r="58.25" fill="none" stroke="${c.ring}" stroke-width="3.5" stroke-dasharray="${circ}" stroke-dashoffset="${(circ * (1 - ring)).toFixed(2)}" transform="rotate(-90 60 60)"/>` : ''}
${s.dot && s.dot.a > 0 ? `<circle cx="60" cy="${s.dot.y.toFixed(2)}" r="${s.dot.r}" fill="${c.a}" opacity="${s.dot.a}"/>` : ''}
</g></svg>`;
  }

  function state(opt, ms, c) {
    switch (opt) {
      case 'meet': // the halves stay put; the two circles come in from the edges and the lens appears the moment they touch (owner, 28.9)
        return { dx: 44 * (1 - EASE(seg(ms, 0, 1100))) };
      case 'close': // the ring closes, the halves settle, a mustard dot lands where they meet and becomes the lens
        return {
          ring: EASE(seg(ms, 0, 750)), fill: EASE(seg(ms, 250, 900)), lensA: seg(ms, 1200, 1450),
          dot: { y: -14 + 74 * EASE(seg(ms, 800, 1200)), r: 7, a: ms < 800 ? 0 : 1 - seg(ms, 1250, 1500) },
        };
      case 'light': // nothing moves; the lens goes from ink to mustard
        return { lens: mix(c.d, c.a, EASE(seg(ms, 0, 450))), scale: 0.97 + 0.03 * EASE(seg(ms, 0, 450)) };
      case 'rise': // the lens fills from the bottom, like a sun coming up between two worlds
        return { reveal: EASE(seg(ms, 0, 900)) };
    }
    return {};
  }

  const frame = (opt, ms, c, id = opt) => draw(state(opt, ms, c), c, id);
  const api = { OPTIONS, frame, EASE, mix };
  if (typeof module !== 'undefined') module.exports = api; else root.AllmaMotion = api;
})(this);
