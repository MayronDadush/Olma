'use strict';
// Tasks + one level of project nesting. Every function is owner-scoped by
// construction — ownerId comes from resolveByToken, never from the caller's
// arguments. Editor-shared task mutation goes through shares.js (which calls
// back in here after its own permission check), keeping one write path.
const { ok, err } = require('./results');
const audit = require('./audit');
const { hasOffset, badTime } = require('./datetime');

const MAX_BULK = 60;

// One place that decides whether a parent is usable, so add_task and the bulk
// split path can never disagree about what "one level of nesting" means.
async function checkParent(client, ownerId, parentId) {
  const { rows } = await client.query(
    `SELECT id, parent_id FROM tasks WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL`,
    [parentId, ownerId]
  );
  if (!rows[0]) return err('not_found', 'parent task not found');
  if (rows[0].parent_id) return err('invalid', 'only one level of nesting');
  return ok({ parent: rows[0] });
}

async function addTask(client, ownerId, { title, category, dueAt, parentId, source }) {
  if (!title || !title.trim()) return err('invalid', 'title required');
  if (dueAt && !hasOffset(dueAt)) return badTime('due_at', dueAt);
  if (parentId) {
    const check = await checkParent(client, ownerId, parentId);
    if (!check.ok) return check;
  }
  const { rows } = await client.query(
    `INSERT INTO tasks (owner_id, title, category, due_at, parent_id, source)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'chat')) RETURNING *`,
    [ownerId, title.trim(), category || null, dueAt || null, parentId || null, source || null]
  );
  await audit.record(client, ownerId, 'task.created', { taskId: rows[0].id, parentId: parentId || null });
  return ok({ task: rows[0] });
}

// Change a task that already exists. Until the dashboard there was no way to
// do this at all — a wrong title was fixed by completing the row and writing a
// new one, which loses its reminders and its place under a project — so the
// page had `set_task_category` marked NO TOOL YET against exactly this gap.
//
// Only the three fields a person can see and point at. `source`, `parent_id`,
// `status` and the archive flag are all changed by their own operations, and
// letting an edit move them would give one call two meanings: completing a task
// and renaming it are different events, and the audit trail has to be able to
// tell them apart.
//
// A field is changed only when it is PRESENT. `undefined` means "leave it",
// `null` means "clear it" — a page that only knows how to send whole objects
// would otherwise wipe a due date every time somebody fixed a typo.
async function editTask(client, ownerId, taskId, patch = {}) {
  const has = (k) => Object.hasOwn(patch, k);
  const sets = [];
  const vals = [taskId, ownerId];
  const changed = {};
  if (has('title')) {
    const title = String(patch.title ?? '').trim();
    if (!title) return err('invalid', 'title cannot be emptied');
    sets.push(`title = $${vals.push(title)}`);
    changed.title = true;
  }
  if (has('category')) {
    const category = patch.category == null ? null : String(patch.category).trim() || null;
    sets.push(`category = $${vals.push(category)}`);
    changed.category = category;
  }
  if (has('dueAt')) {
    // Same rule as add_task, and for the same incident: a bare local time gets
    // read in the server's zone and lands hours off (the shift stored as 15:00Z).
    if (patch.dueAt != null && !hasOffset(patch.dueAt)) return badTime('due_at', patch.dueAt);
    sets.push(`due_at = $${vals.push(patch.dueAt ?? null)}`);
    changed.dueAt = patch.dueAt ?? null;
  }
  if (sets.length === 0) return err('invalid', 'nothing to change');
  const { rows } = await client.query(
    `UPDATE tasks SET ${sets.join(', ')}
      WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL RETURNING *`,
    vals
  );
  if (!rows[0]) return err('not_found', 'task not found');
  await audit.record(client, ownerId, 'task.edited', { taskId: rows[0].id, changed });
  return ok({ task: rows[0] });
}

