'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const watch = require('../src/jobs/credit-watch');
const flagsDomain = require('../src/domain/flags');
const { enqueue } = require('../src/outbox/enqueue');
const { withTx } = require('../src/db/pool');

// The number the "the dashboard can change the target" assertion points the
// alert flag at. Named, because a user row has to exist for it — see before().
const ALT_ALERT_PHONE = '+972590000000';

let db, user, operator, altOperator;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972594000001', { firstName: 'X' });
  // The outage alarm defers outside waking hours too now, and asks what hour
  // it is where the ALERT phone lives. Without a row for that phone the
  // question falls back to the real current hour and this file would pass by
  // day and fail by night — the failure CLAUDE.md records under "the suite was
  // green thirteen hours a day". Parked at midday, five hours clear of either
  // edge, so a slow suite cannot drift out of the window.
  operator = await makeUser(db.pool, watch.DEFAULT_ALERT_PHONE, { firstName: 'Op' });
  // The SAME reasoning for the number one test below points the flag at. It is
  // an ordinary phone as far as the alarm is concerned, so with no row behind
  // it the hour question fell back to DEFAULT_TZ and the real wall clock —
  // and the note below at that assignment guarded the wrong direction: a
  // stray number does not re-open the night window, at night it CLOSES one
  // that the operator's own pinned row was holding open. Live consequence,
  // 2026-09-02 22:19 UTC: the alarm deferred, the assertion threw before the
  // line that puts the flag back could run, and the poisoned flag then failed
  // the NEXT test too. Two reds, 19:00-05:00 UTC daily, on the alarm that
  // pages when the model provider runs dry.
  altOperator = await makeUser(db.pool, ALT_ALERT_PHONE, { firstName: 'Op2' });
  const c = await db.pool.connect();
  try {
    await setLocalHour(c, operator.id, 12);
    await setLocalHour(c, altOperator.id, 12);
  } finally { c.release(); }
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const c = await db.pool.connect();
  try { return await fn(c); } finally { c.release(); }
}

function recorder(ok = true) {
  const sent = [];
  return { sent, send: (phone, text) => { sent.push({ phone, text }); return { ok }; } };
}

test('the first credit error raises exactly one alarm per outage — on the raw pipe number', async () => {
  await withClient(async (c) => {
    const rec = recorder();
    // quiet system → no alarm
    assert.equal((await watch.checkCreditAlert(c, rec)).alerted, false);
    assert.equal(rec.sent.length, 0);

    await withTx(db.pool, (cc) => enqueue(cc, {
      userId: user.id, kind: 'checkin', idempotencyKey: 'cw:1',
    }));
    await c.query(
      `UPDATE outbox SET last_error = 'GatewayClientRequestError: ... Your credit balance is too low to access the Anthropic API ...'
        WHERE idempotency_key = 'cw:1'`);

    const first = await watch.checkCreditAlert(c, rec);
    assert.equal(first.alerted, true);
    assert.equal(rec.sent.length, 1);
    assert.equal(rec.sent[0].phone, watch.DEFAULT_ALERT_PHONE);
    assert.match(rec.sent[0].text, /נגמר הקרדיט/);
    assert.match(rec.sent[0].text, /Auto-reload/);
    assert.match(rec.sent[0].text, /openrouter\.ai/, 'the alert names both providers');

    // same outage, next tick → silence, not a drum
    assert.equal((await watch.checkCreditAlert(c, rec)).alerted, false);
    assert.equal(rec.sent.length, 1);
  });
});

test("OpenRouter's dry-credit phrasing (402 Insufficient credits) also trips the alarm", async () => {
  await withClient(async (c) => {
    await c.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
    await withTx(db.pool, (cc) => enqueue(cc, {
      userId: user.id, kind: 'checkin', idempotencyKey: 'cw:or',
    }));
    await c.query(
      `UPDATE outbox SET last_error = 'Insufficient credits. Add more using https://openrouter.ai/settings/credits'
        WHERE idempotency_key = 'cw:or'`);
    const rec = recorder();
    assert.equal((await watch.checkCreditAlert(c, rec)).alerted, true);
    assert.equal(rec.sent.length, 1);
  });
});

