'use strict';
// Dated tasks, on the person's own Google Calendar.
//
// A TO-DO goes on the calendar only when they ask: per person, off by default.
// Writing to somebody's calendar is an outward-facing act they will see every
// day, so for a job to be done it is never inferred from "they have a calendar
// connected" — they ask for it, and they can stop it.
//
// An EVENT is different, since 2026-10-01, on the owner's word. "תזכיר לי
// לקראת התור שלי לספר בשעה 15" is an appointment; the person already said it
// happens at 15:00, and a calendar they connected WITH write access is where
// they keep those. So an event with no answer of its own goes to Google
// whenever such a calendar is connected, whatever the standing switch says —
// the switch is about to-dos. A task that said no (`calendar_opt_in = false`,
// the sheet's own switch) still wins, and a read-only or broken connection
// asks nothing, because creating an event there fails every tick for ever.
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
const crypto = require('node:crypto');
const { ok, err } = require('./results');
const calendar = require('./calendar');
const audit = require('./audit');
const { isDayShaped } = require('./auto-reminder');
const { partsInZone, zoneOffsetMs } = require('./datetime');

// Bounded per tick because each item is one or two Google calls on a 1-vCPU
// box shared with every user's replies. A backlog drains over several ticks
// rather than holding the loop.
const MAX_PER_TICK = 20;
const EVENT_MINUTES = 30;

// A real end when the task has one, and thirty minutes when it does not.
//
// The fallback is the older half of this and its reasoning still holds for a
// MOMENT: an all-day event would claim we know the task fills a day, which a
// stated hour contradicts. A modest honest block beats an all-day banner
// asserting something nobody said.
//
// What changed is that a task CAN now say where it stops (`tasks.ends_at`), and
// when it does, guessing thirty minutes over the top of a stated seven-hour
// shift is not modesty, it is discarding the answer.
//
// And a task saved for a DAY — "יום הולדת לליאם ב-30.10", stored as local
// midnight, the discriminator `auto-reminder.isDayShaped` reads — IS a whole
// day: nobody said an hour, so a 00:00-00:30 block on their calendar asserts
// one that nobody said, at the worst hour there is (found 2026-10-01 reading
// the code behind a birthday that never reached Google — that one failed for a
// different reason, a view-only connection, see tools/tasks.calendarNote). With the
// person's zone it comes back `allDay` and `start` carries THEIR offset, so
// `calendar.createEvent` reads the right date off it. The instant is the same
// one either way, which is what keeps `expectedIdFor` stable.
function windowFor(dueAt, endsAt, timezone) {
  const start = new Date(dueAt);
  const stated = endsAt ? new Date(endsAt) : null;
  if (!stated && timezone && isDayShaped(start, timezone)) {
    const p = partsInZone(timezone, start);
    const off = Math.round(zoneOffsetMs(timezone, start) / 60_000);
    const sign = off < 0 ? '-' : '+';
    const hhmm = `${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`;
    const pad = (n) => String(n).padStart(2, '0');
    const local = `${p.y}-${pad(p.m)}-${pad(p.d)}T00:00:00${sign}${hhmm}`;
    return { start: start.toISOString(), end: start.toISOString(), allDay: true, localStart: local };
  }
  const end = stated && !Number.isNaN(stated.getTime()) && stated > start
    ? stated
    : new Date(start.getTime() + EVENT_MINUTES * 60_000);
  return { start: start.toISOString(), end: end.toISOString(), allDay: false };
}

// The id is keyed on the START only, deliberately: moving the end of a shift
// must UPDATE the event in the person's calendar, not leave the old one
// standing and add a second.
function expectedIdFor(userId, task) {
  return calendar.eventIdFor(userId, task.title, windowFor(task.due_at, task.ends_at).start);
}

// ---- a repeating event is a SERIES on Google ----
//
// Owner, 2026-10-05: a course every Monday is ONE thing Google knows — the
// whole term on the calendar from the day it is saved, and every change made
// the way Google makes it. It used to go up one occurrence at a time, each
// created when the last one ended, so the calendar never showed next week.
//
// One row is one series (one weekday each — Monday and Thursday are two, so
// the two days can keep different hours), written with an RRULE in the
// person's zone. The row's `due_at` is its NEXT occurrence and moves every
// week; the series does not, so it is not fingerprinted by the date the way a
// single event is (`expectedIdFor`). `calendar_series_key` holds what the
// series was written for, `tasks.advanceRecurring` carries it forward when
// the row merely moves on, and anything else that changes it — the title,
// the hours, the day, the end — SPLITS the series: the old one is cut at now
// (calendar.endSeries keeps what already happened) and a new one starts at
// the next occurrence. The same as Google's "this and following events".
function seriesKey(t) {
  const iso = (v) => (v ? new Date(v).toISOString() : '');
  return crypto.createHash('sha256')
    .update(`${t.title}|${t.repeat_rule}|${iso(t.due_at)}|${iso(t.ends_at)}|${iso(t.repeat_until)}`)
    .digest('hex').slice(0, 24);
}

