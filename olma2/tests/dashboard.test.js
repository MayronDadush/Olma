'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createDashboard } = require('../src/adapters/http/dashboard');
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

// The two usage-sweep tests that lived here were deleted rather than adapted.
// They fed fake cumulative counters into the sweep and asserted the delta
// arithmetic was right — which it was. What they could not catch is that the
// real field is a context-size GAUGE, not a counter, so the pipeline summed
// the wrong number and both tests passed anyway for a month while the ledger
// under-reported real spend by 7x. The replacement suite in tests/usage.test.js
// drives the sweep off actual transcript files — what production reads — so a
// wrong assumption about the source now fails instead of being encoded.

test('metrics rollup: audit events become daily snapshot rows', async () => {
  const tasks = require('../src/domain/tasks');
  await withTx(db.pool, (c) => tasks.addTask(c, user.id, { title: 'metric fodder' }));
  const out = await withTx(db.pool, (c) => metrics.sweepMetrics(c));
  assert.ok(out.metricsWritten > 0);
  // The sweep's day is `now.toISOString().slice(0, 10)` — UTC. CURRENT_DATE is
  // the SESSION's date, so on a box whose Postgres is not in UTC the two
  // disagree for the hours between the zones' midnights and this read found
  // nothing. Asking on the same basis the writer used is the assertion that
  // was meant; a test must not be right only where the clocks happen to agree.
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await db.pool.query(
    `SELECT value FROM product_metrics_daily WHERE date = $1::date AND metric = 'tasks_created'`, [today]);
  assert.ok(Number(rows[0].value) >= 1);
  const dau = await db.pool.query(
    `SELECT value FROM product_metrics_daily WHERE date = $1::date AND metric = 'active_users'`, [today]);
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

test('/ready is the deploy gate and a stale sweep must not fail it', async () => {
  // The deadlock this guards, live on 2026-08-22: deploy.sh gated on /health,
  // /health is 503 whenever any sweep is behind, and five seconds after a
  // restart the heartbeat table still describes the process that was just
  // replaced. One late sweep therefore failed every deploy, rolled it back,
  // failed the check again, and reported the rollback as broken — including
  // the deploy carrying the fix for the lateness.
  await db.pool.query(
    `INSERT INTO job_heartbeats (job_name, last_run_at, last_ok_at)
     VALUES ('brokerd', now(), now()), ('retention_sweep', now() - interval '9 days', now() - interval '9 days')
     ON CONFLICT (job_name) DO UPDATE SET last_run_at = excluded.last_run_at`);
  assert.equal((await fetch(base + '/health')).status, 503, 'monitoring still says something is wrong');
  const ready = await fetch(base + '/ready');
  assert.equal(ready.status, 200, 'but the release itself came up, so the deploy must stand');
  assert.equal((await ready.json()).ok, true);

  // A brokerd that never wrote a beat is exactly what the gate must catch.
  await db.pool.query(`DELETE FROM job_heartbeats WHERE job_name = 'brokerd'`);
  const dead = await fetch(base + '/ready');
  assert.equal(dead.status, 503);
  assert.equal((await dead.json()).brokerdBeatAgeSeconds, null);

  // So is one whose beat is older than the process could possibly be.
  await db.pool.query(
    `INSERT INTO job_heartbeats (job_name, last_run_at, last_ok_at)
     VALUES ('brokerd', now() - interval '20 minutes', now() - interval '20 minutes')`);
  assert.equal((await fetch(base + '/ready')).status, 503);

  await db.pool.query(`DELETE FROM job_heartbeats WHERE job_name IN ('brokerd', 'retention_sweep')`);
});

test('deploy.sh gates on /ready, never on /health', () => {
  const sh = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'scripts', 'deploy.sh'), 'utf8');
  const probes = [...sh.matchAll(/curl[^\n]*8788(\/[a-z]+)/g)].map((m) => m[1]);
  assert.deepEqual(probes, ['/ready'],
    'gating the deploy on /health is what deadlocked it — see the test above');
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

test('user deletion: two steps, shows the blast radius, then removes everything', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tasks = require('../src/domain/tasks');

  // a throwaway gateway config + workspace, so the test never touches the real ones
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-del-'));
  const cfgPath = path.join(tmp, 'openclaw.json');
  const workspace = path.join(tmp, 'ws-doomed');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, '.olma-identity'), 'olma_tok_' + '7'.repeat(32));

  const doomed = await makeUser(db.pool, '+972619000009', { firstName: 'Doomed' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-doomed', workspace_path = $2 WHERE id = $1`, [doomed.id, workspace]);
  await withTx(db.pool, (c) => tasks.addTask(c, doomed.id, { title: 'משימה שתימחק' }));
  fs.writeFileSync(cfgPath, JSON.stringify({
    agents: { list: [{ id: 'intake' }, { id: 'u-doomed' }] },
    bindings: [
      { agentId: 'u-doomed', match: { peer: { kind: 'direct', id: '+972619000009' } } },
      { agentId: 'intake', match: { peer: { kind: 'direct', id: '*' } } },
    ],
    channels: { whatsapp: { accounts: { default: { allowFrom: ['+972619000009', '+972611000001'] } } } },
  }, null, 2));

  const srv = createDashboard({ pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123', configPath: cfgPath });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${srv.address().port}`;

  // step 1: the plain page offers deletion but does not do it
  const plain = await (await fetch(b2 + `/user?id=${doomed.id}`, { headers: { Authorization: AUTH } })).text();
  assert.match(plain, /מחיקת משתמש/);
  assert.ok(!plain.includes('כן, מחק לצמיתות'), 'no destructive button before confirming');

  // step 2: the confirm view states exactly what will be lost
  const confirmRes = await fetch(b2 + `/user?id=${doomed.id}&confirm=delete`, { headers: { Authorization: AUTH } });
  const confirm = await confirmRes.text();
  assert.match(confirm, /כן, מחק לצמיתות/);
  assert.match(confirm, /1 משימות/, 'blast radius counted, not guessed');
  const csrf = /csrf=([0-9a-f]+)/.exec(confirmRes.headers.get('set-cookie'))[1];

  // a forged POST is still refused — deletion is not exempt from CSRF
  const forged = await fetch(b2 + '/users/delete', {
    method: 'POST', headers: { Authorization: AUTH, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `phone=${encodeURIComponent('+972619000009')}&csrf=nope`,
  });
  assert.equal(forged.status, 403);
  assert.equal((await db.pool.query(`SELECT count(*)::int n FROM users WHERE id = $1`, [doomed.id])).rows[0].n, 1);

  const done = await fetch(b2 + '/users/delete', {
    method: 'POST', redirect: 'manual',
    headers: { Authorization: AUTH, Cookie: `csrf=${csrf}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `phone=${encodeURIComponent('+972619000009')}&csrf=${csrf}`,
  });
  assert.equal(done.status, 303);

  assert.equal((await db.pool.query(`SELECT count(*)::int n FROM users WHERE id = $1`, [doomed.id])).rows[0].n, 0);
  assert.equal((await db.pool.query(`SELECT count(*)::int n FROM tasks WHERE owner_id = $1`, [doomed.id])).rows[0].n, 0);
  assert.equal(fs.existsSync(workspace), false, 'workspace directory removed');

  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.deepEqual(cfg.agents.list.map((a) => a.id), ['intake']);
  assert.equal(cfg.bindings.length, 1, 'their binding is gone');
  assert.equal(cfg.bindings[0].match.peer.id, '*', 'the intake catch-all survives — they can re-onboard');
  assert.deepEqual(cfg.channels.whatsapp.accounts.default.allowFrom, ['+972611000001'],
    'only their number was removed from allowFrom');

  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('conversation view: shows the last turns, marks voice notes, hides tool traffic', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const sessions = require('../src/channels/sessions');

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-conv-'));
  const dir = path.join(base, 'agents', 'u-conv', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const sessionFile = path.join(dir, 'live.jsonl');
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
    'agent:u-conv:whatsapp:direct:+972600000001': { sessionId: 'old', sessionFile: path.join(dir, 'old.jsonl'), lastInteractionAt: 1000 },
    'agent:u-conv:whatsapp:direct:+972600000002': { sessionId: 'live', sessionFile, lastInteractionAt: 9000 },
  }));
  fs.writeFileSync(path.join(dir, 'old.jsonl'), JSON.stringify(
    { type: 'message', timestamp: '2026-08-16T10:00:00Z', message: { role: 'user', content: 'שיחה ישנה' } }) + '\n');

  const lines = [
    { type: 'message', timestamp: '2026-08-16T12:00:00Z', message: { role: 'user', content: 'היי' } },
    // reasoning-only + tool traffic: must not surface (tool results carry tokens)
    { type: 'message', timestamp: '2026-08-16T12:00:01Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'סוד' }] } },
    { type: 'toolResult', timestamp: '2026-08-16T12:00:02Z', content: 'olma_tok_' + 'a'.repeat(32) },
    { type: 'message', timestamp: '2026-08-16T12:00:03Z', message: { role: 'assistant', content: [{ type: 'text', text: 'שלום מירון' }] } },
    { type: 'message', timestamp: '2026-08-16T12:00:04Z', message: { role: 'user', content: 'מה משימות חידרופות שלי?', MediaType: 'audio/ogg; codecs=opus' } },
    { type: 'message', timestamp: '2026-08-16T12:00:05Z', message: { role: 'user', content: "This is a brand-new user's first real conversation with you. Send the following…" } },
    // A crashed model call: the gateway writes an assistant turn whose whole
    // content is this marker. Counting it as a reply is what blinded the
    // dropped-message repair during the 2026-08-20 credit outage.
    { type: 'message', timestamp: '2026-08-16T12:00:06Z', message: { role: 'assistant', content: [{ type: 'text', text: '[assistant turn failed before producing content]' }] } },
  ];
  fs.writeFileSync(sessionFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const msgs = sessions.readRecentMessages('u-conv', 10, base);
  assert.equal(msgs.length, 4, 'reasoning-only turns, tool results and crashed turns are excluded');
  assert.ok(!JSON.stringify(msgs).includes('failed before producing'),
    'a crashed turn is not an answer — the repair sweep must still see the user waiting');
  assert.equal(msgs[msgs.length - 1].role, 'user', 'the transcript still ends on the unanswered user');
  assert.ok(!JSON.stringify(msgs).includes('olma_tok_'), 'identity tokens never reach the dashboard');
  assert.ok(!JSON.stringify(msgs).includes('סוד'), 'model reasoning is not shown');
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'user']);
  assert.equal(msgs[0].text, 'היי', 'oldest first');
  assert.equal(msgs[2].isVoice, true, 'voice note flagged');
  assert.equal(msgs[2].text, 'מה משימות חידרופות שלי?', 'shows the transcript Olma actually received');
  assert.match(msgs[3].text, /הודעה יזומה/, 'system instruction is labelled, not dumped');

  // picks the most recently active session, not just any file
  assert.ok(!msgs.some((m) => m.text === 'שיחה ישנה'));
  // an agent with no sessions at all is empty, never an exception
  assert.deepEqual(sessions.readRecentMessages('u-nope', 10, base), []);
  fs.rmSync(base, { recursive: true, force: true });
});

test('planned messages: queued rows, future reminders and standing digests, in local time', async () => {
  const tasks = require('../src/domain/tasks');
  const reminders = require('../src/domain/reminders');
  const { enqueue } = require('../src/outbox/enqueue');

  const p = await makeUser(db.pool, '+972618000055', { firstName: 'Noam', timezone: 'Asia/Jerusalem' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, digest_times = '08:00' WHERE id = $1`, [p.id]);

  await withTx(db.pool, async (c) => {
    // queued now, plus a held one — both must appear, with their reason
    await enqueue(c, { userId: p.id, kind: 'checkin', payload: { rung: 'deadline_risk' }, idempotencyKey: 'pl-1' });
    // a real future reminder: this has NO outbox row yet, which is exactly why
    // a queue-only view would be misleading
    const t = (await tasks.addTask(c, p.id, { title: 'לקחת את הרכב לטסט' })).data.task;
    await reminders.setReminder(c, p.id, t.id, new Date(Date.now() + 36 * 3600_000).toISOString(), 'weekly');
  });

  const html = await (await fetch(base + '/', { headers: { Authorization: AUTH } })).text();
  assert.match(html, /מה מתוכנן להישלח/);
  assert.match(html, /דדליין מתקרב/, 'a checkin shows WHY it was chosen, not its internal rung id');
  assert.match(html, /לקחת את הרכב לטסט/, 'a scheduled reminder appears before it is ever queued');
  assert.match(html, /weekly/);
  assert.match(html, /08:00/, 'the standing daily digest is listed too');
  // The payload holds an instruction, never the finished text — the page must
  // not imply it is showing a draft.
  assert.match(html, /התוכן עצמו נכתב ברגע השליחה/);

  // ...and the same, narrowed to one person, on their own page
  const userHtml = await (await fetch(base + `/user?id=${p.id}`, { headers: { Authorization: AUTH } })).text();
  assert.match(userHtml, /מה מתוכנן להישלח אליו/);
  assert.match(userHtml, /לקחת את הרכב לטסט/);
  assert.match(userHtml, /Asia\/Jerusalem/, 'states whose clock these times are in');
});

// ---- admin editing: plans, preferences, facts --------------------------------

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { enqueue } = require('../src/outbox/enqueue');
const { drainOnce } = require('../src/outbox/worker');
const factsDomain = require('../src/domain/facts');

// One CSRF cookie, reused: the pair is what the server checks, and issuing a
// fresh one per call would hide a bug where the cookie is not actually rotated.
async function adminPost(pathname, fields) {
  const page = await fetch(base + '/', { headers: { Authorization: AUTH } });
  const csrf = /csrf=([0-9a-f]+)/.exec(page.headers.get('set-cookie'))[1];
  return fetch(base + pathname, {
    method: 'POST', redirect: 'manual',
    headers: { Authorization: AUTH, Cookie: `csrf=${csrf}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, csrf }).toString(),
  });
}

test('cancelling a planned message does not delete it — so the sweep cannot recreate it', async () => {
  const u = await makeUser(db.pool, '+972611000900', { firstName: 'Noa' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem' WHERE id = $1`, [u.id]);
  // exactly what a sweep produces: a row carrying its idempotency key
  const first = await withTx(db.pool, (c) => enqueue(c, {
    userId: u.id, kind: 'checkin', payload: { rung: 'silence' }, idempotencyKey: `sweep:${u.id}:day1`,
  }));
  assert.equal(first.data.enqueued, true);

  const res = await adminPost('/outbox/cancel', { id: first.data.outboxId, back: `/user?id=${u.id}` });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/user?id=${u.id}`);

  const { rows } = await db.pool.query(`SELECT sent_at, hold_reason FROM outbox WHERE id = $1`, [first.data.outboxId]);
  assert.ok(rows[0].sent_at, 'cancelling marks it handled');
  assert.equal(rows[0].hold_reason, 'cancelled_by_admin');

  // the sweep runs again with the same key — and must not produce a second one
  const again = await withTx(db.pool, (c) => enqueue(c, {
    userId: u.id, kind: 'checkin', payload: { rung: 'silence' }, idempotencyKey: `sweep:${u.id}:day1`,
  }));
  assert.equal(again.data.enqueued, false, 'the surviving row is what blocks the duplicate');
  const { rows: all } = await db.pool.query(
    `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1`, [u.id]);
  assert.equal(all[0].n, 1);

  // and it is shown as cancelled rather than quietly disappearing
  const html = await (await fetch(base + `/user?id=${u.id}`, { headers: { Authorization: AUTH } })).text();
  assert.match(html, /בוטלו ע"י מנהל/);
});

test('a cancelled message does not burn the daily budget', async () => {
  const u = await makeUser(db.pool, '+972611000901', { firstName: 'Ronit', timezone: 'UTC' });
  const day = '2026-08-16T12:00:00Z';
  // three genuinely delivered messages, plus one the operator cancelled
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, sent_at) VALUES
       ($1,'checkin','{}','normal',$2), ($1,'checkin','{}','normal',$2), ($1,'checkin','{}','normal',$2)`,
    [u.id, day]);
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, sent_at, hold_reason)
     VALUES ($1,'checkin','{}','normal',$2,'cancelled_by_admin')`, [u.id, day]);

  await withTx(db.pool, (c) => enqueue(c, {
    userId: u.id, kind: 'connection_request', payload: {}, idempotencyKey: 'budget-cancel-1',
  }));
  // Assert on THIS row, not on the drain's totals — other tests in this file
  // leave rows of their own in the queue, and a global count would make this
  // test pass or fail for reasons that have nothing to do with the budget.
  await drainOnce(db.pool, async () => ({ ok: true }), new Date(day));
  const { rows } = await db.pool.query(
    `SELECT sent_at, hold_reason FROM outbox WHERE idempotency_key = 'budget-cancel-1'`);
  assert.equal(rows[0].hold_reason, null,
    'three delivered + one cancelled is three against a budget of four');
  assert.ok(rows[0].sent_at, 'so the fourth genuine message still goes out');
});

test('an operator can queue a proactive message, and it shows up as planned', async () => {
  const u = await makeUser(db.pool, '+972611000902', { firstName: 'Tal' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem' WHERE id = $1`, [u.id]);
  const res = await adminPost('/outbox/new', {
    user_id: u.id, instruction: 'שאלי אותו איך הלך הראיון אתמול',
    urgency: 'normal', release_after: '2026-09-01T09:30', back: `/user?id=${u.id}`,
  });
  assert.equal(res.status, 303);

  const { rows } = await db.pool.query(
    `SELECT kind, urgency, payload, idempotency_key,
            to_char(release_after AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD"T"HH24:MI') AS local
     FROM outbox WHERE user_id = $1`, [u.id]);
  assert.equal(rows[0].kind, 'checkin');
  assert.equal(rows[0].urgency, 'normal');
  assert.equal(rows[0].payload.rung, 'admin');
  assert.equal(rows[0].payload.checkinInstruction, 'שאלי אותו איך הלך הראיון אתמול');
  assert.equal(rows[0].idempotency_key, null, 'a one-off has nothing to deduplicate against');
  assert.equal(rows[0].local, '2026-09-01T09:30', 'the time entered is the time in HIS zone');

  const html = await (await fetch(base + `/user?id=${u.id}`, { headers: { Authorization: AUTH } })).text();
  assert.match(html, /שאלי אותו איך הלך הראיון אתמול/, 'what the operator wrote is shown back to them');

  // an empty instruction queues nothing rather than an empty message
  await adminPost('/outbox/new', { user_id: u.id, instruction: '   ', back: `/user?id=${u.id}` });
  const { rows: after } = await db.pool.query(`SELECT count(*)::int AS n FROM outbox WHERE user_id = $1`, [u.id]);
  assert.equal(after[0].n, 1);
});

test('rescheduling moves the time in the person\'s zone and unsticks a budget hold', async () => {
  const u = await makeUser(db.pool, '+972611000903', { firstName: 'Gil' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem' WHERE id = $1`, [u.id]);
  const q = await withTx(db.pool, (c) => enqueue(c, {
    userId: u.id, kind: 'checkin', payload: { rung: 'silence' }, idempotencyKey: 'resched-1',
  }));
  await db.pool.query(`UPDATE outbox SET hold_reason = 'budget' WHERE id = $1`, [q.data.outboxId]);

  await adminPost('/outbox/reschedule', {
    id: q.data.outboxId, release_after: '2026-09-02T08:15', expires_at: '2026-09-03T08:15',
    back: `/user?id=${u.id}`,
  });
  const { rows } = await db.pool.query(
    `SELECT hold_reason,
            to_char(release_after AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD"T"HH24:MI') AS rel,
            to_char(expires_at   AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD"T"HH24:MI') AS exp
     FROM outbox WHERE id = $1`, [q.data.outboxId]);
  assert.equal(rows[0].rel, '2026-09-02T08:15');
  assert.equal(rows[0].exp, '2026-09-03T08:15');
  assert.equal(rows[0].hold_reason, null, 'a budget-held row is skipped forever unless the hold is cleared');

  // garbage in the time field must not blank a schedule by accident
  await adminPost('/outbox/reschedule', { id: q.data.outboxId, release_after: 'tomorrow-ish', back: `/user?id=${u.id}` });
  const { rows: after } = await db.pool.query(`SELECT release_after FROM outbox WHERE id = $1`, [q.data.outboxId]);
  assert.equal(after[0].release_after, null, 'unparseable input clears rather than storing nonsense');
});

test('editing preferences and facts rewrites USER.md, not just the database', async () => {
  const u = await makeUser(db.pool, '+972611000904', { firstName: 'Yael' });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-dash-'));
  await db.pool.query(`UPDATE users SET workspace_path = $2 WHERE id = $1`, [u.id, ws]);
  const card = () => fs.readFileSync(path.join(ws, 'USER.md'), 'utf8');
  const back = `/user?id=${u.id}`;

  try {
    await adminPost('/prefs/set', { user_id: u.id, key: 'tone', value: 'קצר ולעניין', back });
    assert.match(card(), /- tone: קצר ולעניין/, 'USER.md is what the agent reads every turn');

    await adminPost('/facts/add', {
      user_id: u.id, category: 'work', fact: 'עובדת במשמרות באיכילוב', importance: '3', back,
    });
    assert.match(card(), /- \[work\] עובדת במשמרות באיכילוב/);

    const listed = await factsDomain.listFacts(db.pool, u.id);
    assert.equal(listed.data.facts[0].source, 'admin', 'an operator decided this; the person did not say it');

    // deleting a fact is a soft delete, and the card follows immediately
    await adminPost('/facts/delete', { user_id: u.id, id: listed.data.facts[0].id, back });
    assert.doesNotMatch(card(), /עובדת במשמרות/);
    const { rows } = await db.pool.query(
      `SELECT active FROM user_facts WHERE id = $1`, [listed.data.facts[0].id]);
    assert.equal(rows[0].active, false, 'kept as history, just not used');

    await adminPost('/prefs/delete', { user_id: u.id, key: 'tone', back });
    assert.doesNotMatch(card(), /tone/);

    // a rejected edit changes nothing — no bad category slips into the card
    await adminPost('/facts/add', { user_id: u.id, category: 'gossip', fact: 'לא אמור להישמר', back });
    assert.doesNotMatch(card(), /לא אמור להישמר/);
    const audits = await db.pool.query(
      `SELECT event FROM audit_log WHERE actor_id = $1 AND event LIKE 'admin.%' ORDER BY id`, [u.id]);
    assert.deepEqual(audits.rows.map((r) => r.event),
      ['admin.preference.set', 'admin.fact.added', 'admin.fact.deleted', 'admin.preference.deleted']);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('the back field cannot be turned into an open redirect', async () => {
  const u = await makeUser(db.pool, '+972611000905', { firstName: 'Adi' });
  const res = await adminPost('/prefs/set', {
    user_id: u.id, key: 'tone', value: 'x', back: 'https://evil.example/steal',
  });
  assert.equal(res.headers.get('location'), '/');
});

// ---- the brain section -------------------------------------------------------

test('the brain shows who is waiting on a human, and what Olma has learned', async () => {
  const connections = require('../src/domain/connections');
  const asker = await makeUser(db.pool, '+972611001000', { firstName: 'Shira' });
  const target = await makeUser(db.pool, '+972611001001', { firstName: 'Eitan' });

  await withTx(db.pool, async (c) => {
    // the exact shape of the incident this half of the screen exists for: a
    // connection request delivered, then never answered
    const req = await connections.requestConnection(c, asker.id, target.phone, {
      reason: 'רוצה לתאם איתך פגישה',
    });
    assert.equal(req.data.connection.status, 'pending_target');
    await c.query(`UPDATE connections SET invited_at = now() - interval '3 days' WHERE id = $1`,
      [req.data.connection.id]);

    await factsDomain.rememberFact(c, asker.id, {
      category: 'work', fact: 'מנהלת צוות של שישה אנשים', importance: 2,
    });
  });

  const html = await (await fetch(base + '/', { headers: { Authorization: AUTH } })).text();
  assert.match(html, /מה אולמה יודעת ועל מה היא מחכה/);
  assert.match(html, /ממתין לתשובה של אדם/);
  assert.match(html, /בקשת חברות/);
  assert.match(html, /Shira/, 'the person waiting is named and linked');
  assert.match(html, /Eitan/, 'so is the person who owes an answer');
  assert.match(html, /רוצה לתאם איתך פגישה/, 'and what it was about');
  assert.match(html, /מנהלת צוות של שישה אנשים/, 'recently learned facts are listed');
  // three days unanswered is well past the day threshold, so the row is flagged
  const waitingBlock = html.slice(html.indexOf('ממתין לתשובה של אדם'), html.indexOf('מה נלמד לאחרונה'));
  assert.match(waitingBlock, /class="bad"/, 'a wait older than a day reads as a problem');
});

test('the brain covers more than one kind of waiting, and marks unread conversations', async () => {
  const u = await makeUser(db.pool, '+972611001002', { firstName: 'Dror' });
  const other = await makeUser(db.pool, '+972611001003', { firstName: 'Maya' });
  // Seeded directly: this asserts the UNION renders every waiting shape, not
  // the meeting state machine, which meetings.test.js already covers.
  const { rows: m } = await db.pool.query(
    `INSERT INTO meetings (initiator_id, title, status) VALUES ($1, 'קפה בעיר', 'negotiating')
     RETURNING id`, [u.id]);
  await db.pool.query(
    `INSERT INTO meeting_participants (meeting_id, user_id, state) VALUES ($1, $2, 'awaiting')`,
    [m[0].id, other.id]);
  // Dror wrote 40 minutes ago and nothing has read it yet
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, last_inbound_at = now() - interval '40 minutes',
            last_fact_extraction_at = NULL WHERE id = $1`, [u.id]);

  const html = await (await fetch(base + '/', { headers: { Authorization: AUTH } })).text();
  assert.match(html, /תשובה על מועד פגישה/);
  assert.match(html, /קפה בעיר/);
  assert.match(html, /שיחה ממתינה לקריאה/, 'an unread finished conversation is visible');
  assert.match(html, /אף פעם/, 'someone never read yet says so plainly');
});

// ---- outcomes: the three metrics ---------------------------------------------

// The <tr> for one person INSIDE one section. Scoping matters: every name also
// appears in the users section higher up the page, so an unscoped search finds
// that row instead and asserts nothing about the metric under test.
function sectionOf(html, id) {
  const start = html.indexOf(`<section id="${id}"`);
  assert.ok(start > 0, `section ${id} not rendered`);
  const next = html.indexOf('<section id="', start + 1);
  return html.slice(start, next === -1 ? html.length : next);
}

function rowFor(html, name, { section = 'outcomes', under = null } = {}) {
  let scope = sectionOf(html, section);
  if (under) {
    // One section can hold several tables — narrow to the one under this
    // heading, or the same name matches whichever table happens to come first.
    const h = scope.indexOf(under);
    assert.ok(h > 0, `heading ${under} not found in #${section}`);
    const nextH = scope.indexOf('<h4', h + 1);
    scope = scope.slice(h, nextH === -1 ? scope.length : nextH);
  }
  const idx = scope.indexOf(`>${name}</a>`);
  assert.ok(idx > 0, `${name} not rendered under ${under || section}`);
  const start = scope.lastIndexOf('<tr', idx);
  return scope.slice(start, scope.indexOf('</tr>', idx));
}

test('turn_start records each inbound message, so the north star has a numerator', async () => {
  const { createBrokerServer } = require('../src/brokerd/server');
  const u = await makeUser(db.pool, '+972611002000', { firstName: 'Inbal' });
  const { dispatch } = createBrokerServer({ pool: db.pool });
  const res = await dispatch({
    method: 'tool_call',
    params: { name: 'turn_start', args: { olma_identity: u.identity_token } },
  });
  assert.equal(res.ok, true);
  const { rows } = await db.pool.query(
    `SELECT retention_class FROM audit_log WHERE actor_id = $1 AND event = 'message.received'`, [u.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].retention_class, 'routine', 'operational volume, pruned like the rest');
});

test('response rate counts a reply within a day, and ignores what predates measurement', async () => {
  const u = await makeUser(db.pool, '+972611002001', { firstName: 'Ophir' });
  const send = (sentAt, hold = null) => db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, sent_at, hold_reason)
     VALUES ($1,'checkin','{}','normal',$2,$3)`, [u.id, sentAt, hold]);
  const heard = (at) => db.pool.query(
    `INSERT INTO audit_log (actor_id, event, retention_class, created_at)
     VALUES ($1,'message.received','routine',$2)`, [u.id, at]);

  // measurement opened three days ago
  await heard('2026-08-17T09:00:00Z');
  // before that: sent and never answerable — must not be counted at all
  await send('2026-08-15T09:00:00Z');
  // after: one answered within the day, one left in silence
  await send('2026-08-18T09:00:00Z');
  await heard('2026-08-18T15:00:00Z');
  await send('2026-08-19T09:00:00Z');

  const html = await (await fetch(base + '/', { headers: { Authorization: AUTH } })).text();
  const row = rowFor(html, 'Ophir', { under: '<h4>א · ענו להודעות' });
  assert.match(row, />2<\/td>/, 'two sends counted — the pre-measurement one is excluded');
  assert.match(row, />1<\/td>/, 'one of them was answered');
  assert.match(row, />50%<\/td>/);
  assert.match(html, /לפני כן לא נשמר תיעוד/, 'the page says why the older ones are missing');
});

test('task closure reports "too early" rather than a hollow zero', async () => {
  const tasks = require('../src/domain/tasks');
  const u = await makeUser(db.pool, '+972611002002', { firstName: 'Noam' });
  await withTx(db.pool, (c) => tasks.addTask(c, u.id, { title: 'משימה טרייה' }));

  let html = await (await fetch(base + '/', { headers: { Authorization: AUTH } })).text();
  assert.match(html, /זה לא אפס — זה מוקדם מדי/,
    'a task created today cannot have failed a two-week window');

  // age one task past the window, closed in time; and one past it, never closed
  await db.pool.query(
    `INSERT INTO tasks (owner_id, title, status, created_at, completed_at)
     VALUES ($1,'נסגרה בזמן','done', now() - interval '30 days', now() - interval '25 days'),
            ($1,'נשארה פתוחה','open', now() - interval '30 days', NULL)`, [u.id]);
  html = await (await fetch(base + '/', { headers: { Authorization: AUTH } })).text();
  assert.match(html, /נסגרו תוך 14 יום/);
  assert.match(html, /50%/);
  assert.doesNotMatch(html, /זה מוקדם מדי/, 'once a cohort exists the real number is shown');
});

test('habit shows volume, active days, and flags a week of silence', async () => {
  const u = await makeUser(db.pool, '+972611002003', { firstName: 'Rivka' });
  await db.pool.query(
    `INSERT INTO quota_counters (user_id, window_kind, window_start, count)
     VALUES ($1,'day', date_trunc('day', now()), 4),
            ($1,'day', date_trunc('day', now() - interval '2 days'), 3)`, [u.id]);
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);

  const quiet = await makeUser(db.pool, '+972611002004', { firstName: 'Amit' });
  await db.pool.query(
    `UPDATE users SET last_inbound_at = now() - interval '9 days' WHERE id = $1`, [quiet.id]);

  const html = await (await fetch(base + '/', { headers: { Authorization: AUTH } })).text();
  const active = rowFor(html, 'Rivka', { under: '<h4>ד · הרגל</h4>' });
  assert.match(active, />7<\/td>/, 'four plus three messages this week');
  assert.match(active, />2 \/ 7<\/td>/, 'across two days');
  assert.doesNotMatch(active, /class="bad"/);
  assert.match(rowFor(html, 'Amit', { under: '<h4>ד · הרגל</h4>' }), /class="bad"/, 'nine days of silence is flagged');
});

test('the rollup counts proactive sends and replies, floored at measurement start', async () => {
  const u = await makeUser(db.pool, '+972611002005', { firstName: 'Lior' });
  await db.pool.query(
    `INSERT INTO audit_log (actor_id, event, retention_class, created_at)
     VALUES ($1,'message.received','routine','2026-08-18T06:00:00Z'),
            ($1,'message.received','routine','2026-08-18T12:00:00Z')`, [u.id]);
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, sent_at)
     VALUES ($1,'checkin','{}','normal','2026-08-18T10:00:00Z')`, [u.id]);

  await withTx(db.pool, (c) => metrics.rollupDay(c, '2026-08-18'));
  const { rows } = await db.pool.query(
    `SELECT metric, value FROM product_metrics_daily
      WHERE date = '2026-08-18' AND metric IN ('proactive_sent','proactive_answered')
      ORDER BY metric`);
  const byName = Object.fromEntries(rows.map((r) => [r.metric, Number(r.value)]));
  assert.ok(byName.proactive_sent >= 1);
  assert.equal(byName.proactive_answered, byName.proactive_sent,
    'the 12:00 reply answers the 10:00 send');
});

test('the rollup tells a correction from ordinary forgetting, and counts admin fixes', async () => {
  const u = await makeUser(db.pool, '+972611002006', { firstName: 'Gila' });
  const seed = (event, detail, at) => db.pool.query(
    `INSERT INTO audit_log (actor_id, event, detail, retention_class, created_at)
     VALUES ($1, $2, $3, 'routine', $4)`, [u.id, event, JSON.stringify(detail), at]);

  // fact 101: corrected two days after being saved → a correction
  await seed('fact.remembered', { factId: 101 }, '2026-08-10T10:00:00Z');
  await seed('fact.forgotten', { factId: 101 }, '2026-08-12T10:00:00Z');
  // fact 102: forgotten six weeks later → life moved on, NOT a correction
  await seed('fact.remembered', { factId: 102 }, '2026-07-01T10:00:00Z');
  await seed('fact.forgotten', { factId: 102 }, '2026-08-12T11:00:00Z');
  // preference overwritten with a different value the same week → a correction
  await seed('preference.remembered', { key: 'tone' }, '2026-08-09T10:00:00Z');
  await seed('preference.remembered', { key: 'tone', overwrote: true }, '2026-08-12T12:00:00Z');
  // idempotent re-save of the same value → not one
  await seed('preference.remembered', { key: 'lang' }, '2026-08-09T11:00:00Z');
  await seed('preference.remembered', { key: 'lang', overwrote: false }, '2026-08-12T13:00:00Z');
  // rows that predate the 'overwrote' flag fall back to pair-detection alone
  await seed('preference.remembered', { key: 'legacy' }, '2026-08-08T10:00:00Z');
  await seed('preference.remembered', { key: 'legacy' }, '2026-08-12T14:00:00Z');
  // an operator stepping in is a correction whatever it touched
  await seed('admin.outbox.cancelled', { outboxId: 9 }, '2026-08-12T15:00:00Z');
  await seed('admin.fact.deleted', { factId: 101 }, '2026-08-12T16:00:00Z');
  await seed('admin.meeting.slot_corrected', { meetingId: 3 }, '2026-08-12T17:00:00Z');

  await withTx(db.pool, (c) => metrics.rollupDay(c, '2026-08-12'));
  const { rows } = await db.pool.query(
    `SELECT metric, value FROM product_metrics_daily WHERE date = '2026-08-12'`);
  const m = Object.fromEntries(rows.map((r) => [r.metric, Number(r.value)]));
  assert.equal(m.facts_corrected, 1, 'the six-week-old forget is not a correction');
  assert.equal(m.preferences_corrected, 2, 'the flagged overwrite and the legacy pair; not the re-save');
  assert.equal(m.admin_corrections, 3);
  assert.equal(m.facts_remembered, 0, 'nothing was remembered ON the 12th');
  assert.equal(m.preferences_remembered, 3, 'the denominator counts every write that day');

  await withTx(db.pool, (c) => metrics.rollupDay(c, '2026-08-10'));
  const denom = await db.pool.query(
    `SELECT value FROM product_metrics_daily WHERE date = '2026-08-10' AND metric = 'facts_remembered'`);
  assert.equal(Number(denom.rows[0].value), 1);
});

test('the corrections row states each number with its denominator, per person', async () => {
  const facts = require('../src/domain/facts');
  const prefsD = require('../src/domain/preferences');
  const u = await makeUser(db.pool, '+972611002007', { firstName: 'Tamar' });
  await withTx(db.pool, async (c) => {
    const kept = await facts.rememberFact(c, u.id, { category: 'work', fact: 'עובדת בבנק' });
    assert.equal(kept.ok, true);
    const wrong = await facts.rememberFact(c, u.id, { category: 'family', fact: 'בת בשם נגה' });
    await facts.forgetFact(c, u.id, wrong.data.fact.id); // corrected on the spot
    await prefsD.remember(c, u.id, 'tone', 'ארוך');
    await prefsD.remember(c, u.id, 'tone', 'קצר');       // changed her mind
  });
  await db.pool.query(
    `INSERT INTO audit_log (actor_id, event, retention_class)
     VALUES ($1, 'admin.outbox.cancelled', 'routine')`, [u.id]);

  const html = await (await fetch(base + '/', { headers: { Authorization: AUTH } })).text();
  const row = rowFor(html, 'Tamar', { under: '<h4>ג · תיקונים</h4>' });
  assert.equal((row.match(/1 מתוך 2/g) || []).length, 2,
    'one of two facts AND one of two preference writes were corrected — both with denominators');
  assert.match(row, /<td class="num">1<\/td>/, 'the admin fix is counted for her');
  assert.match(html, /תיקון הוא תיקון/, 'the section explains itself in plain Hebrew');
  assert.doesNotMatch(sectionOf(html, 'outcomes'), /אין מה לתקן/,
    'once something was learned the empty-state line is gone');
});

// ---- the address book -------------------------------------------------------
// Operator-only view over every user's saved contacts, grouped by phone. The
// thing worth asserting is that grouping: one number, every name given to it,
// and whether that number is already a user of ours.

test('the address book groups a number under every name given to it, and flags our own users', async () => {
  const contacts = require('../src/domain/contacts');
  const owner1 = await makeUser(db.pool, '+972611000090', { firstName: 'Owner One' });
  const owner2 = await makeUser(db.pool, '+972611000091', { firstName: 'Owner Two' });
  // A number two different people saved under two different names — and that
  // number belongs to a THIRD person who is themselves a user here.
  const alsoAUser = await makeUser(db.pool, '+972611000092', { firstName: 'Rivka' });
  await withTx(db.pool, (c) => contacts.saveContact(c, owner1.id, {
    name: 'אמא', phone: alsoAUser.phone, source: 'user_stated' }));
  await withTx(db.pool, (c) => contacts.saveContact(c, owner2.id, {
    name: 'רבקה כהן', phone: alsoAUser.phone, source: 'contact_card' }));
  // ...and a number nobody here owns.
  await withTx(db.pool, (c) => contacts.saveContact(c, owner1.id, {
    name: 'מוסך', phone: '+972611000093', source: 'user_stated' }));

  const html = await (await fetch(base + '/contacts', { headers: { Authorization: AUTH } })).text();
  assert.match(html, /אמא/);
  assert.match(html, /רבקה כהן/, 'both names for the same number appear together');
  assert.match(html, /Owner One/, 'the operator can see who saved it');
  assert.match(html, /Owner Two/);
  assert.match(html, new RegExp(`/user\\?id=${alsoAUser.id}`), 'a contact who is also a user links to them');
  assert.match(html, /מוסך/);

  // The summary section on the main page counts the same data.
  const home = await (await fetch(base + '/', { headers: { Authorization: AUTH } })).text();
  assert.match(home, /ספר הכתובות/);
  assert.match(home, /מוכרים ליותר ממשתמש אחד/);
});

test('the address book searches by name and by digits, and can show only our users', async () => {
  const byName = await (await fetch(base + '/contacts?q=' + encodeURIComponent('מוסך'),
    { headers: { Authorization: AUTH } })).text();
  assert.match(byName, /מוסך/);
  assert.ok(!byName.includes('רבקה כהן'), 'a search excludes what it does not match');

  const byDigits = await (await fetch(base + '/contacts?q=1000092', { headers: { Authorization: AUTH } })).text();
  assert.match(byDigits, /רבקה כהן/, 'a partial number finds the person');

  const onlyOurs = await (await fetch(base + '/contacts?only=olma', { headers: { Authorization: AUTH } })).text();
  assert.match(onlyOurs, /רבקה כהן/);
  assert.ok(!onlyOurs.includes('מוסך'), 'a contact who is not a user is filtered out');
});

test('the address book is behind the admin password like the rest of the dashboard', async () => {
  const res = await fetch(base + '/contacts');
  assert.equal(res.status, 401, 'one user\'s private contacts must never be public');
});

// ---- someone who asked to stop ---------------------------------------------

test('the user page says they asked to stop, and the button brings them back', async () => {
  const pause = require('../src/domain/pause');
  const u = await makeUser(db.pool, '+972611000099', { firstName: 'קפיש' });
  await withTx(db.pool, (c) => pause.pauseUser(c, u.id, { note: 'זהו' }));

  const page = await (await fetch(`${base}/user?id=${u.id}`, { headers: { Authorization: AUTH } })).text();
  assert.match(page, /ביקש להפסיק/, 'an operator reading queued-message counts must know they are off');
  assert.match(page, /שום דבר לא נמחק/);
  assert.match(page, /\/users\/resume/);

  const csrf = 'test-csrf-resume';
  const res = await fetch(base + '/users/resume', {
    method: 'POST', redirect: 'manual',
    headers: { Authorization: AUTH, Cookie: `csrf=${csrf}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `user_id=${u.id}&back=/user?id=${u.id}&csrf=${csrf}`,
  });
  assert.equal(res.status, 303);
  const { rows } = await db.pool.query('SELECT paused_at FROM users WHERE id = $1', [u.id]);
  assert.equal(rows[0].paused_at, null);

  const { rows: trail } = await db.pool.query(
    `SELECT event FROM audit_log WHERE actor_id = $1 AND event = 'admin.user_resumed'`, [u.id]);
  assert.equal(trail.length, 1, 'an operator bringing someone back leaves a trail');
});

test('the dashboard offers no way to pause someone on their behalf', async () => {
  const u = await makeUser(db.pool, '+972611000098', { firstName: 'לא אני' });
  const csrf = 'test-csrf-nopause';
  await fetch(base + '/users/pause', {
    method: 'POST', redirect: 'manual',
    headers: { Authorization: AUTH, Cookie: `csrf=${csrf}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `user_id=${u.id}&csrf=${csrf}`,
  });
  const { rows } = await db.pool.query('SELECT paused_at FROM users WHERE id = $1', [u.id]);
  assert.equal(rows[0].paused_at, null, 'pausing is the person\'s own decision, not an admin button');
});
