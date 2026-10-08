'use strict';
// foodd's HTTP face. Caddy passes exactly these public shapes here:
//   GET  /food/<token>                    the person's page
//   GET  /food/<token>/api/state?day=     its data for one day
//   POST /food/<token>/api/write          a change made on the page
//   GET  /food/<token>/api/journal        the plates, newest first
//   POST /food/<token>/api/chat           a line to the page's chat
//   POST /food/<token>/api/snap           a photo from the camera button
//   GET  /food/<token>/card.svg?day=      the day card, as the page previews it
//   GET  /food/<token>/card-week.svg?day= the week card: its plates and three counts
//   GET  /food/<token>/photo/<meal id>    a plate's photo
// Everything else (/health, /api/tool, /api/page) is for the box itself: Caddy never
// routes it, and the handler also refuses anything that arrived through a
// proxy, so a Caddyfile mistake cannot open the tools to the world.
//
// The page's link IS its permission, like a game night's: whoever holds it
// sees and changes that person's food log. Olma sends it only to them.
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const card = require('./card');
const chat = require('./chat');
const { Refused } = require('./validate');
const { runTool } = require('./tools');
const { resolveIdentity, makeCard, readMedia } = require('./identity');

const PAGE_FILE = path.join(__dirname, '..', 'public', 'day.html');
const MAX_BODY = 32 * 1024;
// A photo from the camera button, already shrunk by the page (day.html, snap).
const MAX_PHOTO_BODY = 3 * 1024 * 1024;
const WRITES_PER_MIN = 120;      // per page and, separately, per client and per person on the tools

const STATUS = { not_found: 404, too_many: 429, rate_limited: 429, too_old: 409, future_day: 409 };

