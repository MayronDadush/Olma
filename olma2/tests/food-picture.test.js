'use strict';
// The evening food picture (domain/food-picture.js): when it is due, who it
// is never asked for, that it is asked once a day, that Saturday is the week
// and an Israeli Saturday waits for havdalah, and what the gate does with it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { decide } = require('../src/outbox/gate');
const flags = require('../src/domain/flags');
const fp = require('../src/domain/food-picture');

// Pictures this file writes land in its own directory, never the live one.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-food-picture-'));

let db;
before(async () => { db = await freshDb(); });
after(async () => {
  await db.teardown();
  fs.rmSync(HOME, { recursive: true, force: true });
});

// Fixed instants, never the hour the suite runs at (rules/testing.md).
const WED_2045_UTC = new Date('2026-10-07T20:45:00Z');      // a Wednesday
const FRI_2045_IL = new Date('2026-10-09T17:45:00Z');       // Friday 20:45 in Jerusalem: Shabbat
const SAT_2045_IL = new Date('2026-10-10T17:45:00Z');       // Saturday 20:45 in Jerusalem: after havdalah

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#004643"/></svg>';
function fakeFoodd(answer = { ok: true, svg: SVG, texts: { he: 'ככה נראה היום שלך בצלחת 🍽️', en: 'Your day on a plate 🍽️' }, model: 'recraft/recraft-v4.1-flash', drawn: false }) {
  const asked = [];
  return { asked, picture: async (body) => { asked.push(body); return answer; } };
}

let n = 0;
async function eater({ timezone = 'UTC', pack = true, ...extra } = {}) {
  n += 1;
  const phone = `+97250${String(7000000 + n)}`;
  const u = await makeUser(db.pool, phone, { firstName: 'Noa', timezone, ...extra });
  await db.pool.query(
    `UPDATE users SET status = 'active', onboarded_at = now(), timezone = $2 WHERE id = $1`, [u.id, timezone]);
  if (pack) await db.pool.query(`INSERT INTO user_packs (user_id, pack, via) VALUES ($1, 'food', 'owner')`, [u.id]);
  return { ...u, phone };
}
const flag = (key, value) => withTx(db.pool, (c) => flags.setFlag(c, key, value));
const rowsFor = async (id) => (await db.pool.query(
  `SELECT payload, urgency, expires_at, idempotency_key FROM outbox WHERE kind = 'food_picture' AND user_id = $1`, [id])).rows;

test('the slot is 20:30, or half an hour before the window closes, never before 19:00', () => {
  const at = (s) => fp.slotFor(s);
  assert.equal(at(null), 20 * 60 + 30);
  assert.equal(at({ start: '09:00', end: '21:00' }), 20 * 60 + 30, 'the default window');
  assert.equal(at({ start: '08:00', end: '20:00' }), 19 * 60 + 30);
  assert.equal(at({ start: '08:00', end: '19:00' }), 19 * 60, 'not before 19:00');
  assert.equal(at({ start: '08:00', end: '17:00' }), 19 * 60);
  assert.equal(at({ start: '08:00', end: '23:30' }), 20 * 60 + 30);
  assert.equal(at({ start: '22:00', end: '02:00' }), 20 * 60 + 30, 'a window past midnight closes after it');
});

test('off by default: nobody is asked for a picture', async () => {
  await eater();
  const foodd = fakeFoodd();
  const r = await fp.sweep(db.pool, { now: WED_2045_UTC, foodd, home: HOME });
  assert.equal(r.due, 0);
  assert.equal(foodd.asked.length, 0);
});

