#!/usr/bin/env node
// The personal dashboard, for real, on this laptop — so a change to the page
// can be tried in a browser before it is merged, because merging is deploying.
//
// Builds a throwaway database from the real migrations, seeds one person with a
// list worth dragging around, serves the real dashboard on localhost, and
// prints a sign-in link. Nothing here reaches the box, the gateway or anybody's
// WhatsApp: the database is local, and the openclaw home is a temp directory
// (the same isolation tests/helpers.js sets, for the same reason).
//
//   node scripts/demo-dashboard.js            # http://localhost:8790
//   OLMA_DEMO_PORT=8791 node scripts/demo-dashboard.js
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.OLMA_IMMUTABLE_IDENTITY = 'off';
process.env.OLMA_OPENCLAW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-demo-home-'));
process.env.OLMA_OPENCLAW_CONFIG = path.join(process.env.OLMA_OPENCLAW_HOME, 'openclaw.json');
fs.writeFileSync(process.env.OLMA_OPENCLAW_CONFIG, JSON.stringify({
  agents: { defaults: {}, entries: {} }, bindings: [], channels: {},
}));

require('../src/db/types');
const { Client } = require('pg');
const { migrate } = require('../src/db/migrate');
const { createPool, withTx } = require('../src/db/pool');
const { createDashboard } = require('../src/adapters/http/dashboard');
const users = require('../src/domain/users');
const tasks = require('../src/domain/tasks');
const auth = require('../src/domain/dashboard-auth');
const connections = require('../src/domain/connections');
const shares = require('../src/domain/shares');

const ADMIN_URL = process.env.OLMA_TEST_ADMIN_URL || 'postgres://olma:olma2local@127.0.0.1:5432/olma2_test';
const DB = 'olma2_demo_dashboard';
const PORT = parseInt(process.env.OLMA_DEMO_PORT || '8790', 10);

function zoned(daysAhead, hhmm) {
  // A wall-clock moment in Asia/Jerusalem, with its offset, the way the page sends one.
  const d = new Date(Date.now() + daysAhead * 86400e3);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', timeZoneName: 'longOffset' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
  return `${day}T${hhmm}:00${off}`;
}

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, '/' + DB);
  const setup = new Client({ connectionString: url });
  await setup.connect();
  try { await migrate(setup); } finally { await setup.end(); }

  const pool = createPool(url);
  const mk = async (phone, firstName) => {
    const r = await withTx(pool, (c) => users.createUser(c, { phone, firstName }));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.data.user;
  };
  const me = await mk('+972500000001', 'מירון');
  const friend = await mk('+972500000002', 'גלי');
  await pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem', timezone_confirmed = true, locale = 'he'`);

  const add = async (title, extra = {}) => {
    const r = await withTx(pool, (c) => tasks.addTask(c, me.id, { title, source: 'dashboard', ...extra }));
    if (!r.ok) throw new Error(title + ': ' + JSON.stringify(r.error));
    return r.data.task;
  };
  await add('להתקשר לרופא שיניים', { dueAt: zoned(0, '16:00'), category: 'health' });
  await add('פגישה עם רואה החשבון', { dueAt: zoned(0, '18:30'), category: 'money', kind: 'event' });
  await add('לקנות חלב', { category: 'errands' });
  await add('לקנות לחם', { category: 'errands' });
  await add('ביצים');
  await add('לתקן את הברז במטבח', { category: 'home' });
  await add('להחזיר ספר לספרייה', { category: 'errands' });
  await add('לשלם ארנונה', { dueAt: zoned(1, '00:00'), category: 'money' });
  await add('להכין מצגת לישיבה', { category: 'work' });
  const list = await add('קניות לשבת', { category: 'errands' });
  for (const t of ['עגבניות', 'גבינה']) await add(t, { parentId: list.id });
  const trip = await add('לתכנן את הטיול', { category: 'family' });
  const req = await withTx(pool, (c) => connections.requestConnection(c, me.id, friend.phone));
  await withTx(pool, (c) => connections.respondToConnection(c, friend.id, req.data.connection.id, 'approve'));
  const offer = await withTx(pool, (c) => shares.offerShare(c, me.id, trip.id, friend.id, 'viewer'));
  await withTx(pool, (c) => shares.respondToShare(c, friend.id, offer.data.share.id, 'accept'));

  // The real app, behind one demo-only shim. /me/act refuses a write whose
  // Origin is not https://<host> (adapters/http/user-dashboard.js, sameOrigin),
  // which is right for production and refuses every write on plain-http
  // localhost. So the page's own origin is presented as the https one it
  // stands for; any OTHER origin is passed through and still refused.
  const app = createDashboard({ pool, adminUser: 'demo', adminPass: 'demo-password-not-real' });
  const handle = app.listeners('request')[0];
  const server = http.createServer((req, res) => {
    if (req.headers.origin === 'http://' + req.headers.host) req.headers.origin = 'https://' + req.headers.host;
    // OLMA_DEMO_FAIL_DATA=1 breaks /me/data on purpose. The page's boot veil is
    // the one screen that cannot be reached by using the app correctly, and a
    // state nobody can see is a state nobody maintains — this is how it gets
    // looked at. Nothing else is touched, so the rest of the page still serves.
    if (process.env.OLMA_DEMO_FAIL_DATA === '1' && req.url === '/me/data') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"ok":false,"error":{"code":"demo","message":"failing on purpose"}}');
      return;
    }
    // Every write, and how it was answered — the page is fire-and-forget, so
    // this line is the only place a refused drop is visible from outside a
    // browser's devtools. Reading req's OWN body here (to log the payload) is
    // exactly the bug it would exist to catch: the real handler's readJsonBody
    // attaches its 'data'/'end' listeners only after an await (currentUser),
    // by which point a listener attached here has already put the stream in
    // flowing mode and drained it — the real listener's 'end' then never
    // fires and the request hangs forever, unlogged, because res.end is never
    // reached either. So this only ever wraps the RESPONSE, never the request.
    if (req.url === '/me/act') {
      const write = res.write.bind(res), end = res.end.bind(res);
      let out = '';
      res.write = (c, ...a) => { out += c; return write(c, ...a); };
      res.end = (c, ...a) => {
        if (c) out += c;
        console.log(`[demo] ${new Date().toISOString().slice(11, 19)} POST /me/act ${res.statusCode} origin=${req.headers.origin || '-'} -> ${String(out).slice(0, 200)}`);
        return end(c, ...a);
      };
    }
    handle(req, res);
  });
  server.listen(PORT, '127.0.0.1', async () => {
    const link = await withTx(pool, (c) => auth.createLink(c, me.id));
    console.log(`[demo] dashboard on http://localhost:${PORT}`);
    console.log(`[demo] sign in: http://localhost:${PORT}/d/${link.data.token}`);
  });
  const stop = () => { server.close(); pool.end().then(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
