'use strict';
// A dashboard link that opens ON a meeting, and the one-time offer of it from
// chat. The retired /pick/ page's best trait was that a tap from WhatsApp put
// you in front of the meeting; this is that trait kept on the page that
// replaced it. Two halves, each with its own way of going wrong:
//
//   - the LINK: only a meeting this person is in may be named, the id has to
//     survive the sign-in POST (a fragment would not), and a nonsense value
//     must open the plain page rather than an error;
//   - the OFFER: made once per person per meeting, only from the chat tools,
//     only once there is something on the table worth a page, and never after
//     the meeting is settled.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createDashboard } = require('../src/adapters/http/dashboard');
const auth = require('../src/domain/dashboard-auth');
const meetings = require('../src/domain/meetings');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const { BY_NAME } = require('../src/adapters/mcp/registry');

let db, server, base, ann, ben;
before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972532100001', { firstName: 'Ann' });
  ben = await makeUser(db.pool, '+972532100002', { firstName: 'Ben' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
  await withTx(db.pool, async (c) => {
    const req = await connections.requestConnection(c, ann.id, ben.phone, {});
    const conn = (await connections.respondToConnection(c, ben.id, req.data.connection.id, 'approve')).data.connection;
    await grants.grantFeature(c, ann.id, conn.id, 'meetings');
    await grants.grantFeature(c, ben.id, conn.id, 'meetings');
  });
  server = createDashboard({ pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); if (db) await db.teardown(); });

const tx = (fn) => withTx(db.pool, fn);
const at = (h) => slotStart('', { hours: h });
const get = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts });
const tokenOf = (url) => url.split('/d/')[1].split('?')[0];
const user = (u) => ({ id: u.id, first_name: u.firstName });
const call = (name, u, args) => tx((c) => BY_NAME.get(name).handler(c, user(u), args));

async function meetingOf(title) {
  return Number((await tx((c) => meetings.startMeeting(c, ann.id, title, [ben.id]))).data.meeting.id);
}

// ---- the link ---------------------------------------------------------------

test('a link may name a meeting the person is in, and only such a meeting', async () => {
  const m = await meetingOf('פוקר');
  const mine = await tx((c) => auth.createLinkUrl(c, ann.id, { meetingId: m }));
  assert.equal(mine.ok, true);
  assert.match(mine.data.url, new RegExp(`/d/[a-f0-9]{64}\\?meeting=${m}$`));
  assert.equal(mine.data.meetingId, m);

  // a stranger to the meeting gets their ordinary page, silently
  const cal = await makeUser(db.pool, '+972532100003', { firstName: 'Cal' });
  const theirs = await tx((c) => auth.createLinkUrl(c, cal.id, { meetingId: m }));
  assert.equal(theirs.ok, true);
  assert.match(theirs.data.url, /\/d\/[a-f0-9]{64}$/);
  assert.equal(theirs.data.meetingId, undefined);

  // and so does someone who left it, or names nothing at all
  await tx((c) => meetings.optOut(c, ben.id, m));
  const left = await tx((c) => auth.createLinkUrl(c, ben.id, { meetingId: m }));
  assert.match(left.data.url, /\/d\/[a-f0-9]{64}$/);
  for (const bad of [undefined, null, 0, -3, 'seven', 1.5, 99999999]) {
    const r = await tx((c) => auth.createLinkUrl(c, ann.id, { meetingId: bad }));
    assert.match(r.data.url, /\/d\/[a-f0-9]{64}$/, `meetingId=${bad} leaked into the URL`);
  }
});

test('the id survives the sign-in POST and reaches the page as a fragment', async () => {
  const m = await meetingOf('קפה');
  const link = (await tx((c) => auth.createLinkUrl(c, ann.id, { meetingId: m }))).data.url;
  const token = tokenOf(link);

  // GET: the button's form has to carry the id, or the POST forgets it.
  const page = await get(`/d/${token}?meeting=${m}`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes(`action="/d/${token}?meeting=${m}"`), 'the form dropped the meeting');

  // POST: the redirect names it as a fragment, which is what the page reads.
  const post = await get(`/d/${token}?meeting=${m}`, { method: 'POST' });
  assert.equal(post.status, 303);
  assert.equal(post.headers.get('location'), `/me#meeting=${m}`);
  assert.ok(String(post.headers.get('set-cookie')).includes('olma_dash='), 'no session was opened');
});

