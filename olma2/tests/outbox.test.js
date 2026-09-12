'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { decide, withinWindow, msUntilWindowOpen } = require('../src/outbox/gate');
const { enqueue } = require('../src/outbox/enqueue');
const { drainOnce } = require('../src/outbox/worker');
const sweeps = require('../src/jobs/sweeps');
const { withTx } = require('../src/db/pool');

// ---------------- gate: pure policy tests (no DB) ----------------------------

const DAY = { start: '09:00', end: '20:00' };
const noonUTC = new Date('2026-08-16T12:00:00Z'); // 15:00 in Asia/Jerusalem (UTC+3)
const threeAmUTC = new Date('2026-08-16T00:00:00Z'); // 03:00 local

function row(overrides) {
  return { kind: 'checkin', urgency: 'normal', expires_at: null, ...overrides };
}
const baseFacts = {
  plan: 'free', blocked: false, window: DAY, tz: 'Asia/Jerusalem',
  sentToday: 0, budget: 4, now: noonUTC,
};

test('gate: healthy daytime message delivers', () => {
  assert.equal(decide({ ...baseFacts, row: row() }).action, 'deliver');
});

test('gate: blocked user holds everything except paid reminders and unblock', () => {
  const blocked = { ...baseFacts, blocked: true };
  assert.equal(decide({ ...blocked, row: row() }).holdReason, 'blocked');
  assert.equal(decide({ ...blocked, row: row({ kind: 'reminder' }) }).holdReason, 'blocked'); // free plan
  assert.equal(decide({ ...blocked, plan: 'paid', row: row({ kind: 'reminder' }) }).action, 'deliver'); // paid bypass
  assert.equal(decide({ ...blocked, row: row({ kind: 'unblock_summary' }) }).action, 'deliver');
});

test('gate: an introduction survives the quiet drop, like the ladder\'s own check-in', () => {
  const quiet = { ...baseFacts, checkinMisses: 1 };
  // Everything Olma decided to say stops for someone who has gone quiet...
  assert.equal(decide({ ...quiet, row: row({ kind: 'meeting_invite' }) }).holdReason, 'quiet');
  assert.equal(decide({ ...quiet, row: row({ kind: 'digest' }) }).holdReason, 'quiet');
  // ...but the introduction is the one thing she OWES, and somebody who has
  // not answered is the likeliest person never to have been told who was
  // writing to them. ג.ב would have lost his to this rule (2026-09-08).
  assert.equal(decide({ ...quiet, row: row({ kind: 'introduction' }) }).action, 'deliver');
  assert.equal(decide({ ...quiet, row: row({ kind: 'checkin' }) }).action, 'deliver');
});

test('gate: an unsent introduction holds everything Olma decided to say, in front of it', () => {
  const waiting = { ...baseFacts, introductionPending: true };
  // Olma's own initiatives wait. Held, never dropped — the introduction lands
  // and the queue moves on the next tick.
  const held = decide({ ...waiting, row: row() });
  assert.equal(held.action, 'hold');
  assert.equal(held.holdReason, 'awaiting_introduction');
  assert.equal(held.releaseAfter, null);
  assert.equal(decide({ ...waiting, row: row({ kind: 'meeting_invite' }) }).holdReason, 'awaiting_introduction');

  // The introduction itself is what everything is waiting FOR.
  assert.equal(decide({ ...waiting, row: row({ kind: 'introduction' }) }).action, 'deliver');
  // ...including on a day whose proactive budget is already spent: everything
  // else waits behind it, so a budget hold here is a deadlock.
  assert.equal(decide({ ...baseFacts, sentToday: 9, row: row({ kind: 'introduction' }) }).action, 'deliver');
  assert.equal(decide({ ...baseFacts, sentToday: 9, row: row() }).holdReason, 'budget');

  // A moment THEY chose passes: somebody who asked for a reminder in words
  // knows who is sending it, and holding it back for an introduction would be
  // absurd. Same line the rest of the gate draws.
  assert.equal(decide({ ...waiting, row: row({ kind: 'digest' }) }).action, 'deliver');
  assert.equal(decide({ ...waiting, row: row({ kind: 'reminder', payload: { rung: 1 } }) }).action, 'deliver');
  // Rung 2 is Olma's moment, not theirs, so it waits like the rest.
  assert.equal(decide({ ...waiting, row: row({ kind: 'reminder', payload: { rung: 2 } }) }).holdReason,
    'awaiting_introduction');

  // Nothing pending, nothing changes.
  assert.equal(decide({ ...baseFacts, row: row() }).action, 'deliver');
});

test('gate: an introduction that has just landed keeps the floor for ten minutes', () => {
  // Ordering alone was not enough. ג.ב read who Olma was at 08:00:27 and was
  // asked which city he lives in at 08:01:19: the hold released the instant the
  // introduction was stamped sent, so the next row went out on its heels and
  // was read as part of it.
  const justSent = (msAgo) => ({
    ...baseFacts, introductionPending: false,
    introductionSentAt: new Date(noonUTC.getTime() - msAgo),
  });

  const heldAt2min = decide({ ...justSent(2 * 60_000), row: row() });
  assert.equal(heldAt2min.action, 'hold');
  assert.equal(heldAt2min.holdReason, 'awaiting_introduction');
  assert.equal(new Date(heldAt2min.releaseAfter).getTime(),
    noonUTC.getTime() + 8 * 60_000,
    'the release is ten minutes after the introduction LANDED, not ten from now — '
    + 'counted from now, a row looked at late would wait twice as long as one looked at early');

  // Past the ten minutes it simply goes.
  assert.equal(decide({ ...justSent(11 * 60_000), row: row() }).action, 'deliver');

  // A moment THEY chose still passes, exactly as it does while one is pending.
  assert.equal(decide({ ...justSent(60_000), row: row({ kind: 'digest' }) }).action, 'deliver');
  assert.equal(decide({ ...justSent(60_000), row: row({ kind: 'reminder', payload: { rung: 1 } }) }).action,
    'deliver');
  assert.equal(decide({ ...justSent(60_000), row: row({ kind: 'reminder', payload: { rung: 2 } }) }).holdReason,
    'awaiting_introduction');

  // Nothing on record, nothing changes.
  assert.equal(decide({ ...baseFacts, introductionSentAt: null, row: row() }).action, 'deliver');
});

test('gate: night holds until the personal window opens; user-chosen times bypass', () => {
  const night = { ...baseFacts, now: threeAmUTC };
  const held = decide({ ...night, row: row() });
  assert.equal(held.holdReason, 'night');
  // 03:00 → 09:00 local = six hours away
  assert.equal(Math.round((held.releaseAfter - threeAmUTC) / 3600_000), 6);
  // A reminder was set FOR a moment by the person themselves — 03:00 is when
  // they asked to be reminded, so quiet hours must never move it.
  assert.equal(decide({ ...night, row: row({ kind: 'reminder' }) }).action, 'deliver');
  assert.equal(decide({ ...night, row: row({ kind: 'digest' }) }).action, 'deliver');
});

