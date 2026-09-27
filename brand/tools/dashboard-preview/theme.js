// Local-only brand preview: re-skins the real /me page with a candidate palette.
// Loaded by proxy.js; window.__bt(name) switches palettes.
(function () {
  const PAL = {
    today:    { name: 'היום (סגול)', keep: true },
    coral:    { name: 'אלמוג על דיו', P: '#221C3A', B: '#F7F1E6', A: '#FF8A6B', I: '#221C3A', onP: '#F7F1E6', btn: '#221C3A', onBtn: '#F7F1E6' , mk:['#221C3A','#F7F1E6','#FF8A6B'] },
    blue:     { name: 'כחול חשמלי + מנדרינה', P: '#0145F2', B: '#EDF1F5', A: '#FF7A1A', I: '#0B1533', onP: '#FFFFFF', btn: '#0145F2', onBtn: '#FFFFFF' , mk:['#0145F2','#EDF1F5','#FF7A1A'] },
    navy:     { name: 'נייבי + ענבר', P: '#0A2472', B: '#FFF8EC', A: '#FFBA08', I: '#0A1433', onP: '#FFFFFF', btn: '#0A2472', onBtn: '#FFFFFF' , mk:['#0A2472','#FFF8EC','#FFBA08'] },
    hot:      { name: 'אלמוג לוהט', P: '#FF4F2E', B: '#FFF4EE', A: '#1B1633', I: '#1B1633', onP: '#1B1633', btn: '#1B1633', onBtn: '#FFF4EE' , mk:['#1B1633','#FF4F2E','#FFF4EE'] },
    violet:   { name: 'סגול + לימון', P: '#5B2EFF', B: '#F6F4FF', A: '#FFE14D', I: '#150D3A', onP: '#FFFFFF', btn: '#5B2EFF', onBtn: '#FFFFFF' , mk:['#5B2EFF','#F6F4FF','#FFE14D'] },
    teal:     { name: 'טיל עמוק + חול', P: '#004643', B: '#F0EDE5', A: '#FF7A59', I: '#0E1F1E', onP: '#F0EDE5', btn: '#004643', onBtn: '#F0EDE5' , mk:['#004643','#F0EDE5','#FF7A59'] },
  };
  window.__PAL = PAL;

  const lens = (cx1, cx2, cy, r) => { const h = Math.sqrt(r * r - ((cx2 - cx1) / 2) ** 2), x = (cx1 + cx2) / 2;
    return `M${x} ${(cy - h).toFixed(2)}A${r} ${r} 0 0 1 ${x} ${(cy + h).toFixed(2)}A${r} ${r} 0 0 1 ${x} ${(cy - h).toFixed(2)}Z`; };
  const S = 'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';
  const L = 'fill="var(--lf)" stroke="none"';
  const ICONS = {
    'i-home': `<path d="M4 10.6 12 4l8 6.6V19a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 19z" ${S}/><path d="${lens(10.4, 13.6, 15, 2.6)}" ${L}/><circle cx="10.4" cy="15" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="13.6" cy="15" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/>`,
    'i-list': `<circle cx="18.2" cy="6.5" r="2.3" ${L}/><circle cx="18.2" cy="6.5" r="2.3" ${S}/><circle cx="18.2" cy="12" r="2.3" ${S}/><circle cx="18.2" cy="17.5" r="2.3" ${S}/><path d="M4 6.5h9.6M4 12h9.6M4 17.5h9.6" ${S}/>`,
    'i-cal24': `<rect x="3.5" y="5" width="17" height="15.5" rx="2.6" ${S}/><path d="M8 3v4M16 3v4M3.5 9.6h17" ${S}/><circle cx="15.4" cy="14.9" r="2.4" ${L}/><circle cx="15.4" cy="14.9" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/>`,
    'i-people': `<path d="${lens(9.5, 14.5, 8.6, 3.4)}" ${L}/><circle cx="9.5" cy="8.6" r="3.4" ${S}/><circle cx="14.5" cy="8.6" r="3.4" ${S}/><path d="M2.8 19.6c.7-3.3 3.4-5.2 6.7-5.2M21.2 19.6c-.7-3.3-3.4-5.2-6.7-5.2M9.5 14.4h5" ${S}/>`,
    'i-user24': `<path d="M12 4.8a3.8 3.8 0 0 1 0 7.6z" ${L}/><circle cx="12" cy="8.6" r="3.8" ${S}/><path d="M4.8 20c.8-3.6 3.6-5.6 7.2-5.6s6.4 2 7.2 5.6" ${S}/>`,
  };
  ICONS['i-cal'] = ICONS['i-cal24'];

  const MARK = (P) => `<svg viewBox="0 0 120 120" width="34" height="34" style="border-radius:50%;flex:none;display:block;box-shadow:0 0 0 2px rgba(255,255,255,.85)"><clipPath id="btc"><circle cx="60" cy="60" r="60"/></clipPath><clipPath id="btl"><circle cx="44" cy="60" r="24"/></clipPath><g clip-path="url(#btc)"><rect width="60" height="120" fill="${P.dark}"/><rect x="60" width="60" height="120" fill="${P.light}"/><circle cx="44" cy="60" r="24" fill="${P.light}"/><circle cx="76" cy="60" r="24" fill="${P.dark}"/><circle cx="76" cy="60" r="24" fill="${P.lens}" clip-path="url(#btl)"/></g></svg>`;

  let original = null;
  function apply(name) {
    const p = PAL[name]; if (!p) return;
    if (!original) original = Object.fromEntries(Object.keys(ICONS).map((id) => [id, document.getElementById(id)?.innerHTML]));
    document.documentElement.setAttribute('data-theme', 'light');
    let st = document.getElementById('bt-style');
    if (!st) { st = document.createElement('style'); st.id = 'bt-style'; document.head.appendChild(st); }
    let band = document.getElementById('bt-band');
    const mk = document.getElementById('bt-mark');
    if (p.keep) {
      st.textContent = ''; band && band.remove(); mk && mk.remove();
      for (const [id, html] of Object.entries(original)) { const s = document.getElementById(id); if (s && html != null) s.innerHTML = html; }
      return;
    }
    const mix = (a, b, pct) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
    st.textContent = `
      :root,:root[data-theme="light"]{
        --bg:${p.B}; --bg-tint:${mix(p.P, p.B, 7)}; --surface:#FFFFFF; --surface-2:${mix('#FFFFFF', p.B, 60)};
        --sep:${mix(p.I, p.B, 10)}; --sep-2:${mix(p.I, p.B, 17)};
        --text:${p.I}; --text-2:${mix(p.I, p.B, 74)}; --text-3:${mix(p.I, p.B, 66)};
        --accent:${p.btn}; --accent-2:${mix(p.btn, '#000', 84)}; --accent-soft:${mix(p.P, '#FFFFFF', 11)};
        --prog:${mix(p.P, 'transparent', 28)}; --accent-line:${mix(p.P, 'transparent', 45)};
        --on-accent:${p.onBtn}; --gold:${mix(p.A, '#000', 70)}; --gold-arc:${p.A}; --gold-soft:${mix(p.A, '#FFFFFF', 18)};
        --mk-gold:${p.A}; --lf:${p.A}; --brand-lens:${p.A};
      }
      *{font-family:"IBM Plex Sans Hebrew","IBM Plex Sans",system-ui,sans-serif !important}
      h1,h2,h3,.brand-name,.stat b,.num{letter-spacing:-.01em}
      body{background:${p.B}}
      .tab{--lf:none} .tab[aria-selected="true"]{--lf:${p.A}}
      #bt-band{position:absolute;inset-inline:0;top:0;background:${p.P};z-index:0;pointer-events:none;border-radius:0 0 28px 28px}
      .app{position:relative;z-index:1}
      .topbar,.view.active>.title{--text:${p.onP};--text-2:${mix(p.onP, p.P, 80)};--text-3:${mix(p.onP, p.P, 72)};color:${p.onP}}
      .topbar .brand{display:flex;align-items:center;gap:10px}
    `;
    if (!document.querySelector('link[href*="IBM+Plex"]')) {
      const l = document.createElement('link'); l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Hebrew:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;700&display=swap';
      document.head.appendChild(l);
    }
    for (const [id, html] of Object.entries(ICONS)) { const s = document.getElementById(id); if (s) s.innerHTML = html; }
    if (!band) { band = document.createElement('div'); band.id = 'bt-band'; document.body.prepend(band); }
    const t = document.querySelector('.view.active>.title');
    const home = !!document.querySelector('.view.active #toolsH');
    band.style.height = t ? (t.getBoundingClientRect().bottom + scrollY + (home ? 18 : 2)) + 'px' : '220px';
    const brand = document.querySelector('.topbar .brand');
    const markColors = { dark: p.mk[0], light: p.mk[1], lens: p.mk[2] };
    const html = MARK(markColors);
    if (brand) { let m = document.getElementById('bt-mark'); if (!m) { m = document.createElement('span'); m.id = 'bt-mark'; brand.prepend(m); } m.innerHTML = html; }
  }
  window.__bt = apply;
  const fromHash = () => { const m = /t=(\w+)/.exec(location.hash); if (m) apply(m[1]); };
  addEventListener('hashchange', fromHash);
  addEventListener('load', () => setTimeout(fromHash, 300));
})();
