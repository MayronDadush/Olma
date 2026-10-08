'use strict';
// Reading a link somebody saved ("שמורים", docs/design/saved-links-handoff.md).
//
// Pure apart from the network, and the network is injected (`fetchImpl`,
// `lookup`), so no test ever leaves the machine. NEVER throws: `extract`
// answers `null` when the link could not be read at all, and an object with
// empty fields when it was read and said nothing — the two take different
// actions (a retry later vs. "nothing to add") and must never collapse
// (CLAUDE.md, "Absence of evidence scored as evidence").
//
// What each platform gives from a datacenter IP was MEASURED from the box on
// 2026-10-08, and the readers below follow that and nothing else:
//   - YouTube and TikTok: their oEmbed endpoints (the pages are blocked).
//   - Instagram: the `/embed/captioned/` page. Measured working in the
//     morning and returning a logged-out shell for a public post in the
//     afternoon, so it is the least certain reader here; a shell parses as
//     "read, nothing in it", and the enrich job retries.
//   - Yad2: a browser UA gets a Radware challenge, a link-preview UA gets the
//     real page with `__NEXT_DATA__` carrying price, rooms, size and floor.
//   - Madlan: Cloudflare 403 for every UA tried — unreadable, saved anyway.
//   - Anything else: the page itself, og tags plus JSON-LD `Recipe`.
//
// Only what the fetch returned is ever stored as a title or a line — never a
// model's words (rules/doctrine.md, "Olma never claims a lookup it did not
// perform").
const dnsPromises = require('node:dns').promises;
const net = require('node:net');

const TIMEOUT_MS = 5000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 300 * 1024;
const MAX_REDIRECTS = 3;
const MAX_URLS = 5;

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// What a link preview sends. Yad2 serves the real page to it and a challenge
// to a browser (measured 2026-10-08).
const PREVIEW_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

// Our own hosts are never fetched: a saved link to them is somebody's page.
const OWN_HOSTS = new Set(['allma.world', 'www.allma.world', 'olmachat.duckdns.org', 'localhost']);
const TRACKING_PARAM = /^(utm_[a-z_]+|igsh|igshid|si|feature|fbclid|gclid|mc_eid|ref_src|_r|is_from_webapp|sender_device)$/i;
// Hosts whose links are only a hop to somewhere else; their target is the
// canonical form once it is known.
const SHORT_HOSTS = new Set(['vt.tiktok.com', 'vm.tiktok.com', 'pin.it', 'maps.app.goo.gl', 'goo.gl']);

// ---- finding and naming URLs ------------------------------------------------

// A URL ends at whitespace or at punctuation a sentence put after it.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`״]+/gi;
const TRAILING = /[.,;:!?)\]}>'"»״׳]+$/;