test('in the evening, a person in the flag with the pack gets ONE picture of the day, queued for the outbox', async () => {
  const u = await eater();
  await flag(fp.FLAG, u.phone);
  const foodd = fakeFoodd();

  assert.equal((await fp.sweep(db.pool, { now: new Date('2026-10-07T20:15:00Z'), foodd, home: HOME })).due, 0, 'not before the slot');
  const r = await fp.sweep(db.pool, { now: WED_2045_UTC, foodd, home: HOME });
  assert.equal(r.queued, 1);
  assert.deepEqual(foodd.asked, [{ user: { id: Number(u.id), name: 'Noa', timezone: 'UTC', locale: 'he' }, kind: 'day', day: '2026-10-07' }]);
  const [row] = await rowsFor(u.id);
  assert.equal(row.idempotency_key, `food_picture:${u.id}:day:2026-10-07`);
  assert.equal(row.urgency, 'normal');
  assert.equal(new Date(row.expires_at).getTime(), WED_2045_UTC.getTime() + 3 * 3600_000, 'tonight or not at all');
  assert.ok(fp.fileOk(row.payload.file, { home: HOME }), 'a PNG this module wrote');
  assert.equal(fs.readFileSync(row.payload.file).subarray(1, 4).toString(), 'PNG');
  assert.equal(row.payload.picture, 'day');
  assert.equal(row.payload.model, 'recraft/recraft-v4.1-flash');

  await fp.sweep(db.pool, { now: new Date(WED_2045_UTC.getTime() + 600_000), foodd, home: HOME });
  assert.equal(foodd.asked.length, 1, 'the next tick does not ask foodd again');
  assert.equal((await fp.sweep(db.pool, { now: new Date('2026-10-07T23:31:00Z'), foodd: fakeFoodd(), home: HOME })).due, 0, 'too late tonight');
  await flag(fp.FLAG, '');
});

test('never asked for: no pack, not in the flag, not answering, paused, or on daily-once', async () => {
  const noPack = await eater({ pack: false });
  const other = await eater();
  const quiet = await eater();
  await db.pool.query('UPDATE users SET checkin_misses = 1 WHERE id = $1', [quiet.id]);
  const paused = await eater();
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [paused.id]);
  const once = await eater();
  await flag(fp.FLAG, [noPack, quiet, paused, once].map((u) => u.phone).join(','));
  await flag('daily_once_phones', once.phone);
  const foodd = fakeFoodd();
  const r = await fp.sweep(db.pool, { now: WED_2045_UTC, foodd, home: HOME });
  assert.equal(r.due, 0, JSON.stringify(foodd.asked.map((a) => a.user.id)));
  assert.equal((await rowsFor(other.id)).length, 0, 'the pack without the flag is not enough');
  await flag(fp.FLAG, '');
  await flag('daily_once_phones', '');
});

test('a day\'s picture is not paid for once their window has closed; the week\'s still is', async () => {
  const early = await eater();
  await db.pool.query(`INSERT INTO user_preferences (user_id, key, value) VALUES ($1, 'availability', '08:00-19:00')`, [early.id]);
  await flag(fp.FLAG, early.phone);
  // Slot 19:00 (never earlier), window shut at 19:00: due, but not asked.
  const wed = fakeFoodd();
  await fp.sweep(db.pool, { now: new Date('2026-10-07T19:10:00Z'), foodd: wed, home: HOME });
  assert.equal(wed.asked.length, 0);
  const sat = fakeFoodd();
  await fp.sweep(db.pool, { now: new Date('2026-10-10T19:10:00Z'), foodd: sat, home: HOME });
  assert.equal(sat.asked.length, 1, 'held for the morning by the gate, and still worth it');
  assert.equal(sat.asked[0].kind, 'week');
  await flag(fp.FLAG, '');
});

test('an English speaker is asked for in English', async () => {
  const u = await eater({ locale: 'en-US' });
  await db.pool.query(`UPDATE users SET locale = 'en-US' WHERE id = $1`, [u.id]);
  await flag(fp.FLAG, u.phone);
  const foodd = fakeFoodd();
  await fp.sweep(db.pool, { now: WED_2045_UTC, foodd, home: HOME });
  assert.equal(foodd.asked[0].user.locale, 'en');
  await flag(fp.FLAG, '');
});

test('fewer than two meals is foodd\'s answer, and nothing is queued', async () => {
  const u = await eater();
  await flag(fp.FLAG, 'all');
  const r = await fp.sweep(db.pool, { now: WED_2045_UTC, foodd: fakeFoodd({ ok: false, reason: 'too_few' }), home: HOME });
  assert.ok(r.skipped.too_few >= 1);
  assert.equal((await rowsFor(u.id)).length, 0);
  await flag(fp.FLAG, '');
});

