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

// ---- the day's own name ----------------------------------------------------
// The owner's answer on 2026-09-11 was that a chag is mentioned "רק בהקשר
// השיחה" — it rides this block and sends nothing of its own. `now` is injected
// for the same reason drainOnce takes one: these are calendar dates, and a
// test that could only run on Rosh Hashana is a test that runs once a year.
async function adviseAt(user, now) {
  const client = await db.pool.connect();
  try {
    return await turnDomain.advise(client, user, { counted, firstTurn: false, ourTurn: false, now });
  } finally { client.release(); }
}

// Rosh Hashana 5787: Saturday 12 and Sunday 13 September 2026 in Israel.
const ON_CHAG = new Date('2026-09-12T09:00:00Z');
const EREV = new Date('2026-09-11T09:00:00Z');
const ORDINARY = new Date('2026-11-17T09:00:00Z');

test('the block names the day when the day has a name, in their own language', async () => {
  const u = await makeUser(db.pool, '+972612200021', { firstName: 'יוסי', timezone: TZ });
  const chag = await adviseAt(u, ON_CHAG);
  assert.equal(chag.today.date, '2026-09-12');
  assert.equal(chag.today.holiday.name, 'ראש השנה');
  assert.equal(chag.today.holiday.solemn, undefined, 'a chag is not a fast');
  // And the model is told what to do with it — one clause, only if it fits.
  assert.match(chag.hints.holiday, /ראש השנה/);
  assert.match(chag.hints.holiday, /never instead of answering/);

  // An ordinary Tuesday carries neither the field nor the hint. That is most
  // of the year, and a hint that fires on ordinary input is worse than none.
  const plain = await adviseAt(u, ORDINARY);
  assert.equal(plain.today.holiday, undefined);
  assert.equal(plain.hints && plain.hints.holiday, undefined);
});

test('an English speaker gets their own calendar, and their own words for it', async () => {
  const u = await makeUser(db.pool, '+14155550301',
    { firstName: 'Sarah', timezone: 'America/New_York', locale: 'en' });
  const xmas = await adviseAt(u, new Date('2026-12-25T15:00:00Z'));
  assert.equal(xmas.today.holiday.name, 'Christmas Day');
  // And a chag is not theirs unless they said it was.
  const kippur = await adviseAt(u, new Date('2026-09-21T15:00:00Z'));
  assert.equal(kippur.today.holiday, undefined);
});

test('a solemn day is named and never congratulated', async () => {
  const u = await makeUser(db.pool, '+972612200022', { firstName: 'נועה', timezone: TZ });
  const kippur = await adviseAt(u, new Date('2026-09-21T09:00:00Z'));
  assert.equal(kippur.today.holiday.name, 'יום כפור');
  assert.equal(kippur.today.holiday.solemn, true);
  assert.match(kippur.hints.holiday, /no greeting, nothing celebratory/);
});

test('the offer to go quiet on chagim is made ONCE, by whichever route gets there first', async () => {
  const u = await makeUser(db.pool, '+972612200023', { firstName: 'דנה', timezone: TZ, holidayAsked: null });
  const stamp = async () => (await db.pool.query(
    `SELECT holiday_quiet_asked_at FROM users WHERE id = $1`, [u.id])).rows[0].holiday_quiet_asked_at;
  assert.equal(await stamp(), null);

  // The erev is where it lands: a chag is close enough to picture, and the
  // evening before is when somebody can still decide.
  const erev = await adviseAt(u, EREV);
  assert.equal(erev.today.askHolidayQuiet, true);
  assert.match(erev.hints.askHolidayQuiet, /without a question mark/);
  assert.match(erev.hints.askHolidayQuiet, /"quiet_days"/);
  assert.match(erev.hints.askHolidayQuiet, /"holiday_calendar"/);

  // Spent on the HAND-OUT, not on their answer — a question the model then
  // did not fit in still used up the one turn this person's patience had.
  assert.ok(await stamp(), 'stamped on the person, not on the route');
  const again = await adviseAt(u, ON_CHAG);
  assert.equal(again.today.askHolidayQuiet, undefined, 'asked once, ever');
  assert.equal(again.hints && again.hints.askHolidayQuiet, undefined);
  // The day is still NAMED, though — that half was never a question.
  assert.equal(again.today.holiday.name, 'ראש השנה');

  // And the OTHER route sees the same stamp, which is the whole reason it is a
  // column on the person rather than a topic string in the outbox.
  const checkin = require('../src/jobs/checkin');
  const c = await db.pool.connect();
  try {
    const gaps = await checkin.discoveryGaps(c, u.id, EREV);
    assert.ok(!gaps.some((g) => g.topic === 'holidays'),
      'the ladder must not ask what a turn hint already asked');
  } finally { c.release(); }
});

test('somebody who already asked for quiet chagim is never offered them', async () => {
  const u = await makeUser(db.pool, '+972612200024', { firstName: 'אבי', timezone: TZ, quietDays: 'sat,holidays', holidayAsked: null });
  const erev = await adviseAt(u, EREV);
  assert.equal(erev.today.askHolidayQuiet, undefined);
  assert.equal(erev.today.holiday.name, 'ערב ראש השנה');

  // Nor is somebody whose calendar is not this one at all.
  const none = await makeUser(db.pool, '+972612200025', { firstName: 'רון', timezone: TZ, holidayAsked: null });
  await db.pool.query(
    `INSERT INTO user_preferences (user_id, key, value) VALUES ($1, 'holiday_calendar', 'none')`, [none.id]);
  const quiet = await adviseAt(none, EREV);
  assert.equal(quiet.today.holiday, undefined);
  assert.equal(quiet.today.askHolidayQuiet, undefined);
});
