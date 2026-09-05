'use strict';
// Tasks + one level of project nesting. Every function is owner-scoped by
// construction — ownerId comes from resolveByToken, never from the caller's
// arguments. Editor-shared task mutation goes through shares.js (which calls
// back in here after its own permission check), keeping one write path.
const { ok, err } = require('./results');
const audit = require('./audit');
const { hasOffset, badTime } = require('./datetime');
const reminders = require('./reminders');
const autoReminder = require('./auto-reminder');
const shopping = require('./shopping-list');
const taskCategory = require('./task-category');
const taskKind = require('./task-kind');

const MAX_BULK = 60;

// One place that decides whether a parent is usable, so add_task and the bulk
// split path can never disagree about what "one level of nesting" means.
async function checkParent(client, ownerId, parentId) {
  const { rows } = await client.query(
    `SELECT id, parent_id, category FROM tasks WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL`,
    [parentId, ownerId]
  );
  if (!rows[0]) return err('not_found', 'parent task not found');
  if (rows[0].parent_id) return err('invalid', 'only one level of nesting');
  return ok({ parent: rows[0] });
}

// An end without a start is not a range, and an end before its start is not a
// time. Both are refused rather than stored: a half-written range would draw
// on the day view as a block with no top edge, and the calendar event built
// from it would be negative-length.
function checkRange(dueAt, endsAt, label = '') {
  if (!endsAt) return null;
  if (!hasOffset(endsAt)) return badTime(`ends_at${label ? ` for ${label}` : ''}`, endsAt);
  if (!dueAt) return err('invalid', `ends_at${label ? ` for ${label}` : ''} needs a due_at to end`);
  if (new Date(endsAt).getTime() <= new Date(dueAt).getTime()) {
    return err('invalid', `ends_at${label ? ` for ${label}` : ''} must be after due_at`);
  }
  return null;
}

function pickCategory({ category, title, parent }) {
  const decided = taskCategory.decideCategory({ category, title });
  if (decided.category) return decided;
  if (parent && parent.category) return { category: parent.category, auto: true };
  return { category: null, auto: false };
}

// Every task gets a category, and it is decided here rather than asked of the
// model — see task-category.js for why keywords and not a turn. A subtask
// inherits its parent's category when its own words say nothing, which is the
// single highest-value rule in the whole scheme: a shopping list's items are
// `ירקות`, `פירות`, `קוטג׳` — no stem list will ever place those, and the
// project they hang under already answers the question.
//
// `kind` is decided the same way and for the same reasons (task-kind.js): it
// is what lets a passed appointment leave the list while a job that is merely
// late stays on it.
async function addTask(client, ownerId, { title, category, dueAt, endsAt, parentId, source, now }) {
  if (!title || !title.trim()) return err('invalid', 'title required');
  if (dueAt && !hasOffset(dueAt)) return badTime('due_at', dueAt);
  const range = checkRange(dueAt, endsAt);
  if (range) return range;
  let parent = null;
  if (parentId) {
    const check = await checkParent(client, ownerId, parentId);
    if (!check.ok) return check;
    parent = check.data.parent;
  }
  // "לקנות חלב, קוטג׳ וגבינה צהובה" is three things, not one line nobody can
  // tick off halfway. Recognised in code (domain/shopping-list.js) rather than
  // by asking the model, because this fires on a large share of what people
  // dictate and a per-task token cost is the wrong price for a formatting
  // call. Only ever at the top level: an item added INTO a project was already
  // split by whoever chose the parent, and re-splitting it would nest twice.
  if (!parentId) {
    const list = await shopping.absorb(client, ownerId, { title, dueAt, source });
    if (list) return list;
  }
  const cat = pickCategory({ category, title, parent });
  const { rows } = await client.query(
    `INSERT INTO tasks (owner_id, title, category, category_auto, due_at, ends_at, kind, parent_id, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'chat')) RETURNING *`,
    [ownerId, title.trim(), cat.category, cat.auto, dueAt || null, endsAt || null,
      taskKind.decideKind({ title }), parentId || null, source || null]
  );
  await audit.record(client, ownerId, 'task.created', { taskId: rows[0].id, parentId: parentId || null });
  const auto = await autoAttach(client, ownerId, [rows[0]], now);
  return ok({ task: rows[0], ...auto });
}

