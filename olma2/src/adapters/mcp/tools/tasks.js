'use strict';
// tasks — one slice of the tool registry (see ../registry.js).
const {
  tasks, S, tool, ok,
} = require('./_shared');
const dt = require('../../../domain/datetime');

// What to tell the person about what add_task/add_tasks_bulk just did — on
// the RESULT, only on the calls where it applies, rather than four sentences
// in a description every turn pays for (the same budget rule as turn_start's
// hints). The fields themselves come from domain/tasks.js and
// domain/shopping-list.js; this only explains them.
function taskHints(res, user = {}) {
  if (!res || !res.ok || !res.data) return res;
  const d = res.data;
  const hints = {};
  if (d.shoppingList) {
    hints.shoppingList = 'This went onto their shopping list as items — say what went on the list, '
      + 'not that you created a task. merged:true means it joined the run already open; alreadyOnList '
      + 'names what was there; dueAtIgnored means a date they gave was NOT applied to the existing '
      + 'list — offer it rather than assume it.';
  }
  // A date lifted off the noun instead of off the work. `datesTheObject` fires
  // only where the two readings diverge — ל+weekday in the title AND the task
  // filed on that very weekday — and it reports rather than decides, because
  // resolving it needs the conversation and it only has a string. See
  // domain/datetime.js for Vered's evening, which is the founding case.
  const objectDated = [d.task, ...(Array.isArray(d.tasks) ? d.tasks : [])]
    .filter(Boolean)
    .map((t) => {
      const m = dt.datesTheObject(t.title, t.due_at, user.timezone);
      return m ? `"${t.title}"` : null;
    })
    .filter(Boolean);
  if (objectDated.length) {
    hints.objectDated = `${objectDated.join(', ')} — the day in the title is when the THING is, `
      + 'and it is also the day this was filed on. If the task is to ARRANGE or PREPARE for it, '
      + 'it has to happen earlier: move it with edit_task to when they would actually do it, and '
      + 'say which day you put it on. If the task IS the thing, leave it and say nothing.';
  }
  // Two asks that arrived in one sentence. Reports rather than splits, for the
  // same reason objectDated does: only the model knows whether "ואז" joined two
  // errands or narrated the steps of one. See domain/tasks.joinsTwoAsks for why
  // the pattern is as narrow as it is.
  const twoAsks = [d.task, ...(Array.isArray(d.tasks) ? d.tasks : [])]
    .filter(Boolean)
    .filter((t) => tasks.joinsTwoAsks(t.title))
    .map((t) => `"${t.title}"`);
  if (twoAsks.length) {
    hints.twoAsks = `${twoAsks.join(', ')} — this reads as TWO things joined by ו, saved as one. `
      + 'If they are two separate asks, split it: edit_task the first one down to its own half and '
      + 'add_task the second, then say what you did in one line. If it is one job described in '
      + 'steps, leave it and say nothing.';
  }
  if (Array.isArray(d.reminders) && d.reminders.length) {
    // The times are stated back, in their zone, because the model cannot say a
    // moment nobody armed if the armed moment is the only one on the result.
    // Yahav (2026-09-05) was told 19:00 for a reminder set to 18:00 — the due
    // date was the nearest time to hand and the hint asked for a sentence.
    //
    // The two branches differ in whether there is anything to SAY, which is
    // not the same question as whether a reminder exists. An hour Olma picked
    // is news. An hour they named is not: they said it themselves one message
    // ago. Both branches therefore stay silent about the save itself — that is
    // what the 👍 on their message is for, and a sentence repeating it is a
    // second notification for one fact (Miron, 2026-09-06: 'הוספתי ✅ ...
    // לתזכורת עוד שעתיים' under a live `hints.markPlaced`). The old wording
    // here — "say when you will remind them" — was unconditional, and an
    // unconditional instruction to write beats markPlaced's conditional one
    // every time; that, not a missing hint, is why the mark kept getting
    // talked over.
    const at = Array.isArray(d.remindersAt) && d.remindersAt.length ? ` (${d.remindersAt.join(', ')}, their time)` : '';
    hints.reminders = d.remindersAsked
      ? `Armed for the hour they themselves named${at}: they already know it, so this is not a reason `
        + 'to write. Say nothing about the reminder unless something here differs from what they asked.'
      : `Reminders were armed automatically${at} — that hour is the one thing worth saying, in one short `
        + 'line, and never the due time. Do not also say the task was saved, and do not ask permission. '
        + 'Only call set_task_reminder if they wanted a different moment or a repeat; if they said '
        + '"remind me at X", X was the reminder and belongs in add_task\'s remind_at.';
  }
  if (d.autoRemindersSkipped) {
    hints.autoRemindersSkipped = `${d.autoRemindersSkipped} timed item(s) went past the per-call reminder cap and `
      + 'still have none — offer to set those.';
  }
  return Object.keys(hints).length ? ok({ ...d, hints }) : res;
}

