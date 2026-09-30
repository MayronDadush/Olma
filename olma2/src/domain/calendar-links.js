'use strict';
// A WhatsApp reminder hung on an event in the person's OWN calendar.
//
// The owner's frame (2026-09-30): people keep using their calendar app, and
// Olma is an extra layer on top of it — reminders on WhatsApp if they want
// them, and one tidy place to see everything. What existed instead was two
// copies of everything. A thing on the calendar could only be reminded about
// by saving it AGAIN as a task, so מירון's monthly "העברות + סיבוב bit" was a
// one-off task that archived itself after the first month, and the task sync
// copied it back onto the calendar as a third entry (`incidents.md`, "Two of
// everything").
//
// Now a task can STAND FOR an event (migration 103): the event stays the
// truth, and this row only carries the reminder and a place on Olma's list.
//
//   linkEvent            "remind me about X" for an event already on the
//                        calendar. Follows the whole series for a repeating
//                        one unless they said only this one, adopts the task
//                        they may already have saved for it rather than
//                        writing a second, and arms the reminder.
//   sweepCalendarLinks   brings each row after its event: moved → the row and
//                        its reminder move; renamed → renamed; passed → the
//                        next occurrence of a series, or archived quietly;
//                        deleted → archived quietly. A read that FAILED is
//                        never "deleted" — the row waits for the next tick.
//
// Archived quietly, never with the "I closed this" notice the finished-task
// sweep sends (`sweeps.sweepFinishedTasks` skips linked rows): the person
// deleted the event themselves, or it simply happened, and the calendar is
// where they look for it.
const { ok, err } = require('./results');
const calendar = require('./calendar');
const reminders = require('./reminders');
const tasks = require('./tasks');
const similarity = require('./task-similarity');
const audit = require('./audit');
const google = require('./google-oauth');
const autoReminder = require('./auto-reminder');
const { hasOffset, badTime, partsInZone, instantInZone } = require('./datetime');

const MAX_PER_TICK = 20;
// A linked row is compared with Google at most once an hour while its event
// is ahead — a move made on the phone reaches the reminder within the hour —
// and every ten minutes once it has passed, so a monthly series advances
// promptly without re-reading the same passed event every tick.
const RECHECK_MS = 60 * 60_000;
const PASSED_RECHECK_MS = 10 * 60_000;
// A save waits at most this long on Google before it goes ahead as it always
// did. Asking the calendar is a courtesy; a slow Google must never cost the
// person the thing they asked to have written down.
const SAVE_BUDGET_MS = 3000;
// The widest span one bulk save asks the calendar about, in days.
const LOOKUP_MAX_DAYS = 62;
const EVENT_MINUTES = 30;

async function zoneOf(client, userId) {
  const { rows } = await client.query(`SELECT timezone FROM users WHERE id = $1`, [userId]);
  return (rows[0] && rows[0].timezone) || 'UTC';
}

function dateParts(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

// The moment a row stands for. A timed event is its own start and end. An
// all-day event is local midnight of its date in THEIR zone with no end —
// the shape every reader already takes for "a day" (auto-reminder arms 08:00
// for it, the page draws it without an hour).
function momentFor(ev, tz) {
  if (ev.allDay) {
    const p = dateParts(ev.start);
    if (!p) return null;
    return { dueAt: instantInZone(tz, { ...p, hh: 0, mi: 0, ss: 0 }).toISOString(), endsAt: null };
  }
  const start = new Date(ev.start);
  if (Number.isNaN(start.getTime())) return null;
  const end = ev.end ? new Date(ev.end) : null;
  return {
    dueAt: start.toISOString(),
    endsAt: end && !Number.isNaN(end.getTime()) && end > start ? end.toISOString() : null,
  };
}

// When an occurrence is over. Google's all-day `end` is the EXCLUSIVE next
// date, which in their zone is exactly midnight after the last day.
function endOf(ev, tz) {
  if (ev.allDay) {
    const p = dateParts(ev.end) || (() => {
      const s = dateParts(ev.start);
      const next = new Date(Date.UTC(s.y, s.m - 1, s.d + 1));
      return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() };
    })();
    return instantInZone(tz, { ...p, hh: 0, mi: 0, ss: 0 });
  }
  return new Date(ev.end || ev.start);
}

function sameLocalDay(a, b, tz) {
  const x = partsInZone(tz, new Date(a));
  const y = partsInZone(tz, new Date(b));
  return x.y === y.y && x.m === y.m && x.d === y.d;
}