function createServer({ pool, publicBase = '', page, identify = resolveIdentity, card: cardMaker = makeCard, media = readMedia, fetchImpl } = {}) {
  const html = page ?? fs.readFileSync(PAGE_FILE, 'utf8');
  const buckets = new Map();
  const limited = key => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) { b = { n: 0, reset: now + 60_000 }; buckets.set(key, b); }
    b.n += 1;
    if (buckets.size > 5000) for (const [k, x] of buckets) if (x.reset < now) buckets.delete(k);
    return b.n > WRITES_PER_MIN;
  };

  const base = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',     // the token IS the permission
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
  };
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { ...base, 'Content-Type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const fail = (res, e) => {
    if (e instanceof Refused) return send(res, STATUS[e.code] || 400, { error: e.code });
    console.error('[foodd]', e && e.stack || e);
    return send(res, 500, { error: 'internal' });
  };
  const readBody = (req, max = MAX_BODY) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', ch => {
      size += ch.length;
      if (size > max) { reject(new Refused('too_big')); req.destroy(); return; }
      chunks.push(ch);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Refused('bad_json')); }
    });
    req.on('error', reject);
  });
  const clientOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const isLocal = req => !req.headers['x-forwarded-for'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

  // A change from the page: the same store function the matching tool calls.
  async function pageWrite(p, b) {
    const id = b.meal_id;
    switch (b.op) {
      case 'item_grams': return store.editMeal(pool, p, { meal_id: id, changes: [{ item_id: b.item_id, grams: b.grams, item: '' }] }, { via: 'page' });
      case 'item_remove': return store.editMeal(pool, p, { meal_id: id, changes: [{ item_id: b.item_id, remove: true, item: '' }] }, { via: 'page' });
      case 'meal_slot': return store.editMeal(pool, p, { meal_id: id, slot: b.slot }, { via: 'page' });
      case 'meal_delete': return store.deleteMeal(pool, p, id);
      case 'relog': return store.relog(pool, p, { meal_id: id, date: b.date }, { via: 'page', source: 'usual' });
      case 'water': return store.water(pool, p, b.ml != null ? { date: b.date, ml: b.ml } : { date: b.date, cups: b.cups });
      case 'water_goal': return store.setWaterGoal(pool, p, b.ml);
      case 'vessel': return store.setVessel(pool, p, b.ml);
      case 'numbers': return store.setNumbers(pool, p, b.on);
      case 'forget': return store.forgetPortion(pool, p, b.name);
      case 'auto': return store.setAuto(pool, p, { meal_id: id, title: b.title, on: b.on, hour: b.hour });
      case 'challenge': return store.setChallenge(pool, p, b.key);
      case 'goal': return store.setGoal(pool, p, b);
      default: throw new Refused('bad_op');
    }
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p_ = url.pathname;

      if (p_ === '/health' && isLocal(req)) {
        await pool.query('SELECT 1');
        return send(res, 200, { ok: true });
      }
      // Olma's tools (bin/food-mcp.js). The token in the call is the only
      // claim; brokerd says who it is and whether they hold the pack, and a
      // person without it is refused here whatever the gateway showed them.
      if (p_ === '/api/tool' && req.method === 'POST') {
        if (!isLocal(req)) return send(res, 404, { error: 'not_found' });
        const { name, args } = await readBody(req);
        const a = args && typeof args === 'object' ? { ...args } : {};
        const token = typeof a.olma_identity === 'string' ? a.olma_identity : '';
        delete a.olma_identity;
        let who;
        try { who = await identify(token); } catch (e) {
          return send(res, 200, { text: `ERROR unavailable: could not check who is asking (${e.message})` });
        }
        if (!who || !who.ok) return send(res, 200, { text: `ERROR forbidden: ${who?.error?.message || 'unknown identity token'}` });
        if (!Array.isArray(who.packs) || !who.packs.includes('food')) {
          return send(res, 200, { text: 'ERROR forbidden: food tracking is not turned on for this person' });
        }
        if (limited('u:' + who.user.id)) return send(res, 200, { text: 'ERROR rate_limited: too many calls this minute' });
        const text = await runTool(name, a, { pool, user: who.user, publicBase, makeCard: cardMaker, readMedia: media, fetchImpl });
        return send(res, 200, { text });
      }

      // The food icon on the home screen of their own page (olma2 /me): their
      // page's link. olma2 has already checked the session and that they hold
      // the pack, so the user is its word, which is why only the box may ask.
      // Made on the first ask, like a first tool call makes it: somebody who
      // has the pack and has not logged anything yet still has a page to open.
      if (p_ === '/api/page' && req.method === 'POST') {
        if (!isLocal(req)) return send(res, 404, { error: 'not_found' });
        const { user } = await readBody(req);
        const id = Number(user && user.id);
        if (!Number.isSafeInteger(id) || id <= 0) return send(res, 400, { ok: false, error: 'bad_user' });
        const p = await store.ensurePerson(pool, { ...user, id });
        return send(res, 200, { ok: true, url: `${publicBase}/food/${p.token}` });
      }

      const m = p_.match(/^\/food\/([A-Za-z0-9]{22})(?:\/(api\/state|api\/write|api\/journal|api\/chat|api\/snap|card\.svg|card-week\.svg|photo\/(\d{1,12})))?$/);
      if (!m) return send(res, 404, { error: 'not_found' });
      const [, token, action, photoId] = m;
      const p = await store.personByToken(pool, token);

      if (!action) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
        if (!p) return send(res, 404, '<!doctype html><meta charset="utf-8"><title>לא נמצא</title><p dir="rtl" style="font-family:sans-serif;padding:24px">הקישור הזה לא מוביל לשום עמוד.</p>', 'text/html; charset=utf-8');
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      if (!p) return send(res, 404, { error: 'not_found' });
      if (action === 'api/state') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method' });
        return send(res, 200, await store.dayView(pool, p, url.searchParams.get('day') || undefined, { publicBase }));
      }
      if (action === 'api/journal') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method' });
        return send(res, 200, await store.journal(pool, p, { before: url.searchParams.get('before') || undefined }));
      }
      // A plate's photo, only through its owner's own link. The id is in the
      // path, so the same id under somebody else's token finds nothing.
      if (photoId) {
        if (req.method !== 'GET') return send(res, 405, { error: 'method' });
        const ph = await store.photoOf(pool, p, photoId);
        if (!ph) return send(res, 404, { error: 'not_found' });
        res.writeHead(200, { ...base, 'Content-Type': ph.mime, 'Cache-Control': 'private, max-age=86400', 'Content-Length': ph.body.length });
        return res.end(ph.body);
      }
      if (action === 'card.svg') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method' });
        const v = await store.dayView(pool, p, url.searchParams.get('day') || undefined);
        return send(res, 200, card.buildSvg(v).svg, 'image/svg+xml; charset=utf-8');
      }
      if (action === 'card-week.svg') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method' });
        const w = await store.weekOf(pool, p, url.searchParams.get('day') || undefined);
        // Only the photos the card can hold are read, newest first, as it picks them.
        const got = new Map();
        for (const m of w.meals.filter(x => x.photo && !x.rough).reverse().slice(0, card.TILES)) got.set(m.id, await store.photoOf(pool, p, m.id));
        const photoOf = m => got.get(m.id) || null;
        return send(res, 200, card.buildWeekSvg(w, photoOf).svg, 'image/svg+xml; charset=utf-8');
      }
      if (action === 'api/chat') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method' });
        if (limited('t:' + token) || limited('c:' + clientOf(req))) return send(res, 429, { error: 'rate_limited' });
        const body = await readBody(req);
        if (typeof body.text !== 'string' || !body.text.trim()) return send(res, 400, { error: 'bad_text' });
        const out = await chat.turn(pool, p, body.text, { fetchImpl });
        return send(res, 200, { ok: true, ...out, state: await store.dayView(pool, await store.reload(pool, p.user_id), undefined, { publicBase }) });
      }
      if (action === 'api/snap') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method' });
        if (limited('t:' + token) || limited('c:' + clientOf(req))) return send(res, 429, { error: 'rate_limited' });
        const body = await readBody(req, MAX_PHOTO_BODY);
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(body.mime) || typeof body.base64 !== 'string' || !body.base64) return send(res, 400, { error: 'bad_photo' });
        const out = await chat.photo(pool, p, { mime: body.mime, base64: body.base64 }, { fetchImpl });
        return send(res, 200, { ok: true, ...out, state: await store.dayView(pool, await store.reload(pool, p.user_id), undefined, { publicBase }) });
      }
      // api/write
      if (req.method !== 'POST') return send(res, 405, { error: 'method' });
      if (limited('t:' + token) || limited('c:' + clientOf(req))) return send(res, 429, { error: 'rate_limited' });
      const body = await readBody(req);
      const result = await pageWrite(p, body || {});
      const fresh = await store.reload(pool, p.user_id);
      const day = typeof body.date === 'string' ? body.date : (typeof body.day === 'string' ? body.day : undefined);
      return send(res, 200, { ok: true, result, state: await store.dayView(pool, fresh, day, { publicBase }) });
    } catch (e) {
      return fail(res, e);
    }
  };

  return http.createServer(handler);
}

module.exports = { createServer };