// Vered, her first evening: a reminder for 22:32, and "בוצע?" at 01:33. Rung 1
// is the moment she named; rungs 2 and 3 are three hours later and the next
// day, and she named neither. The exemption belongs to the moment, not to the
// word "reminder" (`incidents.md`, "The rung nobody asked for, at half past
// one").
test('gate: an escalation rung is Olma\'s moment, not theirs, and waits for the morning', () => {
  const night = { ...baseFacts, now: threeAmUTC };
  const reminder = (payload) => row({ kind: 'reminder', payload });

  // Rung 1, however it is spelled: no payload at all, or an explicit rung.
  assert.equal(decide({ ...night, row: reminder(undefined) }).action, 'deliver');
  assert.equal(decide({ ...night, row: reminder({ rung: 1 }) }).action, 'deliver');

  // Rung 2 and rung 3 wait.
  const second = decide({ ...night, row: reminder({ rung: 2, attempt: 2 }) });
  assert.equal(second.action, 'hold');
  assert.equal(second.holdReason, 'night');
  assert.equal(Math.round((second.releaseAfter - threeAmUTC) / 3600_000), 6);
  assert.equal(decide({ ...night, row: reminder({ rung: 3, attempt: 3, finalAttempt: true }) }).holdReason, 'night');

  // A redo carries no `attempt` — it deliberately uses rung 1's wording — so
  // the wording field cannot be what decides this, and `rung` is why.
  assert.equal(decide({ ...night, row: reminder({ rung: 2, redo: true }) }).holdReason, 'night');

  // In the daytime every rung goes out as before: this moves the hour, it does
  // not silence the ladder.
  const day = { ...baseFacts };
  assert.equal(decide({ ...day, row: reminder({ rung: 3, attempt: 3 }) }).action, 'deliver');

  // And someone demonstrably awake still gets it — the conversation grace is
  // not overridden by a rule about not waking people.
  const justWrote = new Date(threeAmUTC.getTime() - 2 * 60_000).toISOString();
  assert.equal(decide({ ...night, row: reminder({ rung: 2 }), lastInboundAt: justWrote }).action, 'deliver');
});

test('gate: someone who just wrote is awake — quiet hours do not silence a live conversation', () => {
  const night = { ...baseFacts, now: threeAmUTC };
  // 3am, well outside any window, but they messaged two minutes ago
  const justWrote = new Date(threeAmUTC.getTime() - 2 * 60_000).toISOString();
  assert.equal(decide({ ...night, row: row(), lastInboundAt: justWrote }).action, 'deliver');

  // ...the grace is 15 minutes, not "any time today"
  const longAgo = new Date(threeAmUTC.getTime() - 40 * 60_000).toISOString();
  assert.equal(decide({ ...night, row: row(), lastInboundAt: longAgo }).holdReason, 'night');

  // never written → no evidence they are awake → normal quiet hours
  assert.equal(decide({ ...night, row: row(), lastInboundAt: null }).holdReason, 'night');

  // the grace opens the window; it does not waive the daily budget
  const busy = { ...night, sentToday: 4, lastInboundAt: justWrote };
  assert.equal(decide({ ...busy, row: row() }).holdReason, 'budget');
});

test('gate: default quiet hours run 21:00 to 09:00', () => {
  const { DEFAULT_WINDOW } = require('../src/domain/preferences');
  const tz = 'UTC';
  const at = (h) => new Date(`2026-08-16T${String(h).padStart(2, '0')}:30:00Z`);
  assert.equal(withinWindow(DEFAULT_WINDOW, tz, at(9)), true, 'awake from 09:00');
  assert.equal(withinWindow(DEFAULT_WINDOW, tz, at(20)), true, '20:30 is still awake time');
  assert.equal(withinWindow(DEFAULT_WINDOW, tz, at(21)), false, 'quiet from 21:00');
  assert.equal(withinWindow(DEFAULT_WINDOW, tz, at(7)), false, 'still quiet at 07:30');
  // 08:30 was awake time until 2026-09-08 and is not any more. The hours are
  // now SAID to people (jobs/checkin.js, the timezone rung), so this line is
  // not a taste question — it is the sentence we send, asserted from the side
  // that has to honour it.
  assert.equal(withinWindow(DEFAULT_WINDOW, tz, at(8)), false, 'quiet until 09:00');
});

test('gate: personal window beats the default one', () => {
  const lateOwl = { ...baseFacts, window: { start: '22:00', end: '06:00' }, now: threeAmUTC };
  assert.equal(decide({ ...lateOwl, row: row() }).action, 'deliver'); // 03:00 inside their overnight window
  const sameNowDefault = { ...baseFacts, now: threeAmUTC };
  assert.equal(decide({ ...sameNowDefault, row: row() }).action, 'hold');
});

// ---------------- gate: whole days they asked to keep ------------------------
//
// Hours are one preference and days are another, and until 2026-09-08 only the
// first existed — so somebody who keeps Shabbat had nowhere to say so and was
// never asked. The owner's line on what survives a quiet day is the narrowest
// one available: a reminder they asked for IN WORDS, first rung. Not a digest
// (quiet hours exempt it because they picked the hour; a day off is a day off),
// and not an automatic reminder the model inferred from a due date.
//
// Saturday 2026-08-15 and Friday 2026-08-14 are literals, so the weekday is
// fixed regardless of when the suite runs — but the INDEX is derived rather
// than written down, because "Saturday is 6" is exactly the kind of constant
// that is right until somebody changes the base of the array.
const saturdayNoonUTC = new Date('2026-08-15T12:00:00Z');
const SAT = saturdayNoonUTC.getUTCDay();
const FRI = new Date('2026-08-14T12:00:00Z').getUTCDay();

test('gate: a quiet day holds everything Olma decided to say', () => {
  const shabbat = { ...baseFacts, now: saturdayNoonUTC, quietDays: [SAT] };
  // Midday, inside their window, nothing wrong with the row — and still held.
  const held = decide({ ...shabbat, row: row() });
  assert.equal(held.action, 'hold');
  assert.equal(held.holdReason, 'quiet_day');

  // The digest is the one that separates a quiet DAY from quiet HOURS: the
  // night rule lets it through because they chose the hour, and this one does
  // not, because a morning picture of a day they asked not to hear about is
  // the message they were opting out of.
  assert.equal(decide({ ...shabbat, row: row({ kind: 'digest' }) }).holdReason, 'quiet_day');

  // An automatic reminder is the model's inference from a due date, not a
  // moment anybody named.
  assert.equal(
    decide({ ...shabbat, row: row({ kind: 'reminder', payload: { rung: 1, auto: true } }) }).holdReason,
    'quiet_day');

  // Urgency buys nothing. Neither does another user's fan-out landing here.
  assert.equal(decide({ ...shabbat, row: row({ urgency: 'urgent' }) }).holdReason, 'quiet_day');
});

test('gate: the reminder they asked for in words still arrives on a quiet day', () => {
  const shabbat = { ...baseFacts, now: saturdayNoonUTC, quietDays: [SAT] };
  const asked = row({ kind: 'reminder', payload: { rung: 1, auto: false } });
  assert.equal(decide({ ...shabbat, row: asked }).action, 'deliver');

  // Rung 2 of that same reminder is Olma's moment, not theirs — the same line
  // the night window and the stopped-answering rule both draw.
  assert.equal(
    decide({ ...shabbat, row: row({ kind: 'reminder', payload: { rung: 2, auto: false } }) }).holdReason,
    'quiet_day');
});