// The task they may already have saved for this event: open, top level, not
// linked to anything, the same words (or the same thing reworded, by the
// measured `task-similarity.compare`), and on the same local day. Adopting it
// is the whole point — linking beside it would be the duplicate this ends.
async function findShadow(client, userId, title, dueAt, tz) {
  const { rows } = await client.query(
    `SELECT * FROM tasks
      WHERE owner_id = $1 AND status = 'open' AND archived_at IS NULL
        AND parent_id IS NULL AND linked_event_id IS NULL AND due_at IS NOT NULL`,
    [userId]
  );
  const want = tasks.normaliseTitle(title);
  const sameDay = rows.filter((r) => sameLocalDay(r.due_at, dueAt, tz));
  return sameDay.find((r) => tasks.normaliseTitle(r.title) === want)
    || sameDay.find((r) => similarity.compare(title, r.title).same)
    || null;
}

async function pendingReminders(client, userId, taskId) {
  const { rows } = await client.query(
    `SELECT * FROM task_reminders
      WHERE task_id = $1 AND (user_id IS NULL OR user_id = $2)
        AND sent_at IS NULL AND cancelled_at IS NULL
      ORDER BY remind_at`,
    [taskId, userId]
  );
  return rows;
}

// Cancel the one-off reminders THEY named that have not fired yet. Used when
// the moment they were named against moves, so the explicit hour can be
// re-derived from the same lead instead of going off at the old time.
async function dropNamedReminders(client, taskId, now) {
  await client.query(
    `UPDATE task_reminders SET cancelled_at = $2
      WHERE task_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL
        AND repeat_rule IS NULL AND attempts = 0 AND NOT auto`,
    [taskId, now]
  );
}

async function linkEvent(client, userId, { eventId, remindAt = null, onlyThisOne = false, now = new Date(), known = null } = {}, deps = {}) {
  const getEvent = deps.getEvent || calendar.getEvent;
  const nextInstance = deps.nextInstance || calendar.nextInstance;
  if (!eventId && !known) return err('invalid', 'event_id is required — take it from my_calendar_events');
  if (remindAt && !hasOffset(remindAt)) return badTime('remind_at', remindAt);

  // `known`: an event this process has just written itself (saveToCalendar),
  // so reading it straight back would be a Google call that says nothing new.
  let ev = known;
  if (!ev) {
    const read = await getEvent(client, userId, eventId);
    if (!read.ok) return read;
    if (read.data.gone) {
      return err('not_found', 'that event is no longer on their calendar', { reason: 'gone' });
    }
    ev = read.data.event;
  }
  const tz = await zoneOf(client, userId);
  // A repeating event is reminded EVERY time unless they said only this one.
  let seriesId = ev.isSeries ? ev.id : (ev.recurringEventId || null);
  if (ev.isSeries || endOf(ev, tz) <= now) {
    if (!seriesId) return err('invalid', 'that event has already passed', { reason: 'passed' });
    const nx = await nextInstance(client, userId, seriesId, { after: now });
    if (!nx.ok) return nx;
    if (!nx.data.next) {
      return err('invalid', 'that repeating event has no occurrence left', { reason: 'passed' });
    }
    ev = nx.data.next;
  }
  if (onlyThisOne) seriesId = null;
  const when = momentFor(ev, tz);
  if (!when) return err('invalid', 'the event has no date that could be read');
  const lead = remindAt
    ? Math.round((new Date(when.dueAt).getTime() - new Date(remindAt).getTime()) / 60_000)
    : null;

  const key = seriesId || ev.id;
  const { rows: had } = await client.query(
    `SELECT * FROM tasks
      WHERE owner_id = $1 AND COALESCE(linked_series_id, linked_event_id) = $2
        AND status = 'open' AND archived_at IS NULL`,
    [userId, key]
  );
  let task = had[0] || null;
  const alreadyLinked = Boolean(task);
  let adopted = false;
  if (!task) {
    task = await findShadow(client, userId, ev.title, when.dueAt, tz);
    adopted = Boolean(task);
  }

  if (task) {
    const moved = !task.due_at || new Date(task.due_at).getTime() !== new Date(when.dueAt).getTime();
    const { rows } = await client.query(
      `UPDATE tasks SET title = $2, kind = 'event', due_at = $3, ends_at = $4,
              location = COALESCE($5, location),
              linked_event_id = $6, linked_series_id = $7,
              linked_lead_minutes = CASE WHEN $8::int IS NULL THEN linked_lead_minutes ELSE $8::int END,
              linked_checked_at = $9
        WHERE id = $1 RETURNING *`,
      [task.id, ev.title, when.dueAt, when.endsAt, ev.location, ev.id, seriesId, lead, now]
    );
    task = rows[0];
    if (moved) await reminders.retireForMovedTask(client, userId, task, { timezone: tz, now });
  } else {
    const { rows } = await client.query(
      `INSERT INTO tasks (owner_id, title, kind, due_at, ends_at, location, source,
                          linked_event_id, linked_series_id, linked_lead_minutes, linked_checked_at)
       VALUES ($1, $2, 'event', $3, $4, $5, 'calendar', $6, $7, $8, $9) RETURNING *`,
      [userId, ev.title, when.dueAt, when.endsAt, ev.location, ev.id, seriesId, lead, now]
    );
    task = rows[0];
  }

  if (remindAt) {
    // The hour they named replaces any other they named for this event; the
    // automatic one on the same local day steps aside inside setReminder.
    await dropNamedReminders(client, task.id, now);
    const set = await reminders.setReminder(client, userId, task.id, remindAt, null);
    if (!set.ok) return set;
  } else {
    // Never stacks: attachAutoReminder refuses when one of theirs is live.
    await reminders.attachAutoReminder(client, userId, task, tz, now);
  }
  const armed = await pendingReminders(client, userId, task.id);
  await audit.record(client, userId, 'calendar.linked', {
    taskId: Number(task.id), eventId: ev.id, seriesId, adopted, alreadyLinked,
  });
  return ok({
    task,
    linked: { eventId: ev.id, seriesId, followsSeries: Boolean(seriesId) },
    adopted,
    alreadyLinked,
    reminders: armed,
    ...(armed.length ? { remindersAt: await tasks.localLabels(client, userId, armed) } : {}),
    remindersAsked: Boolean(remindAt),
  });
}

