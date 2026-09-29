'use strict';
// The notice that the privacy policy and terms changed (domain/policy-notice.js):
// who is queued, what the gate lets through, and that the words are the
// template's, on the raw pipe, in each person's language.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { decide } = require('../src/outbox/gate');
const notice = require('../src/domain/policy-notice');
const proactiveText = require('../src/domain/proactive-text');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// A Wednesday noon UTC, computed once: inside the default window, nobody's quiet day.
const NOON = (() => {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() - 3 + 7) % 7));
  at.setUTCHours(12, 0, 0, 0);
  return at;
})();

async function served(phone, extra = {}) {
  const u = await makeUser(db.pool, phone, extra);
  await db.pool.query(`UPDATE users SET status = 'active', onboarded_at = now() WHERE id = $1`, [u.id]);
  return u;
}

test('the words are the template\'s, in their language, with the link, and no model is asked', () => {
  const row = (locale) => ({ kind: notice.KIND, locale, payload: { version: '2026-09-28', url: 'https://allma.world/privacy' } });
  const he = proactiveText.rawPipeTextFor(row('he'), {}, 'whatsapp');
  const en = proactiveText.rawPipeTextFor(row('en'), {}, 'whatsapp');
  assert.match(he, /עדכנו את מדיניות הפרטיות: מה אני שומרת/);
  assert.match(en, /We updated the privacy policy: what I keep/);
  for (const t of [he, en]) assert.ok(t.includes('https://allma.world/privacy'));
  assert.ok(!/{{/.test(he + en), 'every variable filled');
});

test('the gate: paused drops, stopped-answering passes, the night holds, the budget does not', () => {
  const row = { kind: notice.KIND, urgency: 'urgent', payload: { version: '2026-09-28' } };
  const base = { row, plan: 'free', window: { start: '09:00', end: '21:00' }, tz: 'UTC', sentToday: 0, budget: 4, now: NOON, quietDays: [] };
  assert.equal(decide({ ...base, paused: true }).action, 'drop', 'a pause means nothing at all');
  assert.equal(decide({ ...base, checkinMisses: 2 }).action, 'deliver', 'a policy binds only somebody shown it');
  const night = new Date(NOON); night.setUTCHours(2);
  assert.equal(decide({ ...base, now: night }).holdReason, 'night');
  assert.equal(decide({ ...base, sentToday: 9 }).action, 'deliver');
  assert.equal(decide({ ...base, pendingUser: true }).action, 'drop');
});

test('enqueue reaches the served and not the paused, the pending or the eval user, once per version', async () => {
  const he = await served('+972500000201', { locale: 'he' });
  const en = await served('+15550000202', { locale: 'en' });
  const paused = await served('+972500000203');
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [paused.id]);
  const pending = await makeUser(db.pool, '+972500000204', { status: 'pending' });
  const evalU = await served('+972500000205');
  await db.pool.query(`UPDATE users SET is_eval = true WHERE id = $1`, [evalU.id]);

  const a = await withTx(db.pool, (c) => notice.audience(c));
  const first = await withTx(db.pool, (c) => notice.enqueueAll(c, '2026-09-28'));
  const again = await withTx(db.pool, (c) => notice.enqueueAll(c, '2026-09-28'));
  const { rows } = await db.pool.query(`SELECT user_id, urgency FROM outbox WHERE kind = $1`, [notice.KIND]);
  const ids = rows.map((r) => Number(r.user_id));
  assert.ok(ids.includes(Number(he.id)) && ids.includes(Number(en.id)));
  for (const u of [paused, pending, evalU]) assert.ok(!ids.includes(Number(u.id)));
  assert.ok(rows.every((r) => r.urgency === 'urgent'), 'never folded into a digest a model would reword');
  assert.equal(first.queued, a.eligible);
  assert.equal(again.queued, 0);
  await assert.rejects(withTx(db.pool, (c) => notice.enqueueAll(c, '1999-01-01')));
  const s = await withTx(db.pool, (c) => notice.stats(c, '2026-09-28'));
  assert.equal(s.rows, first.queued);
  assert.equal(s.waiting, first.queued);
});

// The owner's sample goes first, through the same row: one person, nobody
// else, never somebody the audience leaves out, and the full run afterwards
// does not send it to them a second time.
test('--only queues that one person, respects the audience, and the full run skips them', async () => {
  const owner = await served('+972500000211', { locale: 'he' });
  const other = await served('+972500000212', { locale: 'he' });
  const paused = await served('+972500000213');
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [paused.id]);
  const rowsFor = async (id) => (await db.pool.query(
    `SELECT count(*)::int AS n FROM outbox WHERE kind = $1 AND user_id = $2`, [notice.KIND, id])).rows[0].n;

  const sample = await withTx(db.pool, (c) => notice.enqueueAll(c, '2026-09-28', { only: owner.id }));
  assert.deepEqual(sample, { candidates: 1, queued: 1 });
  assert.equal(await rowsFor(other.id), 0, 'a sample reaches nobody else');
  const none = await withTx(db.pool, (c) => notice.enqueueAll(c, '2026-09-28', { only: paused.id }));
  assert.deepEqual(none, { candidates: 0, queued: 0 }, 'a paused person is not a sample either');

  await withTx(db.pool, (c) => notice.enqueueAll(c, '2026-09-28'));
  assert.equal(await rowsFor(owner.id), 1, 'the sample was their notice');
  assert.equal(await rowsFor(other.id), 1);
});

// The pages open in English unless asked (2026-09-29): the link opens the
// page in the notice's own language, decided as the template's is.
test('the link opens the page in the language the notice is in', async () => {
  assert.equal(notice.urlFor('https://allma.world/privacy', 'he'), 'https://allma.world/privacy?lang=he');
  assert.equal(notice.urlFor('https://allma.world/privacy', null), 'https://allma.world/privacy?lang=he');
  assert.equal(notice.urlFor('https://allma.world/privacy', 'en-US'), 'https://allma.world/privacy');
  const he = await served('+972500000221', { locale: 'he' });
  const en = await served('+15550000222', { locale: 'en' });
  for (const u of [he, en]) await withTx(db.pool, (c) => notice.enqueueAll(c, '2026-09-28', { only: u.id }));
  const urlOf = async (id) => (await db.pool.query(
    `SELECT payload->>'url' AS url FROM outbox WHERE kind = $1 AND user_id = $2`, [notice.KIND, id])).rows[0].url;
  assert.equal(await urlOf(he.id), 'https://allma.world/privacy?lang=he');
  assert.equal(await urlOf(en.id), 'https://allma.world/privacy');
  const text = proactiveText.rawPipeTextFor({ kind: notice.KIND, locale: 'he', payload: { version: '2026-09-28', url: await urlOf(he.id) } }, {}, 'whatsapp');
  assert.ok(text.includes('https://allma.world/privacy?lang=he'));
});
