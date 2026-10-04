'use strict';
// gamesd's HTTP face. Caddy passes exactly three public shapes here:
//   GET  /night/<token>                the page
//   *    /night/<token>/api/<action>   its API (state, events, write, next)
//   GET  /g/<code>                     the invite's short link, into a chat with Olma
// Everything else (/health, POST /api/nights, /api/tool, /api/open, /api/join, /api/mine) is for the box itself: Caddy
// never routes it, and the handler also refuses anything that arrived through
// a proxy, so a Caddyfile mistake cannot open night creation to the world.
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Refused } = require('./validate');
const { runTool } = require('./tools');
const { resolveIdentity, sendInvite } = require('./identity');
const { announceClose } = require('./announce');
const { openFor, joinByCode, nightsFor, CODE_RE } = require('./join');

const PAGE_FILE = path.join(__dirname, '..', 'public', 'night.html');
const MAX_BODY = 32 * 1024;
const WRITES_PER_MIN = 120;          // per night and, separately, per client
const MAX_LISTENERS_PER_NIGHT = 60;
const MAX_LISTENERS = 600;

const STATUS = { not_found: 404, too_many: 429, rate_limited: 429 };

// Olma's WhatsApp number, the same default as olma2's referral.WA_NUMBER.
const waNumber = () => String(process.env.OLMA_WA_NUMBER || '972559347282').replace(/\D/g, '');

// The invite's "join from WhatsApp" line (olma2 game_invite): a short link that
// opens a chat with Olma holding "משחק K7M2Q", which brokerd answers by code.
// Every well-formed code redirects, open night or not, and nothing is read:
// a link that answered differently for a live code would be a way to find one.
// The reply to a dead code is Olma's to give, in the chat.
function shortLink(p) {
  const m = p.match(/^\/g\/([A-Za-z0-9]{5})$/);
  if (!m || !CODE_RE.test(m[1].toUpperCase())) return null;
  return `https://wa.me/${waNumber()}?text=${encodeURIComponent('משחק ' + m[1].toUpperCase())}`;
}