test('a NEW outage re-arms the alarm; a failed send does not consume it', async () => {
  await withClient(async (c) => {
    // resolve the previous outage
    await c.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
    const rec = recorder();
    assert.equal((await watch.checkCreditAlert(c, rec)).alerted, false);

    // a fresh outage begins — its first error is NEWER than the last alert
    await withTx(db.pool, (cc) => enqueue(cc, {
      userId: user.id, kind: 'checkin', idempotencyKey: 'cw:2',
    }));
    await c.query(
      `UPDATE outbox SET last_error = 'credit balance is too low'
        WHERE idempotency_key = 'cw:2'`);

    // the send itself fails (gateway down) → no flag stamped, retried next tick
    const failing = recorder(false);
    const tryFail = await watch.checkCreditAlert(c, failing);
    assert.equal(tryFail.alerted, false);
    assert.equal(failing.sent.length, 1, 'it did try');

    const ok = recorder();
    assert.equal((await watch.checkCreditAlert(c, ok)).alerted, true,
      'the failed attempt must not have consumed the one alarm this outage gets');

    // the alert target is a flag the dashboard can change without a deploy
    await flagsDomain.setFlag(c, watch.ALERT_PHONE_FLAG, ALT_ALERT_PHONE);
    try {
      await c.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
      await withTx(db.pool, (cc) => enqueue(cc, {
        userId: user.id, kind: 'checkin', idempotencyKey: 'cw:3',
      }));
      await c.query(
        `UPDATE outbox SET last_error = 'credit balance is too low' WHERE idempotency_key = 'cw:3'`);
      const rec2 = recorder();
      await watch.checkCreditAlert(c, rec2);
      assert.equal(rec2.sent[0].phone, ALT_ALERT_PHONE);
    } finally {
      // Put it back, in a finally rather than inline: the alarm reads the hour
      // where the ALERT PHONE lives, so a flag left pointing anywhere else
      // takes the NEXT test down too. That is not hypothetical — it is how one
      // failure here became two on 2026-09-02.
      await flagsDomain.setFlag(c, watch.ALERT_PHONE_FLAG, '');
    }
  });
});

// The regression this pins is invisible at millisecond resolution, which is
// exactly why it survived: the alarm used to compare a Postgres timestamp
// against a JS-stamped one, and a JS Date cannot hold microseconds. Everything
// in the test above happens inside a few milliseconds, so it failed about two
// runs in three — a flaky test on the credit alarm, which is the thing that
// pages when the model provider runs dry.
test('an outage one microsecond newer than the last alert still re-arms it', async () => {
  await withClient(async (c) => {
    await c.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
    await withTx(db.pool, (cc) => enqueue(cc, {
      userId: user.id, kind: 'checkin', idempotencyKey: 'cw:us',
    }));
    // Both sides pinned by hand, one microsecond apart — the same millisecond,
    // which is all the old comparison could see.
    const alertedAt = '2026-08-28 12:00:00.000500+00';
    const outageAt = '2026-08-28 12:00:00.000501+00';
    await c.query(
      `UPDATE outbox SET last_error = 'credit balance is too low', created_at = $1::timestamptz
        WHERE idempotency_key = 'cw:us'`, [outageAt]);
    await flagsDomain.setFlag(c, watch.ALERT_AT_FLAG, alertedAt);

    const rec = recorder();
    assert.equal((await watch.checkCreditAlert(c, rec)).alerted, true,
      'a microsecond newer is a NEW outage, and the alarm has to see it');

    // ...and the stamp it just wrote came from Postgres, not from Node: PG
    // renders a timestamptz with a space and a +00 offset, never T...Z. Revert
    // the stamp to a JS Date and this is what notices.
    const stored = await flagsDomain.getFlag(c, watch.ALERT_AT_FLAG);
    assert.doesNotMatch(stored, /\dT\d.*Z$/,
      "the alarm's own clock must be the database's");
  });
});

// ---- not at three in the morning ---------------------------------------------
// Owner ask, 2026-09-01: stop the night messages. This alarm held out longest
// because it is the real "everything is down" signal — but the money can only
// be added by the person asleep, and it reads the same at 08:00.
test('a night outage is queued rather than sent, and queued only once', async () => {
  await withClient(async (c) => {
    await c.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
    await flagsDomain.setFlag(c, watch.ALERT_AT_FLAG, '');
    await flagsDomain.setFlag(c, watch.PENDING_ALERT_FLAG, {});
    await flagsDomain.setFlag(c, watch.ALERT_PHONE_FLAG, operator.phone);
    await setLocalHour(c, operator.id, 3);
    try {
      await withTx(db.pool, (cc) => enqueue(cc, {
        userId: user.id, kind: 'checkin', idempotencyKey: 'cw:night',
      }));
      await c.query(
        `UPDATE outbox SET last_error = 'Insufficient credits. Add more.'
          WHERE idempotency_key = 'cw:night'`);

      const rec = recorder();
      const r = await watch.checkCreditAlert(c, rec);
      assert.equal(r.alerted, false);
      assert.equal(r.queued, true);
      assert.equal(rec.sent.length, 0, 'nothing reaches a phone at 03:00');
      const pending = await flagsDomain.getFlag(c, watch.PENDING_ALERT_FLAG);
      assert.equal(pending.phone, operator.phone);
      assert.ok(pending.since, 'the moment the outage began is kept — the evidence itself expires');

      // The 30-second beat must not re-queue the same outage all night.
      const again = await watch.checkCreditAlert(c, rec);
      assert.equal(again.alerted, false);
      assert.equal(again.queued, undefined);

      // Morning is still the only thing that releases it.
      assert.deepEqual(await watch.flushPendingCreditAlert(c, rec), { held: 'quiet hours' });
      assert.equal(rec.sent.length, 0);
    } finally { await setLocalHour(c, operator.id, 12); }
  });
});