test('gate: a quiet day releases into the next day they kept, not the next morning', () => {
  // Friday AND Saturday quiet: a row held on Friday must not wake up on
  // Saturday, or the second day they asked for is one we never honoured.
  const friday = new Date('2026-08-14T12:00:00Z');
  const both = { ...baseFacts, now: friday, quietDays: [FRI, SAT] };
  const held = decide({ ...both, row: row() });
  assert.equal(held.holdReason, 'quiet_day');
  const releaseDay = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', weekday: 'short',
  }).format(held.releaseAfter);
  assert.equal(releaseDay, 'Sun', 'Friday + Saturday quiet releases on Sunday');

  // And it lands inside their window rather than at whatever hour it was held.
  assert.equal(withinWindow(DAY, 'Asia/Jerusalem', held.releaseAfter), true);
});

// facts.shabbatWindow is what an Israeli zone's Saturday becomes instead of
// the plain weekday check (worker.js resolves it via holidays.shabbatWindow
// and strips 6 out of quietDays when it does) — candle-lighting to havdalah,
// both edges precise, replacing a calendar-day boundary that either missed
// Friday evening or ran the hold into Sunday.
const shabbat = { start: new Date('2026-08-14T16:06:00Z'), end: new Date('2026-08-15T17:04:00Z') };

test('gate: the Shabbat window holds from candle-lighting, not from midnight', () => {
  // Friday afternoon, before candle-lighting: an ordinary message, delivered.
  const beforeCandles = { ...baseFacts, now: new Date('2026-08-14T12:00:00Z'), quietDays: [], shabbatWindow: shabbat };
  assert.equal(decide({ ...beforeCandles, row: row() }).action, 'deliver');

  // The instant candle-lighting starts, held — urgency buys nothing, same as
  // the weekday version of this rule.
  const atCandles = { ...baseFacts, now: shabbat.start, quietDays: [], shabbatWindow: shabbat };
  assert.equal(decide({ ...atCandles, row: row({ urgency: 'urgent' }) }).holdReason, 'quiet_day');
});

test('gate: the Shabbat window releases at havdalah, not at the next calendar day', () => {
  // A round-the-clock window, so the release is purely about havdalah and not
  // entangled with a separate "did their window happen to be open" question —
  // that combination already has its own test above (msUntilWindowOpen).
  const allDay = { start: '00:00', end: '23:59' };

  // Held mid-afternoon Saturday: the release is havdalah itself (20:04 local
  // that day), never "24 hours from now" or "tomorrow morning" — the fault
  // that left a real meeting confirmation sitting until Sunday evening
  // (owner, 2026-09-12).
  const midSaturday = {
    ...baseFacts, window: allDay, now: new Date('2026-08-15T12:00:00Z'), quietDays: [], shabbatWindow: shabbat,
  };
  const held = decide({ ...midSaturday, row: row({ kind: 'meeting_confirmed', urgency: 'urgent' }) });
  assert.equal(held.holdReason, 'quiet_day');
  assert.equal(held.releaseAfter.toISOString(), shabbat.end.toISOString());

  // A moment after havdalah: not quiet any more, delivers straight away.
  const afterHavdalah = {
    ...baseFacts, window: allDay, now: new Date('2026-08-15T17:05:00Z'), quietDays: [], shabbatWindow: shabbat,
  };
  assert.equal(decide({ ...afterHavdalah, row: row() }).action, 'deliver');
});

// A holiday reaches the gate as DATES, not as a weekday, and is otherwise the
// same rule with the same exemption — the hold_reason is the only difference,
// so the dashboard can tell "Saturday" from "Yom Kippur" without a second rule
// to keep in step. Opt-in: `quietDates` is empty for everybody who has not
// asked, which is the `no quiet days is the same gate as before` test below,
// one dimension over.
const yomKippur = new Date('2026-09-21T12:00:00Z'); // a Monday, deliberately
test('gate: a quiet holiday holds the same things a quiet day holds', () => {
  const kippur = {
    ...baseFacts, now: yomKippur, quietDays: [], quietDates: ['2026-09-21'],
  };
  const held = decide({ ...kippur, row: row() });
  assert.equal(held.action, 'hold');
  assert.equal(held.holdReason, 'quiet_holiday', 'named apart from a weekday they chose');
  assert.equal(decide({ ...kippur, row: row({ kind: 'digest' }) }).holdReason, 'quiet_holiday');
  assert.equal(decide({ ...kippur, row: row({ urgency: 'urgent' }) }).holdReason, 'quiet_holiday');

  // The one exemption is the same one, word for word: a reminder they put
  // there themselves, first rung.
  assert.equal(
    decide({ ...kippur, row: row({ kind: 'reminder', payload: { rung: 1, auto: false } }) }).action,
    'deliver');
  assert.equal(
    decide({ ...kippur, row: row({ kind: 'reminder', payload: { rung: 1, auto: true } }) }).holdReason,
    'quiet_holiday');

  // A Monday that is not on the list is an ordinary Monday.
  assert.equal(decide({ ...kippur, quietDates: ['2026-09-26'], row: row() }).action, 'deliver');
});

test('gate: a holiday that runs into Shabbat releases after the whole run', () => {
  // Rosh Hashana 5787 is Saturday 12 and Sunday 13 September 2026, so a
  // Hebrew speaker with the default Saturday is quiet for three days running.
  // A release computed from weekdays alone would wake this row on the Sunday,
  // inside the chag — which is why one predicate answers for both.
  const erev = new Date('2026-09-11T12:00:00Z'); // Friday
  const chag = {
    ...baseFacts, now: erev, quietDays: [SAT], quietDates: ['2026-09-12', '2026-09-13'],
  };
  assert.equal(decide({ ...chag, row: row() }).action, 'deliver', 'the erev itself is not quiet');

  const onChag = { ...chag, now: new Date('2026-09-12T12:00:00Z') };
  const held = decide({ ...onChag, row: row() });
  assert.equal(held.holdReason, 'quiet_day', 'Saturday is named first — it is the day THEY chose');
  const releaseDay = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', weekday: 'short', day: '2-digit',
  }).format(held.releaseAfter);
  assert.equal(releaseDay, '14 Mon', 'not Sunday, which is still Rosh Hashana');
  assert.equal(withinWindow(DAY, 'Asia/Jerusalem', held.releaseAfter), true);
});

test('gate: the holiday is judged in THEIR zone too', () => {
  // 22:00 UTC on the 20th is already Yom Kippur in Jerusalem and still the
  // 20th in New York.
  const lateUTC = new Date('2026-09-20T22:00:00Z');
  const nightOwl = {
    ...baseFacts, now: lateUTC, quietDays: [], quietDates: ['2026-09-21'],
    window: { start: '00:00', end: '23:59' },
  };
  assert.equal(decide({ ...nightOwl, row: row() }).holdReason, 'quiet_holiday');
  assert.equal(
    decide({ ...nightOwl, tz: 'America/New_York', row: row() }).action, 'deliver');
});