test('an Israeli Friday evening is Shabbat and gets nothing; Saturday after havdalah gets the WEEK', async () => {
  // quietDays: null — the UNSTATED quiet day, which for an Israeli zone is
  // Shabbat (makeUser stamps 'none' unless told otherwise).
  const u = await eater({ timezone: 'Asia/Jerusalem', locale: 'he', quietDays: null });
  await flag(fp.FLAG, u.phone);
  const fri = fakeFoodd();
  assert.equal((await fp.sweep(db.pool, { now: FRI_2045_IL, foodd: fri, home: HOME })).due, 0, 'waited out, never paid for');
  const sat = fakeFoodd();
  await fp.sweep(db.pool, { now: SAT_2045_IL, foodd: sat, home: HOME });
  assert.equal(sat.asked.length, 1);
  assert.equal(sat.asked[0].kind, 'week');
  assert.equal(sat.asked[0].day, '2026-10-10');
  const [row] = await rowsFor(u.id);
  assert.equal(new Date(row.expires_at).getTime(), SAT_2045_IL.getTime() + 18 * 3600_000, 'still worth Sunday morning');
  await flag(fp.FLAG, '');
});

test('the gate: its own allowance, the quota is not its business, and everything else applies', () => {
  const now = new Date('2026-10-07T18:00:00Z');
  const row = { kind: 'food_picture', urgency: 'normal', payload: { file: '/x.png' } };
  const base = { row, plan: 'free', window: { start: '09:00', end: '21:00' }, tz: 'UTC', sentToday: 0, budget: 4, now, quietDays: [] };
  assert.equal(decide(base).action, 'deliver');
  assert.equal(decide({ ...base, sentToday: 9 }).action, 'deliver', 'outside the daily budget');
  assert.equal(decide({ ...base, blocked: true }).action, 'deliver', 'paid from foodd, so a quota block does not hold it');
  assert.equal(decide({ ...base, paused: true }).action, 'drop');
  assert.equal(decide({ ...base, checkinMisses: 1 }).action, 'drop', 'somebody who stopped answering hears nothing Olma decided');
  assert.equal(decide({ ...base, now: new Date('2026-10-07T22:00:00Z') }).holdReason, 'night');
  assert.equal(decide({ ...base, row: { ...row, kind: 'checkin' }, sentToday: 9 }).holdReason, 'budget', 'the exemption is this kind only');
});

test('the words under it are foodd\'s, in their language, with their link for whoever it is forwarded to', () => {
  const p = { texts: { he: 'ככה נראה היום שלך בצלחת 🍽️', en: 'Your day on a plate 🍽️' } };
  assert.equal(fp.captionFor(p, 'he', 'https://allma.world/i/abc'), 'ככה נראה היום שלך בצלחת 🍽️\n\nרוצה גם? כתבו לעולמה:\nhttps://allma.world/i/abc');
  assert.equal(fp.captionFor(p, 'en-US', null), 'Your day on a plate 🍽️');
  assert.equal(fp.captionFor({ texts: { he: 'רק עברית' } }, 'en', null), 'רק עברית', 'a missing language falls back rather than sending nothing');
});

test('the delivery sends only a file this module wrote', () => {
  const ok = fp.save(Buffer.from('\x89PNG....'), { home: HOME });
  assert.equal(fp.fileOk(ok, { home: HOME }), true);
  assert.equal(fp.fileOk('/etc/passwd', { home: HOME }), false);
  assert.equal(fp.fileOk(path.join(fp.mediaDir(HOME), '..', 'x.png'), { home: HOME }), false);
  assert.equal(fp.fileOk(path.join(fp.mediaDir(HOME), 'not-a-uuid.png'), { home: HOME }), false);
  assert.equal(fp.fileOk(null, { home: HOME }), false);
  fs.utimesSync(ok, new Date(0), new Date(0));
  assert.equal(fp.purge({ home: HOME }), 1, 'files older than two days are cleared by the sweep');
  assert.equal(fs.existsSync(ok), false);
});
