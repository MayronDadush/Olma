'use strict';
// The dashboard links Olma sends on her own (owner, 2026-09-15): a short URL
// whose row says where it lands, a coordination's page with the invite and on
// opening one, and the task list after a long dump or under a long morning
// list — at most once a week. Each half has its own way of going wrong:
//
//   - a link that lands somewhere the person no longer belongs;
//   - a phone that is already signed in being made to spend a key anyway;
//   - the page offered again and again, whichever door offered it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createDashboard } = require('../src/adapters/http/dashboard');
const { instructionFor, offersDashboardLink, dashboardUrlFor } = require('../src/channels/openclaw');
const auth = require('../src/domain/dashboard-auth');
const meetings = require('../src/domain/meetings');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const flags = require('../src/domain/flags');
const tasksDomain = require('../src/domain/tasks');
const { BY_NAME } = require('../src/adapters/mcp/registry');

let db, server, base, ann, ben;
before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972532200001', { firstName: 'Ann' });
  ben = await makeUser(db.pool, '+972532200002', { firstName: 'Ben' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem', locale = 'he'`);
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
const get = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts });
const tokenOf = (url) => url.split('/d/')[1];
const cookieFrom = (res) => String(res.headers.get('set-cookie') || '').split(';')[0];
const row = async (u) => (await db.pool.query(`SELECT * FROM users WHERE id = $1`, [u.id])).rows[0];
const call = async (name, u, args) => {
  const fresh = await row(u);
  return tx((c) => BY_NAME.get(name).handler(c, fresh, args));
};
const forgetTaskLinks = (u) => db.pool.query(`DELETE FROM magic_links WHERE user_id = $1 AND target = 'tasks'`, [u.id]);

async function signIn(u) {
  const made = await tx((c) => auth.createLink(c, u.id));
  const res = await get('/d/' + made.data.token, { method: 'POST' });
  assert.equal(res.status, 303);
  return cookieFrom(res);
}

// ---- where a link lands ----------------------------------------------------

test('a tasks link lands on the list, through the button and through a signed-in phone', async () => {
  const link = await tx((c) => auth.createLinkUrl(c, ann.id, { view: 'tasks' }));
  assert.equal(link.ok, true);
  assert.equal(link.data.view, 'tasks');
  assert.ok(link.data.url.length < 60, `still a long link: ${link.data.url}`);
  const token = tokenOf(link.data.url);

  // With no session: the button, and pressing it lands on the list.
  const page = await get('/d/' + token);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes(`action="/d/${token}"`));
  const post = await get('/d/' + token, { method: 'POST' });
  assert.equal(post.headers.get('location'), '/me#tasks');
});

