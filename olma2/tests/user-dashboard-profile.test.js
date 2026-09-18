'use strict';
// The profile page's settings (2026-09-14): when Olma may write, the quiet
// days and which calendar's holidays, the two new personal fields, and the
// fact questions. What is pinned here most is that every value the page saves
// is one the DELIVERY GATE reads the same way — a setting that saves and is
// then quietly fallen back from is worse than no setting.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const write = require('../src/domain/user-dashboard-write');
const dash = require('../src/domain/user-dashboard');
const preferences = require('../src/domain/preferences');
const holidays = require('../src/domain/holidays');
const factPrompts = require('../src/domain/fact-prompts');
const facts = require('../src/domain/facts');
const { renderCard } = require('../src/intake/user-card');

let db, me;
const tx = (fn) => withTx(db.pool, fn);
const act = (action, payload, who = me) => tx((c) => write.perform(c, who.id, action, payload));
const load = (who = me) => tx((c) => dash.load(c, who.id));

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531940001', { firstName: 'Miron', quietDays: null, holidayAsked: null });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem', locale = 'he' WHERE id = $1`, [me.id]);
});
after(async () => { if (db) await db.teardown(); });

// ---- hours -----------------------------------------------------------------

test('a window saved on the page is the window the gate reads', async () => {
  const r = await act('setAvailability', { start: '08:30', end: '22:00' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const gate = await tx((c) => preferences.availabilityWindow(c, me.id));
  assert.deepEqual(gate.data, { window: { start: '08:30', end: '22:00' }, source: 'stated' });
  const page = await load();
  assert.equal(page.data.schedule.availability.start, '08:30');
  assert.equal(page.data.schedule.availability.source, 'stated');
});

test('an overnight window is a real answer, and an empty one is refused', async () => {
  assert.equal((await act('setAvailability', { start: '22:00', end: '06:00' })).ok, true);
  for (const bad of [{ start: '10:00', end: '10:00' }, { start: '9:00', end: '17:00' }, { start: '24:00', end: '08:00' }, { start: '10:00' }]) {
    const r = await act('setAvailability', bad);
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});

test('clearing the window deletes the row, so the default keeps following the constant', async () => {
  assert.equal((await act('setAvailability', { start: null, end: null })).ok, true);
  const gate = await tx((c) => preferences.availabilityWindow(c, me.id));
  assert.equal(gate.data.source, 'default');
  assert.deepEqual(gate.data.window, preferences.DEFAULT_WINDOW);
});

// ---- quiet days and holidays --------------------------------------------------

test('an untouched person is shown the default day the gate would apply', async () => {
  const page = await load();
  assert.deepEqual(page.data.schedule.quietDays, [6]);
  assert.equal(page.data.schedule.quietDaysSource, 'default');
  assert.equal(page.data.schedule.calendar, 'jewish');
  assert.equal(page.data.schedule.shabbatWindow, true);
});

test('days, holidays and a calendar land in the value the gate parses', async () => {
  const r = await act('setQuietDays', { days: [5, 6], holidays: true, calendar: 'jewish' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const q = await tx((c) => preferences.quietDays(c, me.id, { locale: 'he', timezone: 'Asia/Jerusalem' }));
  assert.deepEqual(q.data.days, [5, 6]);
  assert.equal(q.data.holidays, true);
  assert.equal(q.data.source, 'stated');
});

test('no day at all is saved as "none", never as a deleted row that brings Saturday back', async () => {
  assert.equal((await act('setQuietDays', { days: [], holidays: false })).ok, true);
  const { rows } = await db.pool.query(
    `SELECT value FROM user_preferences WHERE user_id = $1 AND key = 'quiet_days'`, [me.id]);
  assert.equal(rows[0].value, 'none');
  const q = await tx((c) => preferences.quietDays(c, me.id, { locale: 'he', timezone: 'Asia/Jerusalem' }));
  assert.deepEqual(q.data.days, []);
});

test('a days-only save keeps chagim as they were and does not spend the chat offer', async () => {
  const u = await makeUser(db.pool, '+972531940008', { quietDays: 'sat,holidays', holidayAsked: null });
  assert.equal((await act('setQuietDays', { days: [5, 6] }, u)).ok, true);
  const { rows } = await db.pool.query(
    `SELECT value FROM user_preferences WHERE user_id = $1 AND key = 'quiet_days'`, [u.id]);
  assert.equal(rows[0].value, 'fri,sat,holidays');
  const stamp = await db.pool.query(`SELECT holiday_quiet_asked_at FROM users WHERE id = $1`, [u.id]);
  assert.equal(stamp.rows[0].holiday_quiet_asked_at, null);
});

test('seven quiet days is refused as a pause, and a bad day or calendar by name', async () => {
  const all = await act('setQuietDays', { days: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(all.error.reason, 'all_days');
  assert.equal((await act('setQuietDays', { days: [7] })).ok, false);
  assert.equal((await act('setQuietDays', { days: 'sat' })).ok, false);
  assert.equal((await act('setQuietDays', { days: [6], calendar: 'pastafarian' })).error.reason, 'calendar');
});

test('setting chagim from the page spends the once-ever chat offer', async () => {
  const other = await makeUser(db.pool, '+972531940002', { quietDays: null, holidayAsked: null });
  const before_ = await db.pool.query(`SELECT holiday_quiet_asked_at FROM users WHERE id = $1`, [other.id]);
  assert.equal(before_.rows[0].holiday_quiet_asked_at, null);
  assert.equal((await act('setQuietDays', { days: [6], holidays: false }, other)).ok, true);
  const after_ = await db.pool.query(`SELECT holiday_quiet_asked_at FROM users WHERE id = $1`, [other.id]);
  assert.notEqual(after_.rows[0].holiday_quiet_asked_at, null);
});

test('the Islamic calendar: stated only, Friday by default, and the Eids are quiet', async () => {
  // Never guessed off a language — an Arabic speaker still gets the zone's rule.
  assert.equal(holidays.calendarFor({ locale: 'ar', timezone: 'Asia/Jerusalem' }), 'jewish');
  assert.equal(holidays.calendarFor({ locale: 'ar', timezone: 'Asia/Amman', preference: 'muslim' }), 'muslim');
  assert.equal(holidays.defaultQuietDay('muslim'), 5);
  assert.equal(holidays.quietDayWord(5, 'en'), 'on Fridays');
  // Umm al-Qura, 1447 AH.
  const fitr = await holidays.holidaysOn('muslim', '2026-03-20');
  assert.equal(fitr[0].key, 'Eid al-Fitr');
  assert.equal(fitr[0].tier, holidays.QUIET);
  const adha = await holidays.holidaysOn('muslim', '2026-05-27');
  assert.equal(adha[0].key, 'Eid al-Adha');
  // Ramadan is a month of working days: mentioned, never quiet.
  const ramadan = await holidays.holidaysOn('muslim', '2026-02-18');
  assert.ok(ramadan.every((e) => e.tier !== holidays.QUIET));
  const year = await holidays.quietDates('muslim', { tz: 'UTC', from: new Date('2026-01-01T12:00:00Z'), days: 364 });
  assert.deepEqual(year, ['2026-03-20', '2026-05-27']);
});

test('a stated muslim calendar with no stated day gives Friday to the gate', async () => {
  const u = await makeUser(db.pool, '+962790000003', { quietDays: null });
  await db.pool.query(
    `INSERT INTO user_preferences (user_id, key, value) VALUES ($1, 'holiday_calendar', 'muslim')`, [u.id]);
  const q = await tx((c) => preferences.quietDays(c, u.id, { locale: 'ar', timezone: 'Asia/Amman' }));
  assert.deepEqual(q.data.days, [5]);
  assert.equal(q.data.source, 'default');
});

// ---- personal fields ------------------------------------------------------------

test('gender and birthday save, clear, and refuse what is not a real past date', async () => {
  const r = await act('setPersonal', { gender: 'female', birthDate: '1990-02-28' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  let page = await load();
  assert.equal(page.data.user.gender, 'female');
  assert.equal(page.data.user.birthDate, '1990-02-28');
  for (const bad of [{ birthDate: '1990-02-30' }, { birthDate: '2999-01-01' }, { birthDate: '16/03/1994' }, { gender: 'other' }, {}]) {
    assert.equal((await act('setPersonal', bad)).ok, false, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal((await act('setPersonal', { birthDate: null })).ok, true);
  page = await load();
  assert.equal(page.data.user.birthDate, null);
  assert.equal(page.data.user.gender, 'female', 'clearing one field left the other alone');
});

test('the audit trail records that a birthday changed, never the date', async () => {
  await act('setPersonal', { birthDate: '1985-07-04' });
  const { rows } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'dashboard.setPersonal' ORDER BY id DESC LIMIT 1`, [me.id]);
  assert.ok(!JSON.stringify(rows[0].detail).includes('1985'));
});

