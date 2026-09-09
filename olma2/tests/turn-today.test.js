'use strict';
// "מה יש לי היום" used to cost a second model call: turn_start said
// `proceed`, the model called get_my_digest or list_my_tasks (268 calls in
// the fourteen days to 2026-09-09, most of them for today), and only then
// answered. The opening now carries today's picture, in the person's own
// zone, as data the model reads in the same call. What is under test is the
// zone boundary and the shape — a block that lists tomorrow's 01:00 as today
// because 22:00 UTC is still today would be wrong in the way "every time
// crossing a boundary needs an offset" warns about.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const turnDomain = require('../src/domain/turn');

const TZ = 'Asia/Jerusalem';
let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const counted = { data: { blocked: false } };
async function advise(user) {
  const client = await db.pool.connect();
  try {
    return await turnDomain.advise(client, user, { counted, firstTurn: false, ourTurn: false });
  } finally { client.release(); }
}

// A moment on the person's LOCAL calendar, built in SQL so the zone math is
// Postgres's and not a hand-rolled offset: `dayOffset` days from their today,
// at `hhmm` local ('00:00' is day-shaped).
async function at(dayOffset, hhmm) {
  const { rows: [r] } = await db.pool.query(
    `SELECT (((now() AT TIME ZONE $1)::date + $2::int) + $3::time) AT TIME ZONE $1 AS ts`,
    [TZ, dayOffset, hhmm]);
  return r.ts;
}
async function task(owner, title, { kind = 'todo', due, ends = null, location = null } = {}) {
  await db.pool.query(
    `INSERT INTO tasks (owner_id, title, kind, due_at, ends_at, location) VALUES ($1,$2,$3,$4,$5,$6)`,
    [owner.id, title, kind, due, ends, location]);
}

test('the opening carries today in their zone: events, to-dos, overdue count, no invented hours', async () => {
  const u = await makeUser(db.pool, '+972612200001', { firstName: 'Dana', timezone: TZ });
  await task(u, 'רופא שיניים', { kind: 'event', due: await at(0, '15:00'), ends: await at(0, '15:45'), location: 'רמת גן' });
  await task(u, 'לקנות מתנה', { due: await at(0, '00:00') });           // day-shaped
  await task(u, 'להתקשר לבנק', { due: await at(0, '10:30') });
  await task(u, 'ביטוח רכב', { due: await at(-1, '09:00') });          // overdue to-do
  await task(u, 'שיעור אתמול', { kind: 'event', due: await at(-1, '18:00') }); // a passed event is not "overdue"
  await task(u, 'מחר בבוקר', { due: await at(1, '01:00') });           // 22:00 UTC today — tomorrow for her
  await task(u, 'הלילה', { due: await at(0, '01:00') });               // 22:00 UTC YESTERDAY — today for her
  await task(u, 'בלי תאריך');
  const data = await advise(u);
  const { rows: [d] } = await db.pool.query(
    `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS date`, [TZ]);

  assert.equal(data.today.date, d.date, 'the date is hers, not UTC');
  assert.deepEqual(data.today.events, [{ title: 'רופא שיניים', at: '15:00', until: '15:45', location: 'רמת גן' }]);
  assert.deepEqual(data.today.tasks.map((t) => t.title), ['לקנות מתנה', 'הלילה', 'להתקשר לבנק'],
    'local order: the day-shaped one (local midnight) first, then 01:00, then 10:30 — and never tomorrow\'s 01:00');
  assert.deepEqual(data.today.tasks[0], { title: 'לקנות מתנה' }, 'a day-shaped item carries no hour to say');
  assert.equal(data.today.tasks[2].at, '10:30', 'hours are local, not UTC');
  assert.equal(data.today.overdue, 1, 'one to-do due before today; the passed event does not count');
  assert.equal(data.today.more, undefined);
  assert.equal(data.today.googleCalendar, undefined);
  assert.match(data.hints.today, /do NOT call get_my_digest, list_my_tasks or my_calendar_events for today/);
  assert.match(data.hints.today, new RegExp(d.date), 'the hint names the day the block is for');
  assert.doesNotMatch(data.hints.today, /Google calendar/, 'no Google clause for somebody with no connection');
});

test('an empty day is still a block, so the model knows nothing is filed without asking', async () => {
  const u = await makeUser(db.pool, '+972612200002', { firstName: 'Ron', timezone: TZ });
  await task(u, 'בשבוע הבא', { due: await at(6, '12:00') });
  const data = await advise(u);
  assert.deepEqual(data.today.events, []);
  assert.deepEqual(data.today.tasks, []);
  assert.equal(data.today.overdue, 0);
  assert.match(data.hints.today, /empty lists mean nothing is filed/);
});

test('a crowded day is capped and says so; a connected Google calendar is named as NOT in the block', async () => {
  const u = await makeUser(db.pool, '+972612200003', { firstName: 'Maya', timezone: TZ });
  for (let i = 0; i < 15; i++) await task(u, `משימה ${i}`, { due: await at(0, `${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`) });
  await task(u, 'פגישה', { kind: 'event', due: await at(0, '09:00') });
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status) VALUES ($1, 'google_calendar', 'connected')`, [u.id]);
  const data = await advise(u);
  assert.equal(data.today.events.length, 1, 'events come first and are never the ones cut');
  assert.equal(data.today.tasks.length, 11);
  assert.equal(data.today.more, 4);
  assert.equal(data.today.googleCalendar, true);
  assert.match(data.hints.today, /Google calendar, whose events this block does NOT hold/);
});

test('a paused person still gets it — it answers a question, it is not an initiative', async () => {
  const u = await makeUser(db.pool, '+972612200004', { firstName: 'Noa', timezone: TZ });
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [u.id]);
  await task(u, 'ללכת לים', { due: await at(0, '17:00') });
  const data = await advise(u);
  assert.deepEqual(data.today.tasks, [{ title: 'ללכת לים', at: '17:00' }]);
  assert.equal(data.planHeadline, undefined);
});

test('the rendered turn context carries the block for the people the plugin serves', async () => {
  const u = await makeUser(db.pool, '+972612200005', { firstName: 'Tal', timezone: TZ });
  await task(u, 'תור', { kind: 'event', due: await at(0, '11:00') });
  const text = turnDomain.renderContext(await advise(u));
  assert.match(text, /"today":\{"date":"\d{4}-\d{2}-\d{2}","events":\[\{"title":"תור","at":"11:00"\}\]/);
});
