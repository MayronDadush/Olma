'use strict';
// Whether a shared task sits pinned at the top of one person's dashboard list.
//
// Pinned is the default, so the only thing stored is the tap that took the pin
// off (migration 066), and pinning again deletes that row. It is one person's
// view of their own list: nothing the agent says, sends or reminds about reads
// it, which is why there is no tool for it and no audit event.
const { ok, err } = require('./results');

// The task has to be one this person can see — their own, or one actively
// shared with them — or a pin write would be a way to learn which task ids
// exist. Checked the same way loadTasks decides what is on the list.
async function setPinned(client, userId, taskId, pinned) {
  if (!Number.isSafeInteger(Number(taskId)) || Number(taskId) <= 0) {
    return err('invalid', 'taskId required');
  }
  if (typeof pinned !== 'boolean') return err('invalid', 'pinned must be true or false');
  const { rows } = await client.query(
    `SELECT t.id FROM tasks t
     WHERE t.id = $1 AND t.parent_id IS NULL
       AND (t.owner_id = $2 OR EXISTS (
             SELECT 1 FROM shares s
             WHERE s.task_id = t.id AND s.viewer_id = $2 AND s.status = 'active'))`,
    [taskId, userId]
  );
  if (!rows[0]) return err('not_found', 'task not found');
  if (pinned) {
    await client.query(`DELETE FROM task_unpins WHERE user_id = $1 AND task_id = $2`, [userId, taskId]);
  } else {
    await client.query(
      `INSERT INTO task_unpins (user_id, task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, taskId]);
  }
  return ok({ taskId: Number(taskId), pinned });
}

module.exports = { setPinned };
