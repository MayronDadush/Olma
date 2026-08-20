'use strict';
// Per-task sharing only — whole-list sharing is dead in v2. Sharing a project
// (parent task) shares its open subtasks dynamically: a subtask added after
// the share is visible without re-sharing, because visibility is computed
// through the parent's share row at read time, never copied.
//
// role: 'viewer' (default) or 'editor' — editor can complete tasks and add
// subtasks under the shared item (the shared-shopping-list case).
const { ok, err } = require('./results');
const audit = require('./audit');
const grants = require('./grants');
const tasksDomain = require('./tasks');

async function offerShare(client, ownerId, taskId, viewerUserId, role = 'viewer') {
  if (!['viewer', 'editor'].includes(role)) return err('invalid', 'role must be viewer|editor');
  const gate = await grants.requireFeatureBetween(client, ownerId, viewerUserId, 'sharing');
  if (!gate.ok) return gate;

  const { rows } = await client.query(
    `SELECT id, parent_id FROM tasks WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL`,
    [taskId, ownerId]
  );
  if (!rows[0]) return err('not_found', 'task not found');

  let share;
  try {
    const ins = await client.query(
      `INSERT INTO shares (connection_id, owner_id, viewer_id, task_id, role, status, requested_by)
       VALUES ($1, $2, $3, $4, $5, 'pending_viewer', $2) RETURNING *`,
      [gate.data.connection.id, ownerId, viewerUserId, taskId, role]
    );
    share = ins.rows[0];
  } catch (e) {
    if (e.code === '23505') return err('conflict', 'a live share for this task and person already exists');
    throw e;
  }
  await audit.record(client, ownerId, 'share.offered', { shareId: share.id, taskId, viewerId: viewerUserId, role });
  return ok({ share });
}

async function respondToShare(client, viewerId, shareId, decision) {
  if (!['accept', 'decline'].includes(decision)) return err('invalid', 'decision must be accept|decline');
  const { rows } = await client.query(
    `UPDATE shares SET status = $3, responded_at = now()
     WHERE id = $1 AND viewer_id = $2 AND status = 'pending_viewer' RETURNING *`,
    [shareId, viewerId, decision === 'accept' ? 'active' : 'declined']
  );
  if (!rows[0]) return err('not_found', 'pending share not found');
  await audit.record(client, viewerId, `share.${decision === 'accept' ? 'accepted' : 'declined'}`, {
    shareId, ownerId: rows[0].owner_id,
  });
  return ok({ share: rows[0] });
}

async function revokeShare(client, userId, shareId) {
  const { rows } = await client.query(
    `UPDATE shares SET status = 'revoked', responded_at = now()
     WHERE id = $1 AND (owner_id = $2 OR viewer_id = $2)
       AND status IN ('pending_viewer','pending_owner','active')
     RETURNING *`,
    [shareId, userId]
  );
  if (!rows[0]) return err('not_found', 'live share not found');
  await audit.record(client, userId, 'share.revoked', { shareId });
  return ok({ share: rows[0] });
}

async function listMyShares(client, userId) {
  const { rows } = await client.query(
    `SELECT s.*, t.title AS task_title,
            ou.first_name AS owner_first_name, vu.first_name AS viewer_first_name
     FROM shares s
     JOIN tasks t ON t.id = s.task_id
     JOIN users ou ON ou.id = s.owner_id
     JOIN users vu ON vu.id = s.viewer_id
     WHERE (s.owner_id = $1 OR s.viewer_id = $1)
       AND s.status IN ('pending_viewer','pending_owner','active')
     ORDER BY s.created_at`,
    [userId]
  );
  return ok({ shares: rows });
}

// The viewer's read path. Project cascade lives HERE: the shared task plus,
// when it is a parent, its non-archived subtasks — computed live.
async function viewShared(client, viewerId, shareId) {
  const { rows } = await client.query(
    `SELECT s.*, t.id AS t_id FROM shares s JOIN tasks t ON t.id = s.task_id
     WHERE s.id = $1 AND s.viewer_id = $2 AND s.status = 'active'`,
    [shareId, viewerId]
  );
  if (!rows[0]) return err('not_found', 'active share not found');
  const task = await client.query(`SELECT * FROM tasks WHERE id = $1`, [rows[0].task_id]);
  const subs = await client.query(
    `SELECT * FROM tasks WHERE parent_id = $1 AND archived_at IS NULL ORDER BY status DESC, due_at NULLS LAST, id`,
    [rows[0].task_id]
  );
  return ok({ share: rows[0], task: task.rows[0], subtasks: subs.rows });
}

// --- editor rights -----------------------------------------------------------
// One write path: permission check here, then the same tasks.js functions the
// owner uses, called with the OWNER's id — so audit and invariants stay single.

async function editorShareCovering(client, editorId, taskId) {
  const { rows } = await client.query(
    `SELECT s.* FROM shares s
     JOIN tasks t ON t.id = $2
     WHERE s.viewer_id = $1 AND s.status = 'active' AND s.role = 'editor'
       AND (s.task_id = t.id OR s.task_id = t.parent_id)`,
    [editorId, taskId]
  );
  return rows[0] || null;
}

async function completeSharedTask(client, editorId, taskId) {
  const share = await editorShareCovering(client, editorId, taskId);
  if (!share) return err('forbidden', 'no editor share covers this task');
  const res = await tasksDomain.completeTask(client, share.owner_id, taskId);
  if (res.ok) await audit.record(client, editorId, 'share.editor_completed', { shareId: share.id, taskId });
  return res;
}

async function addSubtaskToShared(client, editorId, parentTaskId, title) {
  const share = await editorShareCovering(client, editorId, parentTaskId);
  // String(): task ids come back from Postgres as strings (BIGINT), while the
  // tool argument is a JSON number — a strict !== between the two is always
  // true, which refused every legitimate call.
  if (!share || String(share.task_id) !== String(parentTaskId)) {
    return err('forbidden', 'no editor share on this project');
  }
  const res = await tasksDomain.addTask(client, share.owner_id, {
    title, parentId: parentTaskId, source: 'shared_editor',
  });
  if (res.ok) await audit.record(client, editorId, 'share.editor_added_subtask', {
    shareId: share.id, parentTaskId, taskId: res.data.task.id,
  });
  return res;
}

module.exports = {
  offerShare, respondToShare, revokeShare, listMyShares, viewShared,
  editorShareCovering, completeSharedTask, addSubtaskToShared,
};
