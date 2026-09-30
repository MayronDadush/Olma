'use strict';
// A game night's settlement, sent by code (domain/game-summary.js): brokerd's
// `game_summary` op that gamesd calls when a count closes, who it queues, the
// text the raw pipe sends, and what the gate does with it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { createBrokerServer } = require('../src/brokerd/server');
const { decide } = require('../src/outbox/gate');
const gameSummary = require('../src/domain/game-summary');
const proactiveText = require('../src/domain/proactive-text');

let db, broker;
before(async () => {
  db = await freshDb();
  broker = createBrokerServer({ pool: db.pool, placeMark: () => ({ attempted: false }) });
});
after(async () => { await db.teardown(); });

// gamesd's own drawing (games/src/summary.js), including the isolates.
const TEXTS = {
  he: 'סיכום ערב פוקר\nכניסה ⁦50 ₪⁩ = 1,000 ז\'יטונים\n\nמיוסי למיכל: ⁦90 ₪⁩',
  en: 'Poker night — settlement\nBuy-in ₪50 = 1,000 chips\n\n‎⁨יוסי⁩ pays ⁨מיכל⁩: ₪90',
};
const send = (params) => broker.dispatch({ id: 1, method: 'game_summary', params: { caller: 'games', ...params } });

let seq = 0;
async function player({ pack = true, ...extra } = {}) {
  seq += 1;
  const u = await makeUser(db.pool, `+9726432${String(seq).padStart(4, '0')}`, extra);
  if (pack) await db.pool.query(`INSERT INTO user_packs (user_id, pack, via) VALUES ($1, 'games', 'owner')`, [u.id]);
  return u;
}
const rowsFor = async (nightId) => (await db.pool.query(
  `SELECT user_id, payload, urgency, expires_at, idempotency_key FROM outbox
    WHERE kind = 'game_summary' AND (payload->>'nightId')::int = $1 ORDER BY id`, [nightId])).rows;

