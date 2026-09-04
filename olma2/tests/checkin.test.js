'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const checkin = require('../src/jobs/checkin');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// Onboarded 3 days ago and silent since (no audit rows after creation window).
async function silentUser(phone, extra = {}) {
  const u = await makeUser(db.pool, phone, extra);
  await db.pool.query(
    `UPDATE users SET onboarded_at = now() - interval '3 days', created_at = now() - interval '3 days' WHERE id = $1`, [u.id]);
  await db.pool.query(
    `UPDATE audit_log SET created_at = now() - interval '3 days' WHERE actor_id = $1`, [u.id]);
  return u;
}

test('ladder rung 1: stuck meeting beats everything else', async () => {
  const connections = require('../src/domain/connections');
  const grants = require('../src/domain/grants');
  const meetings = require('../src/domain/meetings');
  const tasks = require('../src/domain/tasks');

  const a = await silentUser('+972591000001');
  const b = await silentUser('+972591000002');
  await withTx(db.pool, async (c) => {
    const req = await connections.requestConnection(c, a.id, b.phone, {});
    const conn = (await connections.respondToConnection(c, b.id, req.data.connection.id, 'approve')).data.connection;
    await grants.grantFeature(c, a.id, conn.id, 'meetings');
    await grants.grantFeature(c, b.id, conn.id, 'meetings');
    const m = (await meetings.startMeeting(c, a.id, 'coffee', [b.id])).data.meeting;
    await meetings.proposeSlot(c, a.id, m.id, 'Tuesday 17:00, cafe',
      slotStart('Tuesday 17:00, cafe'));
    // b also has an at-risk task — the meeting must still win
    const t = (await tasks.addTask(c, b.id, { title: 'urgent thing', dueAt: new Date(Date.now() + 3600_000).toISOString() })).data.task;
    await c.query(`UPDATE tasks SET created_at = now() - interval '2 days' WHERE id = $1`, [t.id]);
    // audit rows from this setup made them look active — push back again
    await c.query(`UPDATE audit_log SET created_at = now() - interval '3 days' WHERE actor_id IN ($1, $2)`, [a.id, b.id]);
  });

  const results = await withTx(db.pool, (c) => checkin.run(c));
  const bResult = results.find((r) => Number(r.userId) === Number(b.id));
  assert.ok(bResult, 'b got a checkin');
  assert.equal(bResult.rung, 'stuck_meeting');

  const { rows } = await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'checkin'`, [b.id]);
  assert.match(rows[0].payload.checkinInstruction, /Tuesday 17:00/);
});

test('ladder rungs: deadline_risk, overload, plain silence', async () => {
  const tasks = require('../src/domain/tasks');

  const risky = await silentUser('+972591000003');
  const overloaded = await silentUser('+972591000004');
  const quiet = await silentUser('+972591000005');

  await withTx(db.pool, async (c) => {
    const t = (await tasks.addTask(c, risky.id, { title: 'submit report', dueAt: new Date(Date.now() + 12 * 3600_000).toISOString() })).data.task;
    await c.query(`UPDATE tasks SET created_at = now() - interval '2 days' WHERE id = $1`, [t.id]);
    for (let i = 0; i < 5; i++) {
      const o = (await tasks.addTask(c, overloaded.id, { title: 'old ' + i, dueAt: new Date(Date.now() - 24 * 3600_000).toISOString() })).data.task;
      await c.query(`UPDATE tasks SET created_at = now() - interval '5 days' WHERE id = $1`, [o.id]);
    }
    await c.query(`UPDATE audit_log SET created_at = now() - interval '3 days' WHERE actor_id IN ($1, $2, $3)`,
      [risky.id, overloaded.id, quiet.id]);
  });

  const results = await withTx(db.pool, (c) => checkin.run(c));
  const byId = Object.fromEntries(results.map((r) => [Number(r.userId), r.rung]));
  assert.equal(byId[Number(risky.id)], 'deadline_risk');
  assert.equal(byId[Number(overloaded.id)], 'overload');
  // A quiet user with open gaps (no digest, no calendar, an empty fact card)
  // now gets the discovery rung, not a generic "מה קורה?" — plain silence is
  // reserved for someone with nothing left to set up (covered further down).
  assert.equal(byId[Number(quiet.id)], 'discovery');
});

test('idempotent per day; backoff excludes after 4 misses; recent activity excludes', async () => {
  const again = await withTx(db.pool, (c) => checkin.run(c));
  assert.equal(again.length, 0, 'second run same day enqueues nothing');

  const gaveUp = await silentUser('+972591000006');
  await db.pool.query(`UPDATE users SET checkin_misses = 4 WHERE id = $1`, [gaveUp.id]);
  const active = await makeUser(db.pool, '+972591000007'); // fresh audit rows = active now
  await db.pool.query(`UPDATE users SET onboarded_at = now() - interval '3 days' WHERE id = $1`, [active.id]);

  const results = await withTx(db.pool, (c) => checkin.run(c));
  const ids = results.map((r) => Number(r.userId));
  assert.ok(!ids.includes(Number(gaveUp.id)), 'backed-off user skipped');
  assert.ok(!ids.includes(Number(active.id)), 'recently active user skipped');
});

test('checkin cadence: fast for new users, slower once settled, backs off when ignored', () => {
  const { requiredGapMs } = require('../src/jobs/checkin');
  const h = (ms) => ms / 3600_000;

  // A brand-new user is the one most likely to drift away, so Olma reaches out
  // within hours; three weeks in, a daily rhythm is enough.
  assert.equal(h(requiredGapMs(0, 0)), 5, 'day 0');
  assert.equal(h(requiredGapMs(2.9, 0)), 5, 'still inside the first 3 days');
  assert.equal(h(requiredGapMs(3, 0)), 10, 'first week');
  assert.equal(h(requiredGapMs(10, 0)), 18, 'first three weeks');
  assert.equal(h(requiredGapMs(30, 0)), 24, 'settled');

  // Engagement, not the calendar, decides the rest: one ignored check-in
  // doubles the wait, two drops to weekly. A responsive new user keeps the
  // fast cadence; a silent one is left alone within a day.
  assert.equal(h(requiredGapMs(0, 1)), 10, 'one miss doubles');
  assert.equal(h(requiredGapMs(0, 2)), 24 * 7, 'two misses → weekly');
  assert.equal(h(requiredGapMs(30, 2)), 24 * 7, 'weekly regardless of age');
});

test('day one ladder: 15m / 2h / 5h, and steps expire instead of piling up', async () => {
  const checkin = require('../src/jobs/checkin');
  const { onboardingStepDue } = checkin;
  const MIN = 60_000, H = 3600_000;

  assert.equal(onboardingStepDue(5 * MIN, 0), null, 'nothing in the first minutes');
  assert.equal(onboardingStepDue(16 * MIN, 0).slot, '15m');
  assert.equal(onboardingStepDue(2.5 * H, 0).slot, '2h');
  assert.equal(onboardingStepDue(6 * H, 0).slot, '5h');
  // only the latest due step, so a gap in the sweep never replays old ones
  assert.equal(onboardingStepDue(23 * H, 0).slot, '5h');
  assert.equal(onboardingStepDue(25 * H, 0), null, 'day one is over');
  // present, not deaf: deafness now means DELIVERED-and-ignored (a boolean
  // the caller derives from the outbox), never a counter that ghost-expired
  // messages inflated.
  assert.equal(onboardingStepDue(6 * H, true), null);
  assert.equal(onboardingStepDue(6 * H, false).slot, '5h');
});

test('day one ladder enqueues one step at a time, each with its own expiry', async () => {
  const checkin = require('../src/jobs/checkin');
  const fresh = await makeUser(db.pool, '+972615000042', { firstName: 'Chen' });
  const t0 = Date.now() - 20 * 60_000; // onboarded 20 minutes ago
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = to_timestamp($2/1000.0) WHERE id = $1`,
    [fresh.id, t0]);

  const out = await withTx(db.pool, (c) => checkin.run(c, Date.now()));
  const mine = out.filter((r) => r.userId === fresh.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].rung, 'onboarding_15m');

  const { rows } = await db.pool.query(
    `SELECT idempotency_key, expires_at, urgency FROM outbox WHERE user_id = $1`, [fresh.id]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].idempotency_key, /^onboarding:\d+:15m$/);
  // expires when the 2h step comes due, so an overnight signup wakes to ONE
  // message rather than the whole ladder at once
  assert.ok(new Date(rows[0].expires_at).getTime() - t0 <= 2 * 3600_000 + 1000);

  // re-running the sweep does not enqueue the same step twice
  await withTx(db.pool, (c) => checkin.run(c, Date.now()));
  const again = await db.pool.query(`SELECT count(*)::int n FROM outbox WHERE user_id = $1`, [fresh.id]);
  assert.equal(again.rows[0].n, 1);
});

