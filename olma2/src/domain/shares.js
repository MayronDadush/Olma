'use strict';
// Per-task sharing only — whole-list sharing is dead in v2. Sharing a project
// (parent task) shares its open subtasks dynamically: a subtask added after
// the share is visible without re-sharing, because visibility is computed
// through the parent's share row at read time, never copied.
//
// One kind of share. Everybody on a task is equal — the one who opened it and
// the ones it was shared with all rename, date, tick, add and remove items,
// and every one of those writes is made AS the owner (actingOwner) so tasks.js
// stays owner-scoped and single. Until 2026-09-19 a share carried a role,
// 'viewer' or 'editor', and the owner could not so much as drop one of his
// own tasks into a list a friend had shared with him as editor. The column
// stays for the rows already written and is read by nothing.
//
// That includes the guest list: ANY participant adds and removes people
// (owner, 2026-09-19 — "כולם שווים גם כאן"). The share row still names the
// TASK's owner as `owner_id`, because that is whom writes are made as; what
// changes is who may create and end one. `requested_by` records who actually
// invited, and `connection_id` is the connection between the INVITER and the
// person they invited — the grant is between those two, and asking the task's
// owner for a connection they may not have would be the wrong question.
//
// Nothing on a shared task is one person's alone any more. The REMINDER is
// not shared either — since 2026-09-19 each participant has their own on the
// same task (migration 073, `task_reminders.user_id`), so setting mine never
// touches yours, and leaving takes mine with me and leaves yours where it is.
const { ok, err } = require('./results');
const audit = require('./audit');
const grants = require('./grants');
const tasksDomain = require('./tasks');
const reminders = require('./reminders');
const { enqueue } = require('../outbox/enqueue');

// The reminders one PERSON has pending on a task and its items, cancelled
// the way they cancel one themselves — through reminders.cancelReminder, so
// a rung already sitting in the outbox is withdrawn with the row. Called
// when somebody comes OFF a task: what they asked to be nudged about is no
// longer on their list, and nobody else's reminder on it is touched.
//
// A reminder that disappears without a word is the same broken promise as one
// that never fires, so when SOMEBODY ELSE took them off the task they are
// told (the owner's decision, 2026-09-19: "מתבטלת ואומרים לו"). Only then,
// and only when a reminder actually went down: a person who leaves of their
// own accord is looking at the page that did it, and a task they were never
// waiting on is not news. It is the one message this path sends, so nothing
// here announces the removal itself.
async function cancelTheirReminders(client, recipientId, taskId, actorId) {
  const { rows } = await client.query(
    `SELECT r.id, t.title FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE (t.id = $1 OR t.parent_id = $1) AND COALESCE(r.user_id, t.owner_id) = $2
        AND r.sent_at IS NULL AND r.cancelled_at IS NULL
      ORDER BY r.id`, [taskId, recipientId]);
  const cancelled = [];
  for (const r of rows) {
    const res = await reminders.cancelReminder(client, recipientId, r.id);
    if (res.ok) cancelled.push(Number(r.id));
  }
  if (cancelled.length && String(actorId) !== String(recipientId)) {
    const { rows: [who] } = await client.query(
      `SELECT first_name, phone FROM users WHERE id = $1`, [actorId]);
    await enqueue(client, {
      userId: recipientId,
      kind: 'share_reminder_dropped',
      // Olma's own housekeeping, not a moment they chose.
      urgency: 'normal',
      payload: {
        taskTitle: rows[0].title,
        byName: (who && (who.first_name || who.phone)) || null,
        count: cancelled.length,
      },
      idempotencyKey: `sremdrop:${recipientId}:${cancelled[0]}`,
    });
  }
  return cancelled;
}

const LIVE = `('pending_viewer','pending_owner','active')`;

