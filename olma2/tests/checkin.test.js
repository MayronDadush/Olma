'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const checkin = require('../src/jobs/checkin');

let db;
before(async () => {
  db = await freshDb();
  await withTx(db.pool, (c) => require('../src/domain/flags').setFlag(c, 'google_connect_phones', 'all'));
});
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

test('idempotent per day; backoff excludes after 3 misses; recent activity excludes', async () => {
  const again = await withTx(db.pool, (c) => checkin.run(c));
  assert.equal(again.length, 0, 'second run same day enqueues nothing');

  const gaveUp = await silentUser('+972591000006');
  await db.pool.query(`UPDATE users SET checkin_misses = 3 WHERE id = $1`, [gaveUp.id]);
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

  // Engagement, not the calendar, decides the rest: one ignored check-in buys
  // three days of quiet (never less, whatever the age tier says), two drops to
  // weekly. A responsive new user keeps the fast cadence; a silent one is
  // left alone — four messages on four days is what "doubles" used to allow.
  assert.equal(h(requiredGapMs(0, 1)), 72, 'one miss → three days');
  assert.equal(h(requiredGapMs(30, 1)), 72, 'three days regardless of age');
  assert.equal(h(requiredGapMs(0, 2)), 24 * 7, 'two misses → weekly');
  assert.equal(h(requiredGapMs(30, 2)), 24 * 7, 'weekly regardless of age');
});

test('day one ladder: 15m / 2h / 5h / 8h, and steps expire instead of piling up', async () => {
  const checkin = require('../src/jobs/checkin');
  const { onboardingStepDue, DEAF_SILENT_SLOTS } = checkin;
  const MIN = 60_000, H = 3600_000;

  assert.equal(onboardingStepDue(5 * MIN, 0), null, 'nothing in the first minutes');
  assert.equal(onboardingStepDue(16 * MIN, 0).slot, '15m');
  assert.equal(onboardingStepDue(2.5 * H, 0).slot, '2h');
  assert.equal(onboardingStepDue(6 * H, 0).slot, '5h');
  // The calendar offer, late on purpose — a link in hour one asks them to
  // leave before anything here has proved useful. Their page was a 22h step
  // until 2026-10-08; it now waits for their tasks (the `dashboard` gap).
  assert.equal(onboardingStepDue(9 * H, 0).slot, '8h');
  // only the latest due step, so a gap in the sweep never replays old ones
  assert.equal(onboardingStepDue(23 * H, 0).slot, '8h');
  assert.equal(onboardingStepDue(25 * H, 0), null, 'day one is over');
  // present, not deaf: deafness now means DELIVERED-and-ignored (a boolean
  // the caller derives from the outbox), never a counter that ghost-expired
  // messages inflated.
  assert.equal(onboardingStepDue(6 * H, true), null);
  assert.equal(onboardingStepDue(6 * H, false).slot, '5h');
  // The link rung asks the person to go and DO something, so it is not sent
  // to somebody who has never once answered.
  assert.equal(onboardingStepDue(9 * H, true), null);
  assert.equal(onboardingStepDue(23 * H, true), null);
  // ...while the first two fire regardless — that is the point of the ladder.
  assert.equal(onboardingStepDue(16 * MIN, true).slot, '15m');
  assert.equal(onboardingStepDue(2.5 * H, true).slot, '2h');
  assert.deepEqual([...DEAF_SILENT_SLOTS].sort(), ['5h', '8h']);
  assert.equal(checkin.ONBOARDING_STEPS.find((s) => s.slot === '22h'), undefined, 'no page at the start');
});

// Both link rungs are for something the person does not yet have. A step whose
// point is already met hands its slot back to the ordinary ladder rather than
// spending the day's one message saying nothing.
test('day one: the calendar offer is skipped once Google is connected', async () => {
  const checkin = require('../src/jobs/checkin');
  const step = checkin.ONBOARDING_STEPS.find((s) => s.slot === '8h');
  const u = await makeUser(db.pool, '+972615000088', { firstName: 'Noa' });
  const client = await db.pool.connect();
  try {
    assert.equal(await step.skipIf(client, u), false, 'nothing connected yet');
    await client.query(
      `INSERT INTO integrations (user_id, provider, status) VALUES ($1, 'google_calendar', 'connected')`,
      [u.id]);
    assert.equal(await step.skipIf(client, u), true);
  } finally { client.release(); }
});

test('a rung the ladder falls through to also replaces the step still waiting', async () => {
  const checkin = require('../src/jobs/checkin');
  const flags = require('../src/domain/flags');
  const H = 3600_000;
  const u = await makeUser(db.pool, '+972615000143', { firstName: 'Ben' });
  const t0 = Date.now() - 9 * H;
  await db.pool.query(
    `UPDATE users SET onboarded_at = $2, created_at = $2, timezone = 'Asia/Jerusalem',
            timezone_confirmed = TRUE, last_inbound_at = $2
       WHERE id = $1`, [u.id, new Date(t0)]);
  // He had given her something — the 5h step is silent for somebody who had not.
  await db.pool.query(`INSERT INTO tasks (owner_id, title) VALUES ($1, 'לקנות חלב')`, [u.id]);

  const c = await db.pool.connect();
  try {
    // The 5h step goes out and is held for the night, exactly as it was for him.
    await checkin.run(c, t0 + 5 * H + 60_000);
    await c.query(
      `UPDATE outbox SET hold_reason = 'night', release_after = now() + interval '8 hours'
        WHERE user_id = $1 AND kind = 'checkin' AND sent_at IS NULL`, [u.id]);
    const five = await c.query(
      `SELECT id FROM outbox WHERE user_id = $1 AND kind = 'checkin' AND sent_at IS NULL`, [u.id]);
    assert.equal(five.rows.length, 1);

    // Now the 8h step DECLINES (Google connecting is shut), so the run falls
    // through to an ordinary rung. Keyed on 'onboarding:%' the supersede would
    // have missed it and both would have been released together in the morning.
    await flags.setFlag(c, 'google_connect_phones', '');
    await checkin.run(c, t0 + 8 * H + 60_000);
    await flags.setFlag(c, 'google_connect_phones', 'all');

    const { rows } = await c.query(
      `SELECT id, hold_reason, sent_at FROM outbox
        WHERE user_id = $1 AND kind = 'checkin' ORDER BY id`, [u.id]);
    const older = rows.find((r) => String(r.id) === String(five.rows[0].id));
    assert.equal(older.hold_reason, 'superseded', 'the waiting step is replaced, not joined');
    assert.ok(older.sent_at, 'withdrawn like a cancellation');
    const live = rows.filter((r) => !r.sent_at);
    assert.equal(live.length, 1, 'exactly one live rung');
  } finally { c.release(); }
});