test('a stuck-meeting nudge carries the user\'s own recorded constraints', async () => {
  const meetings = require('../src/domain/meetings');
  const connections = require('../src/domain/connections');
  const grants = require('../src/domain/grants');
  const checkin = require('../src/jobs/checkin');
  const other = await makeUser(db.pool, '+972641000021', { firstName: 'Rina' });
  const me = await makeUser(db.pool, '+972641000022', { firstName: 'Gadi' });
  const c = await db.pool.connect();
  try {
    const req = await connections.requestConnection(c, other.id, me.phone, {});
    const conn = (await connections.respondToConnection(c, me.id, req.data.connection.id, 'approve')).data.connection;
    await grants.grantFeature(c, other.id, conn.id, 'meetings');
    await grants.grantFeature(c, me.id, conn.id, 'meetings');
    const m = (await meetings.startMeeting(c, other.id, 'ריצה', [me.id])).data.meeting;
    await meetings.recordConstraint(c, me.id, m.id, 'לא בבקרים');
    await meetings.proposeSlot(c, other.id, m.id, 'שלישי 07:00 בפארק',
      slotStart('שלישי 07:00 בפארק'));
    const { instruction, rung } = await checkin.pickRung(c, me.id);
    assert.equal(rung, 'stuck_meeting');
    assert.ok(instruction.includes('<<<לא בבקרים>>>'), 'the nudge must carry their own constraint');
  } finally { c.release(); }
});

