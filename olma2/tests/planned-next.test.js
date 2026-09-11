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

  assert.deepEqual(what, ['דדליין מתקרב', '✓ ⏰ תזכורת: *לקחת את הרכב לטסט*', 'סיכום יומי'],
    'all three sources, ordered by when they land');
  // The middle one is the point of the ✓: a reminder rides the raw pipe with
  // no model in its path, so the sentence is already decided and is what a
  // review needs to read. The checkin beside it is an instruction a model will
  // word at send time and stays a subject line, unticked.
  assert.ok(!what[0].startsWith('✓') && !what[2].startsWith('✓'),
    'only a message with no model in its path may claim to be its own text');
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

// ---- the cross-user review screen -------------------------------------------
// The owner's stated use for this page is reviewing the product: he opens it
// to check that what is planned for each person is right. That makes three
// things load-bearing that an operational queue does not need — everyone with
// anything planned is on it (including the person whose only upcoming message
// is a digest), each person's plan reads as one block so a duplicate sits
// beside its twin, and a message that goes out verbatim shows its actual text.

// `renderPlannedQueue`, not `renderPlanned`: a SECTIONS render is called with
// four positional arguments, so the clock cannot ride the outer signature.
// This is still the function production calls — renderPlanned is one line and
// dashboard.test.js renders the real page over HTTP.
const { renderPlannedQueue } = require('../src/adapters/http/admin/sections/planned');
const globalHtml = () => withTx(db.pool, (c) => renderPlannedQueue(c, new Date('2026-09-11T06:00:00Z')));

test('everyone with anything planned is on the review screen, grouped by who reads it', async () => {
  const tasks = require('../src/domain/tasks');
  const reminders = require('../src/domain/reminders');

  // Two people whose only planned message comes from DIFFERENT places: a
  // queue-driven list would show neither, and a reminders-driven one only the
  // first. Both had to be asked for separately before this was one builder.
  const a = await makeUser(db.pool, '+972618000911', { firstName: 'איתי', timezone: 'Asia/Jerusalem' });
  const b = await makeUser(db.pool, '+972618000912', { firstName: 'רותם', timezone: 'Asia/Jerusalem' });
  await db.pool.query(`UPDATE users SET digest_times = '07:00', onboarded_at = now() WHERE id = $1`, [b.id]);
  await withTx(db.pool, async (c) => {
    const t = (await tasks.addTask(c, a.id, { title: 'לשלם ארנונה' })).data.task;
    await reminders.setReminder(c, a.id, t.id, '2026-09-11T15:00:00Z', null);
  });

  const html = await globalHtml();
  assert.match(html, /איתי/, 'a person whose only plan is a reminder is on the screen');
  assert.match(html, /רותם/, 'and so is one whose only plan is a digest');
  // רותם's digest is 07:00 Jerusalem tomorrow; איתי's reminder is 18:00 today.
  assert.ok(html.indexOf('איתי') < html.indexOf('רותם'),
    'whoever hears from her first comes first');
  assert.match(html, /לשלם ארנונה/);
});

test('reminders that arrive as one message are one row, showing the list she will send', async () => {
  // Three reminders at the same moment leave as ONE WhatsApp message — the
  // worker coalesces at delivery. Showing them as three rows would misreport
  // both the count ("she is sending him three things") and the text (each row
  // would claim the single-reminder wording, which is not what arrives).
  const tasks = require('../src/domain/tasks');
  const reminders = require('../src/domain/reminders');
  const p = await makeUser(db.pool, '+972618000913', { firstName: 'דנה', timezone: 'Asia/Jerusalem' });

  await withTx(db.pool, async (c) => {
    for (const title of ['לבטל את האשראי', 'לבטל דמי מנוי', 'טופס פנסיה']) {
      const t = (await tasks.addTask(c, p.id, { title })).data.task;
      await reminders.setReminder(c, p.id, t.id, '2026-09-14T09:00:00Z', null);
    }
  });

  const rows = tableRows(await render(await userRow(p.id), new Date('2026-09-11T06:00:00Z')));
  assert.equal(rows.length, 1, 'one message, one row');
  assert.match(rows[0][1], /3 ביחד/, 'and it says how many lines are in it');
  for (const title of ['לבטל את האשראי', 'לבטל דמי מנוי', 'טופס פנסיה']) {
    assert.ok(rows[0][0].includes(title), `${title} is one of the lines`);
  }
});

test('the last rung of a ladder shows the sentence it is about to say', async () => {
  // "זו התזכורת האחרונה" went out seven times wrongly once. Its hour cannot be
  // known in advance and its words can, and the words are the half worth
  // reading before they arrive.
  const tasks = require('../src/domain/tasks');
  const reminders = require('../src/domain/reminders');
  const p = await makeUser(db.pool, '+972618000914', { firstName: 'יהב', timezone: 'Asia/Jerusalem' });

  await withTx(db.pool, async (c) => {
    const t = (await tasks.addTask(c, p.id, { title: 'להחזיר את הספר' })).data.task;
    const r = (await reminders.setReminder(c, p.id, t.id, '2026-09-11T09:00:00Z', null)).data.reminder;
    // Two rungs already sent: the next one is the last.
    await c.query(`UPDATE task_reminders SET attempts = 2 WHERE id = $1`, [r.id]);
  });

  const rows = tableRows(await render(await userRow(p.id), new Date('2026-09-11T14:00:00Z')));
  const row = rows.find((r) => r[0].includes('להחזיר את הספר'));
  assert.match(row[1], /שלב 3/);
  assert.match(row[0], /אחרונה/, 'the final-rung wording, read before it is sent');
  assert.doesNotMatch(row[2], /\d\d:\d\d/, 'and still no invented hour');
});

test('one unreadable row does not take the whole page down', async () => {
  // The founding case is a signature clash, not a bad row: SECTIONS renders
  // are called with four positional arguments, a clock was added in position
  // three, and `Intl` threw RangeError on the cached gateway object — which
  // 500'd the entire admin page, every section of it, over one user's digest.
  // The signature is fixed; this holds the blast radius closed for the next
  // way a zone or an instant turns out to be unreadable.
  const p = await makeUser(db.pool, '+972618000915', { firstName: 'עדי' });
  await db.pool.query(
    `UPDATE users SET timezone = 'Nowhere/Notazone', digest_times = '08:00', onboarded_at = now()
      WHERE id = $1`, [p.id]);

  const html = await globalHtml();
  const start = html.indexOf('עדי');
  assert.ok(start > 0, 'the person is still on the page');
  const block = html.slice(start, html.indexOf('<h4>', start + 1) + 1 || undefined);
  assert.doesNotMatch(block, /08:00/, 'with no hour claimed for a zone nobody can read');
});
