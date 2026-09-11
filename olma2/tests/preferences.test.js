'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const prefs = require('../src/domain/preferences');

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972509000001');
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

test('remember/forget/list round-trip with upsert', async () => {
  await withClient(async (c) => {
    await prefs.remember(c, user.id, 'tone', 'short and direct');
    await prefs.remember(c, user.id, 'tone', 'even shorter'); // upsert
    const l = await prefs.list(c, user.id);
    assert.equal(l.data.preferences.length, 1);
    assert.equal(l.data.preferences[0].value, 'even shorter');

    const gone = await prefs.forget(c, user.id, 'tone');
    assert.equal(gone.ok, true);
    const missing = await prefs.forget(c, user.id, 'tone');
    assert.equal(missing.error.code, 'not_found');
  });
});

test('keys are validated — no markdown smuggling into structure', async () => {
  await withClient(async (c) => {
    const bad = await prefs.remember(c, user.id, '<!-- comment -->', 'x');
    assert.equal(bad.ok, false);
    const bad2 = await prefs.remember(c, user.id, 'UPPER CASE', 'x');
    assert.equal(bad2.ok, false);
  });
});

test('remember audits whether it overwrote a different value — the corrections metric depends on it', async () => {
  await withClient(async (c) => {
    await prefs.remember(c, user.id, 'digest.style', 'long');
    await prefs.remember(c, user.id, 'digest.style', 'long');  // idempotent re-save, not a correction
    await prefs.remember(c, user.id, 'digest.style', 'short'); // a real change of mind
    const { rows } = await c.query(
      `SELECT detail FROM audit_log
        WHERE actor_id = $1 AND event = 'preference.remembered' AND detail->>'key' = 'digest.style'
        ORDER BY id`, [user.id]);
    assert.deepEqual(rows.map((r) => r.detail.overwrote), [false, false, true]);
  });
});

test('availabilityWindow: stated beats default, garbage falls back safely', async () => {
  await withClient(async (c) => {
    const def = await prefs.availabilityWindow(c, user.id);
    assert.equal(def.data.source, 'default');
    // Assert against the exported constant, not a copy of its value — the
    // default is a product decision that has already moved once (09:00-20:00
    // → 08:00-21:00) and duplicating it here just means a second place to
    // forget. What matters is that an unstated window IS the default one.
    assert.deepEqual(def.data.window, prefs.DEFAULT_WINDOW);

    // The doctrine's "NEVER write phone numbers into either" is now code:
    const phone = await prefs.remember(c, user.id, 'person.maya', 'חברה — 052-626-9826');
    assert.equal(phone.ok, false);
    assert.match(phone.error.message, /save_contact/);
    // ...while values that legitimately carry digits still pass.
    const okDigits = await prefs.remember(c, user.id, 'person.maya', 'חברה מהעבודה, נפגשות כל יום שלישי');
    assert.equal(okDigits.ok, true);

    await prefs.remember(c, user.id, 'availability', '10:30-23:00');
    const stated = await prefs.availabilityWindow(c, user.id);
    assert.equal(stated.data.source, 'stated');
    assert.deepEqual(stated.data.window, { start: '10:30', end: '23:00' });

    await prefs.remember(c, user.id, 'availability', 'whenever I feel like it');
    const garbage = await prefs.availabilityWindow(c, user.id);
    assert.equal(garbage.data.source, 'default'); // gate never crashes on bad data
  });
});

