'use strict';
// Olma's COPIES of tasks on the person's Google Calendar — being taken down.
//
// Until 2026-09-30 a dated task could be copied onto the person's calendar
// (a standing switch, `users.calendar_sync_tasks`, and one per task,
// `tasks.calendar_opt_in`). The owner retired it that day (option "5ב"): a
// copy is a second entry for a thing that already has one, the person reads
// both, and the thing they told Olma about was usually ON their calendar
// already — מירון's calendar held the original and Olma's copy side by side
// (`incidents.md`, "Two of everything"). What replaced it points the other
// way: Olma hangs a reminder on the calendar's own event
// (`domain/calendar-links.js`) and writes a NEW event only for a meeting told
// to her that the calendar does not have yet.
//
// So nothing here adds an event any more. What is left is taking down the
// copies already written, which is the old remove arm on its own:
//   - a row carrying `calendar_event_id` is a copy; the sweep deletes the
//     event and clears the id;
//   - only for somebody whose calendar is connected WITH EDIT ACCESS — a
//     view-only connection cannot delete, and the old sweep failed on it every
//     tick, for ever. The id stays until edit access returns, so the copy is
//     taken down then, not lost track of;
//   - `removeEventsFor` still runs before a task is deleted for good, because
//     the id lives on the row being deleted.
//
// `eventIdFor`'s fingerprint (userId|title|instant) is still what the ids
// look like, and `windowFor`/`expectedIdFor` stay exported because the linked
// path (calendar-links) creates events the same way.
const { ok, err } = require('./results');
const calendar = require('./calendar');
const audit = require('./audit');

// Bounded per tick because each item is one or two Google calls on a 1-vCPU
// box shared with every user's replies. A backlog drains over several ticks
// rather than holding the loop.
const MAX_PER_TICK = 20;
const RETIRED = 'copying tasks onto the calendar was retired — a reminder is hung on the calendar event itself (remind_calendar_event)';
const EVENT_MINUTES = 30;

