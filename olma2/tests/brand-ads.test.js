'use strict';
// The ad library (domain/brand-ads.js): off until the owner turns it on, who
// is due a clip and which one, when it is released, what the gate does with
// it, and the admin page that holds all of it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser, daytime } = require('./helpers');

// Every clip this file stores lands in its own temp directory, never in the
// default store and never in a directory another test file reads.
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-brand-ads-'));
process.env.OLMA_BRAND_ADS_DIR = STORE;

const { withTx } = require('../src/db/pool');
const { decide } = require('../src/outbox/gate');
const ads = require('../src/domain/brand-ads');
const { createDashboard } = require('../src/adapters/http/dashboard');

let db;
before(async () => { db = await freshDb(); });
after(async () => {
  await db.teardown();
  fs.rmSync(STORE, { recursive: true, force: true });
});

// The smallest thing that passes the MP4 check: a size, then `ftyp`.
function fakeMp4(fill = 'x', size = 2048) {
  const b = Buffer.alloc(size, fill);
  b.writeUInt32BE(32, 0);
  b.write('ftypisom', 4, 'latin1');
  return b;
}

async function served(phone, extra = {}) {
  const u = await makeUser(db.pool, phone, extra);
  await db.pool.query(
    `UPDATE users SET status = 'active', onboarded_at = now(), last_inbound_at = now() - interval '2 days',
            timezone = coalesce($2, timezone)
      WHERE id = $1`, [u.id, extra.timezone || null]);
  return u;
}

const tx = (fn) => withTx(db.pool, fn);
const on = (extra = {}) => tx((c) => ads.saveSettings(c, { ...ads.DEFAULT_SETTINGS, enabled: true, timing: 'window', ...extra }));
const dueFor = async (userId) => (await tx(async (c) => ads.due(c, await ads.getSettings(c))))
  .filter((r) => Number(r.user_id) === Number(userId));
const rowsFor = async (userId) => (await db.pool.query(
  `SELECT payload->>'ad' AS ad, release_after, urgency FROM outbox WHERE kind = 'brand_ad' AND user_id = $1 ORDER BY id`,
  [userId])).rows;

test('settings: off by default, bounded, and an unreadable field falls back on its own', () => {
  const d = ads.normalizeSettings(null);
  assert.equal(d.enabled, false);
  assert.deepEqual(d, { ...ads.DEFAULT_SETTINGS });
  const s = ads.normalizeSettings({ enabled: 'true', everyDays: 0, activeWithinDays: 'x', timing: 'noon', introGapDays: 3 });
  assert.equal(s.enabled, false, 'only a real true turns it on');
  assert.equal(s.everyDays, ads.DEFAULT_SETTINGS.everyDays);
  assert.equal(s.activeWithinDays, ads.DEFAULT_SETTINGS.activeWithinDays);
  assert.equal(s.timing, 'morning');
  assert.equal(s.introGapDays, 3);
});

test('a file must really be an MP4, under WhatsApp\'s ceiling, for an ad that exists', async () => {
  await tx((c) => ads.createAd(c, { id: 'upload-check', title: 'בדיקה' }));
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)]);
  assert.equal((await tx((c) => ads.saveFile(c, { adId: 'upload-check', lang: 'he', data: gif }))).error, 'not_mp4');
  const huge = fakeMp4('x', ads.MAX_BYTES + 1);
  assert.equal((await tx((c) => ads.saveFile(c, { adId: 'upload-check', lang: 'he', data: huge }))).error, 'too_big');
  assert.equal((await tx((c) => ads.saveFile(c, { adId: 'nope', lang: 'he', data: fakeMp4() }))).error, 'not_found');
  assert.equal((await tx((c) => ads.saveFile(c, { adId: 'upload-check', lang: 'fr', data: fakeMp4() }))).error, 'bad_lang');

  const first = await tx((c) => ads.saveFile(c, { adId: 'upload-check', lang: 'he', data: fakeMp4('a') }));
  assert.ok(first.ok && fs.existsSync(path.join(STORE, first.file)));
  const second = await tx((c) => ads.saveFile(c, { adId: 'upload-check', lang: 'he', data: fakeMp4('b') }));
  assert.notEqual(second.file, first.file, 'new bytes, new name: a staged copy can never shadow it');
  assert.equal(second.replaced, first.file);
  ads.removeStoredFile(second.replaced);
  assert.ok(!fs.existsSync(path.join(STORE, first.file)));
  ads.removeStoredFile('../etc/passwd'); // refused, silently
});

