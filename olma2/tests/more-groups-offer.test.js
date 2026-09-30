'use strict';
// Somebody who has just watched a coordination in a room work is offered,
// once, to add Olma to their other groups (owner, 2026-09-23). His four
// answers are what these tests pin: it rides the next check-in, it goes to
// everybody who said yes to the locked time, it is once ever, and only a
// coordination in a ROOM earns it — or, since 2026-09-30, a private one with
// three or more people in it. WHEN it is said is an A/B test
// (experiments.more_groups_timing); the older tests run with arm a locked,
// which is the behaviour they were written for.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const checkin = require('../src/jobs/checkin');
const experiments = require('../src/domain/experiments');

let db;
before(async () => {
  db = await freshDb();
  await withTx(db.pool, (c) => experiments.lock(c, 'more_groups_timing', 'a'));
});
after(async () => { await db.teardown(); });

let seq = 0;
// A meeting locked on one option, with the given answers on that option.
// `groupId` null is a private coordination; everybody named is a participant,
// and `optedOut` are participants who left.
async function lockedMeeting({ initiator, groupId, yes = [], no = [], optedOut = [], daysAgo = 0, startsInDays = 3 }) {
  const startsAt = new Date(Date.now() + startsInDays * 86400000);
  startsAt.setUTCMilliseconds(0);
  const { rows: [m] } = await db.pool.query(
    `INSERT INTO meetings (initiator_id, title, status, group_id, confirmed_start_at, updated_at)
     VALUES ($1, 'פוקר', 'confirmed', $2, $3, now() - make_interval(days => $4)) RETURNING id`,
    [initiator.id, groupId, startsAt, daysAgo]);
  const { rows: [locked] } = await db.pool.query(
    `INSERT INTO meeting_options (meeting_id, slot_text, starts_at) VALUES ($1, 'חמישי', $2) RETURNING id`,
    [m.id, startsAt]);
  const { rows: [other] } = await db.pool.query(
    `INSERT INTO meeting_options (meeting_id, slot_text, starts_at) VALUES ($1, 'שישי', $2) RETURNING id`,
    [m.id, new Date(startsAt.getTime() + 86400000)]);
  for (const u of new Set([initiator, ...yes, ...no, ...optedOut])) {
    await db.pool.query(
      `INSERT INTO meeting_participants (meeting_id, user_id, state) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [m.id, u.id, optedOut.includes(u) ? 'opted_out' : 'confirmed_current']);
  }
  for (const u of yes) {
    await db.pool.query(`INSERT INTO meeting_option_answers (option_id, user_id, answer) VALUES ($1, $2, 'y')`, [locked.id, u.id]);
  }
  for (const u of no) {
    await db.pool.query(`INSERT INTO meeting_option_answers (option_id, user_id, answer) VALUES ($1, $2, 'n')`, [locked.id, u.id]);
    await db.pool.query(`INSERT INTO meeting_option_answers (option_id, user_id, answer) VALUES ($1, $2, 'y')`, [other.id, u.id]);
  }
  return m.id;
}

async function room(subject) {
  seq += 1;
  const { rows: [g] } = await db.pool.query(
    `INSERT INTO chat_groups (external_id, subject, state) VALUES ($1, $2, 'open') RETURNING id`,
    [`1203630000${seq}@g.us`, subject]);
  return g.id;
}

// Onboarded a while ago and quiet since, so the ladder's cadence lets a
// check-in through today.
async function quietUser(phone, extra = {}) {
  const u = await makeUser(db.pool, phone, extra);
  await db.pool.query(
    `UPDATE users SET onboarded_at = now() - interval '3 days', created_at = now() - interval '3 days' WHERE id = $1`, [u.id]);
  await db.pool.query(`UPDATE audit_log SET created_at = now() - interval '3 days' WHERE actor_id = $1`, [u.id]);
  return u;
}

const rungOf = (userId, misses = 0) => withTx(db.pool, (c) => checkin.pickRung(c, userId, misses));

test('everybody who said yes to the locked time in a room is offered it, with the room named and nothing asked', async () => {
  const asker = await makeUser(db.pool, '+972592000001');
  const joiner = await makeUser(db.pool, '+972592000002');
  const g = await room('פחם הסעות 🚌');
  await lockedMeeting({ initiator: asker, groupId: g, yes: [asker, joiner] });
  for (const u of [asker, joiner]) {
    const r = await rungOf(u.id);
    assert.equal(r.rung, 'more_groups', 'not only whoever asked');
    assert.match(r.instruction, /התיאום ב«פחם הסעות 🚌» נסגר/);
    assert.match(r.instruction, /להוסיף אותי גם אליהן ולתייג אותי/);
    const quoted = r.instruction.match(/"([^"]+)"/)[1];
    assert.ok(!quoted.includes('?'), 'an offer, not a question waiting on them');
  }
});

test('a no, a private coordination of one, an old one, or a silence does not earn it', async () => {
  const asker = await makeUser(db.pool, '+972592000011');
  const declined = await makeUser(db.pool, '+972592000012');
  await lockedMeeting({ initiator: asker, groupId: await room('שישי'), yes: [asker], no: [declined] });
  assert.notEqual((await rungOf(declined.id)).rung, 'more_groups', 'said yes only to a time that was not locked');

  const priv = await makeUser(db.pool, '+972592000013');
  await lockedMeeting({ initiator: priv, groupId: null, yes: [priv] });
  assert.notEqual((await rungOf(priv.id)).rung, 'more_groups', 'a private one needs three people');

  const old = await makeUser(db.pool, '+972592000014');
  await lockedMeeting({ initiator: old, groupId: await room('ישן'), yes: [old], daysAgo: 20 });
  assert.notEqual((await rungOf(old.id)).rung, 'more_groups', 'news for two weeks, a non sequitur after');

  const quiet = await makeUser(db.pool, '+972592000015');
  await lockedMeeting({ initiator: quiet, groupId: await room('שקט'), yes: [quiet] });
  assert.equal((await rungOf(quiet.id, 1)).rung, 'silence', 'somebody who has gone quiet is offered nothing');
});

test('it rides the next check-in, is stamped on the person, and never comes back', async () => {
  const u = await quietUser('+972592000021', { locale: 'en' });
  const g = await room(null);
  await lockedMeeting({ initiator: u, groupId: g, yes: [u] });
  const results = await withTx(db.pool, (c) => checkin.run(c));
  assert.equal(results.find((r) => Number(r.userId) === Number(u.id)).rung, 'more_groups');
  const { rows: [row] } = await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'checkin'`, [u.id]);
  assert.equal(row.payload.topic, 'more_groups');
  assert.match(row.payload.checkinInstruction, /So glad the plan in the group came together/);
  const { rows: [stamp] } = await db.pool.query(`SELECT more_groups_offered_at FROM users WHERE id = $1`, [u.id]);
  assert.ok(stamp.more_groups_offered_at, 'spent on the hand-out');

  // Another success in another room: still once ever.
  await lockedMeeting({ initiator: u, groupId: await room('עוד'), yes: [u] });
  assert.notEqual((await rungOf(u.id)).rung, 'more_groups');
});