test('quietDays: whole days off, and no way to spell a permanent mute', async () => {
  await withClient(async (c) => {
    const none = await prefs.quietDays(c, user.id, { locale: 'he' });
    assert.deepEqual(none.data.days.map((d) => prefs.DAY_NAMES[d]), ['sat'],
      'unstated is no longer empty: a Hebrew speaker gets Shabbat');
    assert.equal(none.data.source, 'default');

    await prefs.remember(c, user.id, 'quiet_days', 'fri,sat');
    const stated = await prefs.quietDays(c, user.id);
    assert.equal(stated.data.source, 'stated');
    assert.deepEqual(stated.data.days.map((d) => prefs.DAY_NAMES[d]), ['fri', 'sat']);

    // Forgiving on the way in: the model writes what a person said, and
    // spacing, order and full day names are not worth a failed save.
    await prefs.remember(c, user.id, 'quiet_days', 'Saturday, friday  sunday');
    assert.deepEqual(
      (await prefs.quietDays(c, user.id)).data.days.map((d) => prefs.DAY_NAMES[d]),
      ['sun', 'fri', 'sat'], 'sorted, deduped, case-insensitive, three letters is enough');

    // Unrecognised words are dropped rather than failing — the gate reads this
    // on every row and must never be stoppable by a bad value. What it falls
    // back TO is the default, not silence: a value nobody can read is not an
    // answer, and cancelling the day they were told about on the strength of
    // one is the mistake this distinction exists to stop.
    await prefs.remember(c, user.id, 'quiet_days', 'whenever, really');
    const unreadable = await prefs.quietDays(c, user.id, { locale: 'he' });
    assert.deepEqual(unreadable.data.days.map((d) => prefs.DAY_NAMES[d]), ['sat']);
    assert.equal(unreadable.data.source, 'default');

    // Saying so, on the other hand, IS an answer, and it is the only way to
    // spell it — deleting the row brings the default back.
    await prefs.remember(c, user.id, 'quiet_days', 'none');
    const said = await prefs.quietDays(c, user.id, { locale: 'he' });
    assert.deepEqual(said.data.days, []);
    assert.equal(said.data.source, 'stated');

    // A named day beats a refusal in the same breath: "no, only Saturday".
    await prefs.remember(c, user.id, 'quiet_days', 'no, sat');
    assert.deepEqual(
      (await prefs.quietDays(c, user.id, { locale: 'he' })).data.days.map((d) => prefs.DAY_NAMES[d]),
      ['sat']);

    // Seven quiet days is a pause, which is a different feature with its own
    // reversal path. Reading it here would mute somebody through a route
    // nothing reports on, so it reads as nothing at all.
    await prefs.remember(c, user.id, 'quiet_days', 'sun,mon,tue,wed,thu,fri,sat');
    const everyDay = await prefs.quietDays(c, user.id, { locale: 'he' });
    assert.deepEqual(everyDay.data.days.map((d) => prefs.DAY_NAMES[d]), ['sat']);
    assert.equal(everyDay.data.source, 'default');
  });
});

test('the default quiet day follows the person, not the server', async () => {
  await withClient(async (c) => {
    const u = await makeUser(db.pool, '+14155550111');
    const sunday = await prefs.quietDays(c, u.id, { locale: 'en', timezone: 'America/New_York' });
    assert.deepEqual(sunday.data.days.map((d) => prefs.DAY_NAMES[d]), ['sun']);
    assert.equal(sunday.data.calendar, 'christian');

    // An English speaker in Tel Aviv keeps Saturday. Sunday is a WORKING day
    // there, so the geography has to overrule the language or the default
    // silences an ordinary Sunday for them.
    const israeli = await prefs.quietDays(c, u.id, { locale: 'en', timezone: 'Asia/Jerusalem' });
    assert.deepEqual(israeli.data.days.map((d) => prefs.DAY_NAMES[d]), ['sat']);

    // And a person who has said which calendar they keep is not guessed about.
    await prefs.remember(c, u.id, 'holiday_calendar', 'none');
    const nothing = await prefs.quietDays(c, u.id, { locale: 'he', timezone: 'Asia/Jerusalem' });
    assert.deepEqual(nothing.data.days, []);
    assert.equal(nothing.data.source, 'default');
  });
});

test('forgetting quiet_days restores a real day, and the result says which', async () => {
  await withClient(async (c) => {
    const u = await makeUser(db.pool, '+972509000077');
    await prefs.remember(c, u.id, 'quiet_days', 'fri');
    const gone = await prefs.forget(c, u.id, 'quiet_days', { locale: 'he', timezone: 'Asia/Jerusalem' });
    assert.equal(gone.ok, true);
    // Every sentence a person actually says here is the opposite of what the
    // delete now does, so the one call that can get it wrong is told so.
    assert.match(gone.data.hints.quietDayDefault, /בשבת/);
    assert.match(gone.data.hints.quietDayDefault, /"none"/);
    assert.deepEqual(
      (await prefs.quietDays(c, u.id, { locale: 'he' })).data.days.map((d) => prefs.DAY_NAMES[d]),
      ['sat']);

    // Nothing else grows a hint it did not have.
    await prefs.remember(c, u.id, 'tone', 'short');
    const plain = await prefs.forget(c, u.id, 'tone', { locale: 'he' });
    assert.equal(plain.data.hints, undefined);
  });
});