test('the card addresses them in the form they chose, and says nothing when they have not', () => {
  const base = { first_name: 'Dana', name_confirmed: true, locale: 'he', timezone: 'Asia/Jerusalem', timezone_confirmed: true };
  assert.match(renderCard({ ...base, gender: 'female' }, []), /FEMININE form/);
  assert.match(renderCard({ ...base, gender: 'male', birth_date: new Date(1990, 1, 28) }, []), /Birthday: 1990-02-28/);
  const none = renderCard({ ...base, gender: null }, []);
  assert.doesNotMatch(none, /form —|Birthday/);
});

test('name, Olma’s name and language go through the chat tools’ own calls', async () => {
  assert.equal((await act('setName', { firstName: 'מירון', lastName: 'דדוש' })).ok, true);
  assert.equal((await act('setAssistant', { name: 'נועה', gender: 'female' })).ok, true);
  assert.equal((await act('setLocale', { locale: 'en' })).ok, true);
  const page = await load();
  assert.equal(page.data.user.firstName, 'מירון');
  assert.equal(page.data.user.assistantName, 'נועה');
  assert.equal(page.data.user.locale, 'en');
  assert.equal((await act('setLocale', { locale: 'not a language' })).ok, false);
  await act('setLocale', { locale: 'he' });
});

