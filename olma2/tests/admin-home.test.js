'use strict';
// The admin home page's numbers (admin/home.js): calendar periods in Israel
// time with the week starting Sunday, the eval user out of every count of
// people, and monthly bills spread over their days. The clock is pinned, so
// nothing here depends on the hour or weekday the suite runs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const home = require('../src/adapters/http/admin/home');

// Tuesday 2026-09-15, 12:00 in Jerusalem. Today began 2026-09-14T21:00Z, the
// week on Sunday 2026-09-12T21:00Z, the month on 2026-08-31T21:00Z.
const NOW = new Date('2026-09-15T09:00:00Z');
const INFRA = {
  elevenlabs: { configured: true, monthlyUsd: 30 },
  digitalocean: { configured: true, error: 'http_500' },
};

let db, m;
const u = {};

before(async () => {
  db = await freshDb();
  const q = (sql, params) => db.pool.query(sql, params);
  const mk = async (key, phone, createdAt) => {
    u[key] = await makeUser(db.pool, phone, { firstName: key });
    await q(`UPDATE users SET created_at = $2 WHERE id = $1`, [u[key].id, createdAt]);
  };
  await mk('today', '+972500900001', '2026-09-15T08:00:00Z');
  await mk('sunday', '+972500900002', '2026-09-12T22:00:00Z'); // Saturday in UTC, Sunday 01:00 at home
  await mk('week', '+972500900003', '2026-09-13T10:00:00Z');
  await mk('month', '+972500900004', '2026-08-31T22:00:00Z'); // 1 Sept 01:00 at home
  await mk('old', '+972500900005', '2026-08-31T20:00:00Z'); // 31 Aug 23:00 at home
  await mk('future', '+972500900006', '2026-09-16T08:00:00Z');
  await mk('eval', '+972599999001', '2026-09-15T08:00:00Z');
  await q(`UPDATE users SET is_eval = true WHERE id = $1`, [u.eval.id]);

  const said = (who, at) => q(
    `INSERT INTO audit_log (actor_id, event, detail, created_at) VALUES ($1, 'message.received', '{}', $2)`,
    [u[who].id, at]);
  await said('today', '2026-09-15T07:00:00Z');
  await said('today', '2026-09-15T08:00:00Z');
  await said('week', '2026-09-12T09:00:00Z');
  await said('old', '2026-08-26T09:00:00Z');
  await said('month', '2026-08-01T09:00:00Z');
  await said('eval', '2026-09-15T08:30:00Z');

  const call = (sid, who, at, sec, usd = null) => q(
    `INSERT INTO voice_usage_ledger (call_sid, user_id, phone, started_at, duration_sec, twilio_usd)
     VALUES ($1, $2, '+972500000000', $3, $4, $5)`, [sid, who ? u[who].id : null, at, sec, usd]);
  await call('c1', 'today', '2026-09-15T07:00:00Z', 60, 0.01);
  await call('c2', 'week', '2026-09-13T05:00:00Z', 30);
  await call('c3', null, '2026-09-02T10:00:00Z', 120);
  await call('c4', 'eval', '2026-09-15T07:30:00Z', 500);
  await call('c5', 'today', '2026-09-15T07:40:00Z', 0);
  await call('c6', 'old', '2026-08-01T10:00:00Z', 10);

  const group = async (ext, at, state) => (await q(
    `INSERT INTO chat_groups (external_id, state, created_at) VALUES ($1, $2, $3) RETURNING id`,
    [ext, state, at])).rows[0].id;
  const g1 = await group('g1@g.us', '2026-09-15T06:00:00Z', 'open');
  await group('g2@g.us', '2026-08-10T06:00:00Z', 'locked');

  const google = (who, provider, at, status = 'connected') => q(
    `INSERT INTO integrations (user_id, provider, status, connected_at) VALUES ($1, $2, $3, $4)`,
    [u[who].id, provider, status, at]);
  await google('today', 'google_calendar', '2026-09-15T06:00:00Z');
  await google('today', 'google_contacts', '2026-09-15T06:00:00Z');
  await google('month', 'gmail', '2026-09-03T06:00:00Z');
  await google('old', 'google_calendar', '2026-09-15T06:00:00Z', 'disconnected');
  await google('eval', 'google_calendar', '2026-09-15T06:00:00Z');

  const meeting = (who, at, status, groupId = null, closedAt = null) => q(
    `INSERT INTO meetings (initiator_id, status, group_id, created_at, closed_at) VALUES ($1, $2, $3, $4, $5)`,
    [u[who].id, status, groupId, at, closedAt]);
  await meeting('today', '2026-09-15T06:00:00Z', 'negotiating', g1);
  await meeting('week', '2026-09-13T06:00:00Z', 'confirmed', null, '2026-09-13T08:00:00Z');
  await meeting('month', '2026-09-02T06:00:00Z', 'no_match');
  await meeting('eval', '2026-09-15T06:00:00Z', 'confirmed', null, '2026-09-15T06:01:00Z');

  const said2 = (kind, payload, sentAt, hold = null) => q(
    `INSERT INTO group_outbox (group_id, kind, payload, sent_at, hold_reason, created_at) VALUES ($1, $2, $3, $4, $5, $4)`,
    [g1, kind, payload, sentAt, hold]);
  await said2('intro', {}, '2026-09-15T06:05:00Z');
  await said2('coordination', { line: { kind: 'base' } }, '2026-09-15T06:10:00Z');
  await said2('coordination', { line: { kind: 'chase' } }, '2026-09-15T07:10:00Z', 'abandoned');

  await q(`INSERT INTO media_usage_ledger (user_id, date, images, cost_usd) VALUES ($1, '2026-09-15', 1, 0.5)`, [u.today.id]);

  m = await home.homeMetrics(db.pool, { now: NOW, infra: INFRA });
});
after(async () => { await db.teardown(); });