test('gate: no quiet days is the same gate as before', () => {
  // The feature has to be invisible to everyone who never answered the
  // question — `[]` and "not asked" are the same delivery, and an empty array
  // must never read as "every day".
  assert.equal(decide({ ...baseFacts, now: saturdayNoonUTC, quietDays: [], row: row() }).action, 'deliver');
  assert.equal(decide({ ...baseFacts, now: saturdayNoonUTC, row: row() }).action, 'deliver');
});

test('gate: the quiet day is theirs, in their zone, not the server\'s', () => {
  // 23:00 UTC Friday is already Saturday in Jerusalem. A gate that asked UTC
  // would deliver; one that asks the person's own calendar holds.
  const lateFridayUTC = new Date('2026-08-14T23:00:00Z');
  const nightOwl = {
    ...baseFacts, now: lateFridayUTC, quietDays: [SAT],
    window: { start: '00:00', end: '23:59' }, // take the night rule out of it
  };
  assert.equal(new Date(lateFridayUTC).getUTCDay(), FRI, 'still Friday in UTC');
  assert.equal(decide({ ...nightOwl, row: row() }).holdReason, 'quiet_day');
});

test('gate: over budget folds normal, urgent passes', () => {
  const busy = { ...baseFacts, sentToday: 4, hasDigest: true };
  const held = decide({ ...busy, row: row() });
  assert.equal(held.holdReason, 'budget');
  assert.equal(held.releaseAfter, null); // waits for the next digest, not a clock
  assert.equal(decide({ ...busy, row: row({ urgency: 'urgent' }) }).action, 'deliver');
});

test('gate: a budget hold on someone with no digest is never orphaned', () => {
  // sweepDigests only visits users who HAVE digest_times, so for everyone else
  // "it rides along with the next digest" is a promise nothing keeps and the
  // row sits unsent forever. That happened for real: a connection request the
  // recipient never saw, so he never approved and no meeting could be made.
  const busy = { ...baseFacts, sentToday: 4, hasDigest: false };
  const held = decide({ ...busy, row: row() });
  assert.equal(held.holdReason, 'budget');
  assert.ok(held.releaseAfter, 'a row with no digest to ride must carry a release time');
  assert.equal(held.releaseAfter.toISOString(), '2026-08-17T00:00:00.000Z',
    'next UTC midnight — the moment the daily budget resets');
});

test('gate: expired rows never deliver live', () => {
  const r = row({ kind: 'reminder', expires_at: '2026-08-16T10:00:00Z' });
  assert.equal(decide({ ...baseFacts, row: r }).action, 'expire');
});

test('window math: overnight windows and reopen distance', () => {
  assert.equal(withinWindow({ start: '22:00', end: '06:00' }, 'UTC', new Date('2026-08-16T23:30:00Z')), true);
  assert.equal(withinWindow({ start: '22:00', end: '06:00' }, 'UTC', new Date('2026-08-16T12:00:00Z')), false);
  const ms = msUntilWindowOpen({ start: '09:00', end: '20:00' }, 'UTC', new Date('2026-08-16T21:00:00Z'));
  assert.equal(ms / 3600_000, 12); // 21:00 → 09:00 next day
});

// ---------------- worker + sweeps: DB-backed lifecycle -----------------------

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972581000001', { firstName: 'Dana', timezone: 'UTC' });
});
after(async () => { await db.teardown(); });

function recorder() {
  const sent = [];
  return { sent, deliver: async (r) => { sent.push(r.kind); return { ok: true }; } };
}

// Each worker test starts from an empty pending set — a failed assertion in
// one test must not leak rows into the next one's drain.
async function flushOutbox() {
  await db.pool.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
}

test('worker delivers pending rows and records sent_at', async () => {
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'checkin', payload: { checkinInstruction: 'hi' },
    idempotencyKey: 'w1',
  }));
  const rec = recorder();
  const out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(out.delivered, 1);
  assert.deepEqual(rec.sent, ['checkin']);
  const { rows } = await db.pool.query(`SELECT sent_at FROM outbox WHERE idempotency_key = 'w1'`);
  assert.ok(rows[0].sent_at);
});

test('idempotency: same key enqueues once, jobs are re-runnable', async () => {
  const r1 = await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'checkin', idempotencyKey: 'dup' }));
  const r2 = await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'checkin', idempotencyKey: 'dup' }));
  assert.equal(r1.data.enqueued, true);
  assert.equal(r2.data.enqueued, false);
});

test('delivery failure → attempts + backoff, then success on retry', async () => {
  await flushOutbox();
  // kind=reminder: window-independent, so the retry (whose clock comes from
  // the DB's real now()) can't be night-held by the wall clock of the test run
  await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { title: 'x' }, idempotencyKey: 'flaky' }));
  let fail = true;
  const deliver = async () => fail ? { ok: false, error: 'gateway hiccup' } : { ok: true };
  let out = await drainOnce(db.pool, deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(out.failed, 1);
  const { rows } = await db.pool.query(`SELECT attempts, last_error, release_after FROM outbox WHERE idempotency_key = 'flaky'`);
  assert.equal(rows[0].attempts, 1);
  assert.match(rows[0].last_error, /hiccup/);
  fail = false;
  out = await drainOnce(db.pool, deliver, new Date(new Date(rows[0].release_after).getTime() + 1000));
  assert.equal(out.delivered, 1);
});