test('what is theirs still comes first', async () => {
  const tasks = require('../src/domain/tasks');
  const u = await makeUser(db.pool, '+972592000031');
  await lockedMeeting({ initiator: u, groupId: await room('דחוף'), yes: [u] });
  await withTx(db.pool, (c) => tasks.addTask(c, u.id, {
    title: 'להגיש דוח', dueAt: new Date(Date.now() + 5 * 3600000).toISOString(),
  }));
  await db.pool.query(`UPDATE tasks SET created_at = now() - interval '2 days' WHERE owner_id = $1`, [u.id]);
  assert.equal((await rungOf(u.id)).rung, 'deadline_risk');
});

test('a private coordination of three earns it, with its own sentence; of two, or three with one gone, does not', async () => {
  const [a, b, c] = [await makeUser(db.pool, '+972592000041'), await makeUser(db.pool, '+972592000042'),
    await makeUser(db.pool, '+972592000043')];
  await lockedMeeting({ initiator: a, groupId: null, yes: [a, b, c] });
  const r = await rungOf(b.id);
  assert.equal(r.rung, 'more_groups');
  assert.match(r.instruction, /איזה כיף ש«פוקר» נסגר 🙌/);
  assert.match(r.instruction, /להוסיף אותי לקבוצת הוואטסאפ שלכם ולתייג אותי/);
  assert.match(r.instruction, /with 3 people, arranged in private chats/);
  assert.ok(!r.instruction.match(/"([^"]+)"/)[1].includes('?'));

  const [d, e] = [await makeUser(db.pool, '+972592000044'), await makeUser(db.pool, '+972592000045')];
  await lockedMeeting({ initiator: d, groupId: null, yes: [d, e] });
  assert.notEqual((await rungOf(e.id)).rung, 'more_groups', 'two people have no group to add her to');

  const [f, g, h] = [await makeUser(db.pool, '+972592000046'), await makeUser(db.pool, '+972592000047'),
    await makeUser(db.pool, '+972592000048')];
  await lockedMeeting({ initiator: f, groupId: null, yes: [f, g], optedOut: [h] });
  assert.notEqual((await rungOf(g.id)).rung, 'more_groups', 'somebody who left is not counted');
});