// ---- the fixes for "Olma went quiet on new users" ---------------------------

test('day-one steps never count as misses; regular checkins still do', async () => {
  const checkin = require('../src/jobs/checkin');
  const fresh = await makeUser(db.pool, '+972641000031', { firstName: 'Noa' });
  const c = await db.pool.connect();
  try {
    await c.query(
      `UPDATE users SET onboarded_at = now() - interval '20 minutes' WHERE id = $1`, [fresh.id]);
    await checkin.run(c);
    let { rows } = await c.query(`SELECT checkin_misses FROM users WHERE id = $1`, [fresh.id]);
    assert.equal(rows[0].checkin_misses, 0, 'an onboarding step is not evidence of being ignored');

    // past day one, idle → a regular checkin fires and DOES count
    await c.query(
      `UPDATE users SET onboarded_at = now() - interval '3 days',
              created_at = now() - interval '3 days', last_checkin_at = NULL WHERE id = $1`,
      [fresh.id]);
    await c.query(
      `UPDATE audit_log SET created_at = now() - interval '3 days' WHERE actor_id = $1`, [fresh.id]);
    await checkin.run(c);
    ({ rows } = await c.query(`SELECT checkin_misses FROM users WHERE id = $1`, [fresh.id]));
    assert.equal(rows[0].checkin_misses, 1, 'a real unanswered checkin still counts');
  } finally { c.release(); }
});