module.exports = [
  tool('list_my_tasks', 'List your open tasks (status=done for completed). Each carries its pending reminders with the hour to SAY, in their clock — a due date is when the thing is, never when you will remind them.',
    { status: S('string', 'open | done (default open)') }, [],
    (client, user, a) => tasks.listTasks(client, user.id, { status: a.status || 'open' })),
  tool('add_task', 'Add one task; parent_task_id makes it a subtask (one level). due_at is when the THING is, and arms a reminder automatically an hour before (08:00 for a whole-day one). remind_at is for "תזכיר לי ב-19:00": that hour IS the reminder and replaces the automatic one. A dictated shopping run is filed as a list. Follow any hints on the reply. Times MUST carry a UTC offset (2026-08-20T09:00:00+03:00), from their own local time (USER.md); never bare digits with a Z.',
    { title: S('string', 'Task title'), category: S('string', 'home|work|family|health|money|errands; omit unless the person named one (worked out from the title).'),
      due_at: S('string', 'Optional ISO-8601 datetime WITH UTC offset, e.g. 2026-08-20T09:00:00+03:00'),
      ends_at: S('string', 'Optional end of a range, same format: a shift is title \'משמרת\', due_at 12:00, ends_at 19:00 — never hours in the title.'),
      remind_at: S('string', 'The hour THEY named to be reminded, same format. Replaces the automatic one.'),
      parent_task_id: S('number', 'Optional parent (project) id') }, ['title'],
    async (client, user, a) => taskHints(await tasks.addTask(client, user.id, {
      title: a.title, category: a.category, dueAt: a.due_at, endsAt: a.ends_at,
      remindAt: a.remind_at, parentId: a.parent_task_id,
    }), user)),
  tool('add_tasks_bulk', 'Save a whole dump in ONE call (max 60 items). Never loop add_task. Also the way to SPLIT a goal into its parts: pass parent_task_id and the parts become subtasks in the same call. Timed items get their reminders automatically; when the reply carries hints, follow them. Any due_at MUST carry a UTC offset (2026-08-20T09:00:00+03:00), converted from their own local time (USER.md); never bare digits with a Z.',
    { items: S('array', 'Array of {title, category?, due_at?, ends_at?}; due_at ISO-8601 WITH UTC offset; category as in add_task.', { items: { type: 'object' } }),
      parent_task_id: S('number', 'Optional: save every item as a subtask of this project (one level)') }, ['items'],
    async (client, user, a) => taskHints(await tasks.addTasksBulk(client, user.id, (a.items || []).map((i) => ({
      title: i.title, category: i.category, dueAt: i.due_at, endsAt: i.ends_at,
    })), { parentId: a.parent_task_id }), user)),
  tool('complete_task', 'Mark a task done. Pending reminders on it are cancelled automatically. If the task carries a REPEATING reminder it is a standing one — the reply comes back with recurring:true and nextRemindAt, the task stays open and the cadence stays armed, because doing it once does not finish it. Say when it next comes round. To end a standing task for good: cancel_reminder first, then complete_task.',
    { task_id: S('number', 'Task id') }, ['task_id'],
    (client, user, a) => tasks.completeTask(client, user.id, a.task_id)),
  tool('snooze_task', 'Move a task\'s due date. new_due_at MUST carry a UTC offset (2026-08-20T09:00:00+03:00); a bare local time is rejected.',
    { task_id: S('number', 'Task id'), new_due_at: S('string', 'New ISO-8601 datetime WITH UTC offset') }, ['task_id', 'new_due_at'],
    (client, user, a) => tasks.snoozeTask(client, user.id, a.task_id, a.new_due_at)),
  tool('edit_task', 'Change an existing task\'s title, category or time — WITHOUT losing its reminders or place under a project. Send only the fields you are changing; null clears one. Gives a task an end time: a shift saved as "משמרת - ראשון 12:00-19:00" becomes title "משמרת", due_at 12:00, ends_at 19:00.',
    { task_id: S('number', 'Task id'), title: S('string', 'Optional new title'),
      category: S('string', 'One of home|work|family|health|money|errands — only when the person named it; marks it as their choice.'),
      due_at: S('string', 'Optional new start, ISO-8601 WITH UTC offset'),
      ends_at: S('string', 'Optional new end, ISO-8601 WITH UTC offset, after due_at.') }, ['task_id'],
    (client, user, a) => tasks.editTask(client, user.id, a.task_id, {
      ...(a.title === undefined ? {} : { title: a.title }),
      ...(a.category === undefined ? {} : { category: a.category }),
      ...(a.due_at === undefined ? {} : { dueAt: a.due_at }),
      ...(a.ends_at === undefined ? {} : { endsAt: a.ends_at }),
    })),
  tool('restore_task', 'Put an archived task back on the open list, OPEN with its subtasks intact — the way back from anything Olma closed on its own (a passed appointment, a fully-ticked project).',
    { task_id: S('number', 'Task id') }, ['task_id'],
    (client, user, a) => tasks.unarchiveTask(client, user.id, a.task_id)),
  tool('archive_task', 'Archive a task out of every view.',
    { task_id: S('number', 'Task id') }, ['task_id'],
    (client, user, a) => tasks.archiveTask(client, user.id, a.task_id)),
  tool('get_project_overview', 'A project (parent task) with its subtasks.',
    { project_id: S('number', 'Parent task id') }, ['project_id'],
    (client, user, a) => tasks.projectOverview(client, user.id, a.project_id)),
];