test('off sends nothing, and an empty rotation sends nothing even when on', async () => {
  const u = await served('+972500001001', { locale: 'he' });
  await tx((c) => ads.createAd(c, { id: 'quiet-one', title: 'שקט' }));
  await tx((c) => ads.saveFile(c, { adId: 'quiet-one', lang: 'he', data: fakeMp4('q') }));
  assert.deepEqual(await tx((c) => ads.sweep(c)), { enabled: false, queued: 0 });
  await on();
  await tx((c) => ads.sweep(c));
  assert.equal((await rowsFor(u.id)).length, 0, 'not in rotation');
  await tx((c) => ads.updateAd(c, 'quiet-one', { title: 'שקט', inRotation: false, format: 'gif' }));
});

test('who is due: their language only, never the paused, the silent-for-a-month or the eval user', async () => {
  await db.pool.query(`UPDATE brand_ads SET in_rotation = false`);
  await tx((c) => ads.createAd(c, { id: 'reminder', title: 'שוב שכחת?', about: 'reminders' }));
  await tx((c) => ads.saveFile(c, { adId: 'reminder', lang: 'he', data: fakeMp4('r') }));
  await tx((c) => ads.updateAd(c, 'reminder', { title: 'שוב שכחת?', about: 'reminders', inRotation: true, format: 'gif' }));
  await on();

  const he = await served('+972500001101', { locale: 'he' });
  const en = await served('+15550001102', { locale: 'en' });
  const paused = await served('+972500001103', { locale: 'he' });
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [paused.id]);
  const gone = await served('+972500001104', { locale: 'he' });
  await db.pool.query(`UPDATE users SET last_inbound_at = now() - interval '60 days', last_dashboard_at = NULL WHERE id = $1`, [gone.id]);
  const evalU = await served('+972500001105', { locale: 'he' });
  await db.pool.query(`UPDATE users SET is_eval = true WHERE id = $1`, [evalU.id]);

  const first = await tx((c) => ads.sweep(c));
  assert.ok(first.queued >= 1);
  assert.deepEqual((await rowsFor(he.id)).map((r) => r.ad), ['reminder']);
  assert.equal((await rowsFor(he.id))[0].urgency, 'urgent', 'never folded into a digest as words');
  for (const u of [en, paused, gone, evalU]) assert.equal((await rowsFor(u.id)).length, 0);

  const again = await tx((c) => ads.sweep(c));
  assert.equal(again.queued, 0, 'one row waiting is enough');
});

test('never the same clip twice; the next one waits out the spacing; a dropped one stays available', async () => {
  const u = await served('+972500001201', { locale: 'he' });
  await tx((c) => ads.createAd(c, { id: 'zz-coffee', title: 'קפה' }));
  await tx((c) => ads.saveFile(c, { adId: 'zz-coffee', lang: 'he', data: fakeMp4('c') }));
  await tx((c) => ads.updateAd(c, 'zz-coffee', { title: 'קפה', inRotation: true, format: 'mp4' }));
  await on({ everyDays: 21 });
  await tx((c) => ads.sweep(c));
  assert.deepEqual((await rowsFor(u.id)).map((r) => r.ad), ['reminder'], 'the oldest clip first');

  // It reached them a month ago: the next clip, never the same one.
  await db.pool.query(
    `UPDATE outbox SET sent_at = now() - interval '30 days', created_at = now() - interval '30 days'
      WHERE kind = 'brand_ad' AND user_id = $1`, [u.id]);
  await tx((c) => ads.sweep(c));
  assert.deepEqual((await rowsFor(u.id)).map((r) => r.ad), ['reminder', 'zz-coffee']);

  // That one reached them yesterday: nothing until the spacing has passed,
  // and once it has, nothing left that they have not seen.
  await db.pool.query(
    `UPDATE outbox SET sent_at = now() - interval '1 day', created_at = now() - interval '1 day'
      WHERE kind = 'brand_ad' AND user_id = $1 AND payload->>'ad' = 'zz-coffee'`, [u.id]);
  assert.equal((await dueFor(u.id)).length, 0);
  await db.pool.query(
    `UPDATE outbox SET sent_at = now() - interval '40 days', created_at = now() - interval '40 days'
      WHERE kind = 'brand_ad' AND user_id = $1`, [u.id]);
  assert.equal((await dueFor(u.id)).length, 0,
    'both reached them, so there is nothing left to send');

  // A row the gate DROPPED did not reach them: the clip comes back after the spacing.
  await db.pool.query(
    `UPDATE outbox SET hold_reason = 'quiet' WHERE kind = 'brand_ad' AND user_id = $1 AND payload->>'ad' = 'zz-coffee'`, [u.id]);
  const due = (await dueFor(u.id));
  assert.deepEqual(due.map((r) => r.ad_id), ['zz-coffee']);
});