test('a broken calendar is not pitched like a new one', async () => {
  const checkin = require('../src/jobs/checkin');
  const u = await makeUser(db.pool, '+972641000060', { firstName: 'Noam' });
  // These three are about the OTHER gaps, so settle the timezone one — it now
  // leads the list, and an unconfirmed zone would win every pick here.
  await db.pool.query(
    `UPDATE users SET timezone = 'Asia/Jerusalem', timezone_confirmed = TRUE WHERE id = $1`, [u.id]);
  const c = await db.pool.connect();
  try {
    // close every other gap so the calendar one is what gets picked
    await c.query(`UPDATE users SET digest_times = '09:00' WHERE id = $1`, [u.id]);
    await c.query(
      `INSERT INTO user_facts (user_id, category, fact)
       VALUES ($1, 'context', 'אחת'), ($1, 'work', 'שתיים'), ($1, 'plans', 'שלוש')`, [u.id]);
    const friend = await makeUser(db.pool, '+972641000061', { firstName: 'Tal' });
    const connections = require('../src/domain/connections');
    const req = await connections.requestConnection(c, u.id, friend.phone, {});
    await connections.respondToConnection(c, friend.id, req.data.connection.id, 'approve');

    // never connected → the benefit pitch
    let pick = await checkin.pickRung(c, u.id);
    assert.equal(pick.topic, 'calendar:not_connected');
    assert.match(pick.instruction, /not connected/);

    // connected once, then Google rejected it. They know what a calendar is
    // for; being asked "want to connect?" reads as Olma having forgotten. And
    // this is the only thing that ever raises it again — markNeedsReauth
    // enqueues one message and never follows up (live: user 3 sat like this
    // for 36 hours after abandoning a reconnect). This must fire as its OWN
    // topic even though not_connected was already offered above — a shared
    // topic string would have let "already offered" silently swallow the one
    // recovery path that exists for an abandoned reconnect.
    await c.query(
      `INSERT INTO integrations (user_id, provider, status, access_level)
       VALUES ($1, 'google_calendar', 'needs_reauth', 'read_write')`, [u.id]);
    pick = await checkin.pickRung(c, u.id);
    assert.equal(pick.topic, 'calendar:needs_reauth');
    assert.match(pick.instruction, /do not pitch it/);
    assert.match(pick.instruction, /start_calendar_connection/);

    // and a working one is no gap at all
    await c.query(
      `UPDATE integrations SET status = 'connected' WHERE user_id = $1`, [u.id]);
    pick = await checkin.pickRung(c, u.id);
    assert.notEqual(pick.topic, 'calendar:not_connected');
    assert.notEqual(pick.topic, 'calendar:needs_reauth');
  } finally { c.release(); }
});

test('a discovery topic already offered is never offered again, even as the last gap standing', async () => {
  const checkin = require('../src/jobs/checkin');
  const u = await makeUser(db.pool, '+972641000062', { firstName: 'Sivan' });
  // These three are about the OTHER gaps, so settle the timezone one — it now
  // leads the list, and an unconfirmed zone would win every pick here.
  await db.pool.query(
    `UPDATE users SET timezone = 'Asia/Jerusalem', timezone_confirmed = TRUE WHERE id = $1`, [u.id]);
  const c = await db.pool.connect();
  try {
    // close every gap except calendar, so calendar is the ONLY thing left to
    // pitch — the exact shape that used to re-offer it forever, since
    // "differs from the last pick" has nothing else to rotate to.
    await c.query(`UPDATE users SET digest_times = '09:00' WHERE id = $1`, [u.id]);
    await c.query(
      `INSERT INTO user_facts (user_id, category, fact)
       VALUES ($1, 'context', 'אחת'), ($1, 'work', 'שתיים'), ($1, 'plans', 'שלוש')`, [u.id]);
    const friend = await makeUser(db.pool, '+972641000063', { firstName: 'Roi' });
    const connections = require('../src/domain/connections');
    const req = await connections.requestConnection(c, u.id, friend.phone, {});
    await connections.respondToConnection(c, friend.id, req.data.connection.id, 'approve');

    let pick = await checkin.pickRung(c, u.id);
    assert.equal(pick.topic, 'calendar:not_connected');

    // mark it as actually sent, the way `run()` would
    await c.query(
      `INSERT INTO outbox (user_id, kind, payload)
       VALUES ($1, 'checkin', '{"rung":"discovery","topic":"calendar:not_connected"}')`,
      [u.id]);

    // it is still the only real gap, yet it must never be picked again —
    // falling through to plain silence instead of repeating the same offer
    pick = await checkin.pickRung(c, u.id);
    assert.equal(pick.rung, 'silence', 'the one gap left was already offered once, so nothing to pitch');

    // and if their calendar connection later breaks, that is a DIFFERENT
    // topic and must still fire — the only recovery path for an abandoned
    // reconnect must survive the not_connected pitch having already run
    await c.query(
      `INSERT INTO integrations (user_id, provider, status, access_level)
       VALUES ($1, 'google_calendar', 'needs_reauth', 'read_write')`, [u.id]);
    pick = await checkin.pickRung(c, u.id);
    assert.equal(pick.rung, 'discovery');
    assert.equal(pick.topic, 'calendar:needs_reauth');
  } finally { c.release(); }
});