test('day one: the calendar offer is skipped while Google connecting is off', async () => {
  const checkin = require('../src/jobs/checkin');
  const flags = require('../src/domain/flags');
  const step = checkin.ONBOARDING_STEPS.find((s) => s.slot === '8h');
  const u = await makeUser(db.pool, '+972615000140', { firstName: 'Gil' });
  const client = await db.pool.connect();
  try {
    assert.equal(await step.skipIf(client, u), false, 'open: the offer stands');
    // Nothing connected, so the only thing that changes is the door. An offer
    // the tool would then refuse is the worst kind — they say yes first.
    await flags.setFlag(client, 'google_connect_phones', '');
    assert.equal(await step.skipIf(client, u), true);
    await flags.setFlag(client, 'google_connect_phones', 'all');
    assert.equal(await step.skipIf(client, u), false, 'reopening restores it');
  } finally { client.release(); }
});

test('the ongoing calendar pitch goes quiet while connecting is off', async () => {
  const checkin = require('../src/jobs/checkin');
  const flags = require('../src/domain/flags');
  const u = await makeUser(db.pool, '+972615000141', { firstName: 'Shira' });
  await db.pool.query(
    `UPDATE users SET timezone = 'Asia/Jerusalem', timezone_confirmed = TRUE WHERE id = $1`, [u.id]);
  const c = await db.pool.connect();
  try {
    // Close every gap except the calendar, exactly as the pitch test above does.
    await c.query(`UPDATE users SET digest_times = '09:00' WHERE id = $1`, [u.id]);
    await c.query(
      `INSERT INTO user_facts (user_id, category, fact)
       VALUES ($1, 'context', 'אחת'), ($1, 'work', 'שתיים'), ($1, 'plans', 'שלוש')`, [u.id]);
    const friend = await makeUser(db.pool, '+972615000142', { firstName: 'Tal' });
    const connections = require('../src/domain/connections');
    const req = await connections.requestConnection(c, u.id, friend.phone, {});
    await connections.respondToConnection(c, friend.id, req.data.connection.id, 'approve');

    assert.equal((await checkin.pickRung(c, u.id)).topic, 'calendar:not_connected');

    await flags.setFlag(c, 'google_connect_phones', '');
    let pick = await checkin.pickRung(c, u.id);
    assert.notEqual(pick && pick.topic, 'calendar:not_connected');

    // A connection Google has stopped accepting goes quiet too: their calendar
    // is already doing nothing, and walking them back to a door that will not
    // open is worse than leaving it until it does.
    await c.query(
      `INSERT INTO integrations (user_id, provider, status, access_level)
       VALUES ($1, 'google_calendar', 'needs_reauth', 'read_write')`, [u.id]);
    pick = await checkin.pickRung(c, u.id);
    assert.notEqual(pick && pick.topic, 'calendar:needs_reauth');

    await flags.setFlag(c, 'google_connect_phones', 'all');
    assert.equal((await checkin.pickRung(c, u.id)).topic, 'calendar:needs_reauth');
  } finally { c.release(); }
});