test('a timed-out delivery is booked as sent, never retried — Dana got the same check-in six times', async () => {
  await flushOutbox();
  // kind=reminder for the same reason as the retry test above: the second
  // drain's clock must not be night-held by the wall clock of the test run.
  await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { title: 'x' }, idempotencyKey: 'slow' }));
  let calls = 0;
  // What channels/openclaw.js returns when the CLI is killed at the deadline:
  // the turn kept running on the gateway and the message very likely landed.
  const deliver = async () => { calls++; return { ok: false, timedOut: true, error: 'openclaw timeout' }; };
  let out = await drainOnce(db.pool, deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(out.delivered, 1);
  assert.equal(out.unconfirmed, 1);
  assert.equal(out.failed, 0, 'a timeout is not a failure');
  const { rows } = await db.pool.query(`SELECT sent_at, hold_reason, attempts, last_error FROM outbox WHERE idempotency_key = 'slow'`);
  assert.ok(rows[0].sent_at, 'the row is sent');
  assert.equal(rows[0].hold_reason, null, 'sent, not held or dropped — every "was it delivered" reader agrees');
  assert.equal(rows[0].attempts, 1);
  assert.match(rows[0].last_error, /timeout/);
  // A later tick finds nothing to do with it — no second turn, no second message.
  out = await drainOnce(db.pool, deliver, new Date('2026-08-16T12:30:00Z'));
  assert.equal(out.delivered, 0);
  assert.equal(calls, 1);
  const { rows: audit } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE event = 'delivery.unconfirmed' AND actor_id = $1`, [user.id]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].detail.kind, 'reminder');
});

// ── The fifth draft was the rude one ────────────────────────────────────────
// A model-path delivery runs a whole turn before the channel is asked to carry
// anything, so a channel that cannot carry it makes every retry a NEW message
// composed against a world the failed sends themselves created. Yehav's digest
// was written five times while WhatsApp was disconnected, and the one that
// landed was the one that had watched him say nothing for forty minutes.
const downChannel = () => ({
  status: 'down', channels: [{ id: 'whatsapp', down: true }],
  detail: 'whatsapp: linked/running/connected = false, 6 reconnect attempts',
});

test('a channel the gateway says is down: no turn is spent, and the row books the same failure', async () => {
  await flushOutbox();
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { title: 'x' }, idempotencyKey: 'deadchannel',
  }));
  const rec = recorder();
  const out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T12:00:00Z'),
    { checkChannels: async () => downChannel() });
  assert.equal(rec.sent.length, 0, 'the whole point: deliver() is never called, so no model turn runs');
  assert.equal(out.failed, 1);
  assert.equal(out.channelDown, 1, 'counted apart, so the heartbeat can tell "not attempted" from "attempted and lost"');
  // Everything downstream must read exactly what a real failed send leaves:
  // the stuck-row alarm counts attempts, and the reminder redo needs
  // `attempts > 0` with an error beside it to know OUR pipe lost the rung.
  const { rows } = await db.pool.query(
    `SELECT attempts, last_error, release_after, sent_at FROM outbox WHERE idempotency_key = 'deadchannel'`);
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].sent_at, null);
  assert.match(rows[0].last_error, /no turn spent/);
  assert.match(rows[0].last_error, /linked\/running\/connected = false/, 'the reason names the channel, not just "failed"');
  assert.ok(rows[0].release_after, 'the same backoff a failed send would have set');
});

test('a channel that could not be READ still sends — "could not tell" never silences the queue', async () => {
  await flushOutbox();
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { title: 'x' }, idempotencyKey: 'unknownchannel',
  }));
  const rec = recorder();
  // Every reading that is not the gateway saying so in as many words: the RPC
  // switched off (which is what the suite itself gets), a refused socket, a
  // payload a later gateway version changed the shape of.
  for (const verdict of [
    { status: 'unknown', detail: 'cannot ask the gateway: gateway rpc is switched off', channels: [] },
    { status: 'live', detail: null, channels: [{ id: 'whatsapp', down: false }] },
  ]) {
    await db.pool.query(`UPDATE outbox SET sent_at = NULL, attempts = 0, release_after = NULL WHERE idempotency_key = 'unknownchannel'`);
    const out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T12:00:00Z'),
      { checkChannels: async () => verdict });
    assert.equal(out.delivered, 1, `${verdict.status} must deliver`);
    assert.equal(out.channelDown, undefined);
  }
  assert.equal(rec.sent.length, 2);
});

test('a probe that throws is unknown, not down', async () => {
  await flushOutbox();
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { title: 'x' }, idempotencyKey: 'probethrows',
  }));
  const rec = recorder();
  const out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T12:00:00Z'),
    { checkChannels: async () => { throw new Error('socket hung up'); } });
  assert.equal(out.delivered, 1);
  assert.equal(rec.sent.length, 1);
});

test('the channel is asked ONCE a tick, and not at all when nothing is deliverable', async () => {
  await flushOutbox();
  let asked = 0;
  const ask = async () => { asked++; return downChannel(); };
  // Nothing due: the probe sits behind the gate, so a quiet tick costs nothing.
  let out = await drainOnce(db.pool, recorder().deliver, new Date('2026-08-16T12:00:00Z'), { checkChannels: ask });
  assert.equal(out.failed, 0);
  assert.equal(asked, 0, 'a tick with nothing to send never asks');
  // Three rows, one tick, one question.
  for (const k of ['many1', 'many2', 'many3']) {
    await withTx(db.pool, (c) => enqueue(c, {
      userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { title: k }, idempotencyKey: k,
    }));
  }
  out = await drainOnce(db.pool, recorder().deliver, new Date('2026-08-16T12:00:00Z'), { checkChannels: ask });
  assert.ok(out.failed >= 1);
  assert.equal(asked, 1, 'one probe for the whole tick, never one per row');
});

test('night hold: row waits, then releases when the window opens', async () => {
  await flushOutbox();
  await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'checkin', idempotencyKey: 'night1' }));
  const rec = recorder();
  let out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T03:00:00Z')); // 3am UTC = user tz
  assert.equal(out.held, 1);
  assert.equal(rec.sent.length, 0);
  out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T09:30:00Z'));
  assert.equal(out.delivered, 1);
});

// Regression, from a real incident: a connection request was held for budget
// and never seen, so the recipient never approved and no meeting was possible.
// Five messages had gone out that day, and not one of them was subject to the
// budget it exhausted.
const BUDGET_DAY = '2026-08-16T12:00:00Z';
// A minute apart, because these stand for messages that actually went out one
// after another. The budget counts DISTINCT sent_at — a batch is stamped by one
// UPDATE and shares its transaction's timestamp to the microsecond, so rows
// that rode in one message are one message against the budget. Written with a
// single timestamp, these four would have read as one send.
async function alreadySentThatDay(rows) {
  const values = rows.map((r, i) =>
    `($1,'${r.kind}','{}','${r.urgency}', $2::timestamptz + interval '${i} minutes')`).join(', ');
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, sent_at) VALUES ${values}`,
    [user.id, BUDGET_DAY]
  );
}

test('worker: sends that are exempt from the budget do not consume it', async () => {
  await flushOutbox();
  await alreadySentThatDay([
    { kind: 'reminder', urgency: 'urgent' },      // user chose this moment
    { kind: 'reminder', urgency: 'urgent' },
    { kind: 'reminder', urgency: 'urgent' },
    { kind: 'digest', urgency: 'normal' },        // user chose this slot
    { kind: 'meeting_invite', urgency: 'urgent' }, // live negotiation, bypasses
  ]);
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'connection_request', payload: {}, idempotencyKey: 'budget-exempt-1',
  }));
  const rec = recorder();
  const out = await drainOnce(db.pool, rec.deliver, new Date(BUDGET_DAY));
  assert.equal(out.delivered, 1, 'five exempt sends must not exhaust a budget of four');
  assert.deepEqual(rec.sent, ['connection_request']);
});

test('worker: ordinary sends still count, and the hold is still scheduled', async () => {
  await flushOutbox();
  await alreadySentThatDay([
    { kind: 'checkin', urgency: 'normal' }, { kind: 'checkin', urgency: 'normal' },
    { kind: 'checkin', urgency: 'normal' }, { kind: 'checkin', urgency: 'normal' },
  ]);
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'connection_request', payload: {}, idempotencyKey: 'budget-count-1',
  }));
  const rec = recorder();
  const out = await drainOnce(db.pool, rec.deliver, new Date(BUDGET_DAY));
  assert.equal(out.held, 1, 'the budget must still bite for messages it governs');
  const { rows } = await db.pool.query(
    `SELECT hold_reason, release_after FROM outbox WHERE idempotency_key = 'budget-count-1'`
  );
  assert.equal(rows[0].hold_reason, 'budget');
  assert.ok(rows[0].release_after, 'this user has no digest, so the row must carry a release time');
});

