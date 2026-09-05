'use strict';
// tasks — one slice of the tool registry (see ../registry.js).
const {
  tasks, S, tool,
} = require('./_shared');

module.exports = [
  tool('list_my_tasks', 'List your open tasks (status=done for completed).',
    { status: S('string', 'open | done (default open)') }, [],
    (client, user, a) => tasks.listTasks(client, user.id, { status: a.status || 'open' })),
  tool('add_task', 'Add one task. Use parent_task_id to add a subtask to a project (one level). If due_at is given it MUST carry a UTC offset (2026-08-20T09:00:00+03:00) — a bare local time is rejected; convert from the user\'s own stated local time using their timezone (USER.md), never write their local digits with a bare Z.',
    { title: S('string', 'Task title'), category: S('string', 'Optional category'),
      due_at: S('string', 'Optional ISO-8601 datetime WITH UTC offset, e.g. 2026-08-20T09:00:00+03:00'), parent_task_id: S('number', 'Optional parent (project) id') }, ['title'],
    (client, user, a) => tasks.addTask(client, user.id, {
      title: a.title, category: a.category, dueAt: a.due_at, parentId: a.parent_task_id,
    })),
  tool('add_tasks_bulk', 'Save a whole dump in ONE call (max 60 items). Never loop add_task. Also the way to SPLIT a goal into its parts: pass parent_task_id and the parts become subtasks of it in the same single call. Any due_at given MUST carry a UTC offset (2026-08-20T09:00:00+03:00) — convert from the user\'s own stated local time using their timezone (USER.md), never write their local digits with a bare Z.',
    { items: S('array', 'Array of {title, category?, due_at?} — due_at, if given, ISO-8601 WITH UTC offset', { items: { type: 'object' } }),
      parent_task_id: S('number', 'Optional: save every item as a subtask of this project (one level)') }, ['items'],
    (client, user, a) => tasks.addTasksBulk(client, user.id, (a.items || []).map((i) => ({
      title: i.title, category: i.category, dueAt: i.due_at,
    })), { parentId: a.parent_task_id })),
  tool('complete_task', 'Mark a task done. Pending reminders on it are cancelled automatically. If the task carries a REPEATING reminder it is a standing one — the reply comes back with recurring:true and nextRemindAt, the task stays open and the cadence stays armed, because doing it once does not finish it. Say when it next comes round. To end a standing task for good: cancel_reminder first, then complete_task.',
    { task_id: S('number', 'Task id') }, ['task_id'],
    (client, user, a) => tasks.completeTask(client, user.id, a.task_id)),
  tool('snooze_task', 'Move a task\'s due date. new_due_at MUST carry a UTC offset (2026-08-20T09:00:00+03:00); a bare local time is rejected.',
    { task_id: S('number', 'Task id'), new_due_at: S('string', 'New ISO-8601 datetime WITH UTC offset') }, ['task_id', 'new_due_at'],
    (client, user, a) => tasks.snoozeTask(client, user.id, a.task_id, a.new_due_at)),
  tool('archive_task', 'Archive a task out of every view.',
    { task_id: S('number', 'Task id') }, ['task_id'],
    (client, user, a) => tasks.archiveTask(client, user.id, a.task_id)),
  tool('get_project_overview', 'A project (parent task) with its subtasks.',
    { project_id: S('number', 'Parent task id') }, ['project_id'],
    (client, user, a) => tasks.projectOverview(client, user.id, a.project_id)),
];