test('the intro video: a gap after it, and a clip marked as its remake never follows it', async () => {
  const u = await served('+972500001301', { locale: 'he' });
  await db.pool.query(`UPDATE brand_ads SET in_rotation = false`);
  await tx((c) => ads.createAd(c, { id: 'sorting', title: 'הראש מלא?' }));
  await tx((c) => ads.saveFile(c, { adId: 'sorting', lang: 'he', data: fakeMp4('s') }));
  await tx((c) => ads.updateAd(c, 'sorting', { title: 'הראש מלא?', inRotation: true, format: 'gif', skipIfIntro: true }));
  await on({ introGapDays: 7 });
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, sent_at) VALUES ($1, 'intro_video', '{"video":"v2"}', 'urgent', now() - interval '2 days')`,
    [u.id]);
  const mine = async () => (await dueFor(u.id));
  assert.equal((await mine()).length, 0, 'inside the gap');
  await db.pool.query(`UPDATE outbox SET sent_at = now() - interval '20 days' WHERE kind = 'intro_video' AND user_id = $1`, [u.id]);
  assert.equal((await mine()).length, 0, 'the remake of a story they already heard');
  await db.pool.query(`UPDATE brand_ads SET in_rotation = true WHERE id = 'reminder'`);
  assert.deepEqual((await mine()).map((r) => r.ad_id), ['reminder']);
});

test('morning timing releases at their first digest hour in THEIR zone, or 09:00', async () => {
  assert.equal(ads.morningOf('08:30,20:00'), '08:30');
  assert.equal(ads.morningOf(null), '09:00');
  assert.equal(ads.morningOf('soon'), '09:00');
  const now = daytime(); // 12:00 UTC = 15:00 in Jerusalem, past 08:30 there
  const at = await tx((c) => ads.nextMorning(c, 'Asia/Jerusalem', '08:30', now));
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  assert.equal(local, '08:30');
  assert.ok(at > now && at - now < 24 * 3_600_000, 'the next one, not today\'s that already passed');

  const u = await served('+972500001401', { locale: 'he', timezone: 'Asia/Jerusalem' });
  await db.pool.query(`UPDATE users SET digest_times = '08:30' WHERE id = $1`, [u.id]);
  await on({ timing: 'morning' });
  await tx((c) => ads.sweep(c, { now }));
  const [row] = await rowsFor(u.id);
  assert.equal(new Date(row.release_after).getTime(), at.getTime());
});

test('the gate: paused and stopped-answering are dropped — an ad has no exemption', () => {
  const now = daytime();
  const row = { kind: 'brand_ad', urgency: 'urgent', payload: { ad: 'reminder' } };
  const base = { row, plan: 'free', window: { start: '09:00', end: '21:00' }, tz: 'UTC', sentToday: 0, budget: 4, now, quietDays: [] };
  assert.equal(decide(base).action, 'deliver');
  assert.equal(decide({ ...base, paused: true }).action, 'drop');
  assert.equal(decide({ ...base, checkinMisses: 1 }).action, 'drop');
  const night = new Date(now); night.setUTCHours(2);
  assert.equal(decide({ ...base, now: night }).holdReason, 'night');
});

test('delivery reads the clip in their language and the format the page says now', async () => {
  const he = await tx((c) => ads.forDelivery(c, 'reminder', 'he-IL'));
  assert.equal(he.lang, 'he');
  assert.equal(he.format, 'gif');
  assert.equal(await tx((c) => ads.forDelivery(c, 'reminder', 'en')), null, 'no English cut is no clip, never the Hebrew one');
  await tx((c) => ads.updateAd(c, 'reminder', { title: 'שוב שכחת?', about: 'reminders', inRotation: true, format: 'mp4' }));
  assert.equal((await tx((c) => ads.forDelivery(c, 'reminder', 'he'))).format, 'mp4');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-brand-home-'));
  try {
    const dest = ads.stageMedia(he.file, { home });
    assert.equal(dest, path.join(home, 'workspace', 'outbox-media', 'ads', he.file));
    assert.ok(fs.statSync(dest).size > 1000);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the next turn is told what was sent, in the owner\'s words about it', async () => {
  const u = await served('+972500001501', { locale: 'he' });
  assert.equal(await tx((c) => ads.recentForTurn(c, u.id)), null);
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, sent_at) VALUES ($1, 'brand_ad', '{"ad":"reminder"}', 'urgent', now() - interval '1 hour')`,
    [u.id]);
  const r = await tx((c) => ads.recentForTurn(c, u.id));
  assert.match(r.what, /reminders/);
  await db.pool.query(`UPDATE outbox SET hold_reason = 'paused' WHERE kind = 'brand_ad' AND user_id = $1`, [u.id]);
  assert.equal(await tx((c) => ads.recentForTurn(c, u.id)), null, 'a dropped row never reached them');
});