test('digest times save through the same validation as the chat tool', async () => {
  assert.equal((await act('setDigest', { times: ['20:00', '08:00'], scope: 'today' })).ok, true);
  const page = await load();
  assert.deepEqual(page.data.user.digestTimes, ['08:00', '20:00']);
  assert.equal(page.data.user.digestScope, 'today');
  assert.equal((await act('setDigest', { times: ['1', '2', '3', '4', '5'] })).ok, false);
  assert.equal((await act('setDigest', { times: [] })).ok, true);
  assert.deepEqual((await load()).data.user.digestTimes, []);
});

test('calendar sync cannot be switched on without a connected calendar', async () => {
  const r = await act('setCalendarSync', { on: true });
  assert.equal(r.ok, false);
  assert.equal((await act('setCalendarSync', { on: false })).ok, true);
});

// ---- fact questions ----------------------------------------------------------------

test('there are enough questions to rotate, each key unique, each in both languages', () => {
  assert.ok(factPrompts.PROMPTS.length >= 20 && factPrompts.PROMPTS.length <= 30, `${factPrompts.PROMPTS.length}`);
  assert.equal(new Set(factPrompts.PROMPTS.map((p) => p.key)).size, factPrompts.PROMPTS.length);
  for (const p of factPrompts.PROMPTS) {
    assert.ok(facts.KNOWN_FACT_CATEGORIES.includes(p.category), p.key);
    assert.ok(p.q.he && p.q.en && p.label.he && p.label.en, p.key);
    // No slashed gender forms in a question: the page cannot inflect them.
    assert.doesNotMatch(p.q.he, /\/ה|\/ת/, p.key);
  }
});

