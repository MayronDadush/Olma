'use strict';
// "What is Olma about to say to this person" is decided in three separate
// places, and the admin page used to show them as three separate tables: the
// outbox queue, the reminders nobody has queued yet, and a standing line
// saying which hour the daily digest fires at. The owner opened a real user's
// page on 2026-09-10, read "אין כרגע הודעה בתור", three reminders and
// "כל יום ב-10:00", and had to merge them in his head to answer the only
// question the page exists for — what arrives next, and when.
//
// One ordered list now. These tests hold open the three things that are easy
// to lose while merging: every source reaches the list, a rung mid-ladder is
// IN it (it is still going to reach them) with no invented hour, and the daily
// digest resolves to a real next moment instead of a standing setting.
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { renderPlannedForUser } = require('../src/adapters/http/admin/sections/planned');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// The row user-page.js itself hands the renderer, fetched the same way.
async function userRow(id) {
  const { rows } = await db.pool.query(
    `SELECT u.*, e.plan FROM users u LEFT JOIN entitlements e ON e.user_id = u.id WHERE u.id = $1`, [id]);
  return rows[0];
}
const render = (u, now) => withTx(db.pool, (c) => renderPlannedForUser(c, u, 'csrf', now));

// Cells in document order, per row of the "next" table.
function tableRows(html) {
  const table = html.slice(html.indexOf('<th>ההודעה</th>'));
  const end = table.indexOf('</table>');
  return [...table.slice(0, end).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]))
    .filter((cells) => cells.length);
}

test('the queue, the reminders and the digest are one list, in the order they arrive', async () => {
  const tasks = require('../src/domain/tasks');
  const reminders = require('../src/domain/reminders');
  const { enqueue } = require('../src/outbox/enqueue');

  const p = await makeUser(db.pool, '+972618000901', { firstName: 'נועם', timezone: 'Asia/Jerusalem' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, digest_times = '08:00', onboarded_at = now() WHERE id = $1`,
    [p.id]);

  // A fixed "now" so the digest lands on a known side of 08:00 and the
  // ordering below is not a property of the hour the suite happens to run at.
  const now = new Date('2026-09-11T06:00:00Z'); // 09:00 Jerusalem — today's digest has passed
  await withTx(db.pool, async (c) => {
    await enqueue(c, {
      userId: p.id, kind: 'checkin', payload: { rung: 'deadline_risk' },
      idempotencyKey: 'pn-1', releaseAfter: new Date('2026-09-11T07:00:00Z'),
    });
    const t = (await tasks.addTask(c, p.id, { title: 'לקחת את הרכב לטסט' })).data.task;
    await reminders.setReminder(c, p.id, t.id, '2026-09-11T09:00:00Z', null);
  });

  const rows = tableRows(await render(await userRow(p.id), now));
  const when = rows.map((r) => r[2].replace(/<[^>]+>/g, '').trim());
  const what = rows.map((r) => r[0].replace(/<[^>]+>/g, '').trim());

  assert.deepEqual(what, ['דדליין מתקרב', 'לקחת את הרכב לטסט', 'סיכום יומי'],
    'all three sources, ordered by when they land');
  // 10:00, 12:00 and tomorrow 08:00, all Jerusalem — the person's clock, and
  // the digest resolved to a real moment rather than a standing setting.
  assert.deepEqual(when, ['11/09 10:00', '11/09 12:00', '12/09 08:00']);
  assert.match(rows[1][1], /תזכורת/, 'the second column says what it is tied to');
  assert.match(rows[2][1], /כל יום ב-08:00/, 'and the digest still states its standing hour');
});

test('a reminder already climbing is in the list, and its hour is not invented', async () => {
  // The documented fault: "what is still going to reach them" is a third
  // question, and `attempts = 0` answers it wrongly — a mid-ladder reminder
  // has two messages left to send and was invisible in every reader. Its next
  // rung is due a gap after the PREVIOUS one was delivered, so the one thing
  // this row must not carry is a time.
  const tasks = require('../src/domain/tasks');
  const reminders = require('../src/domain/reminders');
  const p = await makeUser(db.pool, '+972618000902', { firstName: 'ורד', timezone: 'Asia/Jerusalem' });

  await withTx(db.pool, async (c) => {
    const t = (await tasks.addTask(c, p.id, { title: 'להתקשר למוסך' })).data.task;
    const r = (await reminders.setReminder(c, p.id, t.id, '2026-09-11T09:00:00Z', null)).data.reminder;
    await c.query(`UPDATE task_reminders SET attempts = 1 WHERE id = $1`, [r.id]);
  });

  const rows = tableRows(await render(await userRow(p.id), new Date('2026-09-11T10:00:00Z')));
  const row = rows.find((r) => r[0].includes('להתקשר למוסך'));
  assert.ok(row, 'a reminder mid-ladder still has messages to send and belongs on the list');
  assert.match(row[1], /רדיפה, שלב 2/, 'and says which rung is next');
  assert.doesNotMatch(row[2], /\d\d:\d\d/, 'no hour: the next rung is due off the last DELIVERY');
});

test('nothing is cut in silence, and a paused person is promised no digest', async () => {
  const tasks = require('../src/domain/tasks');
  const reminders = require('../src/domain/reminders');
  const p = await makeUser(db.pool, '+972618000903', { firstName: 'גלי', timezone: 'Asia/Jerusalem' });
  await db.pool.query(`UPDATE users SET digest_times = '08:00', onboarded_at = now() WHERE id = $1`, [p.id]);

  await withTx(db.pool, async (c) => {
    for (let i = 0; i < 12; i++) {
      const t = (await tasks.addTask(c, p.id, { title: `משימה ${i}` })).data.task;
      await reminders.setReminder(c, p.id, t.id,
        new Date(Date.UTC(2026, 8, 12 + i, 9, 0)).toISOString(), null);
    }
  });

  const now = new Date('2026-09-11T06:00:00Z');
  const html = await render(await userRow(p.id), now);
  assert.equal(tableRows(html).length, 10, 'ten, as the heading promises');
  assert.match(html, /ועוד 3 מתוכננות אחריהן/, 'the cut says so — 12 reminders plus the digest');

  // sweepDigests never visits a paused person, so the page must not print an
  // hour for a digest that is not coming.
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [p.id]);
  const paused = await render(await userRow(p.id), now);
  assert.doesNotMatch(paused, /כל יום ב-08:00/);
});
