'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createDashboard } = require('../src/adapters/http/dashboard');
const usage = require('../src/jobs/usage');
const metrics = require('../src/jobs/metrics');
const retention = require('../src/jobs/retention');
const flags = require('../src/domain/flags');

let db, server, base, user;
const AUTH = 'Basic ' + Buffer.from('admin:test-password-123').toString('base64');

before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972611000001', { firstName: 'Dana' });
  await db.pool.query(`UPDATE users SET agent_id = 'u-' || id WHERE id = $1`, [user.id]);
  server = createDashboard({ pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.teardown(); });

// ---- pipeline jobs ----------------------------------------------------------

test('usage sweep: attributes positive deltas per user, ignores resets', async () => {
  const agentId = (await db.pool.query(`SELECT agent_id FROM users WHERE id = $1`, [user.id])).rows[0].agent_id;
  const fake = (total) => async () => [
    { sessionId: 'sess-1', agentId, model: 'claude-haiku-4-5', totalTokens: total },
    { sessionId: 'sess-x', agentId: 'main', model: 'x', totalTokens: 999999 }, // non user-agent → ignored
  ];
  let out = await withTx(db.pool, (c) => usage.sweepUsage(c, { listSessions: fake(10_000) }));
  assert.equal(out.recorded, 1); // first sight = full total attributed
  out = await withTx(db.pool, (c) => usage.sweepUsage(c, { listSessions: fake(25_000) }));
  assert.equal(out.recorded, 1); // +15k delta
  out = await withTx(db.pool, (c) => usage.sweepUsage(c, { listSessions: fake(5_000) }));
  assert.equal(out.recorded, 0); // shrink = session reset → re-baseline, no negative charge

  const { rows } = await db.pool.query(
    `SELECT total_tokens, cost_usd FROM usage_ledger WHERE user_id = $1`, [user.id]);
  assert.equal(Number(rows[0].total_tokens), 25_000);
  assert.ok(Number(rows[0].cost_usd) > 0);
});

test('usage sweep: prefers the gateway\'s own cost estimate over the blended rate', async () => {
  const agentId = (await db.pool.query(`SELECT agent_id FROM users WHERE id = $1`, [user.id])).rows[0].agent_id;
  const before = Number((await db.pool.query(
    `SELECT cost_usd FROM usage_ledger WHERE user_id = $1`, [user.id])).rows[0].cost_usd);
  // 100k tokens costing $4 — nothing like the blended flag rate, so if the
  // reported figure were ignored the delta below would be off by ~30x
  await withTx(db.pool, (c) => usage.sweepUsage(c, {
    listSessions: async () => [{
      sessionId: 'sess-cost', agentId, model: 'claude-opus-5',
      totalTokens: 100_000, estimatedCostUsd: 4,
    }],
  }));
  const after = Number((await db.pool.query(
    `SELECT cost_usd FROM usage_ledger WHERE user_id = $1 AND model = 'claude-opus-5'`, [user.id])).rows[0].cost_usd);
  assert.ok(Math.abs(after - 4) < 0.01, `expected ~$4 from the reported estimate, got ${after}`);
  assert.ok(before >= 0);
});

test('metrics rollup: audit events become daily snapshot rows', async () => {
  const tasks = require('../src/domain/tasks');
  await withTx(db.pool, (c) => tasks.addTask(c, user.id, { title: 'metric fodder' }));
  const out = await withTx(db.pool, (c) => metrics.sweepMetrics(c));
  assert.ok(out.metricsWritten > 0);
  const { rows } = await db.pool.query(
    `SELECT value FROM product_metrics_daily WHERE date = CURRENT_DATE AND metric = 'tasks_created'`);
  assert.ok(Number(rows[0].value) >= 1);
  const dau = await db.pool.query(
    `SELECT value FROM product_metrics_daily WHERE date = CURRENT_DATE AND metric = 'active_users'`);
  assert.ok(Number(dau.rows[0].value) >= 1);
});