// Every answer a question can compose must survive every guard in facts.js —
// a question the page offers and the server then refuses is a broken button.
test('every composable answer passes the fact guards, in both languages', () => {
  const sample = { range: { from: '09:00', to: '17:00' }, time: { time: '07:30' }, days: { days: [0, 1, 4] }, text: { text: 'ריצה' } };
  for (const p of factPrompts.PROMPTS) {
    for (const l of ['he', 'en']) {
      const answers = p.type === 'choice' ? p.options.map((o) => ({ value: o.id })) : [sample[p.type]];
      for (const a of answers) {
        const c = factPrompts.composeValue(p, a, l);
        assert.ok(c.value, `${p.key} ${JSON.stringify(a)}`);
        const text = `${p.label[l]}: ${c.value}`;
        assert.equal(facts.firstPerson(text), false, text);
        assert.equal(facts.phoneLike(text), false, text);
        assert.equal(facts.bareNameStatement(text), false, text);
        assert.equal(facts.systemState(text), false, text);
      }
    }
  }
});

test('answering a question saves a fact, takes the question off the list, and deleting it brings it back', async () => {
  const u = await makeUser(db.pool, '+972531940004', { firstName: 'Dana' });
  let page = await load(u);
  assert.equal(page.data.factPrompts[0].key, 'work_hours');
  const total = page.data.factPrompts.length;

  const r = await act('answerFactPrompt', { key: 'work_hours', answer: { from: '09:00', to: '17:00' } }, u);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.data.fact.fact, 'שעות עבודה: 09:00–17:00');
  assert.equal(r.data.fact.source, 'user_stated');

  page = await load(u);
  assert.equal(page.data.factPrompts.length, total - 1);
  assert.ok(!page.data.factPrompts.some((p) => p.key === 'work_hours'));
  assert.equal(page.data.facts[0].fact, 'שעות עבודה: 09:00–17:00');

  assert.equal((await act('forgetFact', { factId: r.data.fact.id }, u)).ok, true);
  page = await load(u);
  assert.ok(page.data.factPrompts.some((p) => p.key === 'work_hours'));
  assert.equal(page.data.facts.length, 0);
});

test('a second answer to the same question replaces the first rather than sitting beside it', async () => {
  const u = await makeUser(db.pool, '+972531940005');
  await act('answerFactPrompt', { key: 'work_pattern', answer: { value: 'fixed' } }, u);
  await act('answerFactPrompt', { key: 'work_pattern', answer: { value: 'shifts' } }, u);
  const page = await load(u);
  const rows = page.data.facts.filter((f) => f.promptKey === 'work_pattern');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fact, 'מבנה העבודה: משמרות');
});

test('an answer that does not fit its question, or a question that does not exist, is refused', async () => {
  const cases = [
    ['work_hours', { from: '9', to: '17' }], ['work_pattern', { value: 'astronaut' }],
    ['work_days', { days: [] }], ['work_days', { days: [9] }], ['occupation', { text: '' }],
    ['occupation', { text: 'x'.repeat(61) }], ['no_such_question', { text: 'hi' }],
  ];
  for (const [key, answer] of cases) {
    const r = await act('answerFactPrompt', { key, answer });
    assert.equal(r.ok, false, `accepted ${key} ${JSON.stringify(answer)}`);
  }
  // The guards still run on typed text: first person is refused by name.
  const mine = await act('answerFactPrompt', { key: 'hobbies', answer: { text: 'הכלב שלי' } });
  assert.equal(mine.error.reason, 'first_person');
});