test('the timezone gap leads discovery, and closes itself once they answer', async () => {
  const checkin = require('../src/jobs/checkin');
  const u = await makeUser(db.pool, '+972641000071', { firstName: 'Dana' });
  const c = await db.pool.connect();
  try {
    // A guessed zone outranks the digest pitch: offering a 09:00 digest against
    // a zone nobody confirmed schedules the very bug it looks helpful doing.
    await c.query(`UPDATE users SET timezone = 'America/New_York' WHERE id = $1`, [u.id]);
    await c.query(`INSERT INTO tasks (owner_id, title) VALUES ($1, 'א'), ($1, 'ב')`, [u.id]);
    let pick = await checkin.pickRung(c, u.id);
    assert.equal(pick.rung, 'discovery');
    assert.equal(pick.topic, 'timezone');
    assert.match(pick.instruction, /America\/New_York/, 'it names the guess it wants replaced');
    assert.match(pick.instruction, /CITY/, 'it asks for a city, not an IANA name');
    assert.match(pick.instruction, /travel/, 'and it is where they learn to say so when they travel');

    // They answer. The gap is real only while it is real, so it disappears —
    // and what it hands back is the digest pitch it was standing in front of.
    const users = require('../src/domain/users');
    const set = await users.setTimezone(c, u.id, 'Europe/Madrid', true);
    assert.equal(set.ok, true);
    pick = await checkin.pickRung(c, u.id);
    assert.equal(pick.topic, 'digest');
  } finally {
    c.release();
  }
});

test('a zone we never had at all is asked about too, and says so', async () => {
  const checkin = require('../src/jobs/checkin');
  const u = await makeUser(db.pool, '+972641000072', { firstName: 'Tal' });
  const c = await db.pool.connect();
  try {
    // NULL is the worse case, not the absent one: the gate and the digest
    // sweep both read it as UTC rather than as "unknown" (CLAUDE.md).
    await c.query(`UPDATE users SET timezone = NULL WHERE id = $1`, [u.id]);
    const pick = await checkin.pickRung(c, u.id);
    assert.equal(pick.topic, 'timezone');
    assert.match(pick.instruction, /UTC/);
  } finally {
    c.release();
  }
});

test('discovery outranks generic silence, is gap-driven, and rotates topics', async () => {
  const checkin = require('../src/jobs/checkin');
  const u = await makeUser(db.pool, '+972641000032', { firstName: 'Omer' });
  // These three are about the OTHER gaps, so settle the timezone one — it now
  // leads the list, and an unconfirmed zone would win every pick here.
  await db.pool.query(
    `UPDATE users SET timezone = 'Asia/Jerusalem', timezone_confirmed = TRUE WHERE id = $1`, [u.id]);
  const c = await db.pool.connect();
  try {
    // no digest + 2 open tasks → the digest gap leads
    await c.query(`INSERT INTO tasks (owner_id, title) VALUES ($1, 'א'), ($1, 'ב')`, [u.id]);
    let pick = await checkin.pickRung(c, u.id);
    assert.equal(pick.rung, 'discovery');
    assert.equal(pick.topic, 'digest');
    assert.match(pick.instruction, /set_digest_preferences/);

    // pretend that topic was just used → next pick rotates to another gap
    await c.query(
      `INSERT INTO outbox (user_id, kind, payload) VALUES ($1, 'checkin', '{"rung":"discovery","topic":"digest"}')`,
      [u.id]);
    pick = await checkin.pickRung(c, u.id);
    assert.equal(pick.rung, 'discovery');
    assert.notEqual(pick.topic, 'digest', 'the same pitch must not run twice in a row');

    // close every gap → plain silence returns
    await c.query(`UPDATE users SET digest_times = '09:00' WHERE id = $1`, [u.id]);
    await c.query(
      `INSERT INTO integrations (user_id, provider, status, access_level)
       VALUES ($1, 'google_calendar', 'connected', 'read_only')`, [u.id]);
    await c.query(
      `INSERT INTO user_facts (user_id, category, fact)
       VALUES ($1, 'context', 'אחת'), ($1, 'work', 'שתיים'), ($1, 'plans', 'שלוש')`,
      [u.id]);
    const friend = await makeUser(db.pool, '+972641000033', { firstName: 'Dana' });
    const connections = require('../src/domain/connections');
    const req = await connections.requestConnection(c, u.id, friend.phone, {});
    await connections.respondToConnection(c, friend.id, req.data.connection.id, 'approve');
    pick = await checkin.pickRung(c, u.id);
    assert.equal(pick.rung, 'silence', 'no gaps left → nothing to pitch');
  } finally { c.release(); }
});

