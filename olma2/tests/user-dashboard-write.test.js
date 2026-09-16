'use strict';
// The dashboard's write half. Two things are being pinned here more than the
// happy paths: that an imported task cannot be quietly edited into a lie, and
// that a paused account cannot be given a reminder the delivery gate will drop.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const write = require('../src/domain/user-dashboard-write');
const dash = require('../src/domain/user-dashboard');
const tasks = require('../src/domain/tasks');

let db, me;
const tx = (fn) => withTx(db.pool, fn);
const act = (action, payload) => tx((c) => write.perform(c, me.id, action, payload));
const iso = (ms) => new Date(Date.now() + ms).toISOString().replace(/\.\d+Z$/, '+00:00');

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531920001', { firstName: 'Miron' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
});
after(async () => { if (db) await db.teardown(); });

// A title per call: one person cannot hold the same task open twice
// (domain/tasks.js, "The same thing, saved twice"), and every test below wants
// its own row rather than a shared one.
let mkTaskN = 0;
const mkTask = async (extra = {}) => {
  const r = await tx((c) => tasks.addTask(c, me.id, { title: `לקנות חלב ${++mkTaskN}`, ...extra }));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  return r.data.task;
};

test('an unknown action is refused before anything runs', async () => {
  for (const bad of ['drop', 'constructor', '__proto__', 'toString', '']) {
    const r = await act(bad, {});
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
    assert.equal(r.error.code, 'invalid');
  }
});

test('a task written here is marked as written here', async () => {
  const r = await act('addTask', { title: 'להזמין צמיגים' });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  assert.equal(r.data.task.source, 'dashboard',
    'a row typed on the page is indistinguishable from one said in chat');
});

test('an edit changes only what it names', async () => {
  const t = await mkTask({ category: 'home', dueAt: iso(86400e3) });
  const r = await act('editTask', { taskId: t.id, title: 'לקנות לחם' });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  assert.equal(r.data.task.title, 'לקנות לחם');
  assert.equal(r.data.task.category, 'home', 'an untouched field was cleared');
  assert.notEqual(r.data.task.due_at, null, 'the due date was wiped by a rename');
});

test('null clears a field and undefined leaves it — the difference is the point', async () => {
  const t = await mkTask({ category: 'home', dueAt: iso(86400e3) });
  const r = await act('editTask', { taskId: t.id, dueAt: null });
  assert.equal(r.ok, true);
  assert.equal(r.data.task.due_at, null);
  assert.equal(r.data.task.category, 'home');
});

test('a bare local time is refused here exactly as it is in add_task', async () => {
  const t = await mkTask();
  const r = await act('editTask', { taskId: t.id, dueAt: '2026-09-20T15:00:00' });
  assert.equal(r.ok, false, 'a time with no offset was accepted');
});