// Chained off the series it replaces, so a split never asks Google for an id
// it has already seen; `n` steps past one that turns out to be taken.
function seriesIdFor(userId, prevId, key, n = 0) {
  return 'olma' + crypto.createHash('sha256')
    .update(`${userId}|series|${prevId || ''}|${key}|${n}`).digest('hex').slice(0, 32);
}

// The RRULE, in Google's dialect of RFC 5545. A month with no day N gets its
// LAST day, the way reminders.nextOccurrence clamps — BYMONTHDAY=31 alone
// would skip those months, and the calendar and the row would disagree.
function seriesRecurrence(t, { allDay, timezone }) {
  const r = t.repeat_rule;
  let rule = null;
  const w = /^weekly:([A-Z]{2})$/.exec(r || '');
  const m = /^monthly:(\d+)$/.exec(r || '');
  if (r === 'daily') rule = 'FREQ=DAILY';
  else if (w) rule = `FREQ=WEEKLY;BYDAY=${w[1]}`;
  else if (r === 'monthly:last') rule = 'FREQ=MONTHLY;BYMONTHDAY=-1';
  else if (m && Number(m[1]) <= 28) rule = `FREQ=MONTHLY;BYMONTHDAY=${Number(m[1])}`;
  else if (m) {
    const days = [];
    for (let d = 28; d <= Number(m[1]); d++) days.push(d);
    rule = `FREQ=MONTHLY;BYMONTHDAY=${days.join(',')};BYSETPOS=-1`;
  }
  if (!rule) return null;
  if (t.repeat_until) rule += `;UNTIL=${calendar.untilStamp(t.repeat_until, { allDay, timezone })}`;
  return [`RRULE:${rule}`];
}

// Whether this row belongs on its owner's calendar, as ONE SQL expression over
// `t` (tasks) and `u` (users), so the add, remove and re-check arms and the
// page's own switch all ask the identical question. See the header for why an
// event answers it differently from a to-do.
const WRITABLE_SQL = `EXISTS (SELECT 1 FROM integrations i
    WHERE i.user_id = u.id AND i.provider = 'google_calendar'
      AND i.status = 'connected' AND i.access_level = 'read_write')`;
const WANTED_SQL = `COALESCE(t.calendar_opt_in,
    u.calendar_sync_tasks OR (t.kind IS NOT DISTINCT FROM 'event' AND ${WRITABLE_SQL}))`;

// The page's switch shows the same answer the sweep acts on. `writable` is
// whether they have a calendar Olma may write to (calendar.getStatus's
// `canEdit`), read once per page rather than per row.
function wantedFor(task, { syncTasks, writable }) {
  if (task.calendar_opt_in != null) return task.calendar_opt_in;
  return Boolean(syncTasks) || (task.kind === 'event' && Boolean(writable));
}