// ---- the stalled-goal rung --------------------------------------------------
//
// The failure it closes: a man told Olma he needed to sell three of his
// vehicles. No date was attached to it, because that is how people say things
// like that — so deadline_risk (due within 24h) and overload (overdue rows)
// were both structurally blind to it, and the check-in brain went off to pitch
// him a daily digest instead. A big thing someone said out loud has to outrank
// anything Olma wants to set up for them.

// A goal, exactly as one arrives: no due date, no reminder, optional parts.
async function goal(c, userId, title, { daysOld = 5, parts = [] } = {}) {
  const { rows } = await c.query(
    `INSERT INTO tasks (owner_id, title, created_at)
     VALUES ($1, $2, now() - make_interval(days => $3)) RETURNING id`,
    [userId, title, daysOld]);
  const id = rows[0].id;
  for (const p of parts) {
    await c.query(
      `INSERT INTO tasks (owner_id, title, parent_id, status, created_at)
       VALUES ($1, $2, $3, $4, now() - make_interval(days => $5))`,
      [userId, p.title, id, p.status || 'open', daysOld]);
  }
  return id;
}

test('a split goal that has not moved outranks every product pitch', async () => {
  const checkin = require('../src/jobs/checkin');
  const u = await makeUser(db.pool, '+972641000041', { firstName: 'Chaim' });
  const c = await db.pool.connect();
  try {
    const id = await goal(c, u.id, 'למכור 3 מהרכבים', {
      daysOld: 5,
      parts: [{ title: 'רכב 1' }, { title: 'רכב 2' }, { title: 'רכב 3' }],
    });
    const pick = await checkin.pickRung(c, u.id);
    assert.equal(pick.rung, 'stalled_goal');
    assert.equal(pick.topic, `goal:${id}`);
    assert.ok(pick.instruction.includes('<<<למכור 3 מהרכבים>>>'), 'their own words, quoted as data');
    assert.match(pick.instruction, /3 open parts/);
    assert.match(pick.instruction, new RegExp(`task id ${id}`));
    assert.match(pick.instruction, /5 days ago/);
    // and it explicitly forbids the empty version of this message
    assert.match(pick.instruction, /any progress/);
  } finally { c.release(); }
});

test('what does NOT count as stalled: too new, being handled, or already moving', async () => {
  const checkin = require('../src/jobs/checkin');
  const c = await db.pool.connect();
  try {
    const fresh = await makeUser(db.pool, '+972641000042');
    await goal(c, fresh.id, 'נמכור מתישהו', { daysOld: 1 });
    assert.notEqual((await checkin.pickRung(c, fresh.id)).rung, 'stalled_goal',
      'said yesterday — nudging that is nagging, not help');

    // an errand gets a week before anyone asks about it; a split project 3 days
    const errand = await makeUser(db.pool, '+972641000043');
    await goal(c, errand.id, 'לקנות מסנן', { daysOld: 4 });
    assert.notEqual((await checkin.pickRung(c, errand.id)).rung, 'stalled_goal');
    const older = await makeUser(db.pool, '+972641000044');
    await goal(c, older.id, 'לסדר את המוסך', { daysOld: 9 });
    assert.equal((await checkin.pickRung(c, older.id)).rung, 'stalled_goal');

    // a reminder already exists → the goal is being handled, say nothing
    const handled = await makeUser(db.pool, '+972641000045');
    const hid = await goal(c, handled.id, 'למכור את הטויוטה', { daysOld: 10 });
    await c.query(
      `INSERT INTO task_reminders (task_id, remind_at) VALUES ($1, now() + interval '2 days')`, [hid]);
    assert.notEqual((await checkin.pickRung(c, handled.id)).rung, 'stalled_goal');

    // one part already done → it is moving, leave them alone
    const moving = await makeUser(db.pool, '+972641000046');
    await goal(c, moving.id, 'למכור 2 רכבים', {
      daysOld: 8, parts: [{ title: 'רכב 1', status: 'done' }, { title: 'רכב 2' }],
    });
    assert.notEqual((await checkin.pickRung(c, moving.id)).rung, 'stalled_goal');

    // a due date means another rung owns it
    const dated = await makeUser(db.pool, '+972641000047');
    const did = await goal(c, dated.id, 'להגיש דוח', { daysOld: 10 });
    await c.query(`UPDATE tasks SET due_at = now() + interval '30 days' WHERE id = $1`, [did]);
    assert.notEqual((await checkin.pickRung(c, dated.id)).rung, 'stalled_goal');
  } finally { c.release(); }
});

