'use strict';
// gamesd's HTTP face. Caddy passes exactly two public shapes here:
//   GET  /night/<token>                the page
//   *    /night/<token>/api/<action>   its API (state, events, write, next)
// Everything else (/health, POST /api/nights) is for the box itself: Caddy
// never routes it, and the handler also refuses anything that arrived through
// a proxy, so a Caddyfile mistake cannot open night creation to the world.
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Refused } = require('./validate');

const PAGE_FILE = path.join(__dirname, '..', 'public', 'night.html');
const MAX_BODY = 32 * 1024;
const WRITES_PER_MIN = 120;          // per night and, separately, per client
const MAX_LISTENERS_PER_NIGHT = 60;
const MAX_LISTENERS = 600;

const STATUS = { not_found: 404, too_many: 429, rate_limited: 429 };

function createServer({ pool, publicBase = '', page } = {}) {
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
        const out = await store.write(pool, token, body);
        broadcast(token, out.state);
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