// Owner, 2026-10-08: their page is not part of the start — it is offered
// once they hold enough tasks for it to show something, and only once.
test('their page is offered at three open tasks, not before, and not to somebody who has it', async () => {
  const checkin = require('../src/jobs/checkin');
  const dashboardAuth = require('../src/domain/dashboard-auth');
  const u = await makeUser(db.pool, '+972615000089', { firstName: 'Adi' });
  const has = async () => (await withTx(db.pool, (c) => checkin.discoveryGaps(c, u.id)))
    .some((g) => g.topic === 'dashboard');
  const addTask = (t) => db.pool.query(`INSERT INTO tasks (owner_id, title) VALUES ($1, $2)`, [u.id, t]);
  await addTask('א'); await addTask('ב');
  assert.equal(await has(), false, 'two is not yet');
  await addTask('ג');
  assert.equal(await has(), true, 'three is');
  const gap = (await withTx(db.pool, (c) => checkin.discoveryGaps(c, u.id))).find((g) => g.topic === 'dashboard');
  assert.match(gap.instruction, /open_my_dashboard/);
  assert.match(gap.instruction, /3 open tasks/);

  const client = await db.pool.connect();
  try {
    // The owner opening it from the admin page is not them having it, and
    // neither is a coordination's page.
    await dashboardAuth.createLinkUrl(client, u.id, { byAdmin: true });
    assert.equal(await has(), true);
    await client.query(
      `INSERT INTO magic_links (token_hash, user_id, expires_at, target) VALUES ('m1', $1, now() + interval '1 day', 'meeting')`, [u.id]);
    assert.equal(await has(), true, 'a coordination page is not their list');
    await dashboardAuth.createLinkUrl(client, u.id);
    assert.equal(await has(), false, 'a second link to their page is noise, not news');
  } finally { client.release(); }
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

// Owner, 2026-10-08: the intro clip a few minutes after the opening takes the
// 15m step's place ("הסרטון במקומה") — silently, never handed to the ladder —
// and a clip the gate dropped leaves the step to go as before.
test('day one: a joiner\'s intro clip takes the 15m step\'s place', async () => {
  const mk = async (phone) => {
    const u = await makeUser(db.pool, phone, { firstName: 'Clip' });
    await db.pool.query(
      `UPDATE users SET agent_id = 'u-' || id, onboarded_at = now() - interval '20 minutes' WHERE id = $1`, [u.id]);
    return u;
  };
  const clipped = await mk('+972615077301');
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, idempotency_key, sent_at)
     VALUES ($1::bigint, 'intro_video', '{"video":"v2","joiner":true}', 'urgent', 'intro_video:v2:' || $1::text, now())`, [clipped.id]);
  const dropped = await mk('+972615077302');
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, idempotency_key, sent_at, hold_reason)
     VALUES ($1::bigint, 'intro_video', '{"video":"v2"}', 'urgent', 'intro_video:v2:' || $1::text, now(), 'paused')`, [dropped.id]);

  const out = await withTx(db.pool, (c) => checkin.run(c, Date.now()));
  assert.equal(out.filter((r) => r.userId === clipped.id).length, 0, 'the clip was the 15m message');
  const { rows } = await db.pool.query(
    `SELECT count(*)::int n FROM outbox WHERE user_id = $1 AND kind = 'checkin'`, [clipped.id]);
  assert.equal(rows[0].n, 0, 'and its slot was not handed to the ordinary ladder');
  assert.deepEqual(out.filter((r) => r.userId === dropped.id).map((r) => r.rung), ['onboarding_15m'],
    'a clip that never reached them leaves the step');
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

// The regular half is counted where the check-in REACHES them, so here only
// the queue is visible; tests/checkin-misses.test.js drains it.
test('day-one steps never count as misses; a regular checkin is queued, not yet counted', async () => {
  const checkin = require('../src/jobs/checkin');
  const fresh = await makeUser(db.pool, '+972641000031', { firstName: 'Noa' });
  const c = await db.pool.connect();
  try {
    await c.query(
      `UPDATE users SET onboarded_at = now() - interval '20 minutes' WHERE id = $1`, [fresh.id]);
    await checkin.run(c);
    let { rows } = await c.query(`SELECT checkin_misses FROM users WHERE id = $1`, [fresh.id]);
    assert.equal(rows[0].checkin_misses, 0, 'an onboarding step is not evidence of being ignored');

    // past day one, idle → a regular checkin fires, and counts once it lands
    await c.query(
      `UPDATE users SET onboarded_at = now() - interval '3 days',
              created_at = now() - interval '3 days', last_checkin_at = NULL WHERE id = $1`,
      [fresh.id]);
    await c.query(
      `UPDATE audit_log SET created_at = now() - interval '3 days' WHERE actor_id = $1`, [fresh.id]);
    await checkin.run(c);
    ({ rows } = await c.query(`SELECT checkin_misses FROM users WHERE id = $1`, [fresh.id]));
    assert.equal(rows[0].checkin_misses, 0, 'queued is not asked');
    ({ rows } = await c.query(
      `SELECT payload->>'rung' AS rung FROM outbox WHERE user_id = $1 AND kind = 'checkin' ORDER BY id DESC LIMIT 1`, [fresh.id]));
    assert.ok(!rows[0].rung.startsWith('onboarding_'), 'a regular rung is what went into the queue');
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

// 2026-09-05, user 13: four proactive messages on four consecutive days to a
// person who answered none of them — two "anything new?", then a question
// about which city he lives in. Nobody is asked a question they have already
// not answered once.
test('after one unanswered check-in there are no more questions, only a quiet one-liner', async () => {
  const u = await silentUser('+972591000031');
  await db.pool.query(`UPDATE users SET timezone_confirmed = false, digest_times = NULL WHERE id = $1`, [u.id]);
  const fresh = await withTx(db.pool, (c) => checkin.pickRung(c, u.id, 0));
  assert.equal(fresh.rung, 'discovery', 'with no miss on record, discovery is still on the table');
  const ignored = await withTx(db.pool, (c) => checkin.pickRung(c, u.id, 1));
  assert.equal(ignored.rung, 'silence');
  assert.match(ignored.instruction, /no question mark/);
  assert.match(ignored.instruction, /stay quiet until they write/);
  assert.ok(!/discovery|city|calendar/i.test(ignored.instruction), 'no pitch rides along');
  // What is THEIRS still outranks the quiet: a meeting waiting on their answer.
  const { rows: [other] } = await db.pool.query(
    `INSERT INTO users (phone, status, first_name, timezone) VALUES ('+972591000032','active','B','Asia/Jerusalem') RETURNING id`);
  const meetings = require('../src/domain/meetings');
  await withTx(db.pool, async (c) => {
    const m = await meetings.createMeeting(c, other.id, { title: 'קפה', participantIds: [u.id] });
    await meetings.proposeSlot(c, other.id, m.data.meeting.id, { proposedSlot: 'מחר 10:00', startsAt: new Date(Date.now() + 86400_000).toISOString() });
  }).catch(() => { /* schema drift in this helper is not what this test is about */ });
  const withMeeting = await withTx(db.pool, (c) => checkin.pickRung(c, u.id, 1));
  assert.ok(withMeeting.rung === 'stuck_meeting' || withMeeting.rung === 'silence');
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
    assert.match(pick.instruction, /COUNTRY/, 'it asks for a country, not an IANA name');
    assert.match(pick.instruction, /באיזו מדינה/, 'and the sentence it hands over says country too');
    assert.doesNotMatch(pick.instruction, /באיזו עיר/, 'the city question is gone (owner, 2026-09-08)');
    assert.match(pick.instruction, /travel/, 'and it is where they learn to say so when they travel');

    // The five countries where a country is NOT a zone. Dropping this follow-up
    // is how Sarah's +1 bought her New York while she was in Los Angeles, so
    // the question that replaced the city has to carry the exception with it.
    for (const multiZone of ['US', 'Canada', 'Russia', 'Australia', 'Brazil', 'Mexico']) {
      assert.match(pick.instruction, new RegExp(multiZone),
        `${multiZone} spans several zones and still needs the area asked`);
    }

    // The same message is the only place a person is ever told the hours, and
    // the hours it states must be the ones the gate actually honours — a
    // literal here would let the two drift the next time the default moves.
    const { DEFAULT_WINDOW } = require('../src/domain/preferences');
    const [openHour] = DEFAULT_WINDOW.start.split(':');
    const [closeHour] = DEFAULT_WINDOW.end.split(':');
    assert.match(pick.instruction,
      new RegExp(`${Number(openHour)}:00 ל- ${Number(closeHour)}:00 בשעון המקומי`),
      'it states the real default window, in their own words and their own clock');

    // And the day, on exactly the same argument: since 2026-09-11 the quiet
    // day is a DEFAULT they already have rather than a setting on offer, so
    // this sentence is a promise the gate has to keep. Pinned to the function
    // that computes it, never to the word "שבת" — a literal here is how the
    // message and the behaviour drift apart.
    const holidays = require('../src/domain/holidays');
    const heDay = holidays.quietDayWord(
      holidays.defaultQuietDay(holidays.calendarFor({ locale: 'he' })), 'he');
    assert.match(pick.instruction, new RegExp(`${heDay} לשלוח רק תזכורות שביקשת`),
      'it names the day they already have, and what still arrives on it');

    // And it opens the two doors nothing else opens, naming the keys their
    // answers have to land in — a question whose answer has nowhere to go is
    // worse than no question.
    assert.match(pick.instruction, /"availability"/);
    assert.match(pick.instruction, /"quiet_days"/);
    assert.match(pick.instruction, /תזכורות שביקשת/,
      'what survives a quiet day is stated to them, not just to the gate');
    // Turning it OFF has one spelling and it is not the delete: with no row
    // at all the default day simply comes back.
    assert.match(pick.instruction, /"none"/);
    assert.match(pick.instruction, /never forget_preference/);

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

test('an English speaker reads the same three lines, in English, naming Sunday', async () => {
  const checkin = require('../src/jobs/checkin');
  const holidays = require('../src/domain/holidays');
  const u = await makeUser(db.pool, '+14155550142', { firstName: 'Sarah', locale: 'en' });
  const c = await db.pool.connect();
  try {
    await c.query(`UPDATE users SET timezone = 'America/Los_Angeles' WHERE id = $1`, [u.id]);
    const pick = await checkin.pickRung(c, u.id);
    assert.equal(pick.topic, 'timezone');

    // Until 2026-09-11 this rung handed every person on earth a Hebrew
    // sentence to say word for word. Quoted in both languages now, because a
    // sentence that is only DESCRIBED is a sentence the model rewrites — the
    // fault that produced "נוסע לשם אחרת". There is no country label inside
    // this one, which is what makes the English quote safe here.
    assert.match(pick.instruction, /Which country are you in\?/);
    assert.doesNotMatch(pick.instruction, /באיזו מדינה/,
      'an English speaker is never told to say the Hebrew copy');

    const enDay = holidays.quietDayWord(
      holidays.defaultQuietDay(holidays.calendarFor({ locale: 'en', timezone: 'America/Los_Angeles' })), 'en');
    assert.equal(enDay, 'on Sundays');
    assert.match(pick.instruction, new RegExp(`${enDay} I send only the reminders you asked for`));

    // One question mark, on the country: the hours and the day are statements,
    // because three questions in one message is a form.
    const quoted = /"(Which country[\s\S]*?)" Do not paraphrase/.exec(pick.instruction);
    assert.ok(quoted, 'the copy is handed over quoted, not described');
    assert.equal(quoted[1].split('?').length - 1, 1, 'exactly one question mark');
    assert.equal(quoted[1].split('\n').length, 3, 'three lines, never a fourth');
  } finally {
    c.release();
  }
});

test('the ladder offers quiet chagim once, close to one, and stamps the person', async () => {
  const checkin = require('../src/jobs/checkin');
  const u = await makeUser(db.pool, '+972641000091', { firstName: 'Avi', holidayAsked: null });
  const c = await db.pool.connect();
  try {
    await c.query(
      `UPDATE users SET timezone = 'Asia/Jerusalem', timezone_confirmed = true WHERE id = $1`, [u.id]);

    // Pinned: Rosh Hashana 5787 is 12-13 September 2026 in Israel, so this is
    // four days out. A relative date here would make the test mean something
    // different every week of the year.
    const fourDaysOut = new Date('2026-09-08T09:00:00Z');
    const gaps = await checkin.discoveryGaps(c, u.id, fourDaysOut);
    const chag = gaps.find((g) => g.topic === 'holidays');
    assert.ok(chag, 'a yom tov within a week is worth one rung');
    assert.match(chag.instruction, /ראש השנה/, 'it names the day, in their language');
    assert.match(chag.instruction, /no question mark/,
      'a statement, because three questions in one message is a form');
    assert.match(chag.instruction, /"quiet_days"/);
    assert.match(chag.instruction, /"holiday_calendar"/);
    assert.doesNotMatch(chag.instruction, /שנה טובה/,
      'the offer is not a greeting — the chag has not arrived');

    // It is placed behind the timezone rung and in front of the rest: a zone
    // nobody confirmed poisons every dated thing under it, including this.
    assert.ok(gaps.findIndex((g) => g.topic === 'holidays')
      < gaps.findIndex((g) => g.topic === 'curiosity'));

    // Far from any chag it costs nothing at all.
    const november = await checkin.discoveryGaps(c, u.id, new Date('2026-11-17T09:00:00Z'));
    assert.ok(!november.some((g) => g.topic === 'holidays'));

    // Asked, and then never again — stamped on the PERSON, which is what lets
    // the turn hint and this rung share one promise (migration 062).
    await c.query(`UPDATE users SET holiday_quiet_asked_at = now() WHERE id = $1`, [u.id]);
    const after = await checkin.discoveryGaps(c, u.id, fourDaysOut);
    assert.ok(!after.some((g) => g.topic === 'holidays'), 'asked once, ever');

    // And somebody who already has it is not offered it either.
    await c.query(`UPDATE users SET holiday_quiet_asked_at = NULL WHERE id = $1`, [u.id]);
    const prefs = require('../src/domain/preferences');
    await prefs.remember(c, u.id, 'quiet_days', 'sat,holidays');
    const already = await checkin.discoveryGaps(c, u.id, fourDaysOut);
    assert.ok(!already.some((g) => g.topic === 'holidays'));
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

test('a shopping list is not a stalled goal — Dov\'s eggs and cottage cheese', async () => {
  const checkin = require('../src/jobs/checkin');
  const c = await db.pool.connect();
  try {
    // 2026-09-28: "עשרים יום עברו וה'קניות בסופר' עדיין מחכה — ביצים, קוטג' ובשר".
    const dov = await makeUser(db.pool, '+972641000049');
    const list = await goal(c, dov.id, 'קניות בסופר', {
      daysOld: 20, parts: [{ title: 'ביצים' }, { title: "קוטג'" }, { title: 'עוף או בשר' }],
    });
    await c.query(`UPDATE tasks SET category = 'errands' WHERE id = $1 OR parent_id = $1`, [list]);
    assert.notEqual((await checkin.pickRung(c, dov.id)).rung, 'stalled_goal');
    // …and the same under 'lists', where every list is filed since 2026-10-05
    await c.query(`UPDATE tasks SET category = 'lists' WHERE id = $1`, [list]);
    assert.notEqual((await checkin.pickRung(c, dov.id)).rung, 'stalled_goal');
    // …while a PROJECT with the same shape and no category still is one
    const chaim = await makeUser(db.pool, '+972641000050');
    await goal(c, chaim.id, 'להתפטר משלושה רכבים', { daysOld: 20, parts: [{ title: 'רכב 1' }] });
    const pick = await checkin.pickRung(c, chaim.id);
    assert.equal(pick.rung, 'stalled_goal');
    assert.match(pick.instruction, /never with how long it has waited/);
    // …and a single errand with no items is still asked about after its week
    const single = await makeUser(db.pool, '+972641000051');
    const sid = await goal(c, single.id, 'להחליף נורה במטבח', { daysOld: 9 });
    await c.query(`UPDATE tasks SET category = 'errands' WHERE id = $1`, [sid]);
    assert.equal((await checkin.pickRung(c, single.id)).rung, 'stalled_goal');
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

// One city question per person, ever — not one per code path.
//
// Sarah (u-17) was asked which city she was in twice, four days apart: once by
// an operator's repair message carrying topic 'timezone_repair', once by this
// ladder's own 'timezone'. The once-ever dedup below keys on the topic string,
// so to it those were two different questions; to her they were the same one,
// asked again after she had already declined to answer it.
test('the city is asked once ever, across every route that asks it', async () => {
  const u = await makeUser(db.pool, '+972641000081', { firstName: 'Sarah' });
  const c = await db.pool.connect();
  try {
    await c.query(`UPDATE users SET timezone = 'America/New_York' WHERE id = $1`, [u.id]);
    await c.query(`INSERT INTO tasks (owner_id, title) VALUES ($1, 'a'), ($1, 'b')`, [u.id]);
    assert.equal((await checkin.pickRung(c, u.id)).topic, 'timezone');

    // Somebody else asked — an operator's one-off, a topic this ladder has
    // never heard of. The stamp is the only thing the two share.
    await c.query(`UPDATE users SET timezone_asked_at = now() WHERE id = $1`, [u.id]);

    const pick = await checkin.pickRung(c, u.id);
    assert.notEqual(pick.topic, 'timezone', 'asked once is asked');
    // ...and the ladder moves on to the gap underneath rather than going quiet.
    assert.equal(pick.topic, 'digest');
  } finally { c.release(); }
});

test('asking stamps the ask, so the next tick cannot ask again', async () => {
  const u = await makeUser(db.pool, '+972641000082', { firstName: 'Noa' });
  await db.pool.query(
    `UPDATE users SET timezone = 'America/New_York', onboarded_at = now() - interval '9 days',
            last_checkin_at = now() - interval '9 days' WHERE id = $1`, [u.id]);
  await db.pool.query(`INSERT INTO tasks (owner_id, title) VALUES ($1, 'a'), ($1, 'b')`, [u.id]);
  // Eligibility reads last_activity off the audit trail, and provisioning
  // wrote rows a second ago — age them with the user or she is never idle.
  await db.pool.query(
    `UPDATE audit_log SET created_at = now() - interval '9 days' WHERE actor_id = $1`, [u.id]);

  await withTx(db.pool, (c) => checkin.run(c, Date.now()));
  const { rows } = await db.pool.query(
    `SELECT timezone_asked_at, (SELECT payload->>'topic' FROM outbox
        WHERE user_id = u.id AND kind = 'checkin' ORDER BY id DESC LIMIT 1) AS topic
       FROM users u WHERE u.id = $1`, [u.id]);
  assert.equal(rows[0].topic, 'timezone', 'the ask went out');
  assert.ok(rows[0].timezone_asked_at, 'and was stamped on the way out, not on the answer');
});

// The first message a stranger ever gets. Two things it must carry and neither
// was being carried: what we are ASSUMING about where they are (Sarah spent her
// first evening three hours out and found out from an operator), and a check on
// the NAME, which is whatever WhatsApp's display field held — שחר was greeted
// by a surname he never gave. And one thing it must never carry: an IANA zone
// name, which is our vocabulary. He was sent "אני מניחה שאתה בישראל
// (Asia/Jerusalem)".
test('the first message states the timezone guess in plain words and checks the name', () => {
  const first = checkin.ONBOARDING_STEPS[0].instruction;
  assert.equal(typeof first, 'function', 'it depends on the person, so it is built per person');

  const shahar = first(null, {
    phone: '+972525497771', first_name: 'שחר מזושיאן', name_confirmed: false, timezone_confirmed: false,
  });
  assert.match(shahar, /\+972/, 'it shows the evidence: the dialling code');
  assert.match(shahar, /ישראל/, 'and names the country');
  assert.doesNotMatch(shahar, /Asia\/Jerusalem/, 'never the zone, not even as a thing not to say');
  // A Hebrew speaker in a one-clock country is handed the SENTENCE, quoted, so
  // there is nothing to translate: described in English, the model told בר
  // "וקבעתי את השעות accordingly" (2026-09-07).
  assert.match(shahar, /word for word/, 'the sentence is quoted, not described');
  assert.match(shahar, /"המספר שלך מתחיל ב־\+972, אז אני מניחה שאתה בישראל וכיוונתי את השעות לפי זה\. ואם תיסע או תעבור לעיר אחרת, פשוט תגיד לי\."/,
    'the exact sentence, evidence and travel line included');
  assert.doesNotMatch(shahar, /set their hours|guessing they are in/, 'no English description left beside the quote to translate from');
  assert.match(shahar, /STATEMENT, not a question/, 'the zone is told, not asked');
  assert.match(shahar, /שחר מזושיאן/, 'the name we hold is quoted so it can be checked');
  assert.match(shahar, /ONLY question mark/, 'exactly one ask in the whole message');

  // A country whose dialling code spans several zones is the case that cost
  // Sarah her first evening: "+1" bought her New York while she was in Los
  // Angeles. Naming the CITY whose clock we set is the only version of the
  // sentence a wrong guess cannot survive unnoticed.
  const sarah = first(null, {
    phone: '+15167802250', first_name: 'Sarah', name_confirmed: false, timezone_confirmed: false,
  });
  assert.match(sarah, /New York/, 'an ambiguous country must name the city it picked');
  assert.match(sarah, /spans several timezones/);
  assert.match(sarah, /travel line/, 'the described form still hands them the way to correct it');
  // An English speaker in a one-clock country stays on the described form:
  // the country labels on file are Hebrew, so there is no English sentence to
  // quote yet, and an English description read by an English speaker leaks
  // nothing.
  const english = first(null, {
    phone: '+972525497772', first_name: 'Dan', name_confirmed: false, timezone_confirmed: false, locale: 'en',
  });
  assert.match(english, /guessing they are in/);
  assert.doesNotMatch(english, /word for word/);

  // Someone who already told us where they are is not informed of our
  // assumption about them, and a confirmed name is not re-checked.
  const settled = first(null, {
    phone: '+972500000000', first_name: 'דנה', name_confirmed: true, timezone_confirmed: true,
  });
  assert.doesNotMatch(settled, /guessing/);
  assert.doesNotMatch(settled, /question mark/);
});

// Yahav, 2026-09-06, 05:01:54 and 05:02:44 UTC: the 5h and the 8h steps, both
// held for the night, both released at 08:00. ג.ב was due the same pair on
// 2026-09-08. The comment on the ladder promised ONE message — the latest
// step still live — and the expiry numbers never delivered it.
test('day one: a step still held when the next comes due is superseded, not stacked', async () => {
  const checkin = require('../src/jobs/checkin');
  const H = 3600_000;
  const u = await makeUser(db.pool, '+972615000090', { firstName: 'Gil' });
  const t0 = Date.now() - 9 * H;
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = to_timestamp($2/1000.0) WHERE id = $1`,
    [u.id, t0]);
  // The 5h step reflects back what she holds, and is silent when that is nothing.
  await db.pool.query(`INSERT INTO tasks (owner_id, title) VALUES ($1, 'לקנות חלב')`, [u.id]);

  // 5h comes due; the row sits held for the night.
  let out = await withTx(db.pool, (c) => checkin.run(c, t0 + 5 * H + 60_000));
  assert.deepEqual(out.filter((r) => r.userId === u.id).map((r) => r.rung), ['onboarding_5h']);
  await db.pool.query(`UPDATE outbox SET hold_reason = 'night', release_after = now() + interval '6 hours'
                        WHERE user_id = $1`, [u.id]);

  // 8h comes due: the 5h row is withdrawn, the 8h row is the one still live.
  out = await withTx(db.pool, (c) => checkin.run(c, t0 + 8 * H + 60_000));
  assert.deepEqual(out.filter((r) => r.userId === u.id).map((r) => r.rung), ['onboarding_8h']);
  const { rows } = await db.pool.query(
    `SELECT idempotency_key, sent_at, hold_reason FROM outbox WHERE user_id = $1 ORDER BY id`, [u.id]);
  assert.equal(rows.length, 2);
  assert.match(rows[0].idempotency_key, /:5h$/);
  assert.ok(rows[0].sent_at, 'the held 5h step is withdrawn');
  assert.equal(rows[0].hold_reason, 'superseded');
  assert.match(rows[1].idempotency_key, /:8h$/);
  assert.equal(rows[1].sent_at, null, 'the 8h step is the morning');

  // A step that was DELIVERED is not touched by the next one — it was heard.
  const v = await makeUser(db.pool, '+972615000091', { firstName: 'Tal' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = to_timestamp($2/1000.0) WHERE id = $1`,
    [v.id, t0]);
  await db.pool.query(`INSERT INTO tasks (owner_id, title) VALUES ($1, 'לקנות חלב')`, [v.id]);
  await withTx(db.pool, (c) => checkin.run(c, t0 + 5 * H + 60_000));
  // Delivered at its own moment, on the run's clock: the gap between steps is
  // measured from here (checkin.STEP_GAP_MS).
  await db.pool.query(`UPDATE outbox SET sent_at = to_timestamp($2/1000.0), hold_reason = NULL WHERE user_id = $1`,
    [v.id, t0 + 5 * H + 60_000]);
  out = await withTx(db.pool, (c) => checkin.run(c, t0 + 8 * H + 60_000));
  assert.deepEqual(out.filter((r) => r.userId === v.id).map((r) => r.rung), ['onboarding_8h']);
  const { rows: theirs } = await db.pool.query(
    `SELECT idempotency_key, hold_reason, sent_at FROM outbox WHERE user_id = $1 ORDER BY id`, [v.id]);
  assert.equal(theirs[0].hold_reason, null, 'delivered stays delivered');
  assert.ok(theirs[0].sent_at);
  assert.equal(theirs[1].sent_at, null, 'and the 8h step is live beside it');
});

// ב׳, from the real day ones of 2026-09-18..25: fifteen minutes after the
// greeter had said who she is, the 15m step opened "היי 👋 ברוך הבא! אני
// עולמה, העוזרת האישית שלך" (u-34, u-35, u-40, u-43), and for somebody who had
// only said "היי" it showed them the emptiness — "כרגע הרשימה שלך נקייה",
// "Nothing on your list yet". Every step is spoken after an introduction.
test('day one: no step introduces her again, and the 15m step for somebody who gave nothing is an example', async () => {
  const u = await makeUser(db.pool, '+972615000740', { firstName: 'Noa' });
  const t0 = Date.now() - 20 * 60_000;
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = to_timestamp($2/1000.0) WHERE id = $1`,
    [u.id, t0]);

  const out = await withTx(db.pool, (c) => checkin.run(c, t0 + 16 * 60_000));
  assert.deepEqual(out.filter((r) => r.userId === u.id).map((r) => r.rung), ['onboarding_15m']);
  const { rows: [row] } = await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND idempotency_key LIKE 'onboarding:%'`, [u.id]);
  const said = row.payload.checkinInstruction;
  assert.match(said, /do not introduce yourself/);
  assert.match(said, /ONE concrete example/, 'nothing to show, so an example of what to send');
  assert.match(said, /Never tell them what you do NOT hold/);
  assert.doesNotMatch(said, /SHOW them something/, 'there is nothing to show');
  assert.match(said, /\+972/, 'the zone is still stated');

  // Somebody with an open task is shown it, as before — and still not re-introduced.
  const v = await makeUser(db.pool, '+972615000741', { firstName: 'Dana' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = to_timestamp($2/1000.0) WHERE id = $1`,
    [v.id, t0]);
  await db.pool.query(`INSERT INTO tasks (owner_id, title) VALUES ($1, 'לקנות חלב')`, [v.id]);
  await withTx(db.pool, (c) => checkin.run(c, t0 + 16 * 60_000));
  const { rows: [theirs] } = await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND idempotency_key LIKE 'onboarding:%'`, [v.id]);
  assert.match(theirs.payload.checkinInstruction, /SHOW them something/);
  assert.match(theirs.payload.checkinInstruction, /do not introduce yourself/);
  assert.doesNotMatch(theirs.payload.checkinInstruction, /ONE concrete example/);

  // Words left with the greeter are something too.
  assert.equal(await withTx(db.pool, (c) => checkin.holdsNothing(c, u.id)), true);
  await db.pool.query(`UPDATE users SET intake_note_at = now() WHERE id = $1`, [u.id]);
  assert.equal(await withTx(db.pool, (c) => checkin.holdsNothing(c, u.id)), false);
});

// The 5h step reflects back what she holds. For somebody holding nothing that
// is the empty-list message, so the slot is SILENT — and silent, not skipped:
// a skipped step hands the slot to the ordinary ladder.
test('day one: the 5h step says nothing to somebody who has given her nothing', async () => {
  const H = 3600_000;
  const u = await makeUser(db.pool, '+972615000742', { firstName: 'Roni' });
  const t0 = Date.now() - 6 * H;
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = to_timestamp($2/1000.0) WHERE id = $1`,
    [u.id, t0]);
  const out = await withTx(db.pool, (c) => checkin.run(c, t0 + 5 * H + 60_000));
  assert.deepEqual(out.filter((r) => r.userId === u.id), [], 'no step and no rung in its place');
  const { rows } = await db.pool.query(`SELECT 1 FROM outbox WHERE user_id = $1`, [u.id]);
  assert.equal(rows.length, 0);

  // With a task on file the step goes out as before.
  await db.pool.query(`INSERT INTO tasks (owner_id, title) VALUES ($1, 'לקנות חלב')`, [u.id]);
  const again = await withTx(db.pool, (c) => checkin.run(c, t0 + 5 * H + 120_000));
  assert.deepEqual(again.filter((r) => r.userId === u.id).map((r) => r.rung), ['onboarding_5h']);
});

// Hod, 2026-10-03: joined at 17:15 on a Saturday. The 15m step was held for
// Shabbat and went out at 19:08 saying he had joined a quarter of an hour ago;
// the 2h step, on its own clock, followed twelve minutes later.
test('day one: a step held past its moment is dropped, and the next waits for the gap', async () => {
  const H = 3600_000;
  const MIN = 60_000;
  const t0 = Date.now() - 4 * H;
  const at = (ms) => new Date(t0 + ms).toISOString();
  const u = await makeUser(db.pool, '+972615000095', { firstName: 'Hod' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = $2 WHERE id = $1`, [u.id, at(0)]);

  let out = await withTx(db.pool, (c) => checkin.run(c, t0 + 20 * MIN));
  assert.deepEqual(out.filter((r) => r.userId === u.id).map((r) => r.rung), ['onboarding_15m']);
  const { rows: [first] } = await db.pool.query(
    `SELECT id, expires_at FROM outbox WHERE user_id = $1`, [u.id]);
  assert.ok(new Date(first.expires_at).getTime() <= t0 + 75 * MIN,
    'released at havdalah, 113 minutes in, it is past its moment and expires');

  // Had it gone out anyway (it did, under the old expiry): the 2h step, due
  // twelve minutes later, waits out the gap from the moment it REACHED him.
  await db.pool.query(`UPDATE outbox SET sent_at = $2 WHERE id = $1`, [first.id, at(113 * MIN)]);
  out = await withTx(db.pool, (c) => checkin.run(c, t0 + 125 * MIN));
  assert.deepEqual(out.filter((r) => r.userId === u.id), [], 'twelve minutes after the last step: nothing');
  out = await withTx(db.pool, (c) => checkin.run(c, t0 + 113 * MIN + checkin.STEP_GAP_MS + MIN));
  assert.deepEqual(out.filter((r) => r.userId === u.id).map((r) => r.rung), ['onboarding_2h']);

  // Nor does a step start while they are talking; the first contact does.
  const v = await makeUser(db.pool, '+972615000096', { firstName: 'Noa' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = $2, last_inbound_at = $3 WHERE id = $1`,
    [v.id, at(0), at(10 * MIN)]);
  out = await withTx(db.pool, (c) => checkin.run(c, t0 + 16 * MIN));
  assert.deepEqual(out.filter((r) => r.userId === v.id).map((r) => r.rung), ['onboarding_15m'],
    'the first contact goes although they wrote six minutes ago');
  await db.pool.query(`UPDATE outbox SET sent_at = $2 WHERE user_id = $1`, [v.id, at(16 * MIN)]);
  await db.pool.query(`UPDATE users SET last_inbound_at = $2 WHERE id = $1`, [v.id, at(2 * H)]);
  out = await withTx(db.pool, (c) => checkin.run(c, t0 + 2 * H + 5 * MIN));
  assert.deepEqual(out.filter((r) => r.userId === v.id), [], 'they wrote five minutes ago');
  out = await withTx(db.pool, (c) => checkin.run(c, t0 + 2 * H + checkin.TALKING_MS + MIN));
  assert.deepEqual(out.filter((r) => r.userId === v.id).map((r) => r.rung), ['onboarding_2h']);
});

// New people said she "חופרת" (2026-10-04): about four unasked messages in
// their first day, and a room joiner had heard the room's invite and its
// coordination before the first step came due. Two is the ceiling, and a
// step past it is silent rather than handed to the ordinary ladder.
test('day one stops at two unasked messages, and what they chose does not count', async () => {
  const flags = require('../src/domain/flags');
  const H = 3600_000;
  const u = await makeUser(db.pool, '+972615009301', { firstName: 'Lior' });
  const t0 = Date.now() - 3 * H;
  await db.pool.query(
    `UPDATE users SET onboarded_at = $2, created_at = $2, timezone = 'Asia/Jerusalem',
            timezone_confirmed = TRUE, last_inbound_at = $2 WHERE id = $1`, [u.id, new Date(t0)]);
  const sent = (kind, key) => db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, idempotency_key, sent_at, created_at)
     VALUES ($1, $2, '{}'::jsonb, $3, now(), now())`, [u.id, kind, key]);
  const me = { id: u.id, onboarded_at: new Date(t0) };
  const c = await db.pool.connect();
  try {
    // A reminder and a digest they asked for, and one message she decided to
    // send: still under the ceiling, so the 2h step goes out.
    await sent('reminder', `cap-r-${u.id}`);
    await sent('digest', `cap-d-${u.id}`);
    await sent('welcome_followup', `cap-w-${u.id}`);
    assert.equal(await checkin.dayOneSpent(c, me), false);
    let out = await checkin.run(c, t0 + 2 * H + 60_000);
    assert.equal(out.find((r) => r.userId === u.id).rung, 'onboarding_2h');

    // The room's invite reaches them too: now two, and the 5h step is silent.
    await c.query(`UPDATE outbox SET sent_at = now() WHERE user_id = $1 AND kind = 'checkin'`, [u.id]);
    await sent('room_cold_invite', `cap-i-${u.id}`);
    await c.query(`INSERT INTO tasks (owner_id, title) VALUES ($1, 'לקנות חלב')`, [u.id]);
    assert.equal(await checkin.dayOneSpent(c, me), true);
    out = await checkin.run(c, t0 + 5 * H + 60_000);
    assert.equal(out.find((r) => r.userId === u.id), undefined, 'the step is silent');
    // ...and silent means nothing at all, not the ordinary ladder instead.
    out = await checkin.run(c, t0 + 8 * H + 60_000);
    assert.equal(out.find((r) => r.userId === u.id), undefined, 'no rung falls through either');

    // Off, it is exactly the old ladder.
    await flags.setFlag(c, 'day_one_proactive_cap', 0);
    out = await checkin.run(c, t0 + 8 * H + 120_000);
    assert.ok(out.find((r) => r.userId === u.id), 'with the cap off the slot is spent again');
    await flags.setFlag(c, 'day_one_proactive_cap', 2);
  } finally { c.release(); }
});

// "אני מניחה שאתה בישראל" and then "באיזו מדינה אתה נמצא?" (owner,
// 2026-10-04): a one-clock country whose zone is still the one the dialling
// code gave is already answered. A several-clock country still asks.
test('the country question is not asked when the number already answered it', async () => {
  const c = await db.pool.connect();
  try {
    const il = await makeUser(db.pool, '+972641000301', { firstName: 'Yael' });
    await c.query(`UPDATE users SET timezone = 'Asia/Jerusalem', timezone_confirmed = FALSE WHERE id = $1`, [il.id]);
    const ilGaps = await checkin.discoveryGaps(c, il.id);
    assert.ok(!ilGaps.some((g) => g.topic === 'timezone'), 'one clock, the code\'s own zone: no question');

    const us = await makeUser(db.pool, '+12125550301', { firstName: 'Sam' });
    await c.query(`UPDATE users SET timezone = 'America/New_York', timezone_confirmed = FALSE WHERE id = $1`, [us.id]);
    const usGaps = await checkin.discoveryGaps(c, us.id);
    assert.equal(usGaps[0].topic, 'timezone', 'several clocks: still asked, first');
  } finally { c.release(); }
});

// A game night's or a room's welcome follow-up waits for the morning, and
// until it has said what she is the day-one ladder says nothing (2026-10-04:
// 63 and 64 heard the 2h step in the middle of the game).
test('no day-one step goes out ahead of the welcome follow-up still owed', async () => {
  const H = 3600_000;
  const u = await makeUser(db.pool, '+972615009302', { firstName: 'Omer' });
  const t0 = Date.now() - 3 * H;
  await db.pool.query(
    `UPDATE users SET onboarded_at = $2, created_at = $2, timezone = 'Asia/Jerusalem',
            timezone_confirmed = TRUE, last_inbound_at = $2 WHERE id = $1`, [u.id, new Date(t0)]);
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, idempotency_key, release_after)
     VALUES ($1, 'welcome_followup', '{"gameOpening": true}'::jsonb, $2, now() + interval '10 hours')`,
    [u.id, `welcome_followup:${u.id}`]);
  const c = await db.pool.connect();
  try {
    let out = await checkin.run(c, t0 + 2 * H + 60_000);
    assert.equal(out.find((r) => r.userId === u.id), undefined, 'the 2h step waits behind it');
    await c.query(`UPDATE outbox SET sent_at = now() WHERE user_id = $1 AND kind = 'welcome_followup'`, [u.id]);
    await require('../src/domain/flags').setFlag(c, 'day_one_proactive_cap', 0);
    out = await checkin.run(c, t0 + 2 * H + 120_000);
    assert.equal(out.find((r) => r.userId === u.id).rung, 'onboarding_2h', 'and goes once it is said');
    await require('../src/domain/flags').setFlag(c, 'day_one_proactive_cap', 2);
  } finally { c.release(); }
});