// ---- before a save: is it on their calendar already? -----------------------

async function calendarAccess(client, userId) {
  const { rows } = await client.query(
    `SELECT access_level FROM integrations
      WHERE user_id = $1 AND provider = 'google_calendar' AND status = 'connected'`,
    [userId]
  );
  return rows[0] ? rows[0].access_level : null;
}

// The local calendar day an event or a moment falls on, as 'YYYY-MM-DD'.
function dayKey(value, tz, allDay = false) {
  if (allDay) { const p = dateParts(value); return p ? `${p.y}-${p.m}-${p.d}` : null; }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const p = partsInZone(tz, d);
  return `${p.y}-${p.m}-${p.d}`;
}

function sameThing(a, b) {
  return tasks.normaliseTitle(a) === tasks.normaliseTitle(b) || similarity.compare(a, b).same;
}

// For each dated item, the event on their calendar that is the same thing on
// the same local day, if there is one. ONE Google call for the whole list.
// Everything that goes wrong answers "nothing found": the save then happens
// exactly as it did before this existed (proposal 2, owner 2026-09-30).
async function findInCalendar(client, userId, items, deps = {}) {
  const found = new Map();
  const dated = items
    .map((it, i) => ({ ...it, i }))
    .filter((it) => it && it.title && it.dueAt && hasOffset(it.dueAt));
  if (!dated.length) return found;
  try {
    if (!(await calendarAccess(client, userId))) return found;
    const tz = await zoneOf(client, userId);
    const times = dated.map((it) => new Date(it.dueAt).getTime()).filter(Number.isFinite);
    if (!times.length) return found;
    const from = new Date(Math.min(...times) - 86400_000);
    const to = new Date(Math.min(Math.max(...times), from.getTime() + LOOKUP_MAX_DAYS * 86400_000) + 2 * 86400_000);
    const between = deps.eventsBetween || calendar.eventsBetween;
    const res = await between(client, userId, { timeMin: from, timeMax: to, maxEvents: 250 },
      { budget: google.createBudget(deps.budgetMs || SAVE_BUDGET_MS) });
    if (!res || !res.ok) return found;
    const linked = await linkedEventIds(client, userId);
    for (const it of dated) {
      const day = dayKey(it.dueAt, tz);
      const hit = res.data.events.find((e) => dayKey(e.start, tz, e.allDay) === day && sameThing(it.title, e.title));
      if (hit) {
        found.set(it.i, {
          id: hit.id, title: hit.title, start: hit.start, allDay: hit.allDay,
          reminded: linked.byEvent.has(hit.id) || Boolean(hit.recurringEventId && linked.bySeries.has(hit.recurringEventId)),
        });
      }
    }
  } catch (e) {
    if (deps.onError) deps.onError(e);
  }
  return found;
}