test('reminder sweep: due → urgent outbox row + repeat spawns next occurrence', async () => {
  const tasks = require('../src/domain/tasks');
  const reminders = require('../src/domain/reminders');
  const { taskId } = await withTx(db.pool, async (c) => {
    const t = (await tasks.addTask(c, user.id, { title: 'daily pills' })).data.task;
    await reminders.setReminder(c, user.id, t.id, '2026-08-16T07:00:00Z', 'daily');
    return { taskId: t.id };
  });
  const swept = await withTx(db.pool, (c) => sweeps.sweepReminders(c, '2026-08-16T07:01:00Z'));
  assert.equal(swept.length, 1);
  const { rows } = await db.pool.query(
    `SELECT urgency, expires_at FROM outbox
     WHERE kind = 'reminder' AND user_id = $1 AND idempotency_key LIKE 'reminder:%'`, [user.id]);
  assert.equal(rows[0].urgency, 'urgent');
  assert.ok(rows[0].expires_at); // 2h staleness horizon
  const next = await db.pool.query(
    `SELECT remind_at FROM task_reminders WHERE task_id = $1 AND sent_at IS NULL`, [taskId]);
  assert.equal(new Date(next.rows[0].remind_at).toISOString(), '2026-08-17T07:00:00.000Z');
});

test('digest sweep fires on the user\'s local slot and folds budget-held rows', async () => {
  await flushOutbox();
  await db.pool.query(
    `UPDATE users SET digest_times = '08:00', digest_scope = 'summary', onboarded_at = now() WHERE id = $1`, [user.id]);
  // a budget-held row waiting to ride along
  await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'system_update', idempotencyKey: 'held-b', payload: { note: 'x' } }));
  await db.pool.query(`UPDATE outbox SET hold_reason = 'budget' WHERE idempotency_key = 'held-b'`);

  const fired = await withTx(db.pool, (c) => sweeps.sweepDigests(c, new Date('2026-08-16T08:01:00Z')));
  assert.equal(fired.length, 1);
  assert.equal(fired[0].folded, 1);
  const missed = await withTx(db.pool, (c) => sweeps.sweepDigests(c, new Date('2026-08-16T11:00:00Z')));
  assert.equal(missed.length, 0); // wrong time → nothing
});

test('unblock sweep: consolidates held + stale, clears the block', async () => {
  const other = await makeUser(db.pool, '+972581000002', { timezone: 'UTC' });
  await db.pool.query(
    `UPDATE users SET quota_blocked_until = '2026-08-16T10:00:00Z' WHERE id = $1`, [other.id]);
  await withTx(db.pool, async (c) => {
    await enqueue(c, { userId: other.id, kind: 'reminder', idempotencyKey: 'ub-stale',
      payload: { title: 'pick up kid 16:00' }, expiresAt: '2026-08-16T09:00:00Z' });
    await enqueue(c, { userId: other.id, kind: 'system_update', idempotencyKey: 'ub-fresh', payload: { note: 'still relevant' } });
  });
  await db.pool.query(`UPDATE outbox SET hold_reason = 'blocked' WHERE user_id = $1`, [other.id]);

  const unblocked = await withTx(db.pool, (c) => sweeps.sweepUnblocks(c, '2026-08-16T10:05:00Z'));
  assert.deepEqual(unblocked.map(Number), [Number(other.id)]);

  const { rows } = await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'unblock_summary'`, [other.id]);
  const p = rows[0].payload;
  assert.equal(p.accumulated.length, 1);
  assert.equal(p.expired.length, 1); // the 16:00 pickup — listed as עבר זמנה, not live
  const u = await db.pool.query(`SELECT quota_blocked_until FROM users WHERE id = $1`, [other.id]);
  assert.equal(u.rows[0].quota_blocked_until, null);
});

test('retry backoff starts in seconds and is capped, so an outage cannot bury a message', async () => {
  await flushOutbox();
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { text: 'x' },
    idempotencyKey: 'reminder:backoff',
  }));
  const failing = async () => ({ ok: false, error: 'billing' });
  const state = async () => {
    const { rows } = await db.pool.query(
      `SELECT attempts, extract(epoch from (release_after - now())) AS secs
       FROM outbox WHERE idempotency_key = 'reminder:backoff'`);
    return { attempts: rows[0].attempts, secs: Number(rows[0].secs) };
  };

  // first retry in seconds — a welcome racing the config reload must not wait minutes
  await drainOnce(db.pool, failing, new Date('2026-08-16T12:00:00Z'));
  let g = await state();
  assert.equal(g.attempts, 1);
  assert.ok(g.secs > 0 && g.secs <= 6, `first retry ~5s, got ${g.secs}`);

  // ...and it never grows past the cap, however long the outage lasts
  await db.pool.query(
    `UPDATE outbox SET attempts = 20, release_after = NULL WHERE idempotency_key = 'reminder:backoff'`);
  await drainOnce(db.pool, failing, new Date('2026-08-16T12:00:00Z'));
  g = await state();
  assert.ok(g.secs <= 601, `capped at 10 minutes, got ${g.secs}`);

  // and it still delivers once the outage ends
  const rec = recorder();
  await db.pool.query(
    `UPDATE outbox SET release_after = NULL WHERE idempotency_key = 'reminder:backoff'`);
  const out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(out.delivered, 1);
});

test('a long outage cannot push the backoff past what an interval can hold', async () => {
  // The gap the test above left: it checked attempts = 20, and the arithmetic
  // only blows up at 26. least() evaluates BOTH arguments, so the 10-minute cap
  // never protected the multiplication that produced the value being capped —
  // at 5s x 3^26 the interval overflowed int64 microseconds and the UPDATE
  // threw `interval out of range`, leaving the row unable to record even its
  // own failure. Live on 2026-08-23 after the Anthropic account ran dry.
  await flushOutbox();
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { text: 'x' },
    idempotencyKey: 'reminder:overflow',
  }));
  const failing = async () => ({ ok: false, error: 'credit balance is too low' });

  for (const attempts of [26, 40, 100]) {
    await db.pool.query(
      `UPDATE outbox SET attempts = $1, release_after = NULL WHERE idempotency_key = 'reminder:overflow'`,
      [attempts]);
    const out = await drainOnce(db.pool, failing, new Date('2026-08-16T12:00:00Z'));
    assert.equal(out.failed, 1, `attempts=${attempts} must record a failure, not throw`);
    assert.ok(!out.errored, `attempts=${attempts} must not error the row`);
    const { rows } = await db.pool.query(
      `SELECT attempts, extract(epoch from (release_after - now())) AS secs
       FROM outbox WHERE idempotency_key = 'reminder:overflow'`);
    assert.equal(rows[0].attempts, attempts + 1);
    assert.ok(Number(rows[0].secs) <= 601,
      `attempts=${attempts} still capped at 10 minutes, got ${rows[0].secs}`);
  }

  // and the message is still deliverable afterwards — the whole point of a cap
  await db.pool.query(
    `UPDATE outbox SET release_after = NULL WHERE idempotency_key = 'reminder:overflow'`);
  const rec = recorder();
  const out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(out.delivered, 1);
});

test('one unprocessable row does not take the rest of the queue down with it', async () => {
  // The outage was not caused by rows failing — rows fail all the time. It was
  // caused by ONE row aborting the tick, oldest-first, so everything behind it
  // stopped too. 28 healthy messages sat behind two poisoned ones for a day.
  await flushOutbox();
  const ids = [];
  for (const n of ['poison', 'good1', 'good2']) {
    const r = await withTx(db.pool, (c) => enqueue(c, {
      userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { text: n },
      idempotencyKey: `reminder:isolation:${n}`,
    }));
    ids.push({ n, id: r.data ? r.data.id : null });
  }
  // the oldest row throws outright, the way the overflowing UPDATE used to
  const deliver = async (row) => {
    if (row.payload.text === 'poison') throw new Error('interval out of range');
    return { ok: true };
  };
  const out = await drainOnce(db.pool, deliver, new Date('2026-08-16T12:00:00Z'));

  assert.equal(out.delivered, 2, 'the two healthy messages must still go out');
  assert.ok(Array.isArray(out.errored) && out.errored.length === 1,
    'and the bad row must be reported, not silently swallowed');
  assert.match(out.errored[0].error, /interval out of range/);

  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM outbox
     WHERE idempotency_key LIKE 'reminder:isolation:good%' AND sent_at IS NOT NULL`);
  assert.equal(rows[0].n, 2);
});