// ── the admin page ───────────────────────────────────────────────────────────

test('admin: the page renders, saves, uploads, plays with ranges, and never on a public host', async () => {
  const server = createDashboard({
    pool: db.pool, adminUser: 'admin', adminPass: 'pw-123',
    gatewayCheck: async () => ({ status: 'live', detail: 'live', port: 1 }), gatewayCacheMs: 0,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const AUTH = 'Basic ' + Buffer.from('admin:pw-123').toString('base64');
  const csrf = 'c'.repeat(32);
  const headers = { Authorization: AUTH, Cookie: `csrf=${csrf}` };
  const post = (p, fields) => fetch(base + p, {
    method: 'POST', redirect: 'manual',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, back: '/#ads', ...fields }),
  });
  try {
    const page = await (await fetch(`${base}/g/brand`, { headers })).text();
    assert.match(page, /ספריית הפרסומות/);
    assert.match(page, /שוב שכחת\?/);

    let r = await post('/brand/ads/create', { id: 'morning', title: 'תמונת הבוקר', about: 'the morning picture' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/g/brand#ads');
    r = await post('/brand/ads/create', { id: 'Bad Id', title: 'x' });
    assert.match(await (await fetch(`${base}/g/brand`, { headers })).text(), /מזהה לא תקין/, 'a refusal is said on the page');

    const fd = new FormData();
    fd.set('csrf', csrf); fd.set('ad', 'morning'); fd.set('lang', 'en');
    fd.set('file', new Blob([fakeMp4('m', 5000)], { type: 'video/mp4' }), 'morning-en.mp4');
    r = await fetch(`${base}/brand/ads/upload`, { method: 'POST', body: fd, headers, redirect: 'manual' });
    assert.equal(r.status, 303);
    const { rows } = await db.pool.query(`SELECT bytes FROM brand_ad_files WHERE ad_id = 'morning' AND lang = 'en'`);
    assert.equal(rows[0].bytes, 5000);

    const bad = new FormData();
    bad.set('csrf', 'wrong'); bad.set('ad', 'morning'); bad.set('lang', 'he');
    bad.set('file', new Blob([fakeMp4()]), 'x.mp4');
    assert.equal((await fetch(`${base}/brand/ads/upload`, { method: 'POST', body: bad, headers, redirect: 'manual' })).status, 403);

    r = await post('/brand/ads/update', { id: 'morning', title: 'תמונת הבוקר', about: 'x', in_rotation: 'on', format: 'mp4' });
    assert.equal(r.status, 303);
    assert.equal((await db.pool.query(`SELECT in_rotation, format FROM brand_ads WHERE id = 'morning'`)).rows[0].format, 'mp4');

    r = await post('/brand/ads/settings', { enabled: 'false', everyDays: '14', activeWithinDays: '30', introGapDays: '7', timing: 'window' });
    assert.equal(r.status, 303);
    const s = await tx((c) => ads.getSettings(c));
    assert.equal(s.enabled, false);
    assert.equal(s.everyDays, 14);

    const whole = await fetch(`${base}/brand/ads/file/morning/en`, { headers });
    assert.equal(whole.status, 200);
    assert.equal((await whole.arrayBuffer()).byteLength, 5000);
    const part = await fetch(`${base}/brand/ads/file/morning/en`, { headers: { ...headers, Range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 0-99/5000');
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(`${base}/brand/ads/file/morning/he`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/brand/ads/file/morning/en`)).status, 401, 'behind the admin password');

    // fetch rewrites Host, so the public-host request goes out on node:http.
    const pub = await new Promise((resolve, reject) => {
      require('node:http').get({
        host: '127.0.0.1', port: server.address().port, path: '/brand/ads/file/morning/en',
        headers: { ...headers, Host: 'allma.world' },
      }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(pub, 404, 'the public host never serves it, even with the password');
  } finally { server.close(); }
});
