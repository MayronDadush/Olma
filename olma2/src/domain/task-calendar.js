'use strict';
// Dated tasks, on the person's own Google Calendar.
//
// Opt-in, per person, off by default. Writing to somebody's calendar is an
// outward-facing act they will see every day, so it is never inferred from
// "they have a calendar connected" — they ask for it, and they can stop it.
//
// ---- why this is a sweep and not part of add_task ----
//
// Creating a task must not wait on Google. The MCP shim gives up at 30s while
// brokerd commits regardless (see domain/google-oauth.js on the budget), so a
// slow calendar call inside add_task would produce the one outcome worse than
// a missing event: a task the agent reports as failed and the database kept.
// Syncing separately also means a Google outage delays events instead of
// losing tasks, and the next tick simply picks up where it stopped.
//
// ---- the id IS the fingerprint ----
//
// calendar.eventIdFor derives an event id from userId|title|start. So a stored
// id that no longer equals the id the task's CURRENT title and due time would
// produce is proof it was renamed or rescheduled since it synced — and the
// repair is the obvious one: remove the stale event, write the new one. No
// second column to drift out of step, and no way for the two to disagree.
const { ok, err } = require('./results');
const calendar = require('./calendar');
const audit = require('./audit');

// Bounded per tick because each item is one or two Google calls on a 1-vCPU
// box shared with every user's replies. A backlog drains over several ticks
// rather than holding the loop.
const MAX_PER_TICK = 20;
const EVENT_MINUTES = 30;

// A task carries one instant, not a span. Thirty minutes is a block a person
// can see and move; an all-day event would claim we know the task is all-day,
// which we do not — `due_at` cannot tell "the 14th" from "09:00 on the 14th"
// once it is a timestamptz. Better a modest block that is honest than an
// all-day banner that asserts something nobody said.
function windowFor(dueAt) {
  const start = new Date(dueAt);
  const end = new Date(start.getTime() + EVENT_MINUTES * 60_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function expectedIdFor(userId, task) {
  return calendar.eventIdFor(userId, task.title, windowFor(task.due_at).start);
}

// Turning it ON requires edit access, and says so plainly rather than letting
// every future sync fail quietly against a view-only grant.
async function setSync(client, userId, on, { removeExisting = false, ...deps } = {}) {
  if (typeof on !== 'boolean') return err('invalid', 'on must be true or false');
  if (on) {
    const status = await calendar.getStatus(client, userId);
    const s = status.ok ? status.data : null;
    if (!s || !s.connected) {
      return err('invalid', 'their Google Calendar is not connected — offer start_calendar_connection first');
    }
    if (!s.canEdit) {
      return err('forbidden',
        'they granted view-only calendar access, so nothing can be written to it. Offer to reconnect with edit access.',
        { reason: 'read_only' });
    }
  }
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

// Everything that is not where it should be: to add, to remove, to redo.
// One query, so a tick is one round trip before any Google call happens.
async function pending(client, { limit = MAX_PER_TICK, now = new Date() } = {}) {
  const { rows } = await client.query(
    `SELECT t.id, t.owner_id, t.title, t.due_at, t.calendar_event_id,
            u.calendar_sync_tasks, t.status, t.archived_at
       FROM tasks t
       JOIN users u ON u.id = t.owner_id
      WHERE u.status = 'active' AND u.paused_at IS NULL AND NOT u.is_eval
        AND (
          -- to add: they want it, it is dated, still open, still ahead
          (u.calendar_sync_tasks AND t.calendar_event_id IS NULL
             AND t.due_at IS NOT NULL AND t.due_at > $2
             AND t.status = 'open' AND t.archived_at IS NULL)
          -- to remove: it is on the calendar and no longer earns its place
          OR (t.calendar_event_id IS NOT NULL
             AND (NOT u.calendar_sync_tasks OR t.status <> 'open'
                  OR t.archived_at IS NOT NULL OR t.due_at IS NULL))
          -- to re-check: on the calendar and still wanted — the fingerprint
          -- comparison below decides whether it actually moved
          OR (u.calendar_sync_tasks AND t.calendar_event_id IS NOT NULL
             AND t.status = 'open' AND t.archived_at IS NULL AND t.due_at IS NOT NULL)
        )
      ORDER BY t.due_at NULLS FIRST
      LIMIT $1`,
    [limit, now]
  );
  return rows;
}

async function syncOne(client, t, deps = {}) {
  const create = deps.createEvent || calendar.createEvent;
  const remove = deps.deleteEvent || calendar.deleteEvent;
  const wanted = t.calendar_sync_tasks && t.status === 'open'
    && !t.archived_at && t.due_at;

  if (t.calendar_event_id) {
    const stale = !wanted || t.calendar_event_id !== expectedIdFor(t.owner_id, t);
    if (stale) {
      const res = await remove(client, t.owner_id, { eventId: t.calendar_event_id });
      if (!res.ok) return { id: t.id, action: 'remove', ok: false, error: res.error.message };
      await client.query(`UPDATE tasks SET calendar_event_id = NULL WHERE id = $1`, [t.id]);
      t.calendar_event_id = null;
      if (!wanted) return { id: t.id, action: 'removed' };
      // fall through: it moved, so it is re-added below under its new id
    } else {
      return { id: t.id, action: 'unchanged' };
    }
  }
  if (!wanted) return { id: t.id, action: 'skipped' };

  const { start, end } = windowFor(t.due_at);
  const res = await create(client, t.owner_id, { title: t.title, start, end });
  if (!res.ok) return { id: t.id, action: 'add', ok: false, error: res.error.message };
  await client.query(
    `UPDATE tasks SET calendar_event_id = $2 WHERE id = $1`, [t.id, res.data.eventId]);
  return { id: t.id, action: 'added', eventId: res.data.eventId };
}

async function sweepTaskCalendar(client, deps = {}) {
  const now = deps.now ? new Date(deps.now) : new Date();
  const rows = await pending(client, { limit: deps.limit || MAX_PER_TICK, now });
  const out = { considered: rows.length, added: [], removed: [], failed: [] };
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
    else if (r.action === 'added') out.added.push(r.id);
    else if (r.action === 'removed') out.removed.push(r.id);
  }
  return out;
}

module.exports = {
  setSync, pending, syncOne, sweepTaskCalendar,
  expectedIdFor, windowFor, MAX_PER_TICK, EVENT_MINUTES,
};
