'use strict';
// Miron, 2026-09-12: "שלח לי תזכורת להעיר את מאיה בעוד 5 דק'" (send me a
// reminder to wake Maya in 5 min). The model built the ISO instant off the
// UTC hour (13:41, the real UTC clock at the time) with his LOCAL offset
// tacked on unconverted (+03:00 — Asia/Nicosia, same as Jerusalem that day),
// instead of converting to his actual local hour (16:41). That is an
// instant three hours in the past the moment it is written.
//
// `add_task`'s first call surfaced this correctly, in a roundabout way: the
// task was saved but no reminder was armed, and the model told him so ("5
// minutes have already passed"). His second try went through `edit_task`,
// which had NO past-moment guard on due_at at all — unlike set_task_reminder,
// which has refused a past remind_at since Vered's evening (CLAUDE.md, "An
// explicit reminder replaces the automatic one only on the SAME local day").
// The bad due_at saved silently, autoReminderAt declined to arm anything for
// a moment already gone (src/domain/auto-reminder.js, `due.getTime() <=
// nowMs`), and Olma told him "עדכנתי. ב-16:41 אשלח לך תזכורת" over a task
// that could never remind him of anything. Confirmed on the box: task #690,
// due_at stored as 2026-09-12T10:41:00Z (=13:41 local, not 16:41), zero rows
// in task_reminders.
//
// Fix: the same tool-boundary refusal set_task_reminder already had (moved
// into _shared.pastMoment so every date-taking tool tool can share it) now
// also guards add_task's due_at/remind_at, edit_task's due_at and
// snooze_task's new_due_at.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { BY_NAME } = require('../src/adapters/mcp/registry');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const TZ = 'Asia/Nicosia';
let seq = 400;
async function freshUser() {
  seq += 1;
  return makeUser(db.pool, `+9573000${seq}`, { timezone: TZ });
}

// Real, correctly-converted ISO instants at the fixed +03:00 offset (Asia/
// Nicosia that day): shift the UTC instant by the offset BEFORE reading its
// clock digits, then label those digits with the offset — the step Miron's
// bug skipped.
const OFFSET_MS = 3 * 3600_000;
const isoLocal = (deltaMs) => new Date(Date.now() + deltaMs + OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, '+03:00');
const gone = () => isoLocal(-3 * 3600_000);
const soon = () => isoLocal(5 * 60_000);

test('add_task refuses a due_at built off the wrong clock, and saves nothing', async () => {
  const u = await freshUser();
  const add = BY_NAME.get('add_task');
  const res = await withTx(db.pool, (c) => add.handler(c, u, { title: 'להעיר את מאיה', due_at: gone() }));
  assert.equal(res.ok, false, 'a due_at three hours gone was accepted');
  assert.equal(res.error.reason, 'due_at_in_past');
  assert.match(res.error.message, /NOTHING was changed/);

  const list = await withTx(db.pool, (c) => BY_NAME.get('list_my_tasks').handler(c, u, {}));
  assert.equal(list.data.tasks.length, 0, 'the refused call still saved a task');
});

test('add_task refuses a remind_at built off the wrong clock, same as set_task_reminder always has', async () => {
  const u = await freshUser();
  const add = BY_NAME.get('add_task');
  const res = await withTx(db.pool, (c) => add.handler(c, u, { title: 'להעיר את מאיה', remind_at: gone() }));
  assert.equal(res.ok, false, 'a remind_at three hours gone was accepted');
  assert.equal(res.error.reason, 'remind_at_in_past');
});

test('edit_task refuses a due_at already gone instead of silently arming nothing — Miron\'s exact path', async () => {
  const u = await freshUser();
  const add = BY_NAME.get('add_task');
  const edit = BY_NAME.get('edit_task');
  const created = await withTx(db.pool, (c) => add.handler(c, u, { title: 'להעיר את מאיה' }));
  assert.equal(created.ok, true, JSON.stringify(created.error || {}));

  const res = await withTx(db.pool, (c) => edit.handler(c, u, { task_id: created.data.task.id, due_at: gone() }));
  assert.equal(res.ok, false, 'edit_task accepted a due_at already three hours gone');
  assert.equal(res.error.reason, 'due_at_in_past');
  assert.match(res.error.message, /NOTHING was changed/);

  const list = await withTx(db.pool, (c) => BY_NAME.get('list_my_tasks').handler(c, u, {}));
  const row = list.data.tasks.find((t) => Number(t.id) === Number(created.data.task.id));
  assert.equal(row.due_at, null, 'the refused edit still changed the due date');
});

test('edit_task still saves a real due_at, and arms the automatic reminder for it', async () => {
  const u = await freshUser();
  const add = BY_NAME.get('add_task');
  const edit = BY_NAME.get('edit_task');
  const created = await withTx(db.pool, (c) => add.handler(c, u, { title: 'להעיר את מאיה' }));

  // Two hours out, not five minutes: auto-reminder.js arms an HOUR before
  // due, so a due_at only 5 minutes out computes into the past on its own —
  // correct, unrelated behaviour this test is not the place to re-assert.
  const res = await withTx(db.pool, (c) => edit.handler(c, u, { task_id: created.data.task.id, due_at: isoLocal(2 * 3600_000) }));
  assert.equal(res.ok, true, JSON.stringify(res.error || {}));

  const list = await withTx(db.pool, (c) => BY_NAME.get('list_my_tasks').handler(c, u, {}));
  const row = list.data.tasks.find((t) => Number(t.id) === Number(created.data.task.id));
  assert.ok(row.reminders && row.reminders.length, 'a real two-hours-out due_at should have armed the automatic reminder');
});

test('snooze_task refuses moving a task to a moment already gone', async () => {
  const u = await freshUser();
  const add = BY_NAME.get('add_task');
  const snooze = BY_NAME.get('snooze_task');
  const created = await withTx(db.pool, (c) => add.handler(c, u, { title: 'להעיר את מאיה', due_at: soon() }));

  const res = await withTx(db.pool, (c) => snooze.handler(c, u, { task_id: created.data.task.id, new_due_at: gone() }));
  assert.equal(res.ok, false, 'snooze_task moved a task onto a moment already gone');
  assert.equal(res.error.reason, 'new_due_at_in_past');
});
