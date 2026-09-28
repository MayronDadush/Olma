'use strict';
// A person deleting everything Olma holds about them, themselves — from the
// chat (`delete_my_account`) or from their own page (owner, 2026-09-28).
//
// The owner's two decisions, and they are the shape of this module:
//   * ONLY on their explicit request. Never after a pause, never after
//     silence, never because anybody else asked. Two steps in the chat: the
//     tool first shows what would go (`preview`, stamped), and a confirmation
//     is accepted only within PREVIEW_TTL_MS of that — so a model cannot
//     confirm a deletion nobody was shown. The page has its own confirmation
//     sheet and sends `confirm: true`.
//   * What they share with others STAYS with the others, and they leave it.
//     A shared task goes to whoever accepted first (`shares.leaveTask`, the
//     same hand-over the page's "leave" button makes); a coordination they
//     are in is left the way anybody leaves one (`meetings.optOut`), and one
//     they opened is handed to somebody still in it. Without this the
//     schema's ON DELETE CASCADE deletes a coordination for everybody in it
//     because its opener left.
//
// The deletion itself is `intake/deprovision.deprovisionUser`, the admin
// delete button's own function, so the two can never mean different things.
// It runs from the `self_delete` job a minute after the request, never inside
// the turn that asked: the agent answering them is one of the things it
// removes. What it still cannot reach is said, not hidden:
//   * the gateway's store of their conversation (`agents/<id>/`) stays on disk
//     until scripts/purge-orphan-agents.js runs with the gateway stopped (a
//     live removal crashes the gateway; see intake/orphan-agents.js);
//   * backups age out on their own (14 days local, 30 off-box);
//   * the audit trail keeps that the deletion was asked for and done — the
//     record that we acted on it — with no phone and no name in it.
const { ok, err } = require('./results');
const audit = require('./audit');

const PREVIEW_TTL_MS = 15 * 60 * 1000;
// The turn that confirmed must be over before its own agent is removed.
const GRACE_MS = 60 * 1000;

async function counts(client, userId) {
  const { rows } = await client.query(
    `SELECT (SELECT count(*)::int FROM tasks WHERE owner_id = $1 AND archived_at IS NULL) AS tasks,
            (SELECT count(*)::int FROM task_reminders r JOIN tasks t ON t.id = r.task_id
              WHERE COALESCE(r.user_id, t.owner_id) = $1) AS reminders,
            (SELECT count(*)::int FROM user_facts WHERE user_id = $1) AS facts,
            (SELECT count(*)::int FROM user_contacts WHERE user_id = $1) AS contacts,
            (SELECT count(*)::int FROM integrations WHERE user_id = $1) AS connections,
            (SELECT count(*)::int FROM shares s JOIN tasks t ON t.id = s.task_id
              WHERE s.status = 'active' AND (s.owner_id = $1 OR s.viewer_id = $1)) AS shared_tasks,
            (SELECT count(*)::int FROM meeting_participants p JOIN meetings m ON m.id = p.meeting_id
              WHERE p.user_id = $1 AND m.status IN ('negotiating', 'confirmed')) AS open_meetings`,
    [userId]);
  return rows[0];
}

// Step one in the chat: what would go. Stamped, because step two checks it.
async function preview(client, userId) {
  const { rows } = await client.query(
    `UPDATE users SET deletion_previewed_at = now() WHERE id = $1 AND status = 'active'
     RETURNING id`, [userId]);
  if (!rows[0]) return err('not_found', 'no such user');
  return ok({ counts: await counts(client, userId) });
}

// Step two. `via` is 'chat' (needs a fresh preview) or 'page' (its own sheet).
async function request(client, userId, { via, now = Date.now() } = {}) {
  const { rows } = await client.query(
    `SELECT id, deletion_previewed_at, deletion_requested_at FROM users
      WHERE id = $1 AND status = 'active' FOR UPDATE`, [userId]);
  const u = rows[0];
  if (!u) return err('not_found', 'no such user');
  if (u.deletion_requested_at) return ok({ alreadyRequested: true, requestedAt: u.deletion_requested_at });
  if (via === 'chat') {
    const seen = u.deletion_previewed_at ? new Date(u.deletion_previewed_at).getTime() : 0;
    if (!seen || now - seen > PREVIEW_TTL_MS) {
      return err('invalid', 'show them what will be deleted first (call without confirm), then ask',
        { reason: 'not_previewed' });
    }
  } else if (via !== 'page') {
    return err('invalid', 'unknown channel for a deletion request');
  }
  // Paused at once, so nothing Olma decided to say reaches them in the minute
  // before the job runs; the rows themselves go with the account.
  await client.query(
    `UPDATE users SET deletion_requested_at = to_timestamp($2 / 1000.0),
            paused_at = COALESCE(paused_at, to_timestamp($2 / 1000.0)),
            paused_reason = COALESCE(paused_reason, 'deleting')
      WHERE id = $1`, [userId, now]);
  await audit.record(client, userId, 'account.deletion_requested', { via });
  return ok({ requested: true });
}