// A meeting told to Olma, for somebody whose calendar she can WRITE to: it
// goes onto the calendar and Olma keeps only the reminder on it — one entry,
// where they already look (proposal 3). Returns null whenever the calendar
// could not take it, and the caller saves it the ordinary way; never an error
// the person would see for a thing they only asked to have noted.
async function saveToCalendar(client, userId, { title, dueAt, endsAt, location, remindAt, now = new Date() }, deps = {}) {
  if (!title || !dueAt || !hasOffset(dueAt)) return null;
  if ((await calendarAccess(client, userId)) !== 'read_write') return null;
  const tz = await zoneOf(client, userId);
  const allDay = autoReminder.isDayShaped(dueAt, tz);
  let start;
  let end;
  if (allDay) {
    const p = partsInZone(tz, new Date(dueAt));
    const pad = (n) => String(n).padStart(2, '0');
    start = `${p.y}-${pad(p.m)}-${pad(p.d)}T00:00:00Z`;
    end = start;
  } else {
    start = new Date(dueAt).toISOString();
    const stated = endsAt && hasOffset(endsAt) ? new Date(endsAt) : null;
    end = (stated && stated > new Date(dueAt)
      ? stated : new Date(new Date(dueAt).getTime() + EVENT_MINUTES * 60_000)).toISOString();
  }
  const create = deps.createEvent || calendar.createEvent;
  let made;
  try {
    made = await create(client, userId, { title, start, end, location, allDay },
      { budget: google.createBudget(deps.budgetMs || SAVE_BUDGET_MS) });
  } catch (e) {
    if (deps.onError) deps.onError(e);
    return null;
  }
  if (!made || !made.ok || !made.data || !made.data.eventId) return null;
  const known = {
    id: made.data.eventId, title, location: location || null, allDay,
    start: allDay ? start.slice(0, 10) : start,
    end: allDay ? null : end,
    recurringEventId: null, isSeries: false,
  };
  const linked = await linkEvent(client, userId, { known, remindAt, now }, deps);
  if (!linked.ok) return null;
  await audit.record(client, userId, 'calendar.saved_as_event', {
    taskId: Number(linked.data.task.id), eventId: known.id,
  });
  return ok({ ...linked.data, onCalendar: true });
}

// ---- the sweep ---------------------------------------------------------------

async function due(client, { now, limit }) {
  const { rows } = await client.query(
    `SELECT t.*, u.timezone
       FROM tasks t
       JOIN users u ON u.id = t.owner_id
       JOIN integrations i ON i.user_id = t.owner_id AND i.provider = 'google_calendar'
      WHERE t.linked_event_id IS NOT NULL AND t.status = 'open' AND t.archived_at IS NULL
        AND i.status = 'connected' AND u.status = 'active' AND NOT u.is_eval
        AND (t.linked_checked_at IS NULL
             OR t.linked_checked_at < $2::timestamptz - make_interval(secs => $3)
             OR (COALESCE(t.ends_at, t.due_at + interval '1 day') < $2
                 AND t.linked_checked_at < $2::timestamptz - make_interval(secs => $4)))
      ORDER BY t.linked_checked_at NULLS FIRST, t.id
      LIMIT $1`,
    [limit, now, RECHECK_MS / 1000, PASSED_RECHECK_MS / 1000]
  );
  return rows;
}

// Bring a row to the occurrence `ev`: the same one moved or renamed, or the
// next one of its series.
async function follow(client, t, ev, tz, now) {
  const when = momentFor(ev, tz);
  if (!when) return { id: t.id, action: 'unreadable' };
  const moved = new Date(t.due_at).getTime() !== new Date(when.dueAt).getTime();
  const renamed = ev.title && ev.title !== t.title;
  const endMoved = String(t.ends_at ? new Date(t.ends_at).toISOString() : null) !== String(when.endsAt);
  const advanced = ev.id !== t.linked_event_id;
  await client.query(
    `UPDATE tasks SET title = $2, due_at = $3, ends_at = $4, linked_event_id = $5,
            location = COALESCE($6, location), linked_checked_at = $7
      WHERE id = $1`,
    [t.id, ev.title || t.title, when.dueAt, when.endsAt, ev.id, ev.location, now]
  );
  if (moved) {
    const task = { ...t, due_at: when.dueAt, ends_at: when.endsAt };
    if (t.linked_lead_minutes !== null && t.linked_lead_minutes !== undefined) {
      await dropNamedReminders(client, t.id, now);
    }
    await reminders.retireForMovedTask(client, t.owner_id, task, { timezone: tz, now });
    if (t.linked_lead_minutes !== null && t.linked_lead_minutes !== undefined) {
      const at = new Date(new Date(when.dueAt).getTime() - t.linked_lead_minutes * 60_000);
      if (at > now) await reminders.setReminder(client, t.owner_id, t.id, at.toISOString(), null);
    }
  }
  if (!moved && !renamed && !endMoved && !advanced) return { id: t.id, action: 'unchanged' };
  await audit.record(client, t.owner_id, 'calendar.link_followed', {
    taskId: Number(t.id), eventId: ev.id, moved, renamed, advanced,
  });
  return { id: t.id, action: advanced ? 'advanced' : 'followed' };
}