// A real end when the task has one, and thirty minutes when it does not.
//
// The fallback is the older half of this and its reasoning still holds: an
// all-day event would claim we know the task fills a day, which `due_at`
// cannot tell us — it cannot separate "the 14th" from "09:00 on the 14th" once
// it is a timestamptz. A modest honest block beats an all-day banner asserting
// something nobody said.
//
// What changed is that a task CAN now say where it stops (`tasks.ends_at`), and
// when it does, guessing thirty minutes over the top of a stated seven-hour
// shift is not modesty, it is discarding the answer.
function windowFor(dueAt, endsAt) {
  const start = new Date(dueAt);
  const stated = endsAt ? new Date(endsAt) : null;
  const end = stated && !Number.isNaN(stated.getTime()) && stated > start
    ? stated
    : new Date(start.getTime() + EVENT_MINUTES * 60_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

// The id is keyed on the START only, deliberately: moving the end of a shift
// must UPDATE the event in the person's calendar, not leave the old one
// standing and add a second.
function expectedIdFor(userId, task) {
  return calendar.eventIdFor(userId, task.title, windowFor(task.due_at, task.ends_at).start);
}

// Only OFF is left. ON is refused by name rather than silently ignored, so a
// stale page or an old tool call learns the switch is gone.
async function setSync(client, userId, on, { removeExisting = false, ...deps } = {}) {
  if (typeof on !== 'boolean') return err('invalid', 'on must be true or false');
  if (on) return err('invalid', RETIRED, { reason: 'retired' });
  await client.query(`UPDATE users SET calendar_sync_tasks = $2 WHERE id = $1`, [userId, on]);
  // Turning it off is deliberately TWO decisions, not one. Events already on
  // the calendar are entries the person has been reading all week, and
  // deleting a fortnight of them because they said "stop adding new ones" is
  // not what they asked for. So `removeExisting` is the caller's separate,
  // explicit answer — the tool asks them.
  let removed = 0;
  if (!on && removeExisting) {
    const { rows } = await client.query(
      `SELECT id, calendar_event_id FROM tasks
        WHERE owner_id = $1 AND calendar_event_id IS NOT NULL`, [userId]);
    for (const t of rows) {
      const remove = deps.deleteEvent || calendar.deleteEvent;
      const res = await remove(client, userId, { eventId: t.calendar_event_id });
      // Already gone counts as removed: the calendar is in the asked-for state.
      if (!res.ok) continue;
      await client.query(`UPDATE tasks SET calendar_event_id = NULL WHERE id = $1`, [t.id]);
      removed += 1;
    }
  }
  await audit.record(client, userId, 'task_calendar.sync_set', { on, removed });
  return ok({ on, removed });
}

// The same decision, for ONE task. This is the switch inside the task sheet,
// and it is a different question from the one setSync answers: "put this on my
// calendar" is about a row somebody is looking at, not about a policy for
// everything they will ever write down.
//
// Turning it OFF removes the event immediately, and here that is not the
// `removeExisting` dilemma setSync agonises over. There, "stop adding new
// ones" said nothing about the fortnight already on the calendar. Here they
// are looking at one task with one event, and leaving it there would make the
// switch a lie about the thing directly above it.
async function setTaskSync(client, userId, taskId, on, deps = {}) {
  if (typeof on !== 'boolean') return err('invalid', 'on must be true or false');
  const { rows } = await client.query(
    `SELECT id, due_at, calendar_event_id FROM tasks
      WHERE id = $1 AND owner_id = $2 AND parent_id IS NULL`,
    [taskId, userId]
  );
  const task = rows[0];
  if (!task) return err('not_found', 'task not found');
  if (on) return err('invalid', RETIRED, { reason: 'retired' });
  await client.query(`UPDATE tasks SET calendar_opt_in = $2 WHERE id = $1`, [taskId, on]);
  let removed = false;
  if (!on && task.calendar_event_id) {
    const remove = deps.deleteEvent || calendar.deleteEvent;
    const res = await remove(client, userId, { eventId: task.calendar_event_id });
    // Already gone counts: the calendar is in the state they asked for, and a
    // stored id pointing at nothing would make every later tick try again.
    if (res.ok || res.error.code === 'not_found') {
      await client.query(`UPDATE tasks SET calendar_event_id = NULL WHERE id = $1`, [taskId]);
      removed = true;
    }
  }
  await audit.record(client, userId, 'task_calendar.task_set', { taskId, on, removed });
  return ok({ taskId, on, removed });
}

// Before a task is deleted for good (tasks.deleteTask): its event, and any of
// its items', taken off the calendar NOW. The sweep cannot do this afterwards —
// the event id lives on the row being deleted — so a removal Google refuses
// fails the delete rather than leaving an event nothing will ever find again.
// Already gone counts as removed, exactly as in setTaskSync.
async function removeEventsFor(client, ownerId, taskId, deps = {}) {
  const remove = deps.deleteEvent || calendar.deleteEvent;
  const { rows } = await client.query(
    `SELECT id, calendar_event_id FROM tasks
      WHERE (id = $1 OR parent_id = $1) AND owner_id = $2 AND calendar_event_id IS NOT NULL`,
    [taskId, ownerId]
  );
  for (const t of rows) {
    const res = await remove(client, ownerId, { eventId: t.calendar_event_id });
    if (!res.ok && res.error.code !== 'not_found') {
      return err('conflict', 'could not take the task off the calendar', { reason: 'calendar' });
    }
    await client.query(`UPDATE tasks SET calendar_event_id = NULL WHERE id = $1`, [t.id]);
  }
  return ok({ removed: rows.length });
}

// Every copy still standing, for somebody who can have it taken down. One
// query, so a tick is one round trip before any Google call happens.
async function pending(client, { limit = MAX_PER_TICK } = {}) {
  const { rows } = await client.query(
    `SELECT t.id, t.owner_id, t.calendar_event_id
       FROM tasks t
       JOIN users u ON u.id = t.owner_id
       JOIN integrations i ON i.user_id = t.owner_id AND i.provider = 'google_calendar'
      WHERE t.calendar_event_id IS NOT NULL
        AND i.status = 'connected' AND i.access_level = 'read_write'
        AND u.status = 'active' AND NOT u.is_eval
      ORDER BY t.id
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function syncOne(client, t, deps = {}) {
  const remove = deps.deleteEvent || calendar.deleteEvent;
  const res = await remove(client, t.owner_id, { eventId: t.calendar_event_id });
  // Already gone counts as removed: the calendar is in the state we want, and
  // an id pointing at nothing would be retried every tick.
  if (!res.ok && res.error.code !== 'not_found') {
    return { id: t.id, action: 'remove', ok: false, error: res.error.message };
  }
  await client.query(`UPDATE tasks SET calendar_event_id = NULL WHERE id = $1`, [t.id]);
  return { id: t.id, action: 'removed' };
}

async function sweepTaskCalendar(client, deps = {}) {
  const rows = await pending(client, { limit: deps.limit || MAX_PER_TICK });
  const out = { considered: rows.length, removed: [], failed: [] };
  for (const t of rows) {
    let r;
    try {
      r = await syncOne(client, t, deps);
    } catch (e) {
      // A dead connection or a revoked grant must not stop the other people's
      // rows — the next tick retries this one on its own.
      out.failed.push({ id: t.id, error: String(e.message).slice(0, 200) });
      continue;
    }
    if (r.ok === false) out.failed.push({ id: r.id, error: r.error });
    else if (r.action === 'removed') out.removed.push(r.id);
  }
  return out;
}

module.exports = {
  setSync, setTaskSync, removeEventsFor, pending, syncOne, sweepTaskCalendar,
  expectedIdFor, windowFor, MAX_PER_TICK, EVENT_MINUTES,
};