test('a title cannot be emptied, and another person\'s task cannot be touched', async () => {
  const t = await mkTask();
  assert.equal((await act('editTask', { taskId: t.id, title: '   ' })).ok, false);
  const other = await makeUser(db.pool, '+972531920002');
  const theirs = await tx((c) => tasks.addTask(c, other.id, { title: 'שלהם' }));
  const r = await act('editTask', { taskId: theirs.data.task.id, title: 'שלי עכשיו' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found', 'ownership leaked through the error');
});

test('a field the source does not have is refused as unsupported', async () => {
  // Slack carries a date and who it involves, and nothing else this page edits.
  const t = await mkTask({ source: 'slack' });
  const r = await act('editTask', { taskId: t.id, category: 'work' });
  assert.equal(r.ok, false);
  assert.equal(r.error.reason, 'unsupported_by_source');
  assert.equal(r.error.source, 'slack');
});

test('a field the source DOES have is still refused, and says why', async () => {
  const t = await mkTask({ source: 'monday' });
  const r = await act('editTask', { taskId: t.id, dueAt: iso(86400e3) });
  assert.equal(r.ok, false);
  assert.equal(r.error.reason, 'no_writeback',
    'an imported field was edited locally, to be erased by the next sync');
});

test('an origin we do not model is the person\'s own writing', async () => {
  const t = await mkTask({ source: 'chat' });
  assert.equal((await act('editTask', { taskId: t.id, title: 'משהו אחר' })).ok, true);
});

test('an imported task can still be reminded about — the reminder is ours', async () => {
  const t = await mkTask({ source: 'monday' });
  const r = await act('setReminder', { taskId: t.id, remindAt: iso(3600e3) });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
});

test('a paused account is not given a reminder that would be silently dropped', async () => {
  const t = await mkTask();
  assert.equal((await act('pause', {})).ok, true);
  const r = await act('setReminder', { taskId: t.id, remindAt: iso(3600e3) });
  assert.equal(r.ok, false);
  assert.equal(r.error.reason, 'paused', 'the page has nothing to offer without a reason');
  // Cancelling always works: it only ever reduces what Olma will send.
  const live = await db.pool.query(
    `SELECT id FROM task_reminders WHERE task_id = $1 AND cancelled_at IS NULL`, [t.id]);
  if (live.rows[0]) {
    assert.equal((await act('cancelReminder', { reminderId: live.rows[0].id })).ok, true);
  }
  assert.equal((await act('resume', {})).ok, true);
  assert.equal((await act('setReminder', { taskId: t.id, remindAt: iso(3600e3) })).ok, true);
});

test('a timezone picked here is confirmed, and repairs what the guess converted', async () => {
  const u = await makeUser(db.pool, '+972531920003', { firstName: 'Sarah' });
  await db.pool.query(
    `UPDATE users SET timezone = 'Asia/Jerusalem', timezone_confirmed = false WHERE id = $1`, [u.id]);
  const t = await tx((c) => tasks.addTask(c, u.id, { title: 'brunch', dueAt: iso(4 * 86400e3) }));
  const r = await tx((c) => write.perform(c, u.id, 'setTimezone', { timezone: 'America/Los_Angeles' }));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  assert.equal(r.data.confirmed, true, 'a person picking their own city is not a guess');
  assert.equal(r.data.movedTasks.length >= 1, true,
    'the zone was corrected and the rows it had already converted were left wrong');
  assert.equal(String(r.data.movedTasks[0].id ?? r.data.movedTasks[0]), String(t.data.task.id));
});

test('every write leaves a trail saying it came from the dashboard', async () => {
  const t = await mkTask();
  await act('completeTask', { taskId: t.id });
  const { rows } = await db.pool.query(
    `SELECT event FROM audit_log WHERE actor_id = $1 AND event = 'dashboard.completeTask'`, [me.id]);
  assert.equal(rows.length >= 1, true,
    'an operator cannot tell a person tapping their phone from their agent acting for them');
});

test('the payload can never name the actor', async () => {
  const other = await makeUser(db.pool, '+972531920004');
  const r = await act('addTask', { title: 'שלהם', userId: other.id, ownerId: other.id });
  assert.equal(r.ok, true);
  assert.equal(String(r.data.task.owner_id), String(me.id),
    'a user id in the payload moved the write to another account');
});

test('the read model sees what the write model just did', async () => {
  const r = await act('addTask', { title: 'לבדוק מהדף' });
  const page = await tx((c) => dash.load(c, me.id));
  assert.equal(page.ok, true);
  assert.equal(page.data.tasks.some((x) => String(x.id) === String(r.data.task.id)), true);
});

// ---------------------------------------------------------------------------
// The switches the sheet draws. Each of these was a control that moved on
// screen and wrote nothing, which is the failure mode this file exists to
// catch: a page that looks like it works.

test('the reminder switch replaces rather than accumulates', async () => {
  const t = await mkTask({ dueAt: iso(3 * 86400e3) });
  const first = await act('setTaskReminder', { taskId: t.id, on: true, remindAt: iso(2 * 86400e3) });
  assert.equal(first.ok, true, first.ok ? '' : JSON.stringify(first.error));
  const second = await act('setTaskReminder', { taskId: t.id, on: true, remindAt: iso(86400e3) });
  assert.equal(second.ok, true, second.ok ? '' : JSON.stringify(second.error));
  const { rows } = await db.pool.query(
    `SELECT id FROM task_reminders WHERE task_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL`,
    [t.id]);
  assert.equal(rows.length, 1,
    'flipping one switch twice left two pending reminders, so the person is told twice');
  assert.equal(String(rows[0].id), String(second.data.reminder.id));
});

test('turning the reminder off cancels it', async () => {
  const t = await mkTask({ dueAt: iso(3 * 86400e3) });
  assert.equal((await act('setTaskReminder', { taskId: t.id, on: true, remindAt: iso(86400e3) })).ok, true);
  const off = await act('setTaskReminder', { taskId: t.id, on: false });
  assert.equal(off.ok, true, off.ok ? '' : JSON.stringify(off.error));
  assert.equal(off.data.cancelled, 1);
  const { rows } = await db.pool.query(
    `SELECT id FROM task_reminders WHERE task_id = $1 AND cancelled_at IS NULL AND sent_at IS NULL`,
    [t.id]);
  assert.equal(rows.length, 0);
});

// Pausing already cancels every pending reminder (domain/pause.js), so there
// is normally nothing left for this to cancel. What is being pinned is that it
// is not REFUSED: the switch has to be able to come back down, and the only
// direction a paused person is ever blocked in is the one that adds a send.
test('the reminder switch can always be turned off, paused or not', async () => {
  const t = await mkTask({ dueAt: iso(3 * 86400e3) });
  assert.equal((await act('setTaskReminder', { taskId: t.id, on: true, remindAt: iso(86400e3) })).ok, true);
  assert.equal((await act('pause', {})).ok, true);
  const off = await act('setTaskReminder', { taskId: t.id, on: false });
  assert.equal(off.ok, true, 'a paused person could not switch a reminder OFF');
  assert.equal((await act('resume', {})).ok, true);
});

test('a repeat rule reaches the row in the vocabulary the sweep reads', async () => {
  const t = await mkTask({ dueAt: iso(3 * 86400e3) });
  const r = await act('setTaskReminder',
    { taskId: t.id, on: true, remindAt: iso(86400e3), repeatRule: 'weekly' });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  assert.equal(r.data.reminder.repeat_rule, 'weekly',
    'the sweep compares against canonical rules and would never fire this again');
});

test('a reminder cannot be set on a paused account, and says why', async () => {
  const t = await mkTask({ dueAt: iso(3 * 86400e3) });
  assert.equal((await act('pause', {})).ok, true);
  const r = await act('setTaskReminder', { taskId: t.id, on: true, remindAt: iso(86400e3) });
  assert.equal(r.ok, false);
  assert.equal(r.error.reason, 'paused');
  assert.equal((await act('resume', {})).ok, true);
});

test('the reminder switch refuses a task that is finished or gone', async () => {
  const t = await mkTask({ dueAt: iso(3 * 86400e3) });
  assert.equal((await act('completeTask', { taskId: t.id })).ok, true);
  const r = await act('setTaskReminder', { taskId: t.id, on: true, remindAt: iso(86400e3) });
  assert.equal(r.ok, false);
  const gone = await act('setTaskReminder', { taskId: 9_000_001, on: true, remindAt: iso(86400e3) });
  assert.equal(gone.ok, false);
  assert.equal(gone.error.code, 'not_found');
});

test('restoring brings a task back out of the archive', async () => {
  const t = await mkTask();
  assert.equal((await act('archiveTask', { taskId: t.id })).ok, true);
  let page = await tx((c) => dash.load(c, me.id));
  assert.equal(page.data.archived.some((x) => String(x.id) === String(t.id)), true);
  const r = await act('restoreTask', { taskId: t.id });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  page = await tx((c) => dash.load(c, me.id));
  assert.equal(page.data.tasks.some((x) => String(x.id) === String(t.id)), true,
    'the archive was a one-way door');
  assert.equal((await act('restoreTask', { taskId: t.id })).ok, false,
    'restoring an unarchived task should not silently succeed');
});

test('the calendar switch refuses when there is no calendar to write to', async () => {
  const t = await mkTask({ dueAt: iso(3 * 86400e3) });
  const r = await act('setTaskCalendar', { taskId: t.id, on: true });
  assert.equal(r.ok, false, 'a lit switch with nowhere to write is the worst outcome');
  assert.equal(r.error.reason, 'not_connected');
  const { rows } = await db.pool.query(`SELECT calendar_opt_in FROM tasks WHERE id = $1`, [t.id]);
  assert.equal(rows[0].calendar_opt_in, null, 'the wish was stored anyway');
});

test('turning the calendar switch off is always allowed, and is per task', async () => {
  const t = await mkTask({ dueAt: iso(3 * 86400e3) });
  const r = await act('setTaskCalendar', { taskId: t.id, on: false });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  const { rows } = await db.pool.query(`SELECT calendar_opt_in FROM tasks WHERE id = $1`, [t.id]);
  assert.equal(rows[0].calendar_opt_in, false);
  // and the standing switch does not override it
  await db.pool.query(`UPDATE users SET calendar_sync_tasks = true WHERE id = $1`, [me.id]);
  const page = await tx((c) => dash.load(c, me.id));
  const row = page.data.tasks.find((x) => String(x.id) === String(t.id));
  assert.equal(row.calendar, false,
    'one task turned off came back on because the standing switch won');
  await db.pool.query(`UPDATE users SET calendar_sync_tasks = false WHERE id = $1`, [me.id]);
});

test('a task that says nothing follows the standing switch', async () => {
  const t = await mkTask({ dueAt: iso(3 * 86400e3) });
  await db.pool.query(`UPDATE users SET calendar_sync_tasks = true WHERE id = $1`, [me.id]);
  let page = await tx((c) => dash.load(c, me.id));
  assert.equal(page.data.tasks.find((x) => String(x.id) === String(t.id)).calendar, true);
  await db.pool.query(`UPDATE users SET calendar_sync_tasks = false WHERE id = $1`, [me.id]);
  page = await tx((c) => dash.load(c, me.id));
  assert.equal(page.data.tasks.find((x) => String(x.id) === String(t.id)).calendar, false);
});

test('the page is told which channels actually exist', async () => {
  const page = await tx((c) => dash.load(c, me.id));
  assert.equal(Array.isArray(page.data.channels), true);
  assert.equal(page.data.channels.length >= 1, true, 'a person with no channel cannot be reached');
  assert.equal(page.data.channels[0].type, 'whatsapp');
  assert.equal(page.data.channels[0].primary, true);
  assert.equal(Object.hasOwn(page.data.channels[0], 'channel_identifier'), false,
    'a phone number in a browser payload is a phone number published');
});

test('a pending reminder travels with the id needed to cancel it', async () => {
  const t = await mkTask({ dueAt: iso(3 * 86400e3) });
  const set = await act('setTaskReminder', { taskId: t.id, on: true, remindAt: iso(86400e3) });
  const page = await tx((c) => dash.load(c, me.id));
  const row = page.data.tasks.find((x) => String(x.id) === String(t.id));
  assert.equal(String(row.reminder.id), String(set.data.reminder.id));
});

// ---------------------------------------------------------------------------
// The address book, and the one button that acts on it.

test('the address book arrives, and drops anyone already connected or asked', async () => {
  const friend = await makeUser(db.pool, '+972531920011', { firstName: 'Gali' });
  await db.pool.query(
    `INSERT INTO user_contacts (user_id, display_name, phone, source)
     VALUES ($1,'גלי','+972531920011','card'), ($1,'יעל','+972531920012','card'),
            ($1,'אלון','+972531920013','card')`, [me.id]);
  await db.pool.query(
    `INSERT INTO connections (requester_id, target_id, target_phone, status, responded_at)
     VALUES ($1, $2, '+972531920011', 'active', now())`, [me.id, friend.id]);
  await db.pool.query(
    `INSERT INTO connections (requester_id, target_phone, status)
     VALUES ($1, '+972531920012', 'invited')`, [me.id]);

  const page = await tx((c) => dash.load(c, me.id));
  const names = page.data.contacts.map((x) => x.name);
  assert.equal(names.includes('גלי'), false, 'offered to invite somebody already connected');
  assert.equal(names.includes('יעל'), false, 'offered to ask again somebody still deciding');
  assert.equal(names.includes('אלון'), true);
  assert.equal(page.data.contacts.find((x) => x.name === 'אלון').phone, '+972531920013',
    'their own address book without the numbers is an invite button that cannot work');
});

test('an invite goes out by contact id, and the other side is actually told', async () => {
  const c = await db.pool.query(
    `SELECT id FROM user_contacts WHERE user_id = $1 AND display_name = 'אלון'`, [me.id]);
  const r = await act('inviteContact', { contactId: c.rows[0].id });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  const { rows } = await db.pool.query(
    `SELECT o.kind FROM outbox o WHERE o.kind IN ('connection_request','connection_intro')`);
  assert.equal(rows.length >= 1, true,
    'the row was written and nobody was ever asked — the request would sit there for ever');
});

test('a contact that is not theirs cannot be invited', async () => {
  const other = await makeUser(db.pool, '+972531920014');
  const c = await db.pool.query(
    `INSERT INTO user_contacts (user_id, display_name, phone, source)
     VALUES ($1,'זר','+972531920015','card') RETURNING id`, [other.id]);
  const r = await act('inviteContact', { contactId: c.rows[0].id });
  assert.equal(r.ok, false, 'a session could invite anybody at all by guessing an id');
  assert.equal(r.error.code, 'not_found');
});

test('a phone number in the payload is ignored', async () => {
  const r = await act('inviteContact', { contactId: 9_000_003, phone: '+972500000000', targetPhone: '+972500000000' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

// The page branches on `error.reason` and reloads in silence for anything it
// does not recognise, so a duplicate without one would look to the person like
// the row simply failing to appear. `toast.duplicate` is the sentence it shows.
test('a task they already have is refused with a reason the page can say out loud', async () => {
  const r = await act('addTask', { title: 'להזמין צמיגים' });
  assert.equal(r.ok, false, 'the same title was added by an earlier test and is still open');
  assert.equal(r.error.code, 'conflict');
  assert.equal(r.error.reason, 'duplicate');
});

// ---- default channel -------------------------------------------------------
// The picker used to call API.call only: it toasted "ברירת המחדל היא X" and
// wrote nothing, so the choice was forgotten on the next reload. It cannot
// reach a real user today (the picker only renders with two live channels,
// and nothing in the codebase ever gives anyone a second one), but the switch
// underneath it is now real, so it is not still lying on the day it can.
test('setDefaultChannel moves is_primary, and refuses a channel this user does not have', async () => {
  await db.pool.query(
    `INSERT INTO user_channels (user_id, channel_type, channel_identifier, is_primary)
     VALUES ($1, 'imessage', 'imsg:test', FALSE)`, [me.id]);

  const refused = await act('setDefaultChannel', { channelType: 'sms' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'not_found');
  const stillWa = await db.pool.query(
    `SELECT channel_type FROM user_channels WHERE user_id = $1 AND is_primary`, [me.id]);
  assert.equal(stillWa.rows[0].channel_type, 'whatsapp', 'a refused switch moved the primary anyway');

  const r = await act('setDefaultChannel', { channelType: 'imessage' });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  const { rows } = await db.pool.query(
    `SELECT channel_type, is_primary FROM user_channels WHERE user_id = $1 ORDER BY channel_type`, [me.id]);
  assert.deepEqual(rows, [
    { channel_type: 'imessage', is_primary: true },
    { channel_type: 'whatsapp', is_primary: false },
  ]);
  assert.equal(write.CARD_ACTIONS.has('setDefaultChannel'), false,
    'USER.md never mentions the channel — nothing needs refreshing');

  // Switch back so later tests in this file keep seeing whatsapp as primary.
  await act('setDefaultChannel', { channelType: 'whatsapp' });
});

test('the page sends the real channel_type, not its own short id', () => {
  const page = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'docs', 'design', 'user-dashboard.html'), 'utf8');
  assert.match(page, /API\.send\("setDefaultChannel", \{channelType:c\.type\}/);
  assert.match(page, /\{id:"wa",[^}]*type:"whatsapp"/);
});

// ---- removing a friend -----------------------------------------------------
// The page's "remove connection" was a toast and nothing else: it told the
// person the connection was gone while every share and switch stayed live. It
// now goes through revoke_connection's own domain function, cascade included.
test('removing a friend revokes the connection and everything hanging off it', async () => {
  const connections = require('../src/domain/connections');
  const shares = require('../src/domain/shares');
  const friend = await makeUser(db.pool, '+972531920031', { firstName: 'רוני' });
  const conn = await tx(async (c) => {
    const req = await connections.requestConnection(c, me.id, friend.phone, {});
    assert.equal(req.ok, true, req.ok ? '' : JSON.stringify(req.error));
    return (await connections.respondToConnection(c, friend.id, req.data.connection.id, 'approve')).data.connection;
  });
  const task = await mkTask();
  const share = await tx(async (c) => {
    const s = (await shares.offerShare(c, me.id, task.id, friend.id, 'viewer')).data.share;
    await shares.respondToShare(c, friend.id, s.id, 'accept');
    return s;
  });

  const r = await act('revokeConnection', { connectionId: conn.id });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  const { rows: [row] } = await db.pool.query(`SELECT status FROM connections WHERE id = $1`, [conn.id]);
  assert.equal(row.status, 'revoked');
  const { rows: [sh] } = await db.pool.query(`SELECT status FROM shares WHERE id = $1`, [share.id]);
  assert.equal(sh.status, 'revoked', 'the friend is gone and can still see the task');
  const { rows: [g] } = await db.pool.query(
    `SELECT count(*)::int AS n FROM connection_feature_grants WHERE connection_id = $1`, [conn.id]);
  assert.equal(g.n, 0);
  const { rows: ev } = await db.pool.query(
    `SELECT event FROM audit_log WHERE actor_id = $1 AND event IN ('connection.revoked','dashboard.revokeConnection')`, [me.id]);
  assert.deepEqual(ev.map((e) => e.event).sort(), ['connection.revoked', 'dashboard.revokeConnection']);
  assert.ok(write.CARD_ACTIONS.has('revokeConnection'), 'USER.md lists connections and would keep this one');

  const again = await act('revokeConnection', { connectionId: conn.id });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'not_found');
});

test('a connection between two other people cannot be removed from this page', async () => {
  const connections = require('../src/domain/connections');
  const a = await makeUser(db.pool, '+972531920032');
  const b = await makeUser(db.pool, '+972531920033');
  const conn = await tx(async (c) => {
    const req = await connections.requestConnection(c, a.id, b.phone, {});
    return (await connections.respondToConnection(c, b.id, req.data.connection.id, 'approve')).data.connection;
  });
  const r = await act('revokeConnection', { connectionId: conn.id });
  assert.equal(r.ok, false, 'a session could cut anybody off by guessing an id');
  assert.equal(r.error.code, 'not_found');
  const { rows: [row] } = await db.pool.query(`SELECT status FROM connections WHERE id = $1`, [conn.id]);
  assert.equal(row.status, 'active');
  for (const bad of [undefined, null, 'x', -1, 0]) {
    assert.equal((await act('revokeConnection', { connectionId: bad })).error.code, 'invalid');
  }
});

test('the page no longer claims a removal it never sends', () => {
  const page = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'docs', 'design', 'user-dashboard.html'), 'utf8');
  // The attribute, not the word: the comment where it used to live says why it
  // is gone, and that sentence is the thing keeping it gone.
  assert.equal(/data-toast\s*[="\]]/.test(page), false,
    'the attribute that answers a click with a sentence and no write is back');
  assert.match(page, /API\.send\("revokeConnection", \{connectionId:f\.cid\}/);
});