test('users: the eval user is never counted, and periods are Israeli calendar days with a Sunday week', () => {
  assert.equal(m.bounds.today, '2026-09-15');
  assert.equal(m.bounds.weekDay, '2026-09-13');
  assert.equal(m.bounds.monthDay, '2026-09-01');
  assert.deepEqual(m.users, { total: 5, month: 4, week: 3, day: 1 });
});

test('active users are distinct people who wrote, over the last day, week and month', () => {
  assert.deepEqual(m.activeUsers, { d1: 1, d7: 2, d30: 3 });
});

test('phone calls and their seconds: answered calls only, eval calls out', () => {
  assert.deepEqual(m.calls, { total: 4, month: 3, week: 2, day: 1 });
  assert.deepEqual(m.seconds, { total: 220, month: 210, week: 90, day: 60 });
});

test('groups, google connections (a person once) and meeting coordinations', () => {
  assert.deepEqual(m.groups, { total: 2, month: 1, week: 1, day: 1 });
  assert.deepEqual(m.google, { total: 2, month: 2, week: 1, day: 1 });
  assert.deepEqual(m.meetings, { total: 3, month: 3, week: 2, day: 1 });
  assert.deepEqual(m.groupMeetings, { total: 1, month: 1, week: 1, day: 1 });
});

test('the meetings panel: status, time to confirm, and a Sunday-keyed weekly series', () => {
  const f = m.meetingFocus;
  assert.deepEqual(f.byStatus.all, { negotiating: 1, confirmed: 1, no_match: 1 });
  assert.deepEqual(f.byStatus.group, { negotiating: 1 });
  assert.equal(f.medianConfirmSec, 7200);
  assert.equal(f.weekly.length, 8);
  assert.deepEqual(f.weekly.at(-1), { week: '2026-09-13', started: 2, confirmed: 1, inGroup: 1 });
  assert.deepEqual(f.weekly.at(-2), { week: '2026-09-06', started: 0, confirmed: 0, inGroup: 0 });
  assert.deepEqual(f.weekly.at(-3), { week: '2026-08-30', started: 1, confirmed: 0, inGroup: 0 });
});

test('the groups panel: states, and what was said in the rooms by line', () => {
  const f = m.groupFocus;
  assert.deepEqual(f.states, { open: 1, locked: 1 });
  assert.deepEqual(f.outbox.intro, { sent: 1, held: 0, pending: 0 });
  assert.deepEqual(f.outbox.base, { sent: 1, held: 0, pending: 0 });
  assert.deepEqual(f.outbox.chase, { sent: 0, held: 1, pending: 0 });
  assert.equal(f.weeklyNewGroups.at(-1).n, 1);
});

test('money: monthly bills spread over their days, and an unreadable bill is named, not zeroed', () => {
  const fixed = m.money.parts.fixed;
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);
  // Claude $20 over September's 30 days + ElevenLabs $30 over the same 30.
  close(fixed.day, 20 / 30 + 1, 'day');
  close(fixed.week, 3 * (20 / 30 + 1), 'week (Sun-Tue)');
  close(fixed.month, 15 * (20 / 30 + 1), 'month');
  // Claude from 27 June: 4 June days, all of July and August, 15 September
  // days. ElevenLabs from 18 August: 14 August days and 15 September days.
  close(fixed.total, (4 * 20 / 30 + 20 + 20 + 10) + (14 * 30 / 31 + 15), 'since the start');
  assert.deepEqual(m.money.missing, ['DigitalOcean']);
  close(m.money.parts.media.day, 0.5, 'media today');
  for (const k of ['total', 'month', 'week', 'day']) {
    const p = m.money.parts;
    close(m.money[k], p.model[k] + p.media[k] + p.voice[k] + p.fixed[k], `sum ${k}`);
  }
  // The eval user's calls cost money too, so voice spend includes them.
  assert.ok(m.money.parts.voice.day > 0.01 + (500 / 60) * 0.03, 'eval calls are in the bill');
});

test('a readable DigitalOcean bill: the invoiced total, this month accrued, and a daily rate from it', () => {
  const b = { today: '2026-09-15', weekDay: '2026-09-13', monthDay: '2026-09-01' };
  const withDo = home.fixedCosts(b, { digitalocean: { configured: true, paid: 50, accrued: 15 } });
  const without = home.fixedCosts(b, {});
  assert.deepEqual(withDo.missing, []);
  const close = (a, x) => assert.ok(Math.abs(a - x) < 1e-9, `${a} vs ${x}`);
  close(withDo.total - without.total, 65);
  close(withDo.month - without.month, 15);
  close(withDo.week - without.week, 3);
  close(withDo.day - without.day, 1);
});

test('the page renders every number in its place and never shows raw internal names', () => {
  const html = home.renderHome(m, { alertsHtml: '<div class="alerts"></div>', fx: 3.5 });
  for (const id of ['users', 'active', 'meetings', 'groups', 'calls', 'seconds', 'google', 'money']) {
    assert.ok(html.includes(`id="kpi-${id}"`), `tile ${id}`);
  }
  assert.ok(html.includes('0:03:40'), 'seconds also as a duration');
  assert.match(html, /לא נקרא: DigitalOcean/);
  assert.ok(!html.includes('no_match') && !html.includes('negotiating'), 'statuses are labelled in Hebrew');
  assert.ok(html.includes('₪'), 'shekels when a rate is known');
});