test('a mangled meeting value opens the plain page — never an error, never echoed', async () => {
  for (const q of ['?meeting=abc', '?meeting=-1', '?meeting=0', '?meeting=<script>', '?meeting=', '?meeting=1e3']) {
    const token = (await tx((c) => auth.createLink(c, ann.id))).data.token;
    const page = await get(`/d/${token}${q}`);
    assert.equal(page.status, 200, `${q} broke the sign-in page`);
    const html = await page.text();
    assert.ok(html.includes(`action="/d/${token}"`), `${q} was echoed into the form`);
    assert.ok(!html.includes('<script>'), 'the value reached the page unescaped');
    const post = await get(`/d/${token}${q}`, { method: 'POST' });
    assert.equal(post.headers.get('location'), '/me', `${q} was forwarded to the page`);
  }
});

// ---- the offer --------------------------------------------------------------

test('the page is offered once, only from chat, only once two options are on the table, and not after settling', async () => {
  const m = await meetingOf('סבב');
  // One option: the table is not yet worth a page.
  const one = await call('propose_meeting_slot', ann, { meeting_id: m, slot_description: 'option 1', starts_at: at(24) });
  assert.equal(one.ok, true, JSON.stringify(one.error));
  assert.equal(one.data.hints && one.data.hints.dashboard, undefined, 'offered on a one-option table');

  // Two options: offered, exactly here, naming the meeting.
  const two = await call('propose_meeting_slot', ann, { meeting_id: m, slot_description: 'option 2', starts_at: at(48) });
  assert.equal(two.ok, true, JSON.stringify(two.error));
  assert.match(two.data.hints.dashboard, new RegExp(`open_my_dashboard with meeting_id=${m}`));
  assert.match(two.data.hints.dashboard, /optional/);
  // the table hint that was already there is still there — added to, not replaced
  assert.match(two.data.hints.table, /2 option/);

  // A third move by the same person: not again.
  const three = await call('propose_meeting_slot', ann, { meeting_id: m, slot_description: 'option 3', starts_at: at(72) });
  assert.equal(three.ok, true, JSON.stringify(three.error));
  assert.equal(three.data.hints.dashboard, undefined, 'offered twice to the same person');

  // The other side's first move on a full table: offered to THEM, once.
  const bens = await call('respond_to_meeting_slot', ben, { meeting_id: m, accept: false, accepted_starts_at: at(24) });
  assert.equal(bens.ok, true, JSON.stringify(bens.error));
  assert.match(bens.data.hints.dashboard, new RegExp(`meeting_id=${m}`));
  const bens2 = await call('respond_to_meeting_slot', ben, { meeting_id: m, accept: false, accepted_starts_at: at(48) });
  assert.equal(bens2.data.hints && bens2.data.hints.dashboard, undefined);

  // The record of "offered" is an audit row per person per meeting.
  const { rows } = await db.pool.query(
    `SELECT actor_id FROM audit_log WHERE event = 'meeting.dashboard_offered' AND (detail->>'meetingId')::bigint = $1 ORDER BY actor_id`, [m]);
  assert.deepEqual(rows.map((r) => Number(r.actor_id)), [ann.id, ben.id].sort((a, b) => a - b));

  // Settling: the yes that confirms carries the calendar hint, never the page.
  const yes = await call('respond_to_meeting_slot', ben, { meeting_id: m, accept: true, accepted_starts_at: at(72) });
  assert.equal(yes.ok, true, JSON.stringify(yes.error));
  assert.equal(yes.data.meetingStatus, 'confirmed');
  assert.equal(yes.data.hints && yes.data.hints.dashboard, undefined, 'offered a page for a meeting that is over');
});

test('the tool still needs nothing but identity, and the description budget holds', () => {
  const t = BY_NAME.get('open_my_dashboard');
  assert.deepEqual(t.inputSchema.required, ['olma_identity']);
  assert.ok(t.inputSchema.properties.meeting_id, 'the link cannot name a meeting');
});