// Give every task that arrived with a moment its reminder, and say what
// happened. Shared by add_task and add_tasks_bulk so the two can never disagree
// about it — they already did once, which is why this exists: on 2026-09-04 one
// task in a five-item dump was offered a reminder and another with an equally
// real due date was not, because it came down to what the model remembered.
//
// `reminders` are rows, `autoRemindersSkipped` is the count the per-call cap
// refused. Reporting the second is not decoration: a cap nobody is told about
// reads as "everything was covered" (CLAUDE.md, no silent caps), and the model
// needs it to offer the rest rather than leave them silently unarmed.
async function autoAttach(client, ownerId, tasks, now) {
  const timed = tasks.filter((t) => t.due_at);
  if (!timed.length) return {};
  const { rows: u } = await client.query(`SELECT timezone FROM users WHERE id = $1`, [ownerId]);
  const tz = (u[0] && u[0].timezone) || 'UTC';
  const made = [];
  let skipped = 0;
  for (const t of timed) {
    if (made.length >= autoReminder.BULK_CAP) { skipped++; continue; }
    const r = await reminders.attachAutoReminder(client, ownerId, t, tz, now);
    if (r) made.push(r);
  }
  if (!made.length && !skipped) return {};
  return { reminders: made, ...(skipped ? { autoRemindersSkipped: skipped } : {}) };
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
    // An edit is a person pointing at the field, so whatever comes out of it
    // is theirs: `category_auto` goes false and the guesser stops touching it.
    // Off-vocabulary text is still folded onto a key rather than refused —
    // `בריאות` means health, and rejecting it would only teach the caller to
    // send nothing.
    const raw = patch.category == null ? null : String(patch.category).trim() || null;
    const category = raw == null ? null : taskCategory.normaliseCategory(raw);
    sets.push(`category = $${vals.push(category)}`);
    sets.push('category_auto = false');
    changed.category = category;
  }
  if (has('dueAt')) {
    // Same rule as add_task, and for the same incident: a bare local time gets
    // read in the server's zone and lands hours off (the shift stored as 15:00Z).
    if (patch.dueAt != null && !hasOffset(patch.dueAt)) return badTime('due_at', patch.dueAt);
    sets.push(`due_at = $${vals.push(patch.dueAt ?? null)}`);
    changed.dueAt = patch.dueAt ?? null;
  }
  // The two ends of a range are validated against EACH OTHER, so the pair has
  // to be resolved against what the row already holds — moving only the start
  // of a 12:00–19:00 shift to 20:00 is exactly as broken as writing the pair
  // that way in one call, and a check that only looked at the patch would miss
  // it. Clearing the start clears the end with it: an end alone is not a time.
  if (has('endsAt') || has('dueAt')) {
    const { rows: cur } = await client.query(
      `SELECT due_at, ends_at FROM tasks WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL`,
      [taskId, ownerId]
    );
    if (!cur[0]) return err('not_found', 'task not found');
    const iso = (v) => (v instanceof Date ? v.toISOString() : v);
    const nextDue = has('dueAt') ? patch.dueAt ?? null : iso(cur[0].due_at);
    let nextEnd = has('endsAt') ? patch.endsAt ?? null : iso(cur[0].ends_at);
    if (nextEnd && !nextDue) nextEnd = null;
    if (nextEnd) {
      const bad = checkRange(nextDue, has('endsAt') ? patch.endsAt : nextEnd);
      if (bad) return bad;
    }
    if (has('endsAt') || nextEnd !== iso(cur[0].ends_at)) {
      sets.push(`ends_at = $${vals.push(nextEnd)}`);
      changed.endsAt = nextEnd;
    }
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
async function addTasksBulk(client, ownerId, items, { parentId, source, now } = {}) {
  if (!Array.isArray(items) || items.length === 0) return err('invalid', 'items required');
  if (items.length > MAX_BULK) return err('invalid', `max ${MAX_BULK} items per call`);
  let parent = null;
  if (parentId) {
    const check = await checkParent(client, ownerId, parentId);
    if (!check.ok) return check;
    parent = check.data.parent;
  }
  const rowSource = source || (parentId ? 'breakdown' : 'brain_dump');
  const created = [];
  for (const item of items) {
    if (!item || !item.title || !item.title.trim()) return err('invalid', 'every item needs a title');
    if (item.dueAt && !hasOffset(item.dueAt)) return badTime(`due_at for "${item.title.trim().slice(0, 40)}"`, item.dueAt);
    const bad = checkRange(item.dueAt, item.endsAt, `"${item.title.trim().slice(0, 40)}"`);
    if (bad) return bad;
    const cat = pickCategory({ category: item.category, title: item.title, parent });
    const { rows } = await client.query(
      `INSERT INTO tasks (owner_id, title, category, category_auto, due_at, ends_at, kind, parent_id, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [ownerId, item.title.trim(), cat.category, cat.auto, item.dueAt || null,
        item.endsAt || null, taskKind.decideKind({ title: item.title }), parentId || null, rowSource]
    );
    created.push(rows[0]);
  }
  await audit.record(client, ownerId, 'task.bulk_created', {
    count: created.length, parentId: parentId || null,
  });
  const auto = await autoAttach(client, ownerId, created, now);
  return ok({ tasks: created, ...auto });
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
  const parentDone = await completeParentIfDrained(client, ownerId, rows[0].parent_id);
  return ok({ task: rows[0], remindersCancelled: cancelled.rowCount, ...parentDone });
}

// Ticking the last item off a list finishes the list.
//
// It did not, and the evidence was sitting in production: `סופר` with six
// subtasks, six of them done, the project itself still open and still on
// somebody's list. Every individual step had been reported and the thing they
// were actually doing was never marked as over — so the list kept asking, and
// the only way to close it was to notice by eye and say so.
//
// A project with no children is NOT drained. `0 of 0 done` is arithmetically
// true and means "nothing has been broken out yet", which is the opposite of
// finished; without that guard, adding an empty project would complete it on
// the spot.
//
// Returns `{ parentCompleted }` so the caller can say so — the agent in its
// tool result, the page in its toast. A thing that happened silently is a
// thing the person finds out about by rereading their own list.
async function completeParentIfDrained(client, ownerId, parentId) {
  if (!parentId) return {};
  const { rows } = await client.query(
    `UPDATE tasks p SET status = 'done', completed_at = now()
      WHERE p.id = $1 AND p.owner_id = $2 AND p.status = 'open' AND p.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = p.id AND c.archived_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM tasks c
                         WHERE c.parent_id = p.id AND c.archived_at IS NULL AND c.status <> 'done')
      RETURNING id, title`,
    [parentId, ownerId]
  );
  if (!rows[0]) return {};
  await client.query(
    `UPDATE task_reminders SET cancelled_at = now()
      WHERE task_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL`,
    [rows[0].id]
  );
  await audit.record(client, ownerId, 'task.completed', {
    taskId: Number(rows[0].id), reason: 'all_subtasks_done',
  });
  return { parentCompleted: { id: Number(rows[0].id), title: rows[0].title } };
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
// "Put it back on my list" means back on the list, open. Clearing only
// `archived_at` returned it already ticked — and both faces of the system
// promise otherwise: the page's own comment says a restored shopping list must
// not come back empty, and the sweep that archives a task on its own is only
// honest if the way back is complete. There is no caller for whom
// "un-archived but still done" is a state worth having.
async function unarchiveTask(client, ownerId, taskId) {
  const { rows } = await client.query(
    `UPDATE tasks SET archived_at = NULL, status = 'open', completed_at = NULL
     WHERE id = $1 AND owner_id = $2
       AND (archived_at IS NOT NULL OR status = 'done') RETURNING id, title`,
    [taskId, ownerId]
  );
  // `status = 'done'` is in that guard because a completed task is not
  // necessarily an archived one: `complete_task` from chat sets the status and
  // nothing else, and those rows now sit in the page's archive (see
  // user-dashboard.js). Asking only about `archived_at` would have put a way
  // back on screen and then refused it — the same shape of bug this is fixing.
  if (!rows[0]) return err('not_found', 'finished task not found');
  await audit.record(client, ownerId, 'task.unarchived', { taskId });
  return ok({ taskId, title: rows[0].title });
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
  completeParentIfDrained,
};