test('retention: routine audit ages out, permanent survives', async () => {
  await db.pool.query(
    `INSERT INTO audit_log (actor_id, event, retention_class, created_at)
     VALUES ($1, 'task.created', 'routine', now() - interval '400 days'),
            ($1, 'connection.approved', 'permanent', now() - interval '400 days')`,
    [user.id]);
  const out = await withTx(db.pool, (c) => retention.sweepRetention(c));
  assert.ok(out.auditPurged >= 1);
  const perm = await db.pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE event = 'connection.approved' AND created_at < now() - interval '399 days'`);
  assert.equal(perm.rows[0].n, 1); // the permanent row survived
});

// ---- HTTP surface -----------------------------------------------------------

test('/health is unauthenticated, leaks nothing, and does not cry wolf', async () => {
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200); // clean DB, no heartbeats yet → healthy, not 503
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.stale, []);
  assert.ok(!JSON.stringify(body).includes('972'), 'health must leak no user data');
});

test('staleness respects each job\'s own interval', () => {
  const { assessJobs, isStale } = require('../src/jobs/expectations');
  const now = Date.parse('2026-08-16T12:00:00Z');
  const ago = (s) => new Date(now - s * 1000).toISOString();

  // an hourly job 90 minutes late is fine; the 30s outbox worker at 5min is not
  assert.equal(isStale('metrics_sweep', ago(5400), now), false);
  assert.equal(isStale('outbox_worker', ago(300), now), true);
  assert.equal(isStale('retention_sweep', ago(80_000), now), false);
  assert.equal(isStale('brokerd', null, now), false, 'never-run is not a failure');

  const verdict = assessJobs([
    { job_name: 'outbox_worker', last_run_at: ago(10), note: null },
    { job_name: 'minute_sweeps', last_run_at: ago(20), note: 'ERR boom' },
    { job_name: 'checkin_ladder', last_run_at: ago(99_999), note: null },
  ], now);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.failing, ['minute_sweeps']);
  assert.deepEqual(verdict.stale, ['checkin_ladder']);
});

test('/health reports 503 when a job is genuinely stuck', async () => {
  await db.pool.query(
    `INSERT INTO job_heartbeats (job_name, last_run_at, last_ok_at)
     VALUES ('outbox_worker', now() - interval '2 hours', now() - interval '2 hours')`);
  const res = await fetch(base + '/health');
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.deepEqual(body.stale, ['outbox_worker']);
  await db.pool.query(`DELETE FROM job_heartbeats WHERE job_name = 'outbox_worker'`);
});

test('stuck outbox rows raise an alarm', async () => {
  const guard = require('../src/jobs/config-guard');
  assert.deepEqual(await withTx(db.pool, (c) => guard.checkStuckOutbox(c)), []);
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, attempts, created_at, idempotency_key)
     VALUES ($1, 'checkin', 7, now() - interval '3 hours', 'stuck-1')`, [user.id]);
  const v = await withTx(db.pool, (c) => guard.checkStuckOutbox(c));
  assert.equal(v.length, 1);
  assert.match(v[0], /stuck after 5\+ delivery attempts/);
  await db.pool.query(`DELETE FROM outbox WHERE idempotency_key = 'stuck-1'`);
});

test('dashboard requires auth; renders all sections with it', async () => {
  const noAuth = await fetch(base + '/');
  assert.equal(noAuth.status, 401);

  const res = await fetch(base + '/', { headers: { Authorization: AUTH } });
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const t of ['מצב המערכת', 'עלות', 'שימוש במוצר', 'הגדרות מערכת', 'משתמשים', 'הודעות יוצאות']) {
    assert.ok(html.includes(t), `section "${t}" rendered`);
  }
  assert.match(html, /Dana/);
  // every control is labelled in Hebrew — no raw internal identifiers on screen
  assert.ok(!html.includes('>registration_open<'), 'flag keys are not shown raw');
  assert.match(html, /הרשמת משתמשים חדשים/);
  assert.match(html, /מכסת הודעות ליום/);
  assert.ok(html.includes('color-scheme'), 'declares dark/light support');
  assert.ok(res.headers.get('set-cookie').includes('SameSite=Strict'));
});

