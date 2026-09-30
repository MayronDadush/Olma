'use strict';
// A task shared with somebody who is not on Olma yet (owner, 2026-09-30 —
// the growth plan, week 2). Until now `share_task_with` answered
// `not_connected` and nothing happened; now the number gets ONE message
// saying who shared what, and a connection request rides it, so the share
// is offered the moment they approve.
//
// The owner's rules: one message, ever, per number — never a follow-up, and
// never a second one because a second person shared something — and only
// when a person explicitly shared a task. On top of that a sharer can reach
// at most DAILY_CAP new numbers a day, so a stolen session or a looping
// model cannot turn this into a way to message strangers in bulk.
//
// The wording is an A/B test (experiments.task_share_intro): the stranger's
// pending row is the one exposed, and the outcome is that person joining.
const usersDomain = require('../domain/users');
const connections = require('../domain/connections');
const contacts = require('../domain/contacts');
const shares = require('../domain/shares');
const audit = require('../domain/audit');
const experiments = require('../domain/experiments');
const templates = require('../domain/message-templates');
const format = require('../domain/message-format');
const { enqueue } = require('../outbox/enqueue');
const { ensurePendingUser } = require('./invites');
const { isHebrewPhone } = require('./messages');
const { ok, err } = require('../domain/results');

const DAILY_CAP = 3;
const EVENT = 'share.invited_stranger';
const TITLE_MAX = 80;

// Has this number ever been sent — or is it about to be sent — a first
// message from Olma? A row the gate dropped or let expire never reached them,
// so it does not count (the same test group-meetings.coldInvite uses).
async function everContacted(client, phone) {
  const { rows } = await client.query(
    `SELECT 1 FROM outbox o JOIN users p ON p.id = o.user_id
      WHERE p.phone = $1 AND o.kind IN ('connection_intro', 'room_cold_invite')
        AND (o.sent_at IS NULL OR o.hold_reason IS NULL)
      LIMIT 1`, [phone]);
  return Boolean(rows[0]);
}

async function sentToday(client, userId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE actor_id = $1 AND event = $2 AND created_at > now() - interval '24 hours'`,
    [userId, EVENT]);
  return rows[0].n;
}

function messageFor(variant, { inviterName, inviterPhone, task, phone }, overrides) {
  const clean = format.stripUserMarkup;
  const t = clean(task).trim();
  const key = `task_share_intro_${variant}_${isHebrewPhone(phone) ? 'he' : 'en'}`;
  return templates.render(key, {
    inviter_name: clean(inviterName), inviter_phone: inviterPhone,
    task: t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t,
  }, overrides);
}

// Called by share_task_with when the phone is not a connection. Returns null
// when this is not a stranger at all (a real user who simply is not connected
// keeps the original not_connected answer), or the tool result otherwise.
async function inviteForShare(client, user, taskId, rawPhone) {
  // The nightly eval bot shares tasks with made-up numbers, and a made-up
  // number can belong to somebody real.
  if (user.is_eval || user.is_test) return null;
  const phone = contacts.normalisePhone(rawPhone, user.phone);
  if (!phone) return null;
  const target = await usersDomain.getByPhone(client, phone);
  if (target && target.status !== 'pending') return null;
  if (target && target.is_eval) return null;

  const { rows } = await client.query(
    `SELECT title FROM tasks WHERE id = $1 AND owner_id = $2 AND status <> 'archived'`, [taskId, user.id]);
  if (!rows[0]) return err('not_found', 'task not found');

  if (await everContacted(client, phone)) {
    return err('conflict', 'this number has already had its one message from Olma', {
      reason: 'already_invited',
      hint: 'Olma writes to somebody who is not on it only once. Tell the user they can send the person the task themselves, or ask them to write to Olma.',
    });
  }
  if (await sentToday(client, user.id) >= DAILY_CAP) {
    return err('rate_limited', 'too many new people today', { reason: 'daily_cap', cap: DAILY_CAP });
  }

  const req = await connections.requestConnection(client, user.id, phone, { reason: rows[0].title });
  if (!req.ok) return req;
  const connection = req.data.connection;
  const pending = await ensurePendingUser(client, phone);
  const variant = await experiments.expose(client, 'task_share_intro', pending.id, { by: user.id });
  const inviterName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.phone;
  await enqueue(client, {
    userId: pending.id, kind: 'connection_intro',
    payload: {
      connectionId: Number(connection.id),
      text: messageFor(variant, { inviterName, inviterPhone: user.phone, task: rows[0].title, phone },
        await templates.load(client)),
    },
    idempotencyKey: `connintro:${connection.id}`,
  });
  await audit.record(client, user.id, EVENT, { connectionId: Number(connection.id), taskId: Number(taskId), variant });
  return ok({
    invited: true,
    hint: 'They are not on Olma yet. They were sent ONE message saying you want to share this task, and Olma will not write to them again. If they reply and approve, the task is offered to them automatically — nothing more to do. Tell the user exactly that, briefly.',
  });
}

// On approval of a connection this module opened: offer each task that was
// waiting on it. Approval turns sharing on for both sides, so the offer goes
// through the ordinary gate. Returns the share offers made.
async function afterApproval(client, connection) {
  const { rows } = await client.query(
    `SELECT DISTINCT (detail->>'taskId')::bigint AS task_id FROM audit_log
      WHERE event = $1 AND actor_id = $2 AND (detail->>'connectionId')::bigint = $3`,
    [EVENT, connection.requester_id, connection.id]);
  const offered = [];
  for (const r of rows) {
    const res = await shares.offerShare(client, Number(connection.requester_id), Number(r.task_id), Number(connection.target_id));
    if (res.ok) offered.push({ shareId: Number(res.data.share.id), taskId: Number(r.task_id) });
  }
  return offered;
}

module.exports = { inviteForShare, afterApproval, messageFor, everContacted, DAILY_CAP, EVENT };