test('a tick delivers at most MAX_DELIVERIES_PER_TICK — a backlog drains in short beats, not one 20-minute gulp', async () => {
  const { MAX_DELIVERIES_PER_TICK } = require('../src/outbox/worker');
  await flushOutbox();
  for (let i = 0; i < MAX_DELIVERIES_PER_TICK + 3; i++) {
    await withTx(db.pool, (c) => enqueue(c, {
      userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { text: `b${i}` },
      idempotencyKey: `reminder:cap:${i}`,
    }));
  }
  const rec = recorder();
  const first = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(first.delivered, MAX_DELIVERIES_PER_TICK,
    'a real send is a model turn; the tick must hand the core back between batches');
  const second = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(second.delivered, 3, 'the next tick finishes the backlog');
});

// Vered's first morning: a night of held reminders released together, and she
// got nine separate WhatsApp messages one after another. They are one moment
// in her day.
test('worker: reminders that come due together go out as ONE message', async () => {
  const proactiveText = require('../src/domain/proactive-text');
  await flushOutbox();
  const now = new Date('2026-08-16T12:00:00Z');
  for (const [i, title] of ['לדבר עם גידיס', 'להתקשר לאביטל', 'לארגן אימון'].entries()) {
    await withTx(db.pool, (c) => enqueue(c, {
      userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { title },
      idempotencyKey: `reminder:batch:${i}`,
    }));
  }
  // A second rung says something the first does not ("בוצע? … להפסיק להזכיר"),
  // so it is a different message and must go out as its own.
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'reminder', urgency: 'normal',
    payload: { title: 'לשלוח מסמכים', attempt: 2 },
    idempotencyKey: 'reminder:batch:rung2',
  }));
  // Expired: its own two hours ran out, and it must not ride along on a
  // sibling that is still live.
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { title: 'עבר זמנה' },
    expiresAt: new Date(now.getTime() - 60_000), idempotencyKey: 'reminder:batch:stale',
  }));

  const sent = [];
  const out = await drainOnce(db.pool, async (r) => { sent.push(r); return { ok: true }; }, now);

  assert.equal(out.delivered, 2, 'three first rungs are one message; the second rung is its own');
  assert.equal(out.batched, 2, 'two rows folded into the send that led them');
  assert.equal(out.expired, 1);

  const list = proactiveText.rawPipeTextFor(sent[0]);
  assert.match(list, /גידיס/);
  assert.match(list, /אביטל/);
  assert.match(list, /אימון/);
  assert.doesNotMatch(list, /עבר זמנה/, 'an expired rung is not delivered by the back door');
  assert.doesNotMatch(list, /מסמכים/, 'a follow-up rung never joins a first one');

  const solo = proactiveText.rawPipeTextFor(sent[1]);
  assert.match(solo, /מסמכים/);
  assert.match(solo, /להפסיק להזכיר/, 'the follow-up still says how to stop it');

  const { rows } = await db.pool.query(
    `SELECT idempotency_key k, sent_at, hold_reason FROM outbox
      WHERE idempotency_key LIKE 'reminder:batch:%' ORDER BY id`);
  for (const r of rows) assert.ok(r.sent_at, `${r.k} must be marked sent`);
  assert.equal(rows.filter((r) => r.hold_reason === null).length, 4,
    'every row the one send carried is delivered, not just the one that led it');
});

// The language decision is taken at delivery from the joined users row, so
// the proof has to go through the worker's own query: a row hand-built in a
// test with `locale: 'en'` on it proves nothing about what the deliverer
// actually receives.
test('worker: the row that reaches the deliverer carries the recipient\'s locale, so an English speaker\'s reminders are English', async () => {
  const proactiveText = require('../src/domain/proactive-text');
  await flushOutbox();
  const sarah = await makeUser(db.pool, '+972581000009', { firstName: 'Sarah', timezone: 'UTC', locale: 'en' });
  // A MONDAY, and pinned rather than relative. Everywhere else in this file
  // 2026-08-16 is fine because it is a Sunday and the users are Hebrew, but
  // Sarah's locale is the whole point of this test and an English speaker's
  // default quiet day IS Sunday (domain/holidays.js) — so on the date the
  // rest of the file uses, the only thing this would prove is that the gate
  // held her.
  const now = new Date('2026-08-17T12:00:00Z');
  for (const [i, title] of ['call mom', 'pay rent'].entries()) {
    await withTx(db.pool, (c) => enqueue(c, {
      userId: sarah.id, kind: 'reminder', urgency: 'urgent', payload: { title },
      idempotencyKey: `reminder:en:${i}`,
    }));
  }
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { title: 'תרופה' },
    idempotencyKey: 'reminder:he:0',
  }));
  const sent = [];
  const out = await drainOnce(db.pool, async (r) => { sent.push(r); return { ok: true }; }, now);
  assert.equal(out.delivered, 2, 'her two are one message; his is another');

  const hers = sent.find((r) => r.user_id === sarah.id);
  const his = sent.find((r) => r.user_id === user.id);
  assert.equal(hers.locale, 'en', 'the worker did not join the locale onto the row');
  const herText = proactiveText.rawPipeTextFor(hers);
  assert.match(herText, /^⏰ \*Reminders\*\n• call mom\n• pay rent$/);
  assert.equal(proactiveText.rawPipeTextFor(his), '⏰ תזכורת: *תרופה*');
});