test('POST without matching CSRF cookie is rejected; with it, flags persist', async () => {
  const forged = await fetch(base + '/flags', {
    method: 'POST', headers: { Authorization: AUTH, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'key=registration_open&value=false&csrf=forged',
  });
  assert.equal(forged.status, 403);

  const page = await fetch(base + '/', { headers: { Authorization: AUTH } });
  const csrf = /csrf=([0-9a-f]+)/.exec(page.headers.get('set-cookie'))[1];
  const ok = await fetch(base + '/flags', {
    method: 'POST', redirect: 'manual',
    headers: { Authorization: AUTH, Cookie: `csrf=${csrf}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `key=registration_open&value=false&csrf=${csrf}`,
  });
  assert.equal(ok.status, 303);
  const val = await withTx(db.pool, (c) => flags.getFlag(c, 'registration_open'));
  assert.equal(val, false);

  // numeric flags are coerced by type; garbage is rejected, not stored as text
  const post = (body) => fetch(base + '/flags', {
    method: 'POST', redirect: 'manual',
    headers: { Authorization: AUTH, Cookie: `csrf=${csrf}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `${body}&csrf=${csrf}`,
  });
  await post('key=quota_daily_free&value=75');
  assert.equal(await withTx(db.pool, (c) => flags.getFlag(c, 'quota_daily_free')), 75);
  await post('key=quota_daily_free&value=abc');
  assert.equal(await withTx(db.pool, (c) => flags.getFlag(c, 'quota_daily_free')), 75, 'garbage ignored');
  // unknown flag key silently ignored (allowlist)
  await fetch(base + '/flags', {
    method: 'POST', redirect: 'manual',
    headers: { Authorization: AUTH, Cookie: `csrf=${csrf}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `key=evil_flag&value=1&csrf=${csrf}`,
  });
  assert.equal(await withTx(db.pool, (c) => flags.getFlag(c, 'evil_flag')), null);
  await withTx(db.pool, (c) => flags.setFlag(c, 'registration_open', true));
});

test('per-user page shows their tasks, reminders and learned facts', async () => {
  const tasks = require('../src/domain/tasks');
  const reminders = require('../src/domain/reminders');
  const prefs = require('../src/domain/preferences');
  await withTx(db.pool, async (c) => {
    const project = (await tasks.addTask(c, user.id, { title: 'קניות לשבת' })).data.task;
    await tasks.addTask(c, user.id, { title: 'חלב', parentId: project.id });
    const t = (await tasks.addTask(c, user.id, { title: 'לקבוע רופא שיניים', dueAt: new Date(Date.now() + 86400_000).toISOString() })).data.task;
    await reminders.setReminder(c, user.id, t.id, new Date(Date.now() + 3600_000).toISOString());
    await tasks.completeTask(c, user.id, (await tasks.addTask(c, user.id, { title: 'משימה שבוצעה' })).data.task.id);
    await prefs.remember(c, user.id, 'person.maya', 'אשתו');
  });

  const res = await fetch(base + `/user?id=${user.id}`, { headers: { Authorization: AUTH } });
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const t of ['קניות לשבת', 'חלב', 'לקבוע רופא שיניים', 'משימה שבוצעה', 'אשתו', 'משימות פתוחות', '⏰ 1', '↳']) {
    assert.ok(html.includes(t), `user page contains "${t}"`);
  }
  // main page links to it
  const main = await fetch(base + '/', { headers: { Authorization: AUTH } });
  assert.match(await main.text(), new RegExp(`/user\\?id=${user.id}`));
  // unknown user → graceful
  const missing = await fetch(base + '/user?id=99999', { headers: { Authorization: AUTH } });
  assert.match(await missing.text(), /לא נמצא/);
});

test('quota override and issue transitions work through forms', async () => {
  const issues = require('../src/domain/issues');
  const issue = await withTx(db.pool, (c) => issues.reportIssue(c, user.id, {
    category: 'bug', source: 'agent_detected', title: 'dashboard test issue',
  }));
  const page = await fetch(base + '/', { headers: { Authorization: AUTH } });
  const csrf = /csrf=([0-9a-f]+)/.exec(page.headers.get('set-cookie'))[1];
  const common = { Authorization: AUTH, Cookie: `csrf=${csrf}`, 'Content-Type': 'application/x-www-form-urlencoded' };

  await fetch(base + '/users/quota', {
    method: 'POST', redirect: 'manual', headers: common,
    body: `id=${user.id}&override=99&csrf=${csrf}`,
  });
  const u = await db.pool.query(`SELECT quota_override_daily FROM users WHERE id = $1`, [user.id]);
  assert.equal(u.rows[0].quota_override_daily, 99);

  await fetch(base + '/issues/status', {
    method: 'POST', redirect: 'manual', headers: common,
    body: `id=${issue.data.issue.id}&status=fixed&csrf=${csrf}`,
  });
  const i = await db.pool.query(`SELECT status FROM issues WHERE id = $1`, [issue.data.issue.id]);
  assert.equal(i.rows[0].status, 'fixed');
});