function createServer({ pool, publicBase = '', page, identify = resolveIdentity, announce = announceClose, invite = sendInvite } = {}) {
  const html = page ?? fs.readFileSync(PAGE_FILE, 'utf8');
  const listeners = new Map();        // token -> Set<res>
  let listenerCount = 0;
  const buckets = new Map();          // key -> { n, reset }

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
    // The token IS the permission; never hand it to another site.
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
  };
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { ...base, 'Content-Type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const fail = (res, e) => {
    if (e instanceof Refused) return send(res, STATUS[e.code] || 400, { error: e.code });
    console.error('[gamesd]', e && e.stack || e);
    return send(res, 500, { error: 'internal' });
  };
  const readBody = req => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', ch => {
      size += ch.length;
      if (size > MAX_BODY) { reject(new Refused('too_big')); req.destroy(); return; }
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

  function broadcast(token, state) {
    const set = listeners.get(token);
    if (!set) return;
    const msg = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const res of set) res.write(msg);
  }

  async function events(req, res, token) {
    const n = await store.findNight(pool, token);
    if (!n) return send(res, 404, { error: 'not_found' });
    const set = listeners.get(token) || new Set();
    if (set.size >= MAX_LISTENERS_PER_NIGHT || listenerCount >= MAX_LISTENERS) return send(res, 429, { error: 'too_many' });
    res.writeHead(200, { ...base, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    listeners.set(token, set.add(res));
    listenerCount += 1;
    res.write(`event: state\ndata: ${JSON.stringify(await store.stateOf(pool, n))}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      set.delete(res); listenerCount -= 1;
      if (!set.size) listeners.delete(token);
    });
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;

      if (p === '/health' && isLocal(req)) {
        await pool.query('SELECT 1');
        return send(res, 200, { ok: true, listeners: listenerCount });
      }
      if (p === '/api/nights' && req.method === 'POST') {
        if (!isLocal(req)) return send(res, 404, { error: 'not_found' });
        const body = await readBody(req);
        const n = await store.createNight(pool, body);
        return send(res, 201, { token: n.token, code: n.code, url: `${publicBase}/night/${n.token}` });
      }
      // Olma's tools (bin/games-mcp.js). The token in the call is the only
      // claim; brokerd says who it is and whether they hold the pack, and a
      // person without it is refused here whatever the gateway showed them.
      if (p === '/api/tool' && req.method === 'POST') {
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
        if (!Array.isArray(who.packs) || !who.packs.includes('games')) {
          return send(res, 200, { text: 'ERROR forbidden: game nights are not turned on for this person' });
        }
        if (limited('u:' + who.user.id)) return send(res, 200, { text: 'ERROR rate_limited: too many calls this minute' });
        const text = await runTool(name, a, { pool, user: who.user, publicBase, onState: broadcast, announce, invite });
        return send(res, 200, { text });
      }

      // A night opened, or a seat taken, straight from a private message with
      // no model in between (olma2 src/domain/game-shortcut.js). brokerd has
      // already resolved the sender, so the user id is its word — which is
      // why, like the two routes above, nothing but the box may call these.
      // Where their nights stand, for Olma's turn context. Same door, same
      // reason: brokerd has resolved the person and nothing else may ask.
      if (p === '/api/mine' && req.method === 'POST') {
        if (!isLocal(req)) return send(res, 404, { error: 'not_found' });
        return send(res, 200, await nightsFor(pool, await readBody(req)));
      }
      if ((p === '/api/open' || p === '/api/join') && req.method === 'POST') {
        if (!isLocal(req)) return send(res, 404, { error: 'not_found' });
        const body = await readBody(req);
        const out = p === '/api/open'
          ? await openFor(pool, body, { publicBase })
          : await joinByCode(pool, body, { publicBase, onState: broadcast });
        return send(res, 200, out);
      }

      const wa = shortLink(p);
      if (wa) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
        res.writeHead(302, { ...base, Location: wa });
        return res.end();
      }

      const m = p.match(/^\/night\/([A-Za-z0-9]{22})(?:\/api\/(state|events|write|next))?$/);
      if (!m) return send(res, 404, { error: 'not_found' });
      const [, token, action] = m;

      if (!action) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
        const n = await store.findNight(pool, token);
        if (!n) return send(res, 404, '<!doctype html><meta charset="utf-8"><title>לא נמצא</title><p dir="rtl" style="font-family:sans-serif;padding:24px">הקישור הזה לא מוביל לשום ערב.</p>', 'text/html; charset=utf-8');
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      if (action === 'events') return await events(req, res, token);
      if (action === 'state') {
        const n = await store.findNight(pool, token);
        if (!n) return send(res, 404, { error: 'not_found' });
        return send(res, 200, await store.stateOf(pool, n));
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method' });
      if (limited('n:' + token) || limited('c:' + clientOf(req))) return send(res, 429, { error: 'rate_limited' });
      const body = await readBody(req);
      if (action === 'write') {
        const { closed, ...out } = await store.write(pool, token, body);
        broadcast(token, out.state);
        // A tap on the page that closes the count announces it too. Nobody is
        // waiting on the answer here, so a brokerd that cannot be reached
        // costs the message and nothing else — the page already shows it.
        if (closed) {
          Promise.resolve().then(() => announce(pool, closed, out.state))
            .then(r => { if (!r || !r.ok) throw new Error(r && r.error || 'no answer'); })
            .catch(e => console.error('[gamesd] announcing a closed night failed:', e && e.message || e));
        }
        return send(res, 200, out);
      }
      // action === 'next'
      const n = await store.nextNight(pool, token, body);
      return send(res, 201, { token: n.token, url: `${publicBase}/night/${n.token}` });
    } catch (e) {
      return fail(res, e);
    }
  };

  const server = http.createServer(handler);
  server.closeListeners = () => { for (const set of listeners.values()) for (const r of set) r.end(); };
  return server;
}

module.exports = { createServer };