// Archived quietly, and everything that could still speak for it withdrawn.
async function retire(client, t, why, now) {
  await client.query(
    `UPDATE tasks SET archived_at = $2, linked_checked_at = $2 WHERE id = $1`, [t.id, now]);
  const { rows } = await client.query(
    `SELECT r.id, COALESCE(r.user_id, $2) AS recipient FROM task_reminders r
      WHERE r.task_id = $1 AND r.sent_at IS NULL AND r.cancelled_at IS NULL`,
    [t.id, t.owner_id]
  );
  for (const r of rows) await reminders.cancelReminder(client, r.recipient, r.id);
  await audit.record(client, t.owner_id, 'calendar.link_retired', { taskId: Number(t.id), why });
  return { id: t.id, action: 'retired', why };
}

async function sweepCalendarLinks(client, deps = {}) {
  const now = deps.now ? new Date(deps.now) : new Date();
  const getEvent = deps.getEvent || calendar.getEvent;
  const nextInstance = deps.nextInstance || calendar.nextInstance;
  const rows = await due(client, { now, limit: deps.limit || MAX_PER_TICK });
  const out = { considered: rows.length, followed: [], advanced: [], retired: [], unread: [] };
  const stamp = (id) => client.query(`UPDATE tasks SET linked_checked_at = $2 WHERE id = $1`, [id, now]);
  for (const t of rows) {
    const tz = t.timezone || 'UTC';
    try {
      const read = await getEvent(client, t.owner_id, t.linked_event_id);
      // Could not READ is never "gone": the row waits, untouched, for the
      // next check (rules/detectors.md).
      if (!read.ok) { await stamp(t.id); out.unread.push(t.id); continue; }
      const ev = read.data.gone ? null : read.data.event;
      let r;
      if (ev && endOf(ev, tz) > now) {
        r = await follow(client, t, ev, tz, now);
      } else if (t.linked_series_id) {
        const nx = await nextInstance(client, t.owner_id, t.linked_series_id, { after: now });
        if (!nx.ok) { await stamp(t.id); out.unread.push(t.id); continue; }
        r = nx.data.next
          ? await follow(client, t, nx.data.next, tz, now)
          : await retire(client, t, 'series_ended', now);
      } else {
        r = await retire(client, t, ev ? 'passed' : 'gone', now);
      }
      if (r.action === 'advanced') out.advanced.push(t.id);
      else if (r.action === 'followed') out.followed.push(t.id);
      else if (r.action === 'retired') out.retired.push(t.id);
    } catch (e) {
      // One broken connection must not stop everybody else's rows.
      out.unread.push(t.id);
      await stamp(t.id).catch(() => {});
      if (deps.onError) deps.onError(e);
    }
  }
  return out;
}

// Which event ids are already carried by a linked row — so a list of the
// calendar (the page, the digest, my_calendar_events) can say "🔔 reminded"
// and never draw the same thing twice.
async function linkedEventIds(client, userId) {
  const { rows } = await client.query(
    `SELECT id, linked_event_id, linked_series_id FROM tasks
      WHERE owner_id = $1 AND linked_event_id IS NOT NULL
        AND status = 'open' AND archived_at IS NULL`,
    [userId]
  );
  const byEvent = new Map();
  const bySeries = new Map();
  for (const r of rows) {
    byEvent.set(r.linked_event_id, Number(r.id));
    if (r.linked_series_id) bySeries.set(r.linked_series_id, Number(r.id));
  }
  return { byEvent, bySeries };
}

module.exports = {
  linkEvent, sweepCalendarLinks, linkedEventIds, findInCalendar, saveToCalendar, calendarAccess,
  momentFor, endOf, findShadow, MAX_PER_TICK, RECHECK_MS, PASSED_RECHECK_MS, SAVE_BUDGET_MS,
};