// The gate has been able to hold a quiet day since 2026-09-08; until
// 2026-09-11 nobody had one unless they asked. The default is now a fact
// about the PERSON — Saturday on a Jewish calendar, Sunday on a Christian one
// — and the only thing that can prove it is the worker's own query, because
// the default is computed from the joined users row. A facts object built by
// hand here would pass whatever the worker does.
test('worker: a quiet day nobody asked for still reaches the gate, off the users row', async () => {
  await flushOutbox();
  const saturday = new Date('2026-08-15T12:00:00Z');
  // Hebrew (makeUser's default locale) and a real zone, so "which Saturday"
  // is their Saturday and not the server's.
  const yossi = await makeUser(db.pool, '+972581000021',
    { firstName: 'יוסי', timezone: 'Asia/Jerusalem', quietDays: null });
  await withTx(db.pool, (c) => enqueue(c, {
    userId: yossi.id, kind: 'checkin', payload: { checkinInstruction: 'מה איתך' },
    idempotencyKey: 'quiet:default:checkin',
  }));
  // What the owner's sentence promises still arrives: a reminder they asked
  // for in words, first rung. `auto: false` is the whole discriminator.
  await withTx(db.pool, (c) => enqueue(c, {
    userId: yossi.id, kind: 'reminder', urgency: 'urgent',
    payload: { title: 'תרופה', rung: 1, auto: false },
    idempotencyKey: 'quiet:default:reminder',
  }));

  const sent = [];
  const out = await drainOnce(db.pool, async (r) => { sent.push(r); return { ok: true }; }, saturday);
  assert.equal(out.delivered, 1, 'only the reminder they asked for in words');
  assert.equal(sent[0].kind, 'reminder');

  const { rows } = await db.pool.query(
    `SELECT idempotency_key k, hold_reason, release_after FROM outbox
      WHERE user_id = $1 ORDER BY id`, [yossi.id]);
  const checkin = rows.find((r) => r.k === 'quiet:default:checkin');
  assert.equal(checkin.hold_reason, 'quiet_day',
    'nobody wrote a preference row, and Saturday held it anyway');
  // Held, never dropped — and for an Israeli zone the wake is havdalah itself
  // (2026-08-15 is 20:04 local), not a calendar-day boundary into Sunday
  // (owner, 2026-09-12: the quiet window is candle-lighting to havdalah).
  const releaseDay = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', weekday: 'short',
  }).format(checkin.release_after);
  assert.equal(releaseDay, 'Sat');
  assert.equal(new Date(checkin.release_after).toISOString(), '2026-08-15T17:03:32.000Z');

  // And saying so is the one way out: "none" is an answer, an empty row is not.
  const prefs = require('../src/domain/preferences');
  await withTx(db.pool, (c) => prefs.remember(c, yossi.id, 'quiet_days', 'none'));
  await db.pool.query(
    `UPDATE outbox SET hold_reason = NULL, release_after = NULL WHERE user_id = $1 AND sent_at IS NULL`,
    [yossi.id]);
  const after = await drainOnce(db.pool, async () => ({ ok: true }), saturday);
  assert.equal(after.delivered, 1, 'the check-in goes out on the Saturday they said they keep nothing on');
});

test('worker: a batch that fails to send fails for every row it carried', async () => {
  await flushOutbox();
  for (const [i, title] of ['אחת', 'שתיים'].entries()) {
    await withTx(db.pool, (c) => enqueue(c, {
      userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { title },
      idempotencyKey: `reminder:batchfail:${i}`,
    }));
  }
  const out = await drainOnce(db.pool, async () => ({ ok: false, error: 'pipe down' }),
    new Date('2026-08-16T12:00:00Z'));
  assert.equal(out.failed, 1, 'one send, one failure');
  const { rows } = await db.pool.query(
    `SELECT attempts, last_error, release_after FROM outbox
      WHERE idempotency_key LIKE 'reminder:batchfail:%' ORDER BY id`);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.attempts, 1, 'the row that rode along must climb its own retry counter too');
    assert.match(r.last_error, /pipe down/);
    assert.ok(r.release_after, 'and must be held off until the backoff passes');
  }
});

test('an introduction nobody ever received holds nothing back', async () => {
  await flushOutbox();
  const rec = recorder();
  const at = new Date('2026-08-16T12:00:00Z');
  const fresh = await makeUser(db.pool, '+972581000078', { firstName: 'Noa', timezone: 'UTC' });
  // Cancelled from the admin page, and superseded by a reworded replacement:
  // both carry `sent_at`, which is how cancelling stops the producer making the
  // row again, and neither reached the person. Counted as a landing, they would
  // silence this user for ten minutes on the strength of a message that was
  // never sent.
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, sent_at, hold_reason) VALUES
       ($1,'introduction','{}','normal', $2::timestamptz, 'cancelled_by_admin'),
       ($1,'introduction','{}','normal', $2::timestamptz, 'superseded')`,
    [fresh.id, at]
  );
  await withTx(db.pool, (c) => enqueue(c, {
    userId: fresh.id, kind: 'checkin', payload: { checkinInstruction: 'hello' },
    idempotencyKey: 'intro-never-landed',
  }));

  const out = await drainOnce(db.pool, rec.deliver, new Date(at.getTime() + 60_000));
  assert.equal(out.delivered, 1);
  assert.deepEqual(rec.sent, ['checkin']);
});

test('the introduction goes out first, and the queue waits for it to be read', async () => {
  await flushOutbox();
  const rec = recorder();
  const at = new Date('2026-08-16T12:00:00Z');
  // Their own user: this file's shared one has spent its daily budget several
  // times over by now, and the budget is a different rule being tested above.
  const fresh = await makeUser(db.pool, '+972581000077', { firstName: 'Gal', timezone: 'UTC' });
  // Created in the WRONG order on purpose: ordering by creation time is the
  // accident this rule replaces (ג.ב, 2026-09-08 — his introduction and a
  // day-one offer were both due at 08:00).
  await withTx(db.pool, (c) => enqueue(c, {
    userId: fresh.id, kind: 'checkin', payload: { checkinInstruction: 'offer them something' },
    idempotencyKey: 'intro-after',
  }));
  await withTx(db.pool, (c) => enqueue(c, {
    userId: fresh.id, kind: 'introduction', payload: { instruction: 'say who you are' },
    idempotencyKey: 'intro-first',
  }));

  let out = await drainOnce(db.pool, rec.deliver, at);
  assert.equal(out.delivered, 1);
  assert.deepEqual(rec.sent, ['introduction']);
  const { rows: held } = await db.pool.query(
    `SELECT hold_reason, sent_at FROM outbox WHERE idempotency_key = 'intro-after'`);
  assert.equal(held[0].hold_reason, 'awaiting_introduction');
  assert.equal(held[0].sent_at, null, 'held, not dropped');

  // The drain stamps with the real clock and this test lives at a fixed
  // moment, so the landing is dated into that moment's frame — the gap below
  // is a real ten minutes either way.
  await db.pool.query(
    `UPDATE outbox SET sent_at = $1 WHERE idempotency_key = 'intro-first'`, [at]);

  // A minute later it is still waiting. The introduction has the floor: a
  // second message on its heels is read as part of the first, and whatever it
  // asked is answered by nobody (ג.ב, 2026-09-08, 08:00:27 and 08:01:19).
  out = await drainOnce(db.pool, rec.deliver, new Date(at.getTime() + 60_000));
  assert.equal(out.delivered, 0);
  assert.equal(out.held, 1);
  assert.deepEqual(rec.sent, ['introduction']);

  // Eleven minutes later the queue moves.
  out = await drainOnce(db.pool, rec.deliver, new Date(at.getTime() + 11 * 60_000));
  assert.equal(out.delivered, 1);
  assert.deepEqual(rec.sent, ['introduction', 'checkin']);
});