test('the timing test: a offers it at once, b waits for the thing to happen, and both are exposed at the same moment', async () => {
  await withTx(db.pool, (c) => experiments.lock(c, 'more_groups_timing', null));
  const inArm = async (variant, n) => {
    for (let i = 0; i < 40; i++) {
      const u = await makeUser(db.pool, `+9725921${n}${String(i).padStart(3, '0')}`);
      if (experiments.variantFor('more_groups_timing', u.id) === variant) return u;
    }
    throw new Error(`nobody landed in ${variant}`);
  };
  const exposed = async (id) => (await db.pool.query(
    `SELECT detail->>'variant' AS v FROM audit_log WHERE actor_id = $1 AND event = 'experiment.exposed'`, [id])).rows;

  const early = await inArm('a', 1);
  const g = await room('ניסוי');
  await lockedMeeting({ initiator: early, groupId: g, yes: [early] });
  assert.equal((await rungOf(early.id)).rung, 'more_groups');
  assert.deepEqual((await exposed(early.id)).map((r) => r.v), ['a']);

  const late = await inArm('b', 2);
  const mid = await lockedMeeting({ initiator: late, groupId: await room('ניסוי ב'), yes: [late] });
  assert.notEqual((await rungOf(late.id)).rung, 'more_groups', 'b: the meeting has not happened yet');
  assert.deepEqual((await exposed(late.id)).map((r) => r.v), ['b'], 'exposed anyway, so b is measured fairly');

  // The meeting took place yesterday, and it closed weeks ago: b still owes it.
  await db.pool.query(`UPDATE meetings SET confirmed_start_at = confirmed_start_at - interval '4 days',
                         updated_at = now() - interval '20 days' WHERE id = $1`, [mid]);
  await db.pool.query(`UPDATE meeting_options SET starts_at = starts_at - interval '4 days' WHERE meeting_id = $1`, [mid]);
  assert.equal((await rungOf(late.id)).rung, 'more_groups');
  assert.equal((await exposed(late.id)).length, 1, 'once per person');

  // A meeting that closed before the test began gives b nothing a could not get.
  const before = await inArm('b', 3);
  const old = await lockedMeeting({ initiator: before, groupId: await room('ישן ב'), yes: [before], startsInDays: -1 });
  await db.pool.query(`UPDATE meetings SET updated_at = now() - interval '20 days' WHERE id = $1`, [old]);
  assert.notEqual((await rungOf(before.id)).rung, 'more_groups');
  assert.equal((await exposed(before.id)).length, 0);

  const res = await withTx(db.pool, (c) => experiments.results(c, 'more_groups_timing'));
  assert.ok(res.arms.every((x) => x.exposed >= 1));
});
