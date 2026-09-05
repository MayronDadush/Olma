'use strict';
// reminders — one slice of the tool registry (see ../registry.js).
const {
  reminders, S, tool,
} = require('./_shared');

module.exports = [
  tool('set_task_reminder', 'Attach a reminder to a task. Several per task allowed. remind_at MUST carry a UTC offset (2026-08-20T09:00:00+03:00); a bare local time is rejected — convert from the user\'s own stated local time using their timezone (USER.md), never write their local digits with a bare Z.',
    { task_id: S('number', 'Task id'), remind_at: S('string', 'ISO-8601 datetime WITH UTC offset'),
      repeat_rule: S('string', 'Optional repeat: "daily"; "weekly"; "weekly:MO,TH" for specific weekdays (SU MO TU WE TH FR SA); "monthly:16" for a day of the month; "monthly:last" for the last day of every month, whatever it is. A day past the end of a short month lands on that month\'s last day. Anything unrecognised is stored as a ONE-OFF, so use these exact forms.') }, ['task_id', 'remind_at'],
    (client, user, a) => reminders.setReminder(client, user.id, a.task_id, a.remind_at, a.repeat_rule)),
  tool('cancel_reminder', 'Cancel a pending reminder.',
    { reminder_id: S('number', 'Reminder id') }, ['reminder_id'],
    (client, user, a) => reminders.cancelReminder(client, user.id, a.reminder_id)),
  tool('list_my_reminders', 'List pending reminders, optionally for one task.',
    { task_id: S('number', 'Optional task id') }, [],
    (client, user, a) => reminders.listReminders(client, user.id, a.task_id)),
];