function findUrls(text) {
  const out = [];
  for (const m of String(text == null ? '' : text).matchAll(URL_RE)) {
    let u = m[0];
    // Keep a closing paren that closes one inside the URL (wikipedia style).
    while (TRAILING.test(u)) {
      const last = u[u.length - 1];
      if (last === ')' && (u.match(/\(/g) || []).length >= (u.match(/\)/g) || []).length) break;
      u = u.slice(0, -1);
    }
    if (parse(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

function parse(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

function hostOf(url) { return url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, ''); }

function platformOf(u) {
  const url = typeof u === 'string' ? parse(u) : u;
  if (!url) return null;
  const h = hostOf(url);
  if (h === 'instagram.com' || h.endsWith('.instagram.com')) return 'instagram';
  if (h === 'tiktok.com' || h.endsWith('.tiktok.com')) return 'tiktok';
  if (h === 'youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com')) return 'youtube';
  if (h === 'yad2.co.il' || h.endsWith('.yad2.co.il')) return 'yad2';
  if (h === 'maps.app.goo.gl' || /^maps\.google\./.test(h) || (/^google\./.test(h) && url.pathname.startsWith('/maps'))
    || (h === 'goo.gl' && url.pathname.startsWith('/maps'))) return 'maps';
  return 'web';
}

// The form two saves of the same thing share, so the second is "already
// saved" rather than a twin. Computed without the network; a short link's
// canonical form is replaced by its target's once the fetch has followed it.
function normalize(u) {
  const url = typeof u === 'string' ? parse(u) : u;
  if (!url) return null;
  const c = new URL(url.href);
  c.hash = '';
  c.hostname = c.hostname.toLowerCase();
  for (const k of [...c.searchParams.keys()]) if (TRACKING_PARAM.test(k)) c.searchParams.delete(k);
  const platform = platformOf(c);
  const h = hostOf(c);
  if (platform === 'youtube') {
    let id = null;
    if (h === 'youtu.be') id = c.pathname.split('/')[1];
    else if (c.pathname.startsWith('/shorts/') || c.pathname.startsWith('/live/')) id = c.pathname.split('/')[2];
    else if (c.pathname === '/watch') id = c.searchParams.get('v');
    if (id && /^[A-Za-z0-9_-]{6,20}$/.test(id)) {
      return { url: url.href, canonical: `https://www.youtube.com/watch?v=${id}`, platform };
    }
  }
  if (platform === 'instagram') {
    const m = /^\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/.exec(c.pathname);
    if (m) return { url: url.href, canonical: `https://www.instagram.com/p/${m[1]}/`, platform };
  }
  if (platform === 'tiktok') {
    const m = /^\/(@[A-Za-z0-9_.]+)\/(video|photo)\/(\d+)/.exec(c.pathname);
    if (m) return { url: url.href, canonical: `https://www.tiktok.com/${m[1]}/${m[2]}/${m[3]}`, platform };
  }
  if (platform === 'yad2') {
    const m = /^\/realestate\/item\/(?:[a-z0-9-]+\/)?([A-Za-z0-9]+)/.exec(c.pathname);
    if (m) return { url: url.href, canonical: `https://www.yad2.co.il/realestate/item/${m[1]}`, platform };
  }
  if (c.pathname.length > 1) c.pathname = c.pathname.replace(/\/+$/, '');
  c.hostname = c.hostname.replace(/^(m|mobile)\./, 'www.');
  return { url: url.href, canonical: c.href, platform };
}

// ---- the guard every fetch goes through --------------------------------------

function isPrivateIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
  }
  return true;   // not an address at all: refuse
}

// Refuses anything that is not a public host on the open internet. The
// address is resolved here and checked; the fetch resolves it again, so a
// host that answers differently the second time (DNS rebinding) is not
// covered — the reach of that is one GET with no credentials of ours.
async function hostIsSafe(url, lookup) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (OWN_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false;
  if (net.isIP(host)) return !isPrivateIp(host);
  try {
    const addrs = await lookup(host, { all: true });
    return Array.isArray(addrs) && addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch { return false; }
}

async function readCapped(res, maxBytes) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { try { await reader.cancel(); } catch { /* gone */ } return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > maxBytes ? null : buf;
}

// One GET, every hop checked. `null` for anything refused, failed, too big or
// too slow — the reason goes to `why` for the audit, never to the person.
async function safeGet(href, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const lookup = opts.lookup || dnsPromises.lookup;
  const why = opts.why || (() => {});
  let url = parse(href);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!url) { why('bad_url'); return null; }
      if (!(await hostIsSafe(url, lookup))) { why('refused_host'); return null; }
      const res = await fetchImpl(url.href, {
        redirect: 'manual', signal: controller.signal,
        headers: { 'user-agent': opts.ua || BROWSER_UA, accept: opts.accept || '*/*', 'accept-language': 'he,en;q=0.8' },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) { why(`http_${res.status}`); return null; }
        try { url = parse(new URL(loc, url).href); } catch { url = null; }
        continue;
      }
      if (res.status !== 200) { why(`http_${res.status}`); return null; }
      const type = String(res.headers.get('content-type') || '').toLowerCase();
      if (opts.type && !opts.type.test(type)) { why('wrong_type'); return null; }
      const body = await readCapped(res, opts.maxBytes || MAX_PAGE_BYTES);
      if (!body) { why('too_big'); return null; }
      return { finalUrl: url.href, type, body };
    }
    why('too_many_redirects');
    return null;
  } catch (e) {
    why(e && e.name === 'AbortError' ? 'timeout' : 'fetch_failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- reading what came back ---------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] || m);
}
function clean(s, max) {
  const t = decode(s).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return max && t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function metaOf(html, name) {
  const re = new RegExp(`<meta\\s[^>]*(?:property|name)=["']${name.replace(/[.:]/g, '\\$&')}["'][^>]*>`, 'i');
  const tag = re.exec(html);
  if (!tag) return null;
  const c = /content=(["'])([\s\S]*?)\1/i.exec(tag[0]);
  return c ? c[2] : null;
}

function jsonLdNodes(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim());
      for (const top of Array.isArray(j) ? j : [j]) {
        for (const n of (top && Array.isArray(top['@graph']) ? top['@graph'] : [top])) if (n && typeof n === 'object') out.push(n);
      }
    } catch { /* one broken block is not the page */ }
  }
  return out;
}
function isType(n, t) { const v = n['@type']; return v === t || (Array.isArray(v) && v.includes(t)); }

// ISO 8601 duration → minutes ("PT1H15M" → 75).
function minutesOf(d) {
  const m = /^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(String(d || ''));
  if (!m || (!m[1] && !m[2])) return null;
  return (Number(m[1]) || 0) * 60 + (Number(m[2]) || 0);
}
function imageOf(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return imageOf(v[0]);
  return typeof v.url === 'string' ? v.url : null;
}
function stepsOf(v) {
  const out = [];
  const walk = (x) => {
    if (!x) return;
    if (typeof x === 'string') { const t = clean(x, 400); if (t) out.push(t); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (isType(x, 'HowToSection')) { walk(x.itemListElement); return; }
    if (typeof x.text === 'string') walk(x.text);
  };
  walk(v);
  return out.slice(0, 40);
}

function recipeFrom(nodes) {
  const r = nodes.find((n) => isType(n, 'Recipe'));
  if (!r) return null;
  const ingredients = (Array.isArray(r.recipeIngredient) ? r.recipeIngredient : [])
    .map((x) => clean(x, 200)).filter(Boolean).slice(0, 60);
  const steps = stepsOf(r.recipeInstructions);
  const yieldRaw = Array.isArray(r.recipeYield) ? r.recipeYield[0] : r.recipeYield;
  return {
    name: clean(r.name, 200),
    image: imageOf(r.image),
    recipe: {
      ingredients, steps,
      total_min: minutesOf(r.totalTime) || minutesOf(r.cookTime) || null,
      servings: yieldRaw == null ? null : clean(String(yieldRaw), 40),
    },
  };
}

const LINES = {
  he: {
    recipe: (r) => [r.ingredients.length ? `${r.ingredients.length} מצרכים` : null, r.total_min ? `${r.total_min} דק׳` : null],
    flat: (f) => [f.price ? `₪${f.price.toLocaleString('en-US')}` : null, f.rooms ? `${f.rooms} חד׳` : null,
      f.size ? `${f.size} מ״ר` : null, f.floor != null ? (f.floor === 0 ? 'קרקע' : `קומה ${f.floor}`) : null],
  },
  en: {
    recipe: (r) => [r.ingredients.length ? `${r.ingredients.length} ingredients` : null, r.total_min ? `${r.total_min} min` : null],
    flat: (f) => [f.price ? `₪${f.price.toLocaleString('en-US')}` : null, f.rooms ? `${f.rooms} rooms` : null,
      f.size ? `${f.size} m²` : null, f.floor != null ? (f.floor === 0 ? 'ground floor' : `floor ${f.floor}`) : null],
  },
};
function lineFrom(kind, parts, lang) {
  const L = LINES[lang === 'en' ? 'en' : 'he'];
  const bits = (L[kind] ? L[kind](parts) : []).filter(Boolean);
  return bits.length ? bits.join(' · ') : null;
}

// Yad2's page state: the first object anywhere that carries both a price and
// a room count is the listing.
function yad2Listing(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  let found = null;
  const seen = new Set();
  const walk = (x, depth) => {
    if (found || !x || typeof x !== 'object' || depth > 14 || seen.has(x)) return;
    seen.add(x);
    if (!Array.isArray(x) && 'price' in x && ('roomsCount' in x || 'rooms' in x
      || (x.additionalDetails && typeof x.additionalDetails === 'object' && 'roomsCount' in x.additionalDetails))) { found = x; return; }
    for (const v of Array.isArray(x) ? x : Object.values(x)) walk(v, depth + 1);
  };
  walk(data, 0);
  if (!found) return null;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const d = found.additionalDetails && typeof found.additionalDetails === 'object' ? found.additionalDetails : found;
  const addr = found.address && typeof found.address === 'object' ? found.address : found;
  const floorV = (addr.house && addr.house.floor != null) ? addr.house.floor : (found.floor != null ? found.floor : null);
  return {
    price: num(found.price),
    rooms: num(d.roomsCount != null ? d.roomsCount : found.roomsCount != null ? found.roomsCount : found.rooms),
    size: num(d.squareMeter != null ? d.squareMeter : found.squareMeter),
    floor: Number.isFinite(Number(floorV)) ? Number(floorV) : null,
  };
}

function strip(text) { return String(text || '').replace(/<[^>]+>/g, ' '); }

// ---- per platform --------------------------------------------------------------

async function viaOembed(endpoint, canonical, opts) {
  const got = await safeGet(`${endpoint}?url=${encodeURIComponent(canonical)}&format=json`,
    { ...opts, accept: 'application/json', maxBytes: 256 * 1024 });
  if (!got) return null;
  let j;
  try { j = JSON.parse(got.body.toString('utf8')); } catch { return null; }
  return { title: j.title, author: j.author_name, authorUrl: j.author_url, image: j.thumbnail_url };
}

async function readYoutube(n, opts) {
  const o = await viaOembed('https://www.youtube.com/oembed', n.canonical, opts);
  if (!o) return null;
  return { kind: 'video', title: clean(o.title, 200), author: clean(o.author, 80), image: o.image || null };
}

function handleOf(href) {
  const m = /\/(@[A-Za-z0-9_.]+)\/?$/.exec(String(href || ''));
  return m ? m[1] : null;
}

async function readTiktok(n, opts) {
  const o = await viaOembed('https://www.tiktok.com/oembed', n.canonical, opts);
  if (!o) return null;
  // TikTok's "title" is the whole caption, hashtags and all.
  const caption = clean(o.title, 2000);
  return {
    kind: 'video', caption,
    title: caption ? clean(caption.replace(/#[^\s#]+/g, ''), 120) : null,
    // author_name is the display name ("Tyler Butterworth"); the handle is in
    // author_url, and a handle is what a person recognises an account by.
    author: handleOf(o.authorUrl) || clean(o.author, 80),
    image: o.image || null,
  };
}

async function readInstagram(n, opts) {
  const got = await safeGet(`${n.canonical}embed/captioned/`, { ...opts, accept: 'text/html' });
  if (!got) return null;
  const html = got.body.toString('utf8');
  const cap = /class="Caption"[^>]*>([\s\S]*?)<div class="CaptionComments/.exec(html)
    || /class="Caption"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  const user = /class="CaptionUsername"[^>]*>([^<]+)</.exec(html) || /class="UsernameText"[^>]*>([^<]+)</.exec(html);
  const img = /class="EmbeddedMediaImage"[^>]*src="([^"]+)"/.exec(html) || /<img[^>]*class="EmbeddedMediaImage"[^>]*>/.exec(html);
  let caption = cap ? clean(strip(cap[1]), 2000) : null;
  const author = user ? `@${clean(user[1], 60).replace(/^@/, '')}` : null;
  // The caption block starts with the username; it is said separately.
  if (caption && user) caption = clean(caption.replace(new RegExp(`^${user[1].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), ''), 2000);
  const src = img && img[1] ? decode(img[1]) : null;
  return {
    kind: 'video', caption, author, image: src,
    title: caption ? clean(caption.split(/\n|(?<=[.!?])\s/)[0].replace(/#[^\s#]+/g, ''), 120) : null,
  };
}

async function readYad2(n, opts) {
  const got = await safeGet(n.url, { ...opts, ua: PREVIEW_UA, accept: 'text/html' });
  if (!got) return null;
  const html = got.body.toString('utf8');
  const og = clean(metaOf(html, 'og:title'), 300);
  // "דירה, <street>, <neighbourhood>, <city> | אלפי מודעות…" — the address is
  // the title; the slogan after the bar is not.
  const title = og ? clean(og.split(' | ')[0], 160) : null;
  const flat = yad2Listing(html);
  return {
    kind: 'listing', title,
    caption: clean(metaOf(html, 'og:description'), 600),
    image: metaOf(html, 'og:image'),
    line: flat ? lineFrom('flat', flat, opts.lang) : null,
  };
}

async function readPage(n, opts) {
  const got = await safeGet(n.url, { ...opts, accept: 'text/html,application/xhtml+xml', type: /html|xml/ });
  if (!got) return null;
  const html = got.body.toString('utf8');
  const rec = recipeFrom(jsonLdNodes(html));
  const title = clean(metaOf(html, 'og:title') || (/<title[^>]*>([^<]*)/i.exec(html) || [])[1], 200);
  const out = {
    finalUrl: got.finalUrl,
    kind: rec ? 'recipe' : (n.platform === 'maps' ? 'place' : null),
    title: (rec && rec.name) || title,
    author: clean(metaOf(html, 'og:site_name'), 80),
    caption: clean(metaOf(html, 'og:description') || metaOf(html, 'description'), 600),
    image: (rec && rec.image) || metaOf(html, 'og:image'),
  };
  if (rec) { out.recipe = rec.recipe; out.line = lineFrom('recipe', rec.recipe, opts.lang); }
  return out;
}

function placeFromMapsUrl(href) {
  const url = parse(href);
  if (!url) return null;
  const m = /\/place\/([^/]+)/.exec(url.pathname);
  return m ? clean(decodeURIComponent(m[1].replace(/\+/g, ' ')), 120) : null;
}

// Follows a short link to where it goes, through the same guard as any fetch.
async function resolveShort(n, opts) {
  if (!SHORT_HOSTS.has(parse(n.url).hostname.toLowerCase())) return n;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const lookup = opts.lookup || dnsPromises.lookup;
  let url = parse(n.url);
  try {
    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
      if (!url || !(await hostIsSafe(url, lookup))) return n;
      const res = await fetchImpl(url.href, { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': BROWSER_UA } });
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) break;
      url = parse(new URL(loc, url).href);
      if (url && !SHORT_HOSTS.has(url.hostname.toLowerCase())) break;
    }
  } catch { return n; }
  const target = url && normalize(url.href);
  return target ? { ...target, url: n.url } : n;
}

// The whole read. `null` = could not read it (retry later); otherwise an
// object whose missing fields mean "read, not there".
//
// `level` is `full` when there is something to show beyond a title (a recipe,
// a flat's line, a caption), `meta` when only a title or a picture came back.
async function extract(href, opts = {}) {
  try {
    let n = normalize(href);
    if (!n) return null;
    n = await resolveShort(n, opts);
    const read = {
      youtube: readYoutube, tiktok: readTiktok, instagram: readInstagram, yad2: readYad2,
    }[n.platform] || readPage;
    const got = await read(n, opts);
    if (!got) {
      if (n.platform === 'maps') {
        const name = placeFromMapsUrl(n.url);
        if (name) return { canonical: n.canonical, platform: n.platform, kind: 'place', title: name, level: 'meta' };
      }
      return null;
    }
    const out = {
      canonical: n.canonical, platform: n.platform, kind: got.kind || null,
      title: got.title || null, author: got.author || null, caption: got.caption || null,
      image: got.image ? String(got.image) : null, recipe: got.recipe || null, line: got.line || null,
    };
    if (n.platform === 'maps' && !out.title) out.title = placeFromMapsUrl(got.finalUrl || n.url);
    out.level = out.recipe || out.line || out.caption ? 'full' : 'meta';
    return out;
  } catch {
    return null;
  }
}

// The picture beside the title. Instagram's and TikTok's are signed URLs that
// expire, so the bytes are what is kept. `null` for anything not an image or
// over the cap.
async function fetchImage(href, opts = {}) {
  if (!parse(href)) return null;
  const got = await safeGet(href, { ...opts, accept: 'image/*', type: /^image\/(jpeg|png|webp|gif)/, maxBytes: MAX_IMAGE_BYTES });
  if (!got) return null;
  return { mime: got.type.split(';')[0].trim(), bytes: got.body };
}

module.exports = {
  findUrls, normalize, platformOf, extract, fetchImage,
  // exported for the tests
  isPrivateIp, hostIsSafe, safeGet, yad2Listing, recipeFrom, jsonLdNodes, lineFrom,
  MAX_URLS, MAX_IMAGE_BYTES, PREVIEW_UA,
};