test('a fact that is not theirs cannot be forgotten from their page', async () => {
  const other = await makeUser(db.pool, '+972531940006');
  const f = await tx((c) => facts.rememberFact(c, other.id, { category: 'work', fact: 'עובדת בבנק' }));
  const r = await act('forgetFact', { factId: f.data.fact.id });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

test('the questions are drawn in the person’s own language', async () => {
  const u = await makeUser(db.pool, '+447700900007', { locale: 'en' });
  const page = await load(u);
  assert.equal(page.data.factPrompts[0].q, 'What are your working hours?');
  const r = await act('answerFactPrompt', { key: 'work_days', answer: { days: [1, 2] } }, u);
  assert.equal(r.data.fact.fact, 'Work days: Monday, Tuesday');
});

// ---- being chased ----------------------------------------------------------
// The switch מאיה would have wanted on 2026-09-16: a reminder is said once at
// the hour she named, and following up is something to ask for. Both halves of
// the ask are here — the standing one on this page, and the per-reminder one
// set_task_reminder takes — because the ladder query reads whichever is true.
test('the nudge switch is off until it is turned on, and the ladder reads it', async () => {
  const reminders = require('../src/domain/reminders');
  const tasks = require('../src/domain/tasks');
  const sweeps = require('../src/jobs/sweeps');

  const page = await load();
  assert.equal(page.data.user.reminderNudge, false, 'nobody is opted in by default');

  // One reminder at an hour she named, and the follow-up window three hours on.
  // A fresh one per reading, because a ladder that has already ended is over:
  // flipping the switch afterwards cannot reopen it, and should not.
  const at = new Date(Date.now() - 4 * 3600_000);
  const arm = (title) => tx(async (c) => {
    const t = await tasks.addTask(c, me.id, { title });
    const r = await reminders.setReminder(c, me.id, t.data.task.id, at.toISOString());
    return Number(r.data.reminder.id);
  });
  const climb = async (armed) => {
    await tx((c) => sweeps.sweepReminders(c, new Date(at.getTime() + 60_000).toISOString()));
    await db.pool.query(
      `UPDATE outbox SET sent_at = $2::timestamptz, hold_reason = NULL
        WHERE idempotency_key = $1 AND sent_at IS NULL`,
      [reminders.attemptKey(armed, 1), new Date(at.getTime() + 120_000).toISOString()]);
    await tx((c) => sweeps.sweepReminders(c, new Date(at.getTime() + 3.5 * 3600_000).toISOString()));
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE idempotency_key = $1`,
      [reminders.attemptKey(armed, 2)]);
    return rows[0].n;
  };
  assert.equal(await climb(await arm('לארוז תיק לבית חולים')), 0, 'off: the hour she named is said once');

  const r = await act('setReminderNudge', { on: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal((await load()).data.user.reminderNudge, true);
  assert.equal(await climb(await arm('לארוז תיק לבית חולים 2')), 1, 'on: the follow-up she asked for goes out');

  // And off again, which changes nothing about a ladder already walking — that
  // is what "stop reminding me" is for, said in her own words.
  assert.equal((await act('setReminderNudge', { on: false })).ok, true);
  assert.equal((await load()).data.user.reminderNudge, false);
  const { rows: audit } = await db.pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND event = 'user.reminder_nudge_set'`, [me.id]);
  assert.equal(audit[0].n, 2);
});

test('a reminder they asked to be chased about climbs even with the switch off', async () => {
  const reminders = require('../src/domain/reminders');
  const tasks = require('../src/domain/tasks');
  const sweeps = require('../src/jobs/sweeps');
  const at = new Date(Date.now() - 4 * 3600_000);
  const id = await tx(async (c) => {
    const t = await tasks.addTask(c, me.id, { title: 'לשלוח את הדוח' });
    // "תזכירי לי עד שאעשה את זה" — the per-reminder half of the same switch.
    const r = await reminders.setReminder(c, me.id, t.data.task.id, at.toISOString(), null, { nudge: true });
    return Number(r.data.reminder.id);
  });
  await tx((c) => sweeps.sweepReminders(c, new Date(at.getTime() + 60_000).toISOString()));
  await db.pool.query(
    `UPDATE outbox SET sent_at = $2::timestamptz, hold_reason = NULL WHERE idempotency_key = $1 AND sent_at IS NULL`,
    [reminders.attemptKey(id, 1), new Date(at.getTime() + 120_000).toISOString()]);
  await tx((c) => sweeps.sweepReminders(c, new Date(at.getTime() + 3.5 * 3600_000).toISOString()));
  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM outbox WHERE idempotency_key = $1`, [reminders.attemptKey(id, 2)]);
  assert.equal(rows[0].n, 1);
});
