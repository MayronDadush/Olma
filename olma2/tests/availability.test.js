'use strict';
// The availability picker: link lifecycle, server-side validation of what the
// page submits, UTC-correct overlap, and the notification fan-out. The page
// itself is exercised over real HTTP against the dashboard server, like the
// OAuth callback tests one file over.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const meetings = require('../src/domain/meetings');
const availability = require('../src/domain/availability');
const { createDashboard } = require('../src/adapters/http/dashboard');

let db, alice, bob, carol, server, base;

before(async () => {
  db = await freshDb();
  alice = await makeUser(db.pool, '+972531000001', { firstName: 'Alice' });
  bob = await makeUser(db.pool, '+972531000002', { firstName: 'Bob' });
  carol = await makeUser(db.pool, '+972531000003', { firstName: 'Carol' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
  alice.timezone = bob.timezone = carol.timezone = 'Asia/Jerusalem';
  const c = await db.pool.connect();
  try {
    for (const [x, y] of [[alice, bob], [alice, carol], [bob, carol]]) {
      const req = await connections.requestConnection(c, x.id, y.phone, {});
      const conn = (await connections.respondToConnection(c, y.id, req.data.connection.id, 'approve')).data.connection;
      await grants.grantFeature(c, x.id, conn.id, 'meetings');
      await grants.grantFeature(c, y.id, conn.id, 'meetings');
    }
  } finally { c.release(); }

  server = createDashboard({ pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await db.teardown();
});

const withClient = async (fn) => {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
};
const tx = (fn) => withTx(db.pool, fn);

const today = availability.todayInTz('Asia/Jerusalem');
const plus = (n) => {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const opt = (over = {}) => {
  const o = { start_date: plus(3), parts: ['evening'], hour: null, ...over };
  o.end_date = over.end_date || o.start_date;
  return o;
};

async function newMeeting(initiator, others) {
  return withClient(async (c) => (await meetings.startMeeting(c, initiator.id, 'פוקר', others.map((u) => u.id))).data.meeting);
}
async function outboxFor(userId, kind) {
  const { rows } = await db.pool.query(
    `SELECT * FROM outbox WHERE user_id = $1 AND kind = $2 AND sent_at IS NULL ORDER BY id`, [userId, kind]);
  return rows;
}
const tokenOf = (url) => url.match(/\/pick\/([a-f0-9]{48})$/)[1];

// ---- validation -------------------------------------------------------------

test('options are validated server-side: count, dates, vocabulary', () => {
  const tz = 'Asia/Jerusalem';
  assert.equal(availability.normalizeOptions([], tz).ok, false);
  assert.equal(availability.normalizeOptions(Array.from({ length: 11 }, () => opt()), tz).ok, false);
  assert.equal(availability.normalizeOptions([opt({ start_date: plus(-1), end_date: plus(-1) })], tz).ok, false, 'past date refused');
  assert.equal(availability.normalizeOptions([opt({ parts: ['brunch'] })], tz).ok, false, 'unknown daypart refused');
  assert.equal(availability.normalizeOptions([opt({ parts: [] })], tz).ok, false, 'no daypart refused');
  assert.equal(availability.normalizeOptions([opt({ parts: ['hour'] })], tz).ok, false, 'hour part needs an hour');
  assert.equal(availability.normalizeOptions([opt({ end_date: plus(1) })], tz).ok, false, 'reversed range refused');
  assert.equal(availability.normalizeOptions([opt({ end_date: plus(30) })], tz).ok, false, 'over-long range refused');

  const good = availability.normalizeOptions(
    [opt(), opt({ start_date: plus(5), end_date: plus(7), parts: ['hour'], hour: '15:30' })], tz);
  assert.ok(good.ok);
  assert.match(good.data[0].label, /ערב/);
  assert.match(good.data[1].label, /15:30/);
  assert.equal(good.data[1].tz, tz);

  // A page cached from before multi-select still posts a bare `part`.
  const legacy = availability.normalizeOptions([{ start_date: plus(3), end_date: plus(3), part: 'night' }], tz);
  assert.ok(legacy.ok);
  assert.deepEqual(legacy.data[0].parts, ['night']);
});

test('what a set of ticked dayparts means is decided in ONE place', () => {
  const tz = 'Asia/Jerusalem';
  const parts = (list) => {
    const r = availability.normalizeOptions([opt({ parts: list, hour: '09:00' })], tz);
    return r.ok ? r.data[0].parts : r.error.message;
  };
  // Several spans of one day are one statement, stored in time order however
  // they were tapped.
  assert.deepEqual(parts(['evening', 'morning']), ['morning', 'evening']);
  assert.deepEqual(parts(['night', 'noon', 'noon']), ['noon', 'night'], 'duplicates collapse');
  // Every span IS "all day" — said shorter, so the label reads the way a
  // person would say it.
  assert.deepEqual(parts(['morning', 'noon', 'evening', 'night']), ['all_day']);
  // The two whole-day statements replace a selection, never join one. The
  // page enforces this by construction; the server must refuse it anyway,
  // since the page is a convenience and this is the copy that counts.
  assert.match(parts(['hour', 'morning']), /לא משתלבת/);
  assert.match(parts(['all_day', 'morning']), /לא משתלב/);

  const label = availability.normalizeOptions([opt({ parts: ['morning', 'night'] })], tz).data[0].label;
  assert.match(label, /בוקר \(08:00–12:00\) \+ לילה \(21:00–24:00\)/);
});

test('overlap is computed on UTC instants, honouring each side\'s timezone', () => {
  const d = plus(4);
  const at = (parts, hour, tz) => [{ start_date: d, end_date: d, parts, hour: hour || null, tz: tz || 'Asia/Jerusalem' }];
  // Same local evening in the same zone → the full window overlaps.
  const a = at(['evening']);
  const w = availability.overlapWindows([a, at(['hour'], '18:00')]);
  assert.equal(w.length, 1);
  assert.equal(w[0][1] - w[0][0], 60 * 60_000, 'the hour inside the evening');
  assert.match(availability.windowLabel(w[0], 'Asia/Jerusalem'), /18:00–19:00/);

  // 22:00 in London IS 00:00 in Jerusalem — past the Jerusalem evening.
  // Naive local-minute comparison would call this a match; UTC math must not.
  assert.equal(availability.overlapWindows([a, at(['hour'], '22:00', 'Europe/London')]).length, 0);

  // Disjoint parts → nothing.
  assert.equal(availability.overlapWindows([a, at(['morning'])]).length, 0);

  // A multi-part option contributes EVERY window it names: morning+night
  // against someone free all day meets twice, in two separate windows.
  const two = availability.overlapWindows([at(['morning', 'night']), at(['all_day'])]);
  assert.equal(two.length, 2);
  assert.match(availability.windowLabel(two[0], 'Asia/Jerusalem'), /08:00–12:00/);
  assert.match(availability.windowLabel(two[1], 'Asia/Jerusalem'), /21:00–24:00/);

  // The four spans tile the day exactly, so "all day" and "every span" are
  // the same availability — the collapse in canonicalParts loses nothing.
  const allDay = availability.overlapWindows([at(['all_day'])]);
  const everySpan = availability.overlapWindows([at(availability.SPAN_PARTS)]);
  assert.deepEqual(everySpan, allDay);
});

// ---- links ------------------------------------------------------------------

test('a link needs a live negotiation and an active participant, and is idempotent', async () => {
  const m = await newMeeting(alice, [bob]);
  const first = await tx((c) => availability.createLink(c, alice.id, m.id));
  assert.ok(first.ok);
  assert.match(first.data.url, /\/pick\/[a-f0-9]{48}$/);
  const again = await tx((c) => availability.createLink(c, alice.id, m.id));
  assert.equal(again.data.url, first.data.url, 'second ask reuses the live link');

  const stranger = await tx((c) => availability.createLink(c, carol.id, m.id));
  assert.equal(stranger.ok, false);
  assert.equal(stranger.error.code, 'not_found');

  await withClient((c) => meetings.cancelMeeting(c, alice.id, m.id));
  const closed = await tx((c) => availability.createLink(c, alice.id, m.id));
  assert.equal(closed.ok, false, 'no links for a closed meeting');
});

// ---- submit + notifications -------------------------------------------------

test('first submit notifies exactly the people still missing; the last one hands the initiator the overlap', async () => {
  const m = await newMeeting(alice, [bob, carol]);
  const link = (await tx((c) => availability.createLink(c, alice.id, m.id))).data;

  const r1 = await tx((c) => availability.submit(c, tokenOf(link.url), [opt(), opt({ start_date: plus(5), parts: ['morning'] })]));
  assert.ok(r1.ok);
  assert.equal(r1.data.allSubmitted, false);

  // Bob and Carol (who have not answered) hear about it; Alice does not.
  assert.equal((await outboxFor(bob.id, 'availability_shared')).length, 1);
  assert.equal((await outboxFor(carol.id, 'availability_shared')).length, 1);
  assert.equal((await outboxFor(alice.id, 'availability_shared')).length, 0);
  const payload = (await outboxFor(bob.id, 'availability_shared'))[0].payload;
  assert.equal(payload.fromName, 'Alice');
  assert.ok(payload.options.every((l) => typeof l === 'string'));

  // The same options again (double-tap) do not message anyone twice.
  await tx((c) => availability.submit(c, tokenOf(link.url), [opt(), opt({ start_date: plus(5), parts: ['morning'] })]));
  assert.equal((await outboxFor(bob.id, 'availability_shared')).length, 1);

  // Bob answers with an overlapping evening; still one person missing.
  const bobLink = (await tx((c) => availability.createLink(c, bob.id, m.id))).data;
  const r2 = await tx((c) => availability.submit(c, tokenOf(bobLink.url), [opt()]));
  assert.equal(r2.data.allSubmitted, false);
  assert.equal((await outboxFor(alice.id, 'availability_complete')).length, 0);

  // Carol closes the loop → ONE availability_complete, to the initiator only,
  // carrying the computed intersection.
  const carolLink = (await tx((c) => availability.createLink(c, carol.id, m.id))).data;
  const r3 = await tx((c) => availability.submit(c, tokenOf(carolLink.url), [opt({ parts: ['hour'], hour: '19:00' })]));
  assert.equal(r3.data.allSubmitted, true);
  const done = await outboxFor(alice.id, 'availability_complete');
  assert.equal(done.length, 1);
  assert.equal(done[0].urgency, 'urgent');
  assert.equal(done[0].payload.overlap.length, 1);
  assert.match(done[0].payload.overlap[0], /19:00–20:00/);
  assert.equal((await outboxFor(bob.id, 'availability_complete')).length, 0);

  // get_meeting_status now tells the whole story to any participant.
  const status = await withClient((c) => meetings.getStatus(c, bob.id, m.id));
  const byName = Object.fromEntries(status.data.participants.map((p) => [p.first_name, p.availability]));
  assert.equal(byName.Alice.length, 2);
  assert.match(byName.Carol[0], /19:00/);
});

test('a resubmission recomputes: no overlap left → the initiator is told honestly', async () => {
  const m = await newMeeting(alice, [bob]);
  const la = (await tx((c) => availability.createLink(c, alice.id, m.id))).data;
  const lb = (await tx((c) => availability.createLink(c, bob.id, m.id))).data;
  await tx((c) => availability.submit(c, tokenOf(la.url), [opt()]));
  await tx((c) => availability.submit(c, tokenOf(lb.url), [opt({ parts: ['morning'] })]));
  const done = (await outboxFor(alice.id, 'availability_complete'))
    .filter((r) => r.payload.meetingId === m.id);
  assert.equal(done.length, 1);
  assert.deepEqual(done[0].payload.overlap, [], 'disjoint options must not invent a window');
});

// ---- the page over real HTTP ------------------------------------------------

test('the page is public by token, renders RTL Hebrew, and a submit round-trips', async () => {
  const m = await newMeeting(alice, [bob]);
  const link = (await tx((c) => availability.createLink(c, alice.id, m.id))).data;
  const token = tokenOf(link.url);

  const page = await fetch(`${base}/pick/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  assert.match(html, /dir="rtl"/);
  assert.match(html, /פוקר/);
  assert.match(html, /Alice/);
  assert.match(html, /noindex/);

  const post = await fetch(`${base}/pick/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ options: JSON.stringify([opt()]) }),
  });
  assert.equal(post.status, 200);
  assert.match(await post.text(), /נשלח/);
  const { rows } = await db.pool.query(
    `SELECT options FROM meeting_availability WHERE meeting_id = $1 AND user_id = $2`, [m.id, alice.id]);
  assert.equal(rows[0].options.length, 1);
  assert.match(rows[0].options[0].label, /ערב/);

  // Garbage in → a Hebrew 400, nothing stored, nobody messaged.
  const bad = await fetch(`${base}/pick/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ options: JSON.stringify([opt({ parts: ['x'] })]) }),
  });
  assert.equal(bad.status, 400);
});

test('dead links each get their own honest page: unknown, expired, closed', async () => {
  const unknown = await fetch(`${base}/pick/${'a'.repeat(48)}`);
  assert.equal(unknown.status, 404);

  const m = await newMeeting(alice, [bob]);
  const link = (await tx((c) => availability.createLink(c, alice.id, m.id))).data;
  const token = tokenOf(link.url);
  await db.pool.query(`UPDATE picker_links SET expires_at = now() - interval '1 hour' WHERE token = $1`, [token]);
  const expired = await fetch(`${base}/pick/${token}`);
  assert.equal(expired.status, 410);
  assert.match(await expired.text(), /פג/);

  const m2 = await newMeeting(alice, [bob]);
  const link2 = (await tx((c) => availability.createLink(c, alice.id, m2.id))).data;
  await withClient((c) => meetings.cancelMeeting(c, alice.id, m2.id));
  const closed = await fetch(`${base}/pick/${tokenOf(link2.url)}`);
  assert.equal(closed.status, 410);
  assert.match(await closed.text(), /הסתיים/);

  // A POST to a closed meeting is refused the same way — the submit path
  // re-checks, it does not trust the GET that rendered the form.
  const post = await fetch(`${base}/pick/${tokenOf(link2.url)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ options: JSON.stringify([opt()]) }),
  });
  assert.equal(post.status, 410);
});

// ---- agent instructions -----------------------------------------------------

test('both picker instructions carry the delivery preamble and keep the confirm gate', () => {
  const { instructionFor } = require('../src/channels/openclaw');
  const shared = instructionFor({
    kind: 'availability_shared',
    payload: { meetingId: 7, title: 'פוקר', fromName: 'Alice', options: ['יום שלישי 2.9 — ערב (17:00–21:00)'] },
  });
  assert.match(shared, /^DELIVERY:/);
  assert.match(shared, /send_availability_picker meeting_id=7/);
  assert.match(shared, /Do not declare any slot agreed/);

  const done = instructionFor({
    kind: 'availability_complete',
    payload: { meetingId: 7, title: 'פוקר', overlap: ['יום שלישי 2.9 19:00–20:00'] },
  });
  assert.match(done, /^DELIVERY:/);
  assert.match(done, /propose_meeting_slot/);
  assert.match(done, /not agreement/);

  const none = instructionFor({
    kind: 'availability_complete', payload: { meetingId: 7, title: 'פוקר', overlap: [] },
  });
  assert.match(none, /NO window/);
  assert.match(none, /never pretend an overlap exists/);
});
