'use strict';
// reminders — one slice of the tool registry (see ../registry.js).
const {
  reminders, users, S, tool, ok, pastMoment, WHEN_SAID,
} = require('./_shared');
const format = require('../../../domain/message-format');
const listBlock = require('../../../domain/list-block');
const { partsInZone, taskWeekdayClash } = require('../../../domain/datetime');
const chaseDeadline = require('../../../domain/chase-deadline');

// What set_task_reminder(nudge:true) actually armed, said on the result —
// the same two sentences tools/tasks.js gives add_task, because a chase is
// the one arming whose SHAPE is news and a 👍 cannot carry a cadence.
const NOT_A_CHASE = 'No daily chase was armed: there is no deadline, or not two days of it left. This is ONE '
  + 'reminder at this moment, followed up the same day if they do not answer. Never say "every day".';

function chaseArmedHint(reminder, timezone) {
  const tz = timezone || 'UTC';
  const pad = (n) => String(n).padStart(2, '0');
  const p = partsInZone(tz, new Date(reminder.remind_at));
  const u = partsInZone(tz, new Date(reminder.repeat_until));
  return `A daily chase is armed: first ${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mi)} (their time), `
    + `then every day until ${u.y}-${pad(u.m)}-${pad(u.d)}, and it stops the moment they say it is done. `
    + 'Say that shape back in ONE short line and never list the days.';
}

function withHint(res, chase) {
  return { ...res, data: { ...res.data, hints: { ...((res.data && res.data.hints) || {}), chase } } };
}

module.exports = [
  // `nudge` is paid for by the trim in the same sentence — the surface had 35
  // chars of headroom (tests/tool-schema-budget.test.js) and a parameter costs
  // more than that. What went: "Several per task allowed", which the sibling-
  // ladder rule governs anyway, and four words of padding. That a reminder is
  // said ONCE rides the RESULT (tools/tasks.js, hints.reminders), where it
  // costs tokens only on the turns that arm one.
  tool('set_task_reminder', 'Attach a reminder to a task, for a moment they ASKED for. A task with a due_at already has one; this is a different time or a repeat, and it cancels the automatic one, never two. remind_at MUST carry a UTC offset (2026-08-20T09:00:00+03:00), their local time (USER.md); never bare digits with a Z.',
    { task_id: S('number', 'Task id'), remind_at: S('string', 'ISO-8601 datetime WITH UTC offset'),
      nudge: S('boolean', 'Chase until done, if they ask'),
      repeat_rule: S('string', 'Optional repeat, these exact forms or it stores a ONE-OFF: "daily"; "weekly"; "weekly:MO,TH" (SU MO TU WE TH FR SA) — a weekday they NAMED goes HERE, not only in remind_at; "monthly:16"; "monthly:last" (whatever the last day is; a short month clamps).'),
      when_said: WHEN_SAID }, ['task_id', 'remind_at'],
    async (client, user, a, ctx) => {
      if (reminders.momentIsPast(a.remind_at)) {
        return pastMoment('remind_at', a.remind_at, user.timezone, 'no reminder was set and none was cancelled');
      }
      // The same deadline add_task arms, on a task already on their list:
      // the gateway heard "until next week" in this turn's message, so the
      // chase runs to THAT day whatever the task's own date, and the hour is
      // theirs only if they named one (domain/chase-deadline).
      const heard = !reminders.normalizeRepeatRule(a.repeat_rule) && chaseDeadline.pending(ctx && ctx.turn, ctx && ctx.now ? ctx.now() : Date.now());
      // Their words against the moment, as add_task does — and skipped under a
      // heard chase for the same reason: the SERVER reads the day there, off
      // the very sentence these words carry. "ערב לפני" and "עד חמישי" name an
      // anchor rather than the moment, and taskWeekdayClash drops them first.
      if (!heard) {
        const clash = taskWeekdayClash('remind_at', a.when_said, a.remind_at, user.timezone,
          'no reminder was set and none was cancelled');
        if (clash) return clash;
      }
      if (heard) {
        const chase = await reminders.startChase(client, user.id, a.task_id,
          { at: heard.namedHour ? a.remind_at : null, until: heard.dueAt });
        if (chase) {
          if (chase.ok) ctx.turn.chaseUsed = true;
          return chase.ok ? withHint(chase, chaseArmedHint(chase.data.reminder, user.timezone)) : chase;
        }
      }
      // `nudge` on a task with a deadline is a CHASE — one a day at the hour
      // they just named, until that day (reminders.startChase, חיים 2026-09-22).
      // Only when the model asked for no cadence of its own: "כל 16 בחודש,
      // ותנדנדי לי" is a monthly rhythm and is not a thing to end at a date.
      // A null answer is "there was nothing to chase across" and falls through
      // to the ladder, which is what `nudge` has always bought.
      if (a.nudge === true && !reminders.normalizeRepeatRule(a.repeat_rule)) {
        const chase = await reminders.startChase(client, user.id, a.task_id, { at: a.remind_at });
        if (chase) return chase.ok ? withHint(chase, chaseArmedHint(chase.data.reminder, user.timezone)) : chase;
        // The fallback has to SAY it is one. Run 79 (2026-09-23): the model
        // had just been told this call "becomes one a day until the deadline",
        // got back a plain one-off, and promised a message every day. A result
        // that is silent about the shape leaves the hint as the only account of
        // it, and the hint described the other branch.
        const one = await reminders.setReminder(client, user.id, a.task_id, a.remind_at, a.repeat_rule,
          { nudge: true });
        return one.ok ? withHint(one, NOT_A_CHASE) : one;
      }
      return reminders.setReminder(client, user.id, a.task_id, a.remind_at, a.repeat_rule,
        { nudge: a.nudge === true });
    }),
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
