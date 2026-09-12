'use strict';
// reminders — one slice of the tool registry (see ../registry.js).
const {
  reminders, users, S, tool, ok,
} = require('./_shared');
const { err } = require('../../../domain/results');
const format = require('../../../domain/message-format');
const listBlock = require('../../../domain/list-block');
const dt = require('../../../domain/datetime');

// The moment is well-formed, carries the right offset, and has already gone.
// Vered's 20:02 arrived at 23:02 (2026-09-06): it fired on the spot, expired
// undelivered, and cancelled the 08:00 she had just been promised on its way
// in. Refusing HERE means setReminder is never reached, so nothing is
// superseded — a moment we will not honour must not withdraw one we would
// have. The domain keeps the predicate and stays permissive on purpose: our
// own sweeps, repairs and tests arm past moments legitimately; only a model
// asking for one is a mistake.
const pad = (n) => String(n).padStart(2, '0');
function pastMoment(label, value, tz) {
  const fmt = (d) => {
    const p = dt.partsInZone(tz || 'Asia/Jerusalem', d);
    return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mi)}`;
  };
  return err('invalid',
    `${label} is already past: ${fmt(new Date(value))} in their timezone, where it is `
    + `now ${fmt(new Date())}. NOTHING was changed — no reminder was set and none was `
    + 'cancelled. Send the moment you actually mean, ISO-8601 with their offset. If you '
    + 'meant right now, say it in words instead of arming a reminder for it.',
    { reason: 'remind_at_in_past' });
}

module.exports = [
  tool('set_task_reminder', 'Attach a reminder to a task, for a moment they ASKED for. A task saved with a due_at already has one, so this is for a different time or a repeat — it cancels the automatic one, never two. Several per task allowed. remind_at MUST carry a UTC offset (2026-08-20T09:00:00+03:00), from their own local time (USER.md); never bare digits with a Z.',
    { task_id: S('number', 'Task id'), remind_at: S('string', 'ISO-8601 datetime WITH UTC offset'),
      repeat_rule: S('string', 'Optional repeat: "daily"; "weekly"; "weekly:MO,TH" (SU MO TU WE TH FR SA); "monthly:16"; "monthly:last" (the last day, whatever it is; a day past a short month lands on its last day). Anything else is stored as a ONE-OFF, so use these exact forms.') }, ['task_id', 'remind_at'],
    (client, user, a) => (reminders.momentIsPast(a.remind_at)
      ? pastMoment('remind_at', a.remind_at, user.timezone)
      : reminders.setReminder(client, user.id, a.task_id, a.remind_at, a.repeat_rule))),
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
    async (client, user, a) => {
      const res = await reminders.listReminders(client, user.id, a.task_id);
      if (!res.ok || !res.data) return res;
      // Drawn rather than retyped (domain/list-block.js), for one reason
      // beyond the layout: an hour is the whole content of a reminder, and it
      // is rendered here in THEIR zone from the stored instant instead of
      // being re-derived by a model reading a UTC timestamp. `chasing` is
      // deliberately not in it — see the module header.
      const ch = await users.primaryChannel(client, user.id);
      const block = listBlock.renderReminderListBlock(res.data, {
        locale: user.locale,
        timezone: user.timezone,
        channelType: ch.ok ? ch.data.channel.channel_type : null,
      });
      // The layout hint is the FALLBACK and never travels beside the block,
      // which has already done that work: an unconditional "lay these out as a
      // list" on a result that arrives laid out is the markPlaced fault, and
      // here it would be asking for the work again after it was done.
      const many = !block && Array.isArray(res.data.reminders) && res.data.reminders.length > 1;
      const hints = {
        ...(many ? { layout: format.HINTS.list } : {}),
        ...(block ? {
          block: `${format.HINTS.relayBlock} The hours in it are already in their clock — do not `
            + 'convert them, and do not name an hour that is not on one of those lines. Everything '
            + 'you add is at most ONE short sentence.',
        } : {}),
        // `chasing` is the half of the answer that was missing entirely until
        // 2026-09-09 — reminders that already went out and are still following
        // up on their own. Said on the result, on the few calls where any
        // exists, rather than in the description on every turn.
        ...(res.data.chasing ? {
          chasing: 'These already went out and will follow up on their own — a few hours on and '
            + 'again tomorrow. They are NOT hours to promise anybody: say a time from `reminders`, '
            + 'never from here. To stop one, cancel_reminder(id); the task stays. To move the next '
            + 'one, cancel it and set_task_reminder on its taskId.',
        } : {}),
      };
      if (!Object.keys(hints).length) return res;
      return ok({ ...res.data, ...(block ? { block } : {}), hints });
    }),
];