test('the morning flush speaks in the tense that is actually true', async () => {
  await withClient(async (c) => {
    // Still broken when morning comes → the live alarm text.
    const rec = recorder();
    const out = await watch.flushPendingCreditAlert(c, rec);
    assert.equal(out.alerted, true);
    assert.equal(out.stillDown, true);
    assert.match(rec.sent[0].text, /נגמר הקרדיט/);
    // Delivered → the queue is empty, and a second tick says nothing.
    assert.equal(await watch.flushPendingCreditAlert(c, rec), null);
    assert.equal(rec.sent.length, 1);

    // Now the other half: an outage that healed overnight. Saying "אף הודעה
    // לא נשלחת" about a working system is a false alarm, and one false alarm
    // is what teaches someone to ignore the next real one.
    await c.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
    await flagsDomain.setFlag(c, watch.PENDING_ALERT_FLAG,
      { phone: operator.phone, since: '2026-09-01 02:10:00+00' });
    const rec2 = recorder();
    const healed = await watch.flushPendingCreditAlert(c, rec2);
    assert.equal(healed.alerted, true);
    assert.equal(healed.stillDown, false);
    assert.match(rec2.sent[0].text, /בלילה נגמר הקרדיט/);
    assert.match(rec2.sent[0].text, /עובד שוב/);
  });
});

test('a flush whose send fails stays queued', async () => {
  await withClient(async (c) => {
    await flagsDomain.setFlag(c, watch.PENDING_ALERT_FLAG,
      { phone: operator.phone, since: '2026-09-01 02:10:00+00' });
    assert.deepEqual(await watch.flushPendingCreditAlert(c, recorder(false)), { held: 'send failed' });
    const still = await flagsDomain.getFlag(c, watch.PENDING_ALERT_FLAG);
    assert.equal(still.phone, operator.phone, 'a broken pipe must not consume the alarm');
    await flagsDomain.setFlag(c, watch.PENDING_ALERT_FLAG, {});
  });
});

// ---- the runway warning ------------------------------------------------------

// A fixed clock inside the alert window, so these never depend on when the
// suite happens to run. The hour is read in the alert phone's own timezone, so
// the test user carries one.
function costs(over = {}) {
  return async () => ({
    openrouter: { configured: true, prepaid: true, remaining: 1.75, daysLeft: 4.2, dailyTotal: 0.42, ...over.openrouter },
    twilio: { configured: true, prepaid: true, remaining: 18.1, ...over.twilio },
    deepgram: { configured: true, prepaid: true, remaining: 199.9, ...over.deepgram },
  });
}

// The whole ladder runs against a user whose local hour is inside the window;
// setting the phone's timezone is what makes that deterministic.
async function armWindow(c, phone) {
  await flagsDomain.setFlag(c, watch.ALERT_PHONE_FLAG, phone);
  await flagsDomain.setFlag(c, watch.BALANCE_TIERS_FLAG, {});
}

// Park a user in whatever zone makes their LOCAL hour the one a test needs, so
// these never pass or fail depending on when the suite happens to run.
async function setLocalHour(c, userId, hour) {
  const { rows } = await c.query(`SELECT extract(hour from now() at time zone 'UTC')::int AS h`);
  const off = ((hour - rows[0].h) % 24 + 24) % 24;
  const zone = off === 0 ? 'Etc/GMT+0' : (off <= 12 ? `Etc/GMT-${off}` : `Etc/GMT+${24 - off}`);
  await c.query(`UPDATE users SET timezone = $2 WHERE id = $1`, [userId, zone]);
}

