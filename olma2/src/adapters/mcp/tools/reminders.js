'use strict';
// reminders — one slice of the tool registry (see ../registry.js).
const {
  reminders, S, tool, ok,
} = require('./_shared');

module.exports = [
  tool('set_task_reminder', 'Attach a reminder to a task, for a moment they ASKED for. A task saved with a due_at already has one, so this is for a different time or a repeat — it cancels the automatic one, so you get what they asked for and not two. Several per task allowed. remind_at MUST carry a UTC offset (2026-08-20T09:00:00+03:00); a bare local time is rejected — convert from the user\'s own stated local time using their timezone (USER.md), never write their local digits with a bare Z.',
    { task_id: S('number', 'Task id'), remind_at: S('string', 'ISO-8601 datetime WITH UTC offset'),
      repeat_rule: S('string', 'Optional repeat: "daily"; "weekly"; "weekly:MO,TH" (SU MO TU WE TH FR SA); "monthly:16"; "monthly:last" (the last day, whatever it is; a day past a short month lands on its last day). Anything else is stored as a ONE-OFF, so use these exact forms.') }, ['task_id', 'remind_at'],
    (client, user, a) => reminders.setReminder(client, user.id, a.task_id, a.remind_at, a.repeat_rule)),
  tool('cancel_reminder', 'Cancel a pending reminder. If the result carries taskStillOpen, follow its hint — "cancel the reminder" and "cancel the thing" are the same sentence to most people.',
    { reminder_id: S('number', 'Reminder id') }, ['reminder_id'],
    async (client, user, a) => {
      const res = await reminders.cancelReminder(client, user.id, a.reminder_id);
      if (!res.ok || !res.data || !res.data.taskStillOpen) return res;
      // The task is now live with nothing left to raise it. Said here, on the
      // one call where it is true, rather than in the description every turn.
      return ok({ ...res.data, hints: { taskStillOpen: 'ASK, in one short line, whether to drop the task '
        + 'as well; never decide it for them. Say nothing if this cancel is step one of ending a standing '
        + 'task — there complete_task is your own next call and the question is already answered.' } });
    }),
  tool('list_my_reminders', 'List pending reminders, optionally for one task.',
    { task_id: S('number', 'Optional task id') }, [],
    (client, user, a) => reminders.listReminders(client, user.id, a.task_id)),
];
