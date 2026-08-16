'use strict';
// Reminders are always children of a task (the v2 unification). Several per
// task allowed. "Give me everything due in the next hour" is one indexed
// query — the original goal of the merge, kept.
const { ok, err } = require('./results');
const audit = require('./audit');

async function setReminder(client, ownerId, taskId, remindAt, repeatRule) {
  if (!remindAt) return err('invalid', 'remind_at required');
  const { rows } = await client.query(
    `SELECT id, status FROM tasks WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL`,
    [taskId, ownerId]
  );
  if (!rows[0]) return err('not_found', 'task not found');
  if (rows[0].status !== 'open') return err('invalid', 'cannot set a reminder on a completed task');
  const ins = await client.query(
    `INSERT INTO task_reminders (task_id, remind_at, repeat_rule)
     VALUES ($1, $2, $3) RETURNING *`,
    [taskId, remindAt, repeatRule || null]
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
     WHERE r.remind_at <= $1 AND r.sent_at IS NULL AND r.cancelled_at IS NULL
       AND t.status = 'open' AND t.archived_at IS NULL
     ORDER BY r.remind_at`,
    [now]
  );
  return ok({ due: rows });
}

async function markSent(client, reminderId) {
  await client.query(`UPDATE task_reminders SET sent_at = now() WHERE id = $1`, [reminderId]);
  return ok({ reminderId });
}

module.exports = { setReminder, cancelReminder, listReminders, dueForSending, markSent };
