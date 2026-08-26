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
async function completeTask(client, ownerId, taskId) {
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

async function snoozeTask(client, ownerId, taskId, newDueAt) {
  if (!newDueAt) return err('invalid', 'new due date required');
  if (!hasOffset(newDueAt)) return badTime('new_due_at', newDueAt);
  const { rows } = await client.query(
    `UPDATE tasks SET due_at = $3
     WHERE id = $1 AND owner_id = $2 AND status = 'open' AND archived_at IS NULL
     RETURNING *`,
    [taskId, ownerId, newDueAt]
  );
  if (!rows[0]) return err('not_found', 'open task not found');
  await audit.record(client, ownerId, 'task.snoozed', { taskId, newDueAt });
  return ok({ task: rows[0] });
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
  MAX_BULK, addTask, addTasksBulk, listTasks, completeTask,
  snoozeTask, archiveTask, projectOverview,
};