test('the settlement is queued for every linked pack holder, and only them', async () => {
  const a = await player();
  const b = await player({ locale: 'en' });
  const noPack = await player({ pack: false });
  const gone = await player();
  await db.pool.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [gone.id]);

  const out = await send({ nightId: 7, texts: TEXTS, userIds: [a.id, b.id, noPack.id, gone.id, a.id] });
  assert.equal(out.ok, true);
  assert.deepEqual(out.queued.sort(), [Number(a.id), Number(b.id)].sort());
  assert.deepEqual(out.skipped.sort(), [Number(noPack.id), Number(gone.id)].sort(), 'the pack is the audience, as it is for the tools');

  const rows = await rowsFor(7);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.deepEqual(r.payload, { nightId: 7, texts: TEXTS }, 'both languages ride the row; the reader is chosen at delivery');
    assert.equal(r.urgency, 'urgent', 'a result never waits behind the budget');
    assert.ok(new Date(r.expires_at) > new Date(), 'and expires, since the page carries it anyway');
  }
  const audit = (await db.pool.query(
    `SELECT detail FROM audit_log WHERE event = 'games.summary_queued' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.deepEqual(audit.detail, { caller: 'games', nightId: 7, queued: 2, skipped: 2 });
});

test('the same settlement twice is one message; a count that closes on new numbers is a second', async () => {
  const a = await player();
  await send({ nightId: 8, texts: TEXTS, userIds: [a.id] });
  await send({ nightId: 8, texts: TEXTS, userIds: [a.id] });
  assert.equal((await rowsFor(8)).length, 1);
  await send({ nightId: 8, texts: { he: TEXTS.he.replace('90', '95'), en: TEXTS.en.replace('90', '95') }, userIds: [a.id] });
  assert.equal((await rowsFor(8)).length, 2);
});

test('anything malformed is refused whole, and nothing is queued', async () => {
  const a = await player();
  const before = (await db.pool.query(`SELECT count(*)::int n FROM outbox WHERE kind = 'game_summary'`)).rows[0].n;
  for (const [params, error] of [
    [{ nightId: 0, texts: TEXTS, userIds: [a.id] }, /nightId/],
    [{ nightId: 9, texts: { he: TEXTS.he }, userIds: [a.id] }, /both required/],
    [{ nightId: 9, texts: { he: '  ', en: TEXTS.en }, userIds: [a.id] }, /both required/],
    [{ nightId: 9, texts: { he: 'x'.repeat(2001), en: TEXTS.en }, userIds: [a.id] }, /too long/],
    [{ nightId: 9, texts: TEXTS, userIds: [] }, /userIds/],
    [{ nightId: 9, texts: TEXTS, userIds: Array.from({ length: 31 }, (_, i) => i + 1) }, /userIds/],
  ]) {
    const out = await send(params);
    assert.equal(out.ok, false);
    assert.match(out.error, error);
  }
  assert.equal((await db.pool.query(`SELECT count(*)::int n FROM outbox WHERE kind = 'game_summary'`)).rows[0].n, before);
});

test('the raw pipe sends the drawn text itself, in the reader\'s language, and never asks a model', () => {
  const row = (locale) => ({ kind: gameSummary.KIND, locale, payload: { nightId: 7, texts: TEXTS } });
  assert.equal(proactiveText.rawPipeTextFor(row('he'), {}, 'whatsapp'), TEXTS.he);
  assert.equal(proactiveText.rawPipeTextFor(row(null), {}, 'whatsapp'), TEXTS.he);
  assert.equal(proactiveText.rawPipeTextFor(row('en-GB'), {}, 'whatsapp'), TEXTS.en);
  assert.ok(!TEXTS.he.includes('→') && !TEXTS.en.includes('→'));
});

// Wednesday noon and Saturday noon UTC as literals, so the weekday is fixed
// whenever the suite runs (rules/testing.md).
const WED_NOON = new Date('2026-08-12T12:00:00Z');
const SAT_NOON = new Date('2026-08-15T12:00:00Z');
const SAT = SAT_NOON.getUTCDay();

test('the gate: the paused hear nothing, the silent still hear their game, and the one who just closed it hears it now', () => {
  const row = { kind: gameSummary.KIND, urgency: 'urgent', payload: { nightId: 7, texts: TEXTS } };
  const base = { row, plan: 'free', window: { start: '09:00', end: '21:00' }, tz: 'UTC', sentToday: 0, budget: 4, now: WED_NOON, quietDays: [] };
  assert.equal(decide(base).action, 'deliver');
  assert.equal(decide({ ...base, paused: true }).action, 'drop', 'a pause has no exceptions');
  assert.equal(decide({ ...base, checkinMisses: 2 }).action, 'deliver', 'the outcome of an evening they sat at, not Olma\'s idea');
  assert.equal(decide({ ...base, sentToday: 9 }).action, 'deliver', 'a result never waits behind the budget');

  // 23:40 on a Wednesday: somebody else at the table waits for their morning,
  // and the one who reported the last chips two minutes ago does not.
  const late = new Date('2026-08-12T23:40:00Z');
  assert.equal(decide({ ...base, now: late }).holdReason, 'night');
  assert.equal(decide({ ...base, now: late, wokeAt: new Date(late.getTime() - 120_000) }).action, 'deliver');

  // A quiet Saturday: the same line, one rung up.
  const shabbat = { ...base, now: SAT_NOON, quietDays: [SAT] };
  assert.equal(decide(shabbat).holdReason, 'quiet_day');
  assert.equal(decide({ ...shabbat, wokeAt: new Date(SAT_NOON.getTime() - 120_000) }).action, 'deliver');
  assert.equal(decide({ ...shabbat, wokeAt: new Date(SAT_NOON.getTime() - 3600_000) }).holdReason, 'quiet_day',
    'an hour ago is not this conversation');
  // The grace is this kind's alone: any other row a DM woke still waits.
  assert.equal(decide({ ...shabbat, row: { kind: 'checkin', payload: {} }, wokeAt: new Date(SAT_NOON.getTime() - 120_000) }).holdReason, 'quiet_day');
});