test('tierFor: days where the provider reports a burn rate, dollars where it does not', () => {
  // 4.2 days left is inside the 7-day tier, not the 14 — the MOST urgent tier
  // crossed is the one that decides, or the ladder would never escalate.
  assert.equal(watch.tierFor({ configured: true, remaining: 1.75, daysLeft: 4.2 }), 7);
  assert.equal(watch.tierFor({ configured: true, remaining: 0.8, daysLeft: 2 }), 3);
  assert.equal(watch.tierFor({ configured: true, remaining: 50, daysLeft: 30 }), null);
  assert.equal(watch.tierFor({ configured: true, remaining: 3 }), 5, 'no burn rate → dollar tiers');
  assert.equal(watch.tierFor({ configured: true, remaining: 18.1 }), null);
  // A service that could not be read is never a service in trouble.
  assert.equal(watch.tierFor({ configured: true, error: 'http_500', remaining: 0 }), null);
  assert.equal(watch.tierFor({ configured: true, remaining: null, daysLeft: null }), null);
  assert.equal(watch.tierFor({ configured: false }), null);
});

test('the runway alarm climbs tiers and never repeats one', async () => {
  await withClient(async (c) => {
    const u = await makeUser(db.pool, '+972594000777', { firstName: 'R' });
    await armWindow(c, u.phone);
    const rec = recorder();

    await setLocalHour(c, u.id, 12); // midday, comfortably inside the window

    // First sighting at 4.2 days → tier 7, one message naming the service.
    const a = await watch.checkBalanceForecast(c, { ...rec, getInfraCosts: costs() });
    assert.equal(a.alerted, true, `expected an alert, got ${JSON.stringify(a)}`);
    assert.deepEqual(a.services, ['openrouter']);
    assert.match(rec.sent[0].text, /OpenRouter/);
    assert.match(rec.sent[0].text, /4 ימים/);

    // Same tier again → silent. This is the property that stops fourteen
    // consecutive "still low" messages from training the reader to ignore it.
    const b = await watch.checkBalanceForecast(c, { ...rec, getInfraCosts: costs() });
    assert.equal(b.alerted, false);
    assert.equal(rec.sent.length, 1);

    // Genuinely worse → the 3-day tier speaks once.
    const worse = costs({ openrouter: { remaining: 0.6, daysLeft: 1.4, dailyTotal: 0.42 } });
    const d = await watch.checkBalanceForecast(c, { ...rec, getInfraCosts: worse });
    assert.equal(d.alerted, true);
    assert.equal(rec.sent.length, 2);
    assert.match(rec.sent[1].text, /1 ימים|כ-1/);

    // ...and then goes quiet again at that tier.
    assert.equal((await watch.checkBalanceForecast(c, { ...rec, getInfraCosts: worse })).alerted, false);
    assert.equal(rec.sent.length, 2);

    // Topped up → the stamp is forgotten, so the NEXT depletion gets the full
    // ladder instead of being silenced by a stale tier from the last one.
    const healthy = costs({ openrouter: { remaining: 50, daysLeft: 120, dailyTotal: 0.42 } });
    assert.equal((await watch.checkBalanceForecast(c, { ...rec, getInfraCosts: healthy })).alerted, false);
    assert.deepEqual(await flagsDomain.getFlag(c, watch.BALANCE_TIERS_FLAG), {});
    const again = await watch.checkBalanceForecast(c, { ...rec, getInfraCosts: costs() });
    assert.equal(again.alerted, true, 'a fresh depletion must alert again after recovery');
    assert.equal(rec.sent.length, 3);
  });
});

test('outside waking hours the alarm defers — it does not stamp the tier and swallow itself', async () => {
  await withClient(async (c) => {
    const u = await makeUser(db.pool, '+972594000778', { firstName: 'N' });
    await armWindow(c, u.phone);
    await setLocalHour(c, u.id, 3);

    const rec = recorder();
    const r = await watch.checkBalanceForecast(c, { ...rec, getInfraCosts: costs() });
    assert.equal(r.alerted, false);
    assert.deepEqual(r.deferred, ['openrouter']);
    assert.equal(rec.sent.length, 0, 'nothing sent at 03:00 — a prepaid balance cannot be topped up better then');
    assert.deepEqual(await flagsDomain.getFlag(c, watch.BALANCE_TIERS_FLAG), {},
      'the tier must stay unstamped, or the morning tick would think it had already spoken');
  });
});