// The brain-dump path: all-or-nothing, one call. Also everyday bulk entry —
// deliberately NOT an onboarding-only feature.
//
// `parentId` makes this the SPLIT path as well: one goal into its parts in a
// single call. Without it, breaking "I need to sell three of my cars" into the
// three separate sales it actually is meant three sequential add_task calls —
// the very loop the doctrine forbids for a dump — so in practice a big goal
// got saved as one undoable line, or not at all. Splitting has to be cheaper
// than not splitting.
async function addTasksBulk(client, ownerId, items, { parentId, source } = {}) {
  if (!Array.isArray(items) || items.length === 0) return err('invalid', 'items required');
  if (items.length > MAX_BULK) return err('invalid', `max ${MAX_BULK} items per call`);
  if (parentId) {
    const check = await checkParent(client, ownerId, parentId);
    if (!check.ok) return check;
  }
  const rowSource = source || (parentId ? 'breakdown' : 'brain_dump');
  const created = [];
  for (const item of items) {
    if (!item || !item.title || !item.title.trim()) return err('invalid', 'every item needs a title');
    if (item.dueAt && !hasOffset(item.dueAt)) return badTime(`due_at for "${item.title.trim().slice(0, 40)}"`, item.dueAt);
    const { rows } = await client.query(
      `INSERT INTO tasks (owner_id, title, category, due_at, parent_id, source)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [ownerId, item.title.trim(), item.category || null, item.dueAt || null,
        parentId || null, rowSource]
    );
    created.push(rows[0]);
  }
  await audit.record(client, ownerId, 'task.bulk_created', {
    count: created.length, parentId: parentId || null,
  });
  return ok({ tasks: created });
}

async function listTasks(client, ownerId, { status, includeArchived } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM tasks
     WHERE owner_id = $1
       AND ($2::text IS NULL OR status = $2)
       AND (archived_at IS NULL OR $3)
     ORDER BY parent_id NULLS FIRST, due_at NULLS LAST, id`,
    [ownerId, status || null, Boolean(includeArchived)]
  );
  return ok({ tasks: rows });
}

// Completing a task auto-cancels its pending reminders — no reminding about
// something already finished. Returns how many were cancelled so adapters can
// mention it.
//
// EXCEPT when the task carries a live repeating reminder, which makes it a
// STANDING task: doing the dishes on Monday does not finish "clean the dishes
// every Monday and Thursday". This used to mark the task done and cancel every
// pending reminder — and the sweep writes the next occurrence as a pending row
// the moment it fires, so one "סיימתי" silently ended the recurrence for good.
// Confirmed live: user 3's task 17 ("לנקות את הכלים", weekly:MO,TH) was
// completed on 2026-08-27 and has not reminded anyone since.
//
// So an occurrence is acknowledged and the recurrence is left armed. Finishing
// with a standing task for real is two steps and says so: cancel_reminder to
// stop the cadence, then complete_task.
async function completeTask(client, ownerId, taskId) {
  const { rows: standing } = await client.query(
    `SELECT r.id, r.remind_at, r.repeat_rule
       FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE r.task_id = $1 AND t.owner_id = $2
        AND t.status = 'open' AND t.archived_at IS NULL
        AND r.repeat_rule IS NOT NULL
        AND r.sent_at IS NULL AND r.cancelled_at IS NULL
      ORDER BY r.remind_at LIMIT 1`,
    [taskId, ownerId]
  );
  if (standing[0]) {
    const { rows: t } = await client.query(
      `SELECT * FROM tasks WHERE id = $1 AND owner_id = $2`, [taskId, ownerId]);
    await audit.record(client, ownerId, 'task.occurrence_completed', {
      taskId, reminderId: Number(standing[0].id), repeatRule: standing[0].repeat_rule,
    });
    return ok({
      task: t[0],
      recurring: true,
      repeatRule: standing[0].repeat_rule,
      nextRemindAt: standing[0].remind_at,
      remindersCancelled: 0,
    });
  }
  const { rows } = await client.query(
    `UPDATE tasks SET status = 'done', completed_at = now()
     WHERE id = $1 AND owner_id = $2 AND status = 'open' AND archived_at IS NULL
     RETURNING *`,
    [taskId, ownerId]
  );
  if (!rows[0]) return err('not_found', 'open task not found');
  const cancelled = await client.query(
    `UPDATE task_reminders SET cancelled_at = now()
     WHERE task_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL
     RETURNING id`,
    [taskId]
  );
  await audit.record(client, ownerId, 'task.completed', {
    taskId, remindersCancelled: cancelled.rowCount,
  });
  return ok({ task: rows[0], remindersCancelled: cancelled.rowCount });
}

// A snooze is the one action here that DESTROYS the thing it is about: the
// UPDATE overwrites the very due_at the person is pushing away from, so the
// audit row used to say "moved to Sunday 17:00" with no way to know whether
// that was two hours later or the fourth postponement of the same errand.
// Everything else this feature would want is already derivable from columns
// that exist — completed_at against due_at, task_reminders.sent_at against
// completed_at — which is why only this function needs to write anything new.
// The old value is read inside the same statement so a concurrent snooze
// cannot slip between the read and the write.
async function snoozeTask(client, ownerId, taskId, newDueAt) {
  if (!newDueAt) return err('invalid', 'new due date required');
  if (!hasOffset(newDueAt)) return badTime('new_due_at', newDueAt);
  const { rows } = await client.query(
    `WITH prev AS (
       SELECT id, due_at FROM tasks
        WHERE id = $1 AND owner_id = $2 AND status = 'open' AND archived_at IS NULL
        FOR UPDATE
     )
     UPDATE tasks t SET due_at = $3 FROM prev
      WHERE t.id = prev.id
     RETURNING t.*, prev.due_at AS prev_due_at`,
    [taskId, ownerId, newDueAt]
  );
  if (!rows[0]) return err('not_found', 'open task not found');
  const { prev_due_at: fromDueAt, ...task } = rows[0];

  // Context that cannot be reconstructed later: how far the task moved, how
  // many times it has moved before, and whether a reminder had already fired
  // — a postponement AFTER being nudged means something different from one
  // the person made on their own.
  const { rows: ctx } = await client.query(
    `SELECT (SELECT count(*)::int FROM task_reminders
              WHERE task_id = $1 AND sent_at IS NOT NULL) AS reminders_fired,
            (SELECT count(*)::int FROM audit_log
              WHERE actor_id = $2 AND event = 'task.snoozed'
                AND detail->>'taskId' = $1::text) AS prior_snoozes`,
    [taskId, ownerId]
  );
  const { reminders_fired: remindersFired, prior_snoozes: priorSnoozes } = ctx[0];

  await audit.record(client, ownerId, 'task.snoozed', {
    taskId,
    newDueAt,
    // null when the task had no due date at all — snoozing an undated task is
    // setting a date, not postponing one, and the two must not average together.
    fromDueAt: fromDueAt ? fromDueAt.toISOString() : null,
    pushedMinutes: fromDueAt
      ? Math.round((new Date(newDueAt) - fromDueAt) / 60000)
      : null,
    snoozeCount: priorSnoozes + 1,
    afterReminder: remindersFired > 0,
  });
  return ok({ task });
}

async function archiveTask(client, ownerId, taskId) {
  const { rows } = await client.query(
    `UPDATE tasks SET archived_at = now()
     WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL RETURNING id`,
    [taskId, ownerId]
  );
  if (!rows[0]) return err('not_found', 'task not found');
  await audit.record(client, ownerId, 'task.archived', { taskId });
  return ok({ taskId });
}

// Out of the archive and back onto the list. The archive is the only place a
// task ever goes when somebody "deletes" one, so this is the other half of a
// pair that already had one — without it the archive was a one-way door, and
// a person who tidied away the wrong row had no way back through the screen
// that showed them it was still there.
//
// It does NOT un-complete anything: a finished task restored is a finished
// task on the list, and deciding otherwise would silently reopen work
// somebody had already done.
async function unarchiveTask(client, ownerId, taskId) {
  const { rows } = await client.query(
    `UPDATE tasks SET archived_at = NULL
     WHERE id = $1 AND owner_id = $2 AND archived_at IS NOT NULL RETURNING id`,
    [taskId, ownerId]
  );
  if (!rows[0]) return err('not_found', 'archived task not found');
  await audit.record(client, ownerId, 'task.unarchived', { taskId });
  return ok({ taskId });
}

async function projectOverview(client, ownerId, projectId) {
  const { rows } = await client.query(
    `SELECT * FROM tasks WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL`,
    [projectId, ownerId]
  );
  if (!rows[0]) return err('not_found', 'project not found');
  const subs = await client.query(
    `SELECT * FROM tasks WHERE parent_id = $1 AND archived_at IS NULL ORDER BY status DESC, due_at NULLS LAST, id`,
    [projectId]
  );
  return ok({ project: rows[0], subtasks: subs.rows });
}

module.exports = {
  MAX_BULK, addTask, addTasksBulk, editTask, listTasks, completeTask,
  snoozeTask, archiveTask, unarchiveTask, projectOverview,
};
