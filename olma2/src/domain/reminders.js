'use strict';
// Reminders are always children of a task (the v2 unification). Several per
// task allowed. "Give me everything due in the next hour" is one indexed
// query — the original goal of the merge, kept.
const { ok, err } = require('./results');
const audit = require('./audit');
const { hasOffset, badTime } = require('./datetime');

// ---- repeat rules -----------------------------------------------------------
//
// The tool takes freeform text and the model writes whatever reads like a
// repeat rule, so this accepts both vocabularies and stores ONE of them.
// Getting this wrong is silent and expensive: sweeps.js used to compare against
// the literals 'daily'/'weekly' only, while the model was writing RRULE-style
// 'FREQ=DAILY'. No error anywhere — the reminder fired once, no next occurrence
// was ever created, and a person who asked for a daily medication reminder got
// exactly one. Found live 2026-08-18 on four of five reminders in the database.
//
// Canonical forms stored: 'daily' | 'weekly' | 'weekly:MO,TH' | null.
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function normalizeRepeatRule(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const up = s.toUpperCase();

  // plain words, in either language the model tends to reach for
  if (/^(DAILY|EVERY ?DAY|YOM|יומי)$/.test(up)) return 'daily';
  if (/^(WEEKLY|EVERY ?WEEK|שבועי)$/.test(up)) return 'weekly';

  // RRULE-ish: FREQ=DAILY / FREQ=WEEKLY[;BYDAY=MO,TH]
  const freq = /FREQ=([A-Z]+)/.exec(up);
  if (freq) {
    if (freq[1] === 'DAILY') return 'daily';
    if (freq[1] === 'WEEKLY') {
      const byday = /BYDAY=([A-Z,]+)/.exec(up);
      if (!byday) return 'weekly';
      const days = byday[1].split(',').map((d) => d.trim()).filter((d) => DAYS.includes(d));
      return days.length ? `weekly:${days.join(',')}` : 'weekly';
    }
    return null; // MONTHLY/YEARLY are not supported; better null than a lie
  }

  if (/^WEEKLY:/.test(up)) {
    const days = up.slice(7).split(',').map((d) => d.trim()).filter((d) => DAYS.includes(d));
    return days.length ? `weekly:${days.join(',')}` : 'weekly';
  }
  return null; // unrecognised → a one-off, never a wrong cadence
}

// The next time this rule should fire after `from`. Returns null for a
// non-repeating rule, which is what stops the sweep spawning a successor.
function nextOccurrence(from, rule) {
  const norm = normalizeRepeatRule(rule);
  if (!norm) return null;
  const base = new Date(from);
  if (norm === 'daily') return new Date(base.getTime() + 24 * 3600_000);
  if (norm === 'weekly') return new Date(base.getTime() + 7 * 24 * 3600_000);

  // weekly:MO,TH — the soonest listed weekday strictly after `from`
  const wanted = norm.slice(7).split(',').map((d) => DAYS.indexOf(d)).filter((i) => i >= 0);
  if (!wanted.length) return new Date(base.getTime() + 7 * 24 * 3600_000);
  for (let step = 1; step <= 7; step++) {
    const cand = new Date(base.getTime() + step * 24 * 3600_000);
    if (wanted.includes(cand.getUTCDay())) return cand;
  }
  return new Date(base.getTime() + 7 * 24 * 3600_000);
}

async function setReminder(client, ownerId, taskId, remindAt, repeatRule) {
  if (!remindAt) return err('invalid', 'remind_at required');
  if (!hasOffset(remindAt)) return badTime('remind_at', remindAt);
  const { rows } = await client.query(
    `SELECT id, status FROM tasks WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL`,
    [taskId, ownerId]
  );
  if (!rows[0]) return err('not_found', 'task not found');
  if (rows[0].status !== 'open') return err('invalid', 'cannot set a reminder on a completed task');
  const ins = await client.query(
    `INSERT INTO task_reminders (task_id, remind_at, repeat_rule)
     VALUES ($1, $2, $3) RETURNING *`,
    [taskId, remindAt, normalizeRepeatRule(repeatRule)]
  );
  await audit.record(client, ownerId, 'reminder.created', { taskId, reminderId: ins.rows[0].id });
  return ok({ reminder: ins.rows[0] });
}

async function cancelReminder(client, ownerId, reminderId) {
  const { rows } = await client.query(
    `UPDATE task_reminders r SET cancelled_at = now()
     FROM tasks t
     WHERE r.id = $1 AND r.task_id = t.id AND t.owner_id = $2
       AND r.sent_at IS NULL AND r.cancelled_at IS NULL
     RETURNING r.id`,
    [reminderId, ownerId]
  );
  if (!rows[0]) return err('not_found', 'pending reminder not found');
  await audit.record(client, ownerId, 'reminder.cancelled', { reminderId });
  return ok({ reminderId });
}

async function listReminders(client, ownerId, taskId) {
  const { rows } = await client.query(
    `SELECT r.* FROM task_reminders r JOIN tasks t ON t.id = r.task_id
     WHERE t.owner_id = $1 AND ($2::bigint IS NULL OR r.task_id = $2)
       AND r.cancelled_at IS NULL
     ORDER BY r.remind_at`,
    [ownerId, taskId || null]
  );
  return ok({ reminders: rows });
}

// The sweep query the whole design leans on: everything due for sending now,
// across all users, one indexed scan. Caller (outbox enqueue job) marks
// sent_at only after the outbox row is durably written.
async function dueForSending(client, now) {
  const { rows } = await client.query(
    `SELECT r.id AS reminder_id, r.task_id, r.remind_at, r.repeat_rule,
            t.owner_id, t.title, t.due_at
     FROM task_reminders r
     JOIN tasks t ON t.id = r.task_id
     JOIN users u ON u.id = t.owner_id
     WHERE r.remind_at <= $1 AND r.sent_at IS NULL AND r.cancelled_at IS NULL
       AND t.status = 'open' AND t.archived_at IS NULL
       -- A paused user's reminders are already cancelled by pauseUser; this is
       -- the belt to that braces, and it also stops the sweep writing SUCCESSOR
       -- rows (which happens per send, so an unguarded paused user would grow a
       -- fresh reminder every day they were away).
       AND u.paused_at IS NULL AND NOT u.is_eval
     ORDER BY r.remind_at`,
    [now]
  );
  return ok({ due: rows });
}

async function markSent(client, reminderId) {
  await client.query(`UPDATE task_reminders SET sent_at = now() WHERE id = $1`, [reminderId]);
  return ok({ reminderId });
}

module.exports = {
  setReminder, cancelReminder, listReminders, dueForSending, markSent,
  normalizeRepeatRule, nextOccurrence,
};
