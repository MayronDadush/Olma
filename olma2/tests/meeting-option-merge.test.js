'use strict';
// A time close to one already on the table is a QUESTION in the private chat
// before it is a second option (owner, 2026-10-05: Eden added Friday 11:00
// beside Miron's Friday noon in the poker coordination). Close is the same
// local day and at most two hours apart, a part of the day counting as its
// window. The person who wrote it decides: merge — their time takes the old
// one's place and every answer on it moves across — or separate, a new time
// with new answers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const meetings = require('../src/domain/meetings');
const { instructionFor } = require('../src/channels/openclaw');
const { BY_NAME } = require('../src/adapters/mcp/registry');

const TZ = 'Asia/Jerusalem';
let db, ann, ben, cal;
const tx = (fn) => withTx(db.pool, fn);
const call = (name, user, args) => tx((c) => BY_NAME.get(name).handler(c, user, args || {}));

// A local wall-clock moment `days` from now in Jerusalem — three days out, so
// no hour of the day the suite runs at puts it in the past.
function localAt(hhmm, days = 3) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + days * 86400e3));
  const probe = new Date(`${day}T12:00:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' })
    .formatToParts(probe).find((p) => p.type === 'timeZoneName').value.replace('GMT', '');
  const [h, m = '0'] = off.split(':');
  const sign = h.startsWith('-') ? '-' : '+';
  const hh = String(Math.abs(Number(h))).padStart(2, '0');
  return `${day}T${hhmm}:00${sign}${hh}:${m.padStart(2, '0')}`;
}

async function connect(a, b) {
  const { rows } = await db.pool.query(
    `INSERT INTO connections (requester_id, target_id, target_phone, status, responded_at)
     VALUES ($1, $2, $3, 'active', now()) RETURNING id`, [a.id, b.id, b.phone]);
  for (const grantor of [a, b]) {
    await db.pool.query(
      `INSERT INTO connection_feature_grants (connection_id, grantor_id, feature) VALUES ($1, $2, 'meetings')`,
      [rows[0].id, grantor.id]);
  }
}
const reload = async (u) => (await db.pool.query('SELECT * FROM users WHERE id = $1', [u.id])).rows[0];
const outboxFor = async (meetingId) => (await db.pool.query(
  `SELECT user_id, kind, payload, hold_reason FROM outbox
    WHERE (payload->>'meetingId')::bigint = $1 ORDER BY id`, [meetingId])).rows;

before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972531970001', { firstName: 'Ann' });
  ben = await makeUser(db.pool, '+972531970002', { firstName: 'Ben' });
  cal = await makeUser(db.pool, '+972531970003', { firstName: 'Cal' });
  await db.pool.query(`UPDATE users SET timezone = '${TZ}'`);
  [ann, ben, cal] = await Promise.all([ann, ben, cal].map(reload));
  await connect(ann, ben); await connect(ann, cal); await connect(ben, cal);
});
after(async () => { await db.teardown(); });

// Ann opens it and puts "noon" on the table; Ben says yes, Cal says no.
async function noonTable() {
  const id = Number((await tx((c) => meetings.startMeeting(c, ann.id, 'פוקר', [ben.id, cal.id]))).data.meeting.id);
  const put = await call('propose_meeting_slot', ann, {
    meeting_id: id, slot_description: 'בצהריים', starts_at: localAt('13:00'), daypart: 'noon' });
  assert.ok(put.ok, JSON.stringify(put));
  const [noon] = await tx((c) => meetings.options.list(c, id));
  await tx((c) => meetings.options.answer(c, ben.id, id, noon.id, 'y'));
  await tx((c) => meetings.options.answer(c, cal.id, id, noon.id, 'n'));
  return { id, noon };
}

test('what counts as close: same local day, two hours, a part of the day as its window', () => {
  const s = (hhmm, extra = {}) => ({ startsAt: localAt(hhmm), allDay: false, daypart: null, ...extra });
  const close = meetings.options.isSimilar;
  assert.equal(close(TZ, s('11:00'), s('13:00', { daypart: 'noon' })), true, "Eden's 11:00 beside noon");
  assert.equal(close(TZ, s('20:00'), s('21:30')), true);
  assert.equal(close(TZ, s('20:00'), s('22:30')), false, 'two and a half hours is two times');
  assert.equal(close(TZ, s('09:00'), s('19:00', { daypart: 'evening' })), false);
  assert.equal(close(TZ, s('15:00'), s('09:00', { allDay: true })), true, 'a whole day holds every hour of it');
  assert.equal(close(TZ, s('20:00'), { ...s('20:00'), startsAt: localAt('20:00', 4) }), false, 'another day is another time');
  assert.equal(close(TZ, s('20:00'), s('20:00')), false, 'the same moment is a duplicate, never "similar"');
});

test('a close time is a question, nothing is written, and the old time is named', async () => {
  const { id, noon } = await noonTable();
  const res = await call('propose_meeting_slot', cal, {
    meeting_id: id, slot_description: '11:00', starts_at: localAt('11:00') });
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'similar_option');
  assert.deepEqual(res.error.similar.map((o) => o.optionId), [noon.id]);
  assert.equal(res.error.similar[0].yes, 2, 'Ann and Ben are on it');
  assert.match(res.error.hint, /merge_with=<optionId>, or merge_with=0/);
  assert.equal((await tx((c) => meetings.options.list(c, id))).length, 1, 'nothing was added');
});

test('a time far from everything on the table is added as before', async () => {
  const { id } = await noonTable();
  const res = await call('propose_meeting_slot', cal, {
    meeting_id: id, slot_description: '20:00', starts_at: localAt('20:00') });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal((await tx((c) => meetings.options.list(c, id))).length, 2);
});

test('separate: a new time with new answers, the old one untouched', async () => {
  const { id, noon } = await noonTable();
  const res = await call('propose_meeting_slot', cal, {
    meeting_id: id, slot_description: '11:00', starts_at: localAt('11:00'), merge_with: 0 });
  assert.ok(res.ok, JSON.stringify(res));
  const table = await tx((c) => meetings.options.list(c, id));
  assert.equal(table.length, 2);
  const eleven = table.find((o) => o.id !== noon.id);
  assert.deepEqual(eleven.answers, { [cal.id]: 'y' });
  assert.deepEqual(table.find((o) => o.id === noon.id).answers, { [ann.id]: 'y', [ben.id]: 'y', [cal.id]: 'n' });
});

test('merge: the new time takes the old one\'s place and the answers move with it', async () => {
  const { id, noon } = await noonTable();
  const res = await call('propose_meeting_slot', cal, {
    meeting_id: id, slot_description: '11:00', starts_at: localAt('11:00'), merge_with: noon.id });
  assert.ok(res.ok, JSON.stringify(res));
  const table = await tx((c) => meetings.options.list(c, id));
  assert.equal(table.length, 1, 'one time on the table, not two');
  assert.equal(table[0].slotText, '11:00');
  // Ann's and Ben's yes moved; Cal's own no on the old time does not follow
  // him — he merged, and adding is agreeing.
  assert.deepEqual(table[0].answers, { [ann.id]: 'y', [ben.id]: 'y', [cal.id]: 'y' });
  const { rows: [old] } = await db.pool.query('SELECT status FROM meeting_options WHERE id = $1', [noon.id]);
  assert.equal(old.status, 'replaced');

  // Everybody said yes: the minute is armed, like any unanimous answer.
  assert.equal(res.data.meetingStatus, 'settling');

  // The two whose answers moved are TOLD, not asked again.
  const rows = await outboxFor(id);
  const moved = rows.filter((r) => r.kind === 'meeting_answer_moved');
  assert.deepEqual(moved.map((r) => Number(r.user_id)).sort(), [ann.id, ben.id].sort());
  assert.equal(moved[0].payload.from, 'בצהריים');
  assert.equal(moved[0].payload.slot, '11:00');
  assert.ok(!rows.some((r) => r.kind === 'meeting_slot_proposed' && Number(r.payload.optionId) === table[0].id),
    'nobody is asked about the new time: everyone already has an answer on it');
  // …and the queued question about the old time is withdrawn.
  assert.ok(rows.filter((r) => r.kind === 'meeting_slot_proposed' && Number(r.payload.optionId) === noon.id)
    .every((r) => r.hold_reason === 'superseded'));
});

test('merge asks whoever had NOT answered the old time about the new one', async () => {
  const id = Number((await tx((c) => meetings.startMeeting(c, ann.id, 'פוקר', [ben.id, cal.id]))).data.meeting.id);
  const put = await call('propose_meeting_slot', ann, {
    meeting_id: id, slot_description: 'בצהריים', starts_at: localAt('13:00'), daypart: 'noon' });
  const noonId = put.data.optionId;
  const res = await call('propose_meeting_slot', ben, {
    meeting_id: id, slot_description: '11:00', starts_at: localAt('11:00'), merge_with: noonId });
  assert.ok(res.ok, JSON.stringify(res));
  const rows = await outboxFor(id);
  assert.deepEqual(rows.filter((r) => r.kind === 'meeting_answer_moved').map((r) => Number(r.user_id)), [ann.id]);
  assert.ok(rows.some((r) => Number(r.user_id) === cal.id
    && (r.kind === 'meeting_slot_proposed' || r.kind === 'meeting_invite') && r.hold_reason === null),
  'Cal, who had not answered, is still asked');
});

test('a merge into a time no longer on the table is refused and writes nothing', async () => {
  const { id, noon } = await noonTable();
  await tx((c) => meetings.options.remove(c, ann.id, id, noon.id));
  const res = await call('propose_meeting_slot', cal, {
    meeting_id: id, slot_description: '11:00', starts_at: localAt('11:00'), merge_with: noon.id });
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'option_not_active');
  assert.equal((await tx((c) => meetings.options.list(c, id))).length, 0);
});

test('the notice says what moved and asks nothing', () => {
  const body = instructionFor({ kind: 'meeting_answer_moved', payload: {
    meetingId: 9, title: 'פוקר', byName: 'Cal', from: 'בצהריים', slot: '11:00', startsAt: localAt('11:00'), answer: 'y' } });
  assert.match(body, /<<<בצהריים>>> with <<<11:00>>>/);
  assert.match(body, /YES on the old time now stands on the new one/);
  assert.match(body, /Ask nothing else/);
});
