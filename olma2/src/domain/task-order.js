'use strict';
// Where each task sits on one person's dashboard list, once they have dragged
// it (migration 069). The page sends the whole visible order after every drop
// and this writes it as one rank per task — no midpoint ranks and nothing to
// rebalance, because a person's open list is tens of rows, not thousands.
//
// Like task-pins.js it is one person's view of their own list: nothing the
// agent says, sends or reminds about reads it, so there is no tool for it, no
// audit event, and it is not refused while paused.
const { ok, err } = require('./results');

const MAX_IDS = 500;

async function setOrder(client, userId, taskIds) {
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return err('invalid', 'taskIds must be a non-empty list');
  }
  if (taskIds.length > MAX_IDS) return err('invalid', `at most ${MAX_IDS} tasks`);
  const ids = [];
  for (const raw of taskIds) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) return err('invalid', 'every taskId must be a positive integer');
    if (!ids.includes(n)) ids.push(n);
  }
  // Every id has to be a top-level task this person can see — their own, or
  // one actively shared with them — the same test setPinned and loadTasks use.
  // One unknown id refuses the WHOLE write: a partial order would be a list
  // nobody arranged, and answering per id would be a way to probe which task
  // ids exist.
  const { rows } = await client.query(
    `SELECT t.id FROM tasks t
     WHERE t.id = ANY($1::bigint[]) AND t.parent_id IS NULL AND t.archived_at IS NULL
       AND (t.owner_id = $2 OR EXISTS (
             SELECT 1 FROM shares s
             WHERE s.task_id = t.id AND s.viewer_id = $2 AND s.status = 'active'))`,
    [ids, userId]
  );
  if (rows.length !== ids.length) return err('not_found', 'task not found');
  await client.query(
    `INSERT INTO task_order (user_id, task_id, position)
     SELECT $1, u.task_id, u.ord::int
     FROM unnest($2::bigint[]) WITH ORDINALITY AS u(task_id, ord)
     ON CONFLICT (user_id, task_id) DO UPDATE SET position = EXCLUDED.position`,
    [userId, ids]
  );
  return ok({ count: ids.length });
}

module.exports = { setOrder, MAX_IDS };