// `inviterId` is whoever is asking — the person who opened the task or
// anybody already on it. The sharing grant is checked between THEM and the
// person they are inviting; the row is owned by the task's owner.
async function offerShare(client, inviterId, taskId, viewerUserId) {
  const gate = await grants.requireFeatureBetween(client, inviterId, viewerUserId, 'sharing');
  if (!gate.ok) return gate;

  const acting = await actingOwner(client, inviterId, taskId);
  if (!acting) return err('not_found', 'task not found');
  // Inviting the person who opened it, or somebody already on it, is not a
  // share — it is a no-op that would read as one.
  if (String(acting.ownerId) === String(viewerUserId)) {
    return err('conflict', 'that is the person whose task this is');
  }
  const { rows } = await client.query(
    `SELECT id, parent_id FROM tasks WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL`,
    [taskId, acting.ownerId]
  );
  if (!rows[0]) return err('not_found', 'task not found');

  let share;
  try {
    const ins = await client.query(
      `INSERT INTO shares (connection_id, owner_id, viewer_id, task_id, role, status, requested_by)
       VALUES ($1, $2, $3, $4, 'editor', 'pending_viewer', $5) RETURNING *`,
      [gate.data.connection.id, acting.ownerId, viewerUserId, taskId, inviterId]
    );
    share = ins.rows[0];
  } catch (e) {
    if (e.code === '23505') return err('conflict', 'a live share for this task and person already exists');
    throw e;
  }
  await audit.record(client, inviterId, 'share.offered', { shareId: share.id, taskId, viewerId: viewerUserId });
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

// Ended by the person it is FOR, by the task's owner, or by anybody else
// already on the task — the same equality as everything else here. A stranger
// to the task gets `not_found`, never `forbidden`.
async function revokeShare(client, userId, shareId) {
  const { rows } = await client.query(
    `UPDATE shares SET status = 'revoked', responded_at = now()
     WHERE id = $1 AND status IN ('pending_viewer','pending_owner','active')
       AND (owner_id = $2 OR viewer_id = $2
            OR EXISTS (SELECT 1 FROM shares o WHERE o.task_id = shares.task_id
                        AND o.viewer_id = $2 AND o.status = 'active'))
     RETURNING *`,
    [shareId, userId]
  );
  if (!rows[0]) return err('not_found', 'live share not found');
  // The viewer is off the task now, whoever ended it — their reminders on
  // it go with them (a reminder is theirs, not the task's; migration 073).
  const cancelled = await cancelTheirReminders(client, rows[0].viewer_id, rows[0].task_id, userId);
  await audit.record(client, userId, 'share.revoked', {
    shareId, ...(cancelled.length ? { remindersCancelled: cancelled } : {}),
  });
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

// --- writing on a shared task -------------------------------------------------
// One write path: permission check here, then the same tasks.js functions the
// owner uses, called with the OWNER's id — so audit and invariants stay single.

// The active share that puts this person on this task: on the task itself, or
// on the list it is an item of.
async function shareCovering(client, userId, taskId) {
  const { rows } = await client.query(
    `SELECT s.* FROM shares s
     JOIN tasks t ON t.id = $2
     WHERE s.viewer_id = $1 AND s.status = 'active'
       AND (s.task_id = t.id OR s.task_id = t.parent_id)`,
    [userId, taskId]
  );
  return rows[0] || null;
}

// Who a write on this task is made AS. `{ ownerId, share }` — `share` is null
// for the owner themselves; null altogether when the task is neither theirs
// nor shared with them, which the caller reports exactly as tasks.js would:
// not found, never "forbidden", because the second word confirms the row
// exists to somebody who was not shown it.
async function actingOwner(client, userId, taskId) {
  const id = Number(taskId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const { rows } = await client.query(`SELECT owner_id FROM tasks WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  if (String(rows[0].owner_id) === String(userId)) return { ownerId: userId, share: null };
  const share = await shareCovering(client, userId, id);
  return share ? { ownerId: share.owner_id, share } : null;
}

// How many OTHER people are on a task right now. Zero for an item — the share
// sits on the list, and an item is removed from a shared list like any other.
async function othersOn(client, taskId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM shares WHERE task_id = $1 AND status = 'active'`, [taskId]);
  return rows[0].n;
}

async function completeSharedTask(client, userId, taskId) {
  const share = await shareCovering(client, userId, taskId);
  if (!share) return err('forbidden', 'no share covers this task');
  const res = await tasksDomain.completeTask(client, share.owner_id, taskId);
  if (res.ok) await audit.record(client, userId, 'share.editor_completed', { shareId: share.id, taskId });
  return res;
}

async function addSubtaskToShared(client, userId, parentTaskId, title) {
  const share = await shareCovering(client, userId, parentTaskId);
  // String(): task ids come back from Postgres as strings (BIGINT), while the
  // tool argument is a JSON number — a strict !== between the two is always
  // true, which refused every legitimate call.
  if (!share || String(share.task_id) !== String(parentTaskId)) {
    return err('forbidden', 'no share on this project');
  }
  const res = await tasksDomain.addTask(client, share.owner_id, {
    title, parentId: parentTaskId, source: 'shared_editor',
  });
  if (res.ok) await audit.record(client, userId, 'share.editor_added_subtask', {
    shareId: share.id, parentTaskId, taskId: res.data.task.id,
  });
  return res;
}

// A task of MINE dropped onto a list somebody shared with me. The item goes
// to the list's owner — an item is a line on their list, and a line owned by
// somebody else would be the one thing on it they could not tick — and is
// then nested by exactly the write the owner's own drag makes. Dropped onto
// my own list it is the plain nest.
//
// Refused by name, like tasks.nestTask, for the one thing the transfer adds:
// the task has to be mine outright (`shared` — somebody else is on it). A
// reminder pending on it stays MINE: it is stamped with me before the row
// changes hands (migration 073, `task_reminders.user_id`), so the nudge I
// asked for keeps reaching me and never the list's owner. Until 2026-09-19
// this refused `has_reminder`, because a reminder then rode the task's owner.
async function adoptIntoList(client, userId, taskId, parentId) {
  const acting = await actingOwner(client, userId, parentId);
  if (!acting || !acting.share) return tasksDomain.nestTask(client, userId, taskId, parentId);
  const id = Number(taskId);
  if (!Number.isSafeInteger(id) || id <= 0) return err('invalid', 'taskId required');
  const { rows } = await client.query(
    `SELECT t.id, t.parent_id, t.due_at, t.status,
            EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.archived_at IS NULL) AS has_items,
            EXISTS (SELECT 1 FROM shares s WHERE s.task_id = t.id AND s.status IN ${LIVE}) AS shared
       FROM tasks t WHERE t.id = $1 AND t.owner_id = $2 AND t.archived_at IS NULL`,
    [id, userId]
  );
  const child = rows[0];
  if (!child || child.status !== 'open') return err('not_found', 'task not found');
  if (child.parent_id) return err('invalid', 'only one level of nesting', { reason: 'is_item' });
  if (child.due_at) return err('invalid', 'a task with a date cannot become an item', { reason: 'has_date' });
  if (child.has_items) return err('invalid', 'a list cannot become an item', { reason: 'is_list' });
  if (child.shared) return err('invalid', 'a shared task cannot become an item', { reason: 'shared' });
  // Before the owner changes: a row without a recipient of its own means
  // "the task's owner", and that answer is about to become somebody else.
  await client.query(
    `UPDATE task_reminders SET user_id = $2 WHERE task_id = $1 AND user_id IS NULL`, [id, userId]);
  await client.query(`UPDATE tasks SET owner_id = $2 WHERE id = $1 AND owner_id = $3`,
    [id, acting.ownerId, userId]);
  const res = await tasksDomain.nestTask(client, acting.ownerId, id, parentId);
  if (!res.ok) return res;
  await audit.record(client, userId, 'task.given', {
    taskId: id, toUserId: Number(acting.ownerId), parentId: Number(parentId), shareId: acting.share.id,
  });
  return res;
}

// Taking myself off a task. For a participant that is their own share
// revoked; the task stays where it was. For the OWNER the task has to stay
// with the others, so it is handed to whoever accepted first — every row of
// it (the items too), and the remaining shares now point at the new owner.
// The LEAVER's reminders on it go with them, and only theirs — the heir's
// and everybody else's stay exactly as they set them (each participant has
// their own; migration 073). The cancel runs before the row changes hands,
// because a reminder without a recipient of its own means "the task's
// owner", and that is the leaver right up to the transfer. A task nobody
// else is on cannot be left, only deleted — the page offers the other button.
async function leaveTask(client, userId, taskId) {
  const id = Number(taskId);
  if (!Number.isSafeInteger(id) || id <= 0) return err('invalid', 'taskId required');
  const { rows: [task] } = await client.query(
    `SELECT id, owner_id, parent_id FROM tasks WHERE id = $1 AND archived_at IS NULL`, [id]);
  if (!task) return err('not_found', 'task not found');
  if (task.parent_id) return err('invalid', 'an item is removed, not left', { reason: 'is_item' });
  const { rows: active } = await client.query(
    `SELECT id, viewer_id FROM shares WHERE task_id = $1 AND status = 'active'
      ORDER BY responded_at, id`, [id]);
  const mine = active.find((s) => String(s.viewer_id) === String(userId));
  if (String(task.owner_id) !== String(userId)) {
    if (!mine) return err('not_found', 'task not found');
    const res = await revokeShare(client, userId, mine.id);
    if (!res.ok) return res;
    await audit.record(client, userId, 'share.left', { taskId: id, shareId: mine.id });
    return ok({ taskId: id, left: true, handedTo: null });
  }
  if (!active.length) return err('invalid', 'nobody else is on this task', { reason: 'alone' });
  const heir = active[0];
  // BEFORE the task changes hands, and only the leaver's: a reminder row
  // without a recipient of its own means "the task's owner", and one moment
  // later that is the heir. The heir's own reminders, and everybody else's,
  // are theirs and survive the handover untouched.
  const cancelled = await cancelTheirReminders(client, userId, id, userId);
  await client.query(`UPDATE tasks SET owner_id = $2 WHERE id = $1 OR parent_id = $1`, [id, heir.viewer_id]);
  await client.query(
    `UPDATE shares SET status = 'revoked', responded_at = now() WHERE id = $1`, [heir.id]);
  await client.query(
    `UPDATE shares SET owner_id = $2 WHERE task_id = $1 AND status IN ${LIVE}`, [id, heir.viewer_id]);
  await audit.record(client, userId, 'share.left', {
    taskId: id, handedTo: Number(heir.viewer_id),
    ...(cancelled.length ? { remindersCancelled: cancelled } : {}),
  });
  await audit.record(client, heir.viewer_id, 'task.inherited', { taskId: id, fromUserId: Number(userId) });
  return ok({ taskId: id, left: true, handedTo: Number(heir.viewer_id) });
}

module.exports = {
  offerShare, respondToShare, revokeShare, listMyShares, viewShared,
  shareCovering, actingOwner, othersOn, completeSharedTask, addSubtaskToShared,
  adoptIntoList, leaveTask,
};
