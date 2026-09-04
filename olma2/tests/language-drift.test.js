'use strict';
// The bug this closes, exactly: on 2026-09-04 a user wrote four messages in
// English and got four replies in Hebrew. His row said `he`, set once at
// intake from his dialling code, and nothing in the system was capable of
// noticing — there is no messages table, and turn_start records that a
// message arrived without recording a word of it.
//
// So what is defended here is mostly the RESTRAINT. A detector that switches
// somebody's language on one English word would be worse than the bug: it
// would rewrite the relationship of every Hebrew speaker who quotes a subject
// line. The reset-on-agreement rule is what makes three a safe threshold, and
// most of these tests exist to prove it still fires.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const language = require('../src/domain/language');
const users = require('../src/domain/users');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const withClient = async (fn) => {
  const c = await db.pool.connect();
  try { return await fn(c); } finally { c.release(); }
};

// ---- the decision, with no database in it ----------------------------------

test('one message in another language is never enough', () => {
  const d = language.decideStreak({ stored: 'he', observed: 'en', prevObserved: null, prevCount: 0 });
  assert.equal(d.count, 1);
  assert.equal(d.ask, false);
});

test('three in a row is a person writing in that language', () => {
  let d = language.decideStreak({ stored: 'he', observed: 'en' });
  d = language.decideStreak({ stored: 'he', observed: 'en', prevObserved: d.observed, prevCount: d.count });
  assert.equal(d.ask, false, 'two is still a coincidence');
  d = language.decideStreak({ stored: 'he', observed: 'en', prevObserved: d.observed, prevCount: d.count });
  assert.equal(d.ask, true);
  assert.equal(d.observed, 'en');
});

// This is the rule that makes three safe rather than trigger-happy. Somebody
// who answers in Hebrew half the time is not asking for English.
test('a message in their own language breaks the streak completely', () => {
  const d = language.decideStreak({ stored: 'he', observed: 'he', prevObserved: 'en', prevCount: 2 });
  assert.equal(d.count, 0);
  assert.equal(d.observed, null);
  assert.equal(d.ask, false);
});

test('switching between two foreign languages restarts the count', () => {
  const d = language.decideStreak({ stored: 'he', observed: 'ru', prevObserved: 'en', prevCount: 2 });
  assert.equal(d.observed, 'ru');
  assert.equal(d.count, 1, 'two English then one Russian is not three of anything');
});

// The model is the only party that sees the message, so it can decline to
// answer. Silence must cost nothing and must not corrupt the streak.
test('a missing or unparseable code leaves the streak exactly as it was', () => {
  for (const bad of [null, undefined, '', '??', 'english', 'e', 12, {}]) {
    const d = language.decideStreak({ stored: 'he', observed: bad, prevObserved: 'en', prevCount: 2 });
    assert.equal(d.count, 2, `"${String(bad)}" must not disturb the count`);
    assert.equal(d.observed, 'en');
    assert.equal(d.ask, false);
  }
});

test('a recent ask buys silence, and its expiry lets the question return', () => {
  const base = { stored: 'he', observed: 'en', prevObserved: 'en', prevCount: 8, now: '2026-09-04T10:00:00Z' };
  assert.equal(language.decideStreak({ ...base, askedAt: '2026-09-01T10:00:00Z' }).ask, false);
  const old = new Date(Date.parse(base.now) - (language.ASK_AGAIN_DAYS + 1) * 86400_000).toISOString();
  assert.equal(language.decideStreak({ ...base, askedAt: old }).ask, true);
});

// The exact-match version of this check reads as the tighter rule and is the
// buggier one: a count that sails past the threshold during a quiet spell
// would never match again, and the person would never be asked at all.
test('a streak that overshot the threshold still asks', () => {
  const d = language.decideStreak({ stored: 'he', observed: 'en', prevObserved: 'en', prevCount: 40 });
  assert.equal(d.ask, true);
});

test('someone with no stored language at all is still worth asking', () => {
  const d = language.decideStreak({ stored: null, observed: 'en', prevObserved: 'en', prevCount: 2 });
  assert.equal(d.ask, true);
});

// ---- the same thing, against a real row ------------------------------------

test('the streak survives across calls, and asking stamps itself once', async () => {
  const u = await makeUser(db.pool, '+972501000001', { locale: 'he' });
  const reload = async () => (await db.pool.query('SELECT * FROM users WHERE id = $1', [u.id])).rows[0];

  let row = await reload();
  for (const expected of [1, 2]) {
    const out = await withClient((c) => users.noteObservedLanguage(c, row, 'en'));
    assert.equal(out.ask, false);
    row = await reload();
    assert.equal(row.locale_observed_count, expected);
    assert.equal(row.locale_asked_at, null);
  }

  const third = await withClient((c) => users.noteObservedLanguage(c, row, 'en'));
  assert.equal(third.ask, true);
  row = await reload();
  assert.ok(row.locale_asked_at, 'the ask is stamped in the same statement that counted it');
  assert.equal(row.locale, 'he', 'noticing is not switching — locale is untouched');

  // And it does not become a question asked on every message afterwards.
  const fourth = await withClient((c) => users.noteObservedLanguage(c, row, 'en'));
  assert.equal(fourth.ask, false);
});

test('noticing is audited, and only when it leads somewhere', async () => {
  const u = await makeUser(db.pool, '+972501000002', { locale: 'he' });
  const reload = async () => (await db.pool.query('SELECT * FROM users WHERE id = $1', [u.id])).rows[0];
  const noticed = async () => (await db.pool.query(
    `SELECT count(*)::int n FROM audit_log WHERE event = 'user.locale_mismatch_noticed' AND actor_id = $1`,
    [u.id])).rows[0].n;

  let row = await reload();
  for (let i = 0; i < 2; i++) {
    await withClient((c) => users.noteObservedLanguage(c, row, 'en'));
    row = await reload();
  }
  assert.equal(await noticed(), 0, 'a message in an unexpected language is not a finding');
  await withClient((c) => users.noteObservedLanguage(c, row, 'en'));
  assert.equal(await noticed(), 1);
});

test('a person who writes their own language is never counted at all', async () => {
  const u = await makeUser(db.pool, '+972501000003', { locale: 'he' });
  const reload = async () => (await db.pool.query('SELECT * FROM users WHERE id = $1', [u.id])).rows[0];
  let row = await reload();
  for (let i = 0; i < 5; i++) {
    const out = await withClient((c) => users.noteObservedLanguage(c, row, 'he'));
    assert.equal(out.ask, false);
    row = await reload();
  }
  assert.equal(row.locale_observed_count, 0);
  assert.equal(row.locale_asked_at, null);
});