test('a failed send is retried, never stamped away', async () => {
  await withClient(async (c) => {
    const u = await makeUser(db.pool, '+972594000779', { firstName: 'F' });
    await armWindow(c, u.phone);
    await setLocalHour(c, u.id, 12);

    const failing = recorder(false);
    const r = await watch.checkBalanceForecast(c, { ...failing, getInfraCosts: costs() });
    assert.equal(r.alerted, false);
    assert.ok(r.error);
    assert.deepEqual(await flagsDomain.getFlag(c, watch.BALANCE_TIERS_FLAG), {});

    // The retry lands.
    const ok = recorder(true);
    assert.equal((await watch.checkBalanceForecast(c, { ...ok, getInfraCosts: costs() })).alerted, true);
    assert.equal(ok.sent.length, 1);
  });
});

// ---- muting just the credit/budget line --------------------------------------
//
// Owner ask 2026-09-01: stop sending the credit-outage and balance-runway
// WhatsApp lines specifically, permanently until reversed via the dashboard
// flag — while leaving config_guard's BREAKS_USERS alerts and the nightly
// eval alert untouched, since those are a different promise.
test('muted: neither alarm sends, and nothing is queued or stamped while muted', async () => {
  await withClient(async (c) => {
    await flagsDomain.setFlag(c, watch.MUTED_FLAG, true);
    try {
      await c.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
      await flagsDomain.setFlag(c, watch.ALERT_AT_FLAG, '');
      await withTx(db.pool, (cc) => enqueue(cc, {
        userId: user.id, kind: 'checkin', idempotencyKey: 'cw:muted',
      }));
      await c.query(
        `UPDATE outbox SET last_error = 'Insufficient credits. Add more.'
          WHERE idempotency_key = 'cw:muted'`);

      const rec = recorder();
      const outage = await watch.checkCreditAlert(c, rec);
      assert.deepEqual(outage, { alerted: false, muted: true });
      assert.equal(rec.sent.length, 0);
      // Nothing queued either — an un-mute later must see the outage fresh,
      // not replay whatever piled up while silenced.
      assert.deepEqual(await flagsDomain.getFlag(c, watch.PENDING_ALERT_FLAG), {});

      const u = await makeUser(db.pool, '+972594000780', { firstName: 'M' });
      await armWindow(c, u.phone);
      await setLocalHour(c, u.id, 12);
      const balance = await watch.checkBalanceForecast(c, { ...rec, getInfraCosts: costs() });
      assert.deepEqual(balance, { alerted: false, muted: true });
      assert.equal(rec.sent.length, 0);
      assert.deepEqual(await flagsDomain.getFlag(c, watch.BALANCE_TIERS_FLAG), {},
        'muted must not stamp a tier it never actually announced');

      // A row queued the moment before muting must not go out while muted —
      // and must stay queued, not get dropped, so a later un-mute still flushes it.
      await flagsDomain.setFlag(c, watch.PENDING_ALERT_FLAG,
        { phone: operator.phone, since: '2026-09-01 02:10:00+00' });
      assert.deepEqual(await watch.flushPendingCreditAlert(c, rec), { muted: true });
      assert.equal(rec.sent.length, 0);
      const stillPending = await flagsDomain.getFlag(c, watch.PENDING_ALERT_FLAG);
      assert.equal(stillPending.phone, operator.phone, 'muting must not drop what was already queued');
    } finally {
      await flagsDomain.setFlag(c, watch.MUTED_FLAG, false);
    }
  });
});

test('un-muted: both alarms resume exactly as before, including flushing what queued while muted', async () => {
  await withClient(async (c) => {
    assert.equal(await flagsDomain.getFlag(c, watch.MUTED_FLAG), false, 'must not leak muted=true from the prior test');

    await c.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
    await flagsDomain.setFlag(c, watch.ALERT_AT_FLAG, '');
    await withTx(db.pool, (cc) => enqueue(cc, {
      userId: user.id, kind: 'checkin', idempotencyKey: 'cw:unmuted',
    }));
    await c.query(
      `UPDATE outbox SET last_error = 'Insufficient credits. Add more.'
        WHERE idempotency_key = 'cw:unmuted'`);
    const rec = recorder();
    assert.equal((await watch.checkCreditAlert(c, rec)).alerted, true);
    assert.equal(rec.sent.length, 1);

    // The row left queued from the muted test flushes normally now that this
    // outage is over — re-checked live, so it correctly speaks past tense.
    await c.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
    await flagsDomain.setFlag(c, watch.PENDING_ALERT_FLAG,
      { phone: operator.phone, since: '2026-09-01 02:10:00+00' });
    const flushed = await watch.flushPendingCreditAlert(c, rec);
    assert.equal(flushed.alerted, true);
    assert.equal(flushed.stillDown, false);
  });
});