// Everything they share with somebody else, left the way a person leaves it.
async function handOver(client, userId, { now = Date.now() } = {}) {
  const shares = require('./shares');
  const meetings = require('./meetings');
  const out = { tasksHandedOver: 0, tasksLeft: 0, meetingsLeft: 0, meetingsHandedOver: 0 };

  const { rows: sharedTasks } = await client.query(
    `SELECT DISTINCT s.task_id FROM shares s JOIN tasks t ON t.id = s.task_id
      WHERE s.status = 'active' AND (s.owner_id = $1 OR s.viewer_id = $1)
        AND t.archived_at IS NULL AND t.parent_id IS NULL`, [userId]);
  for (const r of sharedTasks) {
    const res = await shares.leaveTask(client, userId, r.task_id);
    if (res.ok && res.data.handedTo) out.tasksHandedOver += 1;
    else if (res.ok) out.tasksLeft += 1;
  }
  // A share the heir now owns still names who first asked for it; that column
  // has no ON DELETE, so it would refuse the delete.
  await client.query(`UPDATE shares SET requested_by = owner_id WHERE requested_by = $1`, [userId]);

  const { rows: open } = await client.query(
    `SELECT m.id FROM meeting_participants p JOIN meetings m ON m.id = p.meeting_id
      WHERE p.user_id = $1 AND p.state <> 'opted_out' AND m.status IN ('negotiating', 'confirmed')`,
    [userId]);
  for (const m of open) {
    const res = await meetings.optOut(client, userId, m.id, now);
    if (res.ok) out.meetingsLeft += 1;
  }
  // Opened by them and somebody else is still in it: it becomes that person's
  // (the earliest still in, else the earliest at all). `initiator_id` grants
  // nothing (rules/reminders-and-tasks.md, "Nobody manages a coordination"),
  // it only has to name somebody who exists.
  const handed = await client.query(
    `UPDATE meetings m SET updated_at = now(), initiator_id = (
         SELECT p.user_id FROM meeting_participants p
          WHERE p.meeting_id = m.id AND p.user_id <> $1
          ORDER BY (p.state = 'opted_out'), p.user_id LIMIT 1)
      WHERE m.initiator_id = $1
        AND EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id = m.id AND p.user_id <> $1)`,
    [userId]);
  out.meetingsHandedOver = handed.rowCount;
  // The shared calendar event lives on THEIR Google calendar, which they are
  // disconnecting; nobody can update it through them any more.
  await client.query(`UPDATE meetings SET calendar_organiser_id = NULL WHERE calendar_organiser_id = $1`, [userId]);
  return out;
}

// Their Google access ends at Google, not only in our table. Mail and
// contacts first: each skips the revoke while a sibling holds the same token,
// and the last one revokes it.
async function disconnectGoogle(client, userId) {
  const done = [];
  for (const mod of ['./mail', './google-contacts', './calendar']) {
    try {
      const res = await require(mod).disconnect(client, userId);
      if (res && res.ok && res.data.revokedAtGoogle) done.push(mod.slice(2));
    } catch { /* a failed revoke must not keep their data; the row goes with the account */ }
  }
  return done;
}

// One person, start to finish. deps: { configPath, deprovision, restartGateway, deleteSession }
async function carryOut(client, user, deps = {}) {
  const deprovision = deps.deprovision || require('../intake/deprovision').deprovisionUser;
  const revoked = await disconnectGoogle(client, user.id);
  const handed = await handOver(client, user.id);
  const res = await deprovision(client, user.phone, {
    configPath: deps.configPath,
    ...(deps.restartGateway ? { restartGateway: deps.restartGateway } : {}),
    ...(deps.deleteSession ? { deleteSession: deps.deleteSession } : {}),
  });
  if (!res.ok) throw new Error(`deprovision failed: ${res.error.message}`);
  // Counts only. The id stays as the record that a request was acted on.
  await audit.record(client, user.id, 'account.deletion_completed', {
    ...handed, googleRevoked: revoked,
    agentRemoved: Boolean(res.data.config && res.data.config.agentRemoved),
    workspaceRemoved: Boolean(res.data.workspaceRemoved),
  });
  return { userId: Number(user.id), ...handed };
}

// The job: every confirmed request older than the grace, one transaction each
// so one failure never holds the others.
async function sweep(pool, deps = {}) {
  const { withTx } = require('../db/pool');
  const { rows } = await pool.query(
    `SELECT id, phone FROM users
      WHERE deletion_requested_at IS NOT NULL
        AND deletion_requested_at < now() - make_interval(secs => $1)
      ORDER BY deletion_requested_at LIMIT 5`, [GRACE_MS / 1000]);
  const out = { deleted: 0, failed: 0 };
  for (const u of rows) {
    try {
      await withTx(pool, (c) => carryOut(c, u, deps));
      out.deleted += 1;
    } catch (e) {
      out.failed += 1;
      console.error(`self_delete: user ${u.id}: ${e.message}`);
    }
  }
  return out;
}

module.exports = { preview, request, handOver, carryOut, sweep, counts, PREVIEW_TTL_MS, GRACE_MS };