test('an already signed-in phone goes straight in and does not spend the link', async () => {
  const cookie = await signIn(ann);
  const m = Number((await tx((c) => meetings.startMeeting(c, ann.id, 'ארוחה', [ben.id]))).data.meeting.id);
  const link = await tx((c) => auth.createLinkUrl(c, ann.id, { meetingId: m }));
  const token = tokenOf(link.data.url);

  const res = await get('/d/' + token, { headers: { cookie } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/me#meeting=${m}`);
  assert.equal(res.headers.get('set-cookie'), null, 'a GET opened a session');
  assert.equal((await tx((c) => auth.peekLink(c, token))).ok, true, 'a signed-in visit spent the link');

  // Somebody ELSE's session is not a shortcut: pressing the button is what
  // switches whose page this is.
  const bens = await signIn(ben);
  const other = await get('/d/' + token, { headers: { cookie: bens } });
  assert.equal(other.status, 200);
  assert.ok((await other.text()).includes('method="POST"'));
});

test('a meeting link for somebody who has since left it lands on the front page', async () => {
  const m = Number((await tx((c) => meetings.startMeeting(c, ann.id, 'טיול', [ben.id]))).data.meeting.id);
  const link = await tx((c) => auth.createLinkUrl(c, ben.id, { meetingId: m }));
  await tx((c) => meetings.optOut(c, ben.id, m));
  const post = await get('/d/' + tokenOf(link.data.url), { method: 'POST' });
  assert.equal(post.status, 303);
  assert.equal(post.headers.get('location'), '/me');
});

// ---- meetings ----------------------------------------------------------------

test('opening a coordination from chat hands back its page, and the two-options offer does not repeat it', async () => {
  const res = await call('start_meeting_coordination', ann, { title: 'פוקר', phones: [ben.phone] });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const mid = Number(res.data.meeting.id);
  assert.match(res.data.dashboard.url, /\/d\/[A-Za-z0-9]{22}$/);
  assert.equal(res.data.dashboard.meetingId, mid);
  assert.ok(res.data.dashboard.sendLinkVerbatim, 'a url with nothing saying it must be sent');
  assert.match(res.data.hints.dashboard, /dashboard\.url/);

  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND event = 'meeting.dashboard_offered'
        AND (detail->>'meetingId')::bigint = $2`, [ann.id, mid]);
  assert.equal(rows[0].n, 1);

  const now = Date.now();
  const at = (h) => new Date(Math.ceil((now + h * 3600e3) / 60e3) * 60e3).toISOString();
  const t1 = at(30);
  const t2 = at(54);
  await call('propose_meeting_slot', ann, { meeting_id: mid, slot_description: 'a', starts_at: t1 });
  const two = await call('propose_meeting_slot', ann, { meeting_id: mid, slot_description: 'b', starts_at: t2 });
  assert.equal(two.ok, true, JSON.stringify(two.error));
  assert.equal(two.data.hints && two.data.hints.dashboard, undefined, 'the page was offered twice');
});

// The invite carries the page as CHARACTERS. It used to carry the sentence
// "call open_my_dashboard with meeting_id=N and put its url here", and on
// 2026-09-22 the first room fan-out after that shipped sent three people three
// different invented domains, each ending in the meeting id the instruction
// had handed over, with not one link minted. So the url is minted at delivery
// and passed in; no url, no clause, and never a number to build one out of.
const URL = 'https://allma.world/d/AbCdEfGhIjKlMnOpQrStUv';
test('the invite carries the page itself, in a private invite and a room\'s', () => {
  const plain = instructionFor({ kind: 'meeting_invite', payload: { meetingId: 41, title: 'x', byName: 'Ann' } }, URL);
  assert.ok(plain.includes(URL));
  const room = instructionFor({ kind: 'meeting_invite', payload: { meetingId: 42, title: 'x', byName: 'Ann', groupSubject: 'פאדל' } }, URL);
  assert.ok(room.includes(URL));
  const none = instructionFor({ kind: 'meeting_invite', payload: { title: 'x', byName: 'Ann' } }, URL);
  assert.ok(!none.includes(URL), 'a payload with no meeting still offered a page');
  // …and the folded table question, which is the invite asked late. Not a
  // plain proposal or a decline (owner, 2026-09-20: shorter; the link is
  // above whatever they are reading by then), and the link line carries no
  // sentence about it.
  const table = instructionFor({ kind: 'meeting_slot_proposed', payload: { meetingId: 43, title: 'x', byName: 'Ann', tableChanged: true } }, URL);
  assert.ok(table.includes(URL));
  const one = instructionFor({ kind: 'meeting_slot_proposed', payload: { meetingId: 43, title: 'x', byName: 'Ann', slot: 'a' } }, URL);
  assert.ok(!one.includes(URL));
  const no = instructionFor({ kind: 'meeting_slot_declined', payload: { meetingId: 43, title: 'x', byName: 'Ann' } }, URL);
  assert.ok(!no.includes(URL));
  for (const body of [plain, room, table]) {
    assert.doesNotMatch(body, /answering here/);
    assert.match(body, /on a line of its own, with no sentence about it/);
    // The half that broke: nothing anywhere asks the model to go and get a url.
    assert.doesNotMatch(body, /open_my_dashboard/);
  }
  // And with no url in hand there is no clause at all — the message still asks
  // its question, which is the half that matters, and says nothing about a page.
  for (const kind of ['meeting_invite', 'meeting_slot_proposed']) {
    const dry = instructionFor({ kind, payload: { meetingId: 44, title: 'x', byName: 'Ann', tableChanged: true } });
    assert.doesNotMatch(dry, /line of its own/);
    assert.doesNotMatch(dry, /open_my_dashboard|allma\.world|\burl\b/i);
  }
});

// The deliverer mints a link only for a row that will actually carry one, and
// it works that out by ASKING the builder rather than keeping its own list of
// kinds — two lists is how the clause and the mint come to disagree.
test('what gets a link minted for it is exactly what would print one', () => {
  const rows = [
    [{ kind: 'meeting_invite', payload: { meetingId: 41, title: 'x', byName: 'Ann' } }, true],
    [{ kind: 'meeting_invite', payload: { meetingId: 42, title: 'x', byName: 'Ann', groupSubject: 'פאדל' } }, true],
    [{ kind: 'meeting_invite', payload: { meetingId: 42, title: 'x', byName: 'Ann', askedItYourself: true } }, true],
    [{ kind: 'meeting_invite', payload: { title: 'x', byName: 'Ann' } }, false],
    [{ kind: 'meeting_slot_proposed', payload: { meetingId: 43, title: 'x', byName: 'Ann', tableChanged: true } }, true],
    [{ kind: 'meeting_slot_proposed', payload: { meetingId: 43, title: 'x', byName: 'Ann', slot: 'a' } }, false],
    [{ kind: 'meeting_slot_declined', payload: { meetingId: 43, title: 'x', byName: 'Ann' } }, false],
    [{ kind: 'meeting_confirmed', payload: { meetingId: 43, title: 'x', slot: 'a' } }, false],
    [{ kind: 'digest', payload: {} }, false],
    [{ kind: 'reminder', payload: { title: 'x', rung: 1 } }, false],
  ];
  for (const [row, want] of rows) {
    assert.equal(offersDashboardLink(row), want, `${row.kind}: ${JSON.stringify(row.payload)}`);
    // the two answers are the same answer
    assert.equal(instructionFor(row, URL).includes(URL), want);
  }
  // A row whose payload cannot even be read is a row we mint nothing for.
  assert.equal(offersDashboardLink({ kind: 'meeting_invite', payload: '{not json' }), false);
});

// The whole road, on the shape that failed: an invite row for a real meeting
// comes out of the deliverer's hands with a real link in the instruction. This
// is the test the old design could not have — there was nothing to assert on,
// because the url only ever existed inside a model turn.
test('an invite row is handed a link that was really minted, and the instruction carries it', async () => {
  const started = await call('start_meeting_coordination', ann, { title: 'ערב משחקים', phones: [ben.phone] });
  assert.equal(started.ok, true, JSON.stringify(started.error));
  const mid = Number(started.data.meeting.id);

  const invite = { kind: 'meeting_invite', user_id: ben.id,
    payload: { meetingId: mid, title: 'ערב משחקים', byName: 'Ann', groupSubject: 'משחקים' } };
  const url = await dashboardUrlFor(db.pool, invite);
  assert.match(String(url), /^https?:\/\/\S+\/d\/[A-Za-z0-9]{22}$/, 'no link was minted for an invite');

  const { rows } = await db.pool.query(
    `SELECT target, meeting_id FROM magic_links WHERE user_id = $1 AND target = 'meeting'
        AND meeting_id = $2`, [ben.id, mid]);
  assert.equal(rows.length, 1, 'the link exists in the table the page reads it from');

  const body = instructionFor(invite, url);
  assert.ok(body.includes(url), 'the instruction does not carry the url it was given');
  assert.doesNotMatch(body, /open_my_dashboard/);

  // …and nothing is minted for somebody the coordination does not include, or
  // for a kind that never offers a page. A key is five per person and the
  // oldest is evicted, so a link nobody was going to be shown costs a real one.
  const stranger = { ...invite, user_id: ann.id, payload: { ...invite.payload, meetingId: mid + 9999 } };
  assert.equal(await dashboardUrlFor(db.pool, stranger), null);
  assert.equal(await dashboardUrlFor(db.pool, { kind: 'digest', user_id: ben.id, payload: {} }), null);
});

// ---- tasks -------------------------------------------------------------------

const items = (n, tag) => Array.from({ length: n }, (_, i) => ({ title: `${tag} ${i + 1}` }));

test('a long dump gets the list\'s page, a short one does not, and never twice in a week', async () => {
  await forgetTaskLinks(ann);
  const short = await call('add_tasks_bulk', ann, { items: items(3, 'קצר') });
  assert.equal(short.ok, true, JSON.stringify(short.error));
  assert.equal(short.data.dashboard, undefined, 'three tasks earned a page');

  const long = await call('add_tasks_bulk', ann, { items: items(4, 'ארוך') });
  assert.equal(long.ok, true, JSON.stringify(long.error));
  assert.match(long.data.dashboard.url, /\/d\/[A-Za-z0-9]{22}$/);
  assert.equal(long.data.dashboard.view, 'tasks');
  assert.ok(long.data.dashboard.sendLinkVerbatim);
  // it says the link is a reason to write, in markPlaced's own terms
  assert.match(long.data.hints.dashboard, /cannot carry a link/);

  const again = await call('add_tasks_bulk', ann, { items: items(5, 'שוב') });
  assert.equal(again.ok, true);
  assert.equal(again.data.dashboard, undefined, 'offered twice inside a week');

  // A breakdown of one goal into parts is not a list to go and arrange.
  await forgetTaskLinks(ann);
  const parent = (await tx((c) => tasksDomain.addTask(c, ann.id, { title: 'מעבר דירה' }))).data.task;
  const parts = await call('add_tasks_bulk', ann, { items: items(5, 'חלק'), parent_task_id: Number(parent.id) });
  assert.equal(parts.ok, true, JSON.stringify(parts.error));
  assert.equal(parts.data.dashboard, undefined);
});

test('a long morning list draws the page link as the block\'s last line; a short one does not', async () => {
  await db.pool.query(`DELETE FROM tasks WHERE owner_id = $1`, [ben.id]);
  await forgetTaskLinks(ben);
  await flags.setFlag(db.pool, 'digest_card_min_items', 0);
  for (let i = 0; i < 5; i++) await tx((c) => tasksDomain.addTask(c, ben.id, { title: `בוקר ${i + 1}` }));

  const five = await call('get_my_digest', ben, { scope: 'full' });
  assert.equal(five.ok, true, JSON.stringify(five.error));
  assert.doesNotMatch(five.data.block, /\/d\//, 'five open tasks earned a page');

  await tx((c) => tasksDomain.addTask(c, ben.id, { title: 'בוקר 6' }));
  const six = await call('get_my_digest', ben, { scope: 'full' });
  const lines = six.data.block.trim().split('\n');
  assert.match(lines[lines.length - 1], /^https?:\/\/\S+\/d\/[A-Za-z0-9]{22}$/, 'the link is not the last line');
  assert.equal(lines[lines.length - 2], 'כל הרשימה במסך אחד, לעריכה ולסידור:');
  assert.equal(six.data.dashboard, undefined, 'the link rode twice: in the block and beside it');

  const seven = await call('get_my_digest', ben, { scope: 'full' });
  assert.doesNotMatch(seven.data.block, /\/d\//, 'the page was offered two mornings running');
});

test('on the card path the link rides the result, since there is no block to draw it into', async () => {
  await forgetTaskLinks(ben);
  await flags.setFlag(db.pool, 'digest_card_min_items', 3);
  const card = await call('get_my_digest', ben, { scope: 'full' });
  assert.equal(card.ok, true);
  assert.equal(card.data.block, undefined);
  assert.match(card.data.dashboard.url, /\/d\/[A-Za-z0-9]{22}$/);
  assert.ok(card.data.dashboard.sendLinkVerbatim);
  assert.match(card.data.hints.dashboard, /After the MEDIA line/);
  await flags.setFlag(db.pool, 'digest_card_min_items', 0);
});