test('a goal is raised at most once a fortnight, then rotates or steps aside', async () => {
  const checkin = require('../src/jobs/checkin');
  const u = await makeUser(db.pool, '+972641000048', { firstName: 'Chaim' });
  const c = await db.pool.connect();
  try {
    const first = await goal(c, u.id, 'למכור 3 מהרכבים', { daysOld: 20, parts: [{ title: 'רכב 1' }] });
    const second = await goal(c, u.id, 'לסיים את הרישוי', { daysOld: 15 });
    assert.equal((await checkin.pickRung(c, u.id)).topic, `goal:${first}`);

    await c.query(
      `INSERT INTO outbox (user_id, kind, payload)
       VALUES ($1, 'checkin', $2::jsonb)`,
      [u.id, JSON.stringify({ rung: 'stalled_goal', topic: `goal:${first}` })]);
    assert.equal((await checkin.pickRung(c, u.id)).topic, `goal:${second}`,
      'the same goal must not be raised twice running');

    await c.query(
      `INSERT INTO outbox (user_id, kind, payload)
       VALUES ($1, 'checkin', $2::jsonb)`,
      [u.id, JSON.stringify({ rung: 'stalled_goal', topic: `goal:${second}` })]);
    assert.notEqual((await checkin.pickRung(c, u.id)).rung, 'stalled_goal',
      'nothing left to raise this fortnight — do not repeat, fall through');

    // ...and an old nudge stops holding it back once the fortnight is up
    await c.query(
      `UPDATE outbox SET created_at = now() - interval '20 days' WHERE user_id = $1`, [u.id]);
    assert.equal((await checkin.pickRung(c, u.id)).topic, `goal:${first}`);
  } finally { c.release(); }
});

// The ladder's top rung is what actually reached the user on Saturday morning.
// Beyond quoting a dead slot, stuck_meeting outranks everything — so an
// unclosable negotiation also shadowed every other check-in this person should
// have been getting. Both halves are asserted here.
test('a passed meeting neither nudges nor blocks the rest of the ladder', async () => {
  const connections = require('../src/domain/connections');
  const grants = require('../src/domain/grants');
  const meetings = require('../src/domain/meetings');
  const checkin = require('../src/jobs/checkin');

  const host = await makeUser(db.pool, '+972581000001', { firstName: 'Miron' });
  const amit = await makeUser(db.pool, '+972581000002', { firstName: 'Amit' });
  const c = await db.pool.connect();
  try {
    const req = await connections.requestConnection(c, host.id, amit.phone, {});
    const conn = (await connections.respondToConnection(c, amit.id, req.data.connection.id, 'approve')).data.connection;
    await grants.grantFeature(c, host.id, conn.id, 'meetings');
    await grants.grantFeature(c, amit.id, conn.id, 'meetings');
    const m = (await meetings.startMeeting(c, host.id, 'פוקר', [amit.id])).data.meeting;
    await meetings.proposeSlot(c, host.id, m.id, 'יום שישי 20:00',
      slotStart('יום שישי 20:00'));

    assert.equal((await checkin.pickRung(c, amit.id)).rung, 'stuck_meeting',
      'while the slot is ahead, chasing an unanswered proposal is exactly right');

    // Friday 20:00 came and went with no answer.
    await c.query(`UPDATE meetings SET proposed_start_at = now() - interval '13 hours' WHERE id = $1`, [m.id]);

    const pick = await checkin.pickRung(c, amit.id);
    assert.notEqual(pick.rung, 'stuck_meeting',
      'Saturday: no message about Friday night');
    assert.ok(['discovery', 'silence', 'stalled_goal', 'deadline_risk', 'overload'].includes(pick.rung),
      `the ladder moves on to something real, got ${pick.rung}`);
  } finally { c.release(); }
});
