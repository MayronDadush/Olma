'use strict';
// tasks — one slice of the tool registry (see ../registry.js).
const {
  tasks, users, S, tool, ok,
} = require('./_shared');
const dt = require('../../../domain/datetime');
const format = require('../../../domain/message-format');
const listBlock = require('../../../domain/list-block');

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
  // Part of a dump was already open on their list and was not saved again
  // (domain/tasks.js, "The same thing, saved twice"). The whole-dump case is an
  // ERROR and never reaches here, so this only ever fires where something else
  // WAS saved — which is why it says to name what went in rather than to lead
  // with what did not.
  if (Array.isArray(d.duplicatesSkipped) && d.duplicatesSkipped.length) {
    hints.duplicatesSkipped = `${d.duplicatesSkipped.map((t) => `"${t}"`).join(', ')} — already open `
      + 'on their list, so nothing was saved for those and they are NOT in tasks. Say what you did '
      + 'save; mention the rest only as already being there, and never as newly added.';
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
  // What was filed as an EVENT is on their calendar, not their list, and the
  // one sentence that never fits it is "רשמתי" — that is what a to-do gets.
  // ג.ב (2026-09-07) asked to put a meeting in, was told "הנה, רשמתי" and
  // then, in a second message, about a reminder he had not asked for. The
  // row was right (kind = event, 11:45–12:45); nothing had told the model.
  // Conditional like every other hint here: it says what words to use IF
  // there are words, and never asks for a sentence the 👍 already sent.
  const events = [d.task, ...(Array.isArray(d.tasks) ? d.tasks : [])]
    .filter((t) => t && t.kind === 'event')
    .map((t) => `"${t.title}"`);
  if (events.length) {
    hints.event = `${events.join(', ')} went onto their CALENDAR, not their to-do list: it closes by itself `
      + 'once its time passes and is never chased with "בוצע?". If you say anything about it, say it '
      + 'as a calendar entry — the day, the hour, the place if they gave one ("ביומן: שלישי 11:45, '
      + 'ביהס דרור") — never "רשמתי משימה", and never call it a task.';
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

// The list is ONE array so nothing that reads it by shape breaks. What
// separates it into the two lists the person hears — what is on the calendar,
// then what is on the plate — used to be a paragraph asking the model to do
// it. It is DRAWN now (domain/list-block.js): the layout cannot drift between
// two readings, a row cannot go missing on the way through, and a meeting
// cannot come back called a task, because nothing here builds a mixed list.
//
// The instruction hints are the FALLBACK and never travel beside the block.
// A block handed over with "lay these out as a list" next to it is the
// markPlaced fault exactly — a conditional result outvoted by an unconditional
// sentence sitting on the same result — and here it would be worse than
// outvoted, because it would be asking for the work again after it was done.
async function listHints(client, user, res, status) {
  if (!res || !res.ok || !res.data || !Array.isArray(res.data.tasks)) return res;
  const ch = await users.primaryChannel(client, user.id);
  const block = listBlock.renderTaskListBlock(res.data, {
    locale: user.locale,
    timezone: user.timezone,
    channelType: ch.ok ? ch.data.channel.channel_type : null,
    status,
  });
  if (block) {
    return ok({
      ...res.data,
      block,
      hints: {
        ...(res.data.hints || {}),
        block: `${format.HINTS.relayBlock} Everything you add is at most ONE short sentence around `
          + 'it — the answer to what they actually asked, or the one thing worth doing first. '
          + 'If the list IS the answer, send the block alone.',
      },
    });
  }
  // Two conditions, not one: "there are several of these" and "two of these
  // are different things" are different facts about the same result, and the
  // layout hint has no work to do on a single line.
  if (res.data.tasks.length < 2) return res;
  const layout = { layout: format.HINTS.list };
  if (!res.data.tasks.some((t) => t.kind === 'event')) return ok({ ...res.data, hints: layout });
  return ok({
    ...res.data,
    hints: {
      ...layout,
      kinds: 'kind:"event" rows are CALENDAR entries (a moment they will be at — meeting, appointment, '
        + 'shift; it leaves the list by itself once it passes); kind:"todo" rows are jobs until done. '
        + 'When you tell them what they have, give the calendar first as "ביומן" and the to-dos after '
        + 'as "לעשות" — two short lists, never one mixed one, and never a meeting called a task.',
    },
  });
}

module.exports = [
  tool('list_my_tasks', 'List your open tasks (status=done for completed). Each carries its kind (event = calendar, todo = job) and its pending reminders with the hour to SAY, in their clock — a due date is when the thing is, never when you will remind them.',
    { status: S('string', 'open | done (default open)') }, [],
    async (client, user, a) => {
      const status = a.status || 'open';
      return listHints(client, user, await tasks.listTasks(client, user.id, { status }), status);
    }),
  tool('add_task', 'Add one todo (a job until done) or event (a moment they will be AT; closes when it passes) — say which in kind. due_at is when the THING is, and arms a reminder automatically an hour before (08:00 for a whole-day one). remind_at is for "תזכיר לי ב-19:00": that hour IS the reminder and replaces the automatic one. A dictated shopping run is filed as a list. Follow any hints on the reply. Times MUST carry a UTC offset (2026-08-20T09:00:00+03:00), from their own local time (USER.md); never bare digits with a Z.',
    { title: S('string', 'What it is — never the hours or the place, those have fields'),
      kind: S('string', 'event | todo ("פגישה מחר ב-10" = event, "לקבוע פגישה" = todo); omitted = guessed from the title'),
      location: S('string', 'Where an event is — never in the title'),
      category: S('string', 'home|work|family|health|money|errands; omit unless the person named one (worked out from the title).'),
      due_at: S('string', 'Optional ISO-8601 datetime WITH UTC offset, e.g. 2026-08-20T09:00:00+03:00'),
      ends_at: S('string', 'Optional end of a range, same format: a shift is title \'משמרת\', due_at 12:00, ends_at 19:00 — never hours in the title.'),
      remind_at: S('string', 'The hour THEY named to be reminded, same format. Replaces the automatic one.'),
      parent_task_id: S('number', 'Optional parent (project) id') }, ['title'],
    async (client, user, a) => taskHints(await tasks.addTask(client, user.id, {
      title: a.title, kind: a.kind, location: a.location, category: a.category, dueAt: a.due_at, endsAt: a.ends_at,
      remindAt: a.remind_at, parentId: a.parent_task_id,
    }), user)),
  tool('add_tasks_bulk', 'Save a whole dump in ONE call (max 60 items). Never loop add_task. Also the way to SPLIT a goal into its parts: pass parent_task_id and the parts become subtasks in the same call. Timed items get their reminders automatically; when the reply carries hints, follow them. Any due_at MUST carry a UTC offset (2026-08-20T09:00:00+03:00), converted from their own local time (USER.md); never bare digits with a Z.',
    { items: S('array', 'Array of {title, kind?, location?, category?, due_at?, ends_at?}; kind event|todo, location, category and times as in add_task.', { items: { type: 'object' } }),
      parent_task_id: S('number', 'Optional: save every item as a subtask of this project (one level)') }, ['items'],
    async (client, user, a) => taskHints(await tasks.addTasksBulk(client, user.id, (a.items || []).map((i) => ({
      title: i.title, kind: i.kind, location: i.location, category: i.category, dueAt: i.due_at, endsAt: i.ends_at,
    })), { parentId: a.parent_task_id }), user)),
  tool('complete_task', 'Mark a task done. Pending reminders on it are cancelled automatically. If the task carries a REPEATING reminder it is a standing one — the reply comes back with recurring:true and nextRemindAt, the task stays open and the cadence stays armed, because doing it once does not finish it. Say when it next comes round. To end a standing task for good: cancel_reminder first, then complete_task.',
    { task_id: S('number', 'Task id') }, ['task_id'],
    (client, user, a) => tasks.completeTask(client, user.id, a.task_id)),
  tool('snooze_task', 'Move a task\'s due date; its reminders follow (a rung chasing the old date is closed, the automatic one re-arms an hour before the new one). new_due_at MUST carry a UTC offset (2026-08-20T09:00:00+03:00); a bare local time is rejected.',
    { task_id: S('number', 'Task id'), new_due_at: S('string', 'New ISO-8601 datetime WITH UTC offset') }, ['task_id', 'new_due_at'],
    async (client, user, a) => {
      const res = taskHints(await tasks.snoozeTask(client, user.id, a.task_id, a.new_due_at), user);
      // Deliberately NOT inside `taskHints`: add_task and edit_task go through
      // it too and both earn a 👍, and an unconditional "say this" beside a
      // conditional markPlaced is the fault that put a sentence under a live
      // thumbs-up for two days (CLAUDE.md, "markPlaced is CONDITIONAL").
      // snooze_task earns no mark, so a sentence is expected of it anyway.
      if (!res || !res.ok || !res.data) return res;
      return ok({ ...res.data, hints: { ...(res.data.hints || {}), moved: format.HINTS.struckOut } });
    }),
  tool('edit_task', 'Change an existing task\'s title, kind, location, category or time — WITHOUT losing its reminders or place under a project. Send only the fields you are changing; null clears one. Gives a task an end time: a shift saved as "משמרת - ראשון 12:00-19:00" becomes title "משמרת", due_at 12:00, ends_at 19:00.',
    { task_id: S('number', 'Task id'), title: S('string', 'Optional new title'),
      kind: S('string', 'event | todo'),
      location: S('string', 'Where an event is; null clears it'),
      category: S('string', 'One of home|work|family|health|money|errands — only when the person named it; marks it as their choice.'),
      due_at: S('string', 'Optional new start, ISO-8601 WITH UTC offset'),
      ends_at: S('string', 'Optional new end, ISO-8601 WITH UTC offset, after due_at.') }, ['task_id'],
    (client, user, a) => tasks.editTask(client, user.id, a.task_id, {
      ...(a.title === undefined ? {} : { title: a.title }),
      ...(a.kind === undefined ? {} : { kind: a.kind }),
      ...(a.location === undefined ? {} : { location: a.location }),
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