async function canWrite(client, userId) {
  const { rows } = await client.query(
    `SELECT ${WRITABLE_SQL} AS w FROM users u WHERE u.id = $1`, [userId]);
  return Boolean(rows[0] && rows[0].w);
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
    `SELECT t.id, t.due_at, t.calendar_event_id, t.repeat_rule, u.timezone
       FROM tasks t JOIN users u ON u.id = t.owner_id
      WHERE t.id = $1 AND t.owner_id = $2 AND t.parent_id IS NULL`,
    [taskId, userId]
  );
  const task = rows[0];
  if (!task) return err('not_found', 'task not found');
  if (on) {
    // A task with no date has no moment to put anywhere. The sheet already
    // hides the row until a day is chosen; this is the same rule, enforced.
    if (!task.due_at) return err('invalid', 'a task with no date cannot go on a calendar');
    const status = await calendar.getStatus(client, userId);
    const s = status.ok ? status.data : null;
    if (!s || !s.connected) {
      return err('invalid', 'no calendar is connected', { reason: 'not_connected' });
    }
    if (!s.canEdit) {
      return err('forbidden', 'the calendar was connected view-only', { reason: 'read_only' });
    }
  }
  await client.query(`UPDATE tasks SET calendar_opt_in = $2 WHERE id = $1`, [taskId, on]);
  let removed = false;
  if (!on && task.calendar_event_id) {
    // A series is ended at now, never deleted, exactly as removeEventsFor
    // does it: the classes that already happened stay theirs.
    const res = task.repeat_rule
      ? await (deps.endSeries || calendar.endSeries)(client, userId, {
        eventId: task.calendar_event_id, at: deps.now ? new Date(deps.now) : new Date(), timezone: task.timezone,
      })
      : await (deps.deleteEvent || calendar.deleteEvent)(client, userId, { eventId: task.calendar_event_id });
    // Already gone counts: the calendar is in the state they asked for, and a
    // stored id pointing at nothing would make every later tick try again.
    if (res.ok || res.error.code === 'not_found') {
      await client.query(`UPDATE tasks SET calendar_event_id = NULL, calendar_series_key = NULL WHERE id = $1`, [taskId]);
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
  const end = deps.endSeries || calendar.endSeries;
  const { rows } = await client.query(
    `SELECT t.id, t.calendar_event_id, t.repeat_rule, u.timezone FROM tasks t JOIN users u ON u.id = t.owner_id
      WHERE (t.id = $1 OR t.parent_id = $1) AND t.owner_id = $2 AND t.calendar_event_id IS NOT NULL`,
    [taskId, ownerId]
  );
  for (const t of rows) {
    // A series is ended, never deleted: its past is their record.
    const res = t.repeat_rule
      ? await end(client, ownerId, { eventId: t.calendar_event_id, at: deps.now ? new Date(deps.now) : new Date(), timezone: t.timezone })
      : await remove(client, ownerId, { eventId: t.calendar_event_id });
    if (!res.ok && res.error.code !== 'not_found') {
      return err('conflict', 'could not take the task off the calendar', { reason: 'calendar' });
    }
    await client.query(`UPDATE tasks SET calendar_event_id = NULL, calendar_series_key = NULL WHERE id = $1`, [t.id]);
  }
  return ok({ removed: rows.length });
}

// Everything that is not where it should be: to add, to remove, to redo.
// One query, so a tick is one round trip before any Google call happens.
// `sync_wanted` is the one question every branch below asks, and it is
// answered once, in SQL (`WANTED_SQL`): the task's own answer when it gave
// one, the person's standing switch when it did not — or, for an event, a
// calendar they let Olma write to. Computing it here rather than in three
// separate WHERE clauses is what stops the add, remove and re-check arms from
// ever disagreeing about whether a row belongs on somebody's calendar.
//
// A moment that is OVER is left exactly where it is, whatever happened to its
// row since. The expired-events sweep archives "תור לספר" three hours after
// it passes, and this used to read "archived" as "take it off the calendar":
// the haircut vanished from Google the evening it happened. Leaving the list
// is not leaving the calendar — what already happened is the person's
// record, not a row we own. Only something still AHEAD is removed (cancelled,
// deleted, done early, undated, switched off); the dashboard's own delete
// (`removeEventsFor`) is a person acting on it and is untouched.
async function pending(client, { limit = MAX_PER_TICK, now = new Date() } = {}) {
  const { rows } = await client.query(
    `SELECT t.id, t.owner_id, t.title, t.due_at, t.ends_at, t.location, t.calendar_event_id,
            t.repeat_rule, t.repeat_until, t.calendar_series_key,
            u.calendar_sync_tasks, u.timezone, t.calendar_opt_in, t.status, t.archived_at,
            ${WANTED_SQL} AS sync_wanted
       FROM tasks t
       JOIN users u ON u.id = t.owner_id
      WHERE u.status = 'active' AND u.paused_at IS NULL AND NOT u.is_eval
        AND (
          -- to add: they want it, it is dated, still open, still ahead
          (${WANTED_SQL} AND t.calendar_event_id IS NULL
             AND t.due_at IS NOT NULL AND t.due_at > $2
             AND t.status = 'open' AND t.archived_at IS NULL)
          -- to remove: it is on the calendar and no longer earns its place
          OR (t.calendar_event_id IS NOT NULL
             AND (t.due_at IS NULL OR COALESCE(t.ends_at, t.due_at) > $2)
             AND (NOT ${WANTED_SQL} OR t.status <> 'open'
                  OR t.archived_at IS NOT NULL OR t.due_at IS NULL))
          -- to re-check: on the calendar and still wanted — the fingerprint
          -- comparison below decides whether it actually moved
          OR (${WANTED_SQL} AND t.calendar_event_id IS NOT NULL
             AND t.status = 'open' AND t.archived_at IS NULL AND t.due_at IS NOT NULL
             AND COALESCE(t.ends_at, t.due_at) > $2)
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
  // `sync_wanted` is what pending() computed; the two fallbacks keep a
  // hand-built row (a test, a caller with one task in hand) working without
  // having to know the precedence rule.
  const wants = t.sync_wanted ?? t.calendar_opt_in ?? t.calendar_sync_tasks;
  const wanted = wants && t.status === 'open'
    && !t.archived_at && t.due_at;

  // The same line pending() draws, for a caller that handed us a row itself.
  const now = deps.now ? new Date(deps.now) : new Date();
  const over = t.due_at && new Date(t.ends_at || t.due_at) <= now;
  if (t.calendar_event_id && over) return { id: t.id, action: 'unchanged' };
  if (t.repeat_rule) {
    const series = await syncSeries(client, t, wanted, now, deps);
    if (series) return series;
  }

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

  const w = windowFor(t.due_at, t.ends_at, t.timezone);
  const res = await create(client, t.owner_id, w.allDay
    ? { title: t.title, start: w.localStart, end: w.localStart, allDay: true, location: t.location || undefined }
    : { title: t.title, start: w.start, end: w.end, location: t.location || undefined });
  if (!res.ok) return { id: t.id, action: 'add', ok: false, error: res.error.message };
  await client.query(
    `UPDATE tasks SET calendar_event_id = $2 WHERE id = $1`, [t.id, res.data.eventId]);
  return { id: t.id, action: 'added', eventId: res.data.eventId };
}

// A repeating row's half of syncOne. Null when the rule is one Google cannot
// be given, and the row then goes up as a single event like any other.
async function syncSeries(client, t, wanted, now, deps) {
  const w = windowFor(t.due_at, t.ends_at, t.timezone);
  const recurrence = seriesRecurrence(t, { allDay: w.allDay, timezone: t.timezone });
  if (!recurrence) return null;
  const create = deps.createEvent || calendar.createEvent;
  const end = deps.endSeries || calendar.endSeries;
  const get = deps.getEvent || calendar.getEvent;
  const key = seriesKey(t);
  const prev = t.calendar_event_id;
  if (prev) {
    if (wanted && t.calendar_series_key === key) return { id: t.id, action: 'unchanged' };
    const res = await end(client, t.owner_id, { eventId: prev, at: now, timezone: t.timezone });
    if (!res.ok) return { id: t.id, action: 'remove', ok: false, error: res.error.message };
    await client.query(`UPDATE tasks SET calendar_event_id = NULL, calendar_series_key = NULL WHERE id = $1`, [t.id]);
    if (!wanted) return { id: t.id, action: 'removed' };
  }
  if (!wanted) return { id: t.id, action: 'skipped' };
  const body = w.allDay
    ? { title: t.title, start: w.localStart, end: w.localStart, allDay: true, location: t.location || undefined, recurrence }
    : { title: t.title, start: w.start, end: w.end, location: t.location || undefined, recurrence, timeZone: t.timezone || 'UTC' };
  for (let n = 0; n < 4; n++) {
    const eventId = seriesIdFor(t.owner_id, prev, key, n);
    const res = await create(client, t.owner_id, { ...body, eventId });
    if (!res.ok) return { id: t.id, action: 'add', ok: false, error: res.error.message };
    if (res.data.alreadyExisted) {
      // Either our own earlier write whose answer never reached us — that IS
      // this series, and is adopted — or one we have since ended or deleted,
      // which Google will not let us reuse. Only an identical live rule is ours.
      const got = await get(client, t.owner_id, { eventId });
      if (!got.ok) return { id: t.id, action: 'add', ok: false, error: got.error.message };
      const ev = got.data.event;
      if (!ev || JSON.stringify(ev.recurrence || []) !== JSON.stringify(recurrence)) continue;
    }
    await client.query(
      `UPDATE tasks SET calendar_event_id = $2, calendar_series_key = $3 WHERE id = $1`, [t.id, eventId, key]);
    return { id: t.id, action: 'added', eventId };
  }
  return { id: t.id, action: 'add', ok: false, error: 'no free series id' };
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
  setSync, setTaskSync, removeEventsFor, pending, syncOne, sweepTaskCalendar,
  expectedIdFor, windowFor, wantedFor, canWrite, MAX_PER_TICK, EVENT_MINUTES,
  seriesKey, seriesIdFor, seriesRecurrence,
};
