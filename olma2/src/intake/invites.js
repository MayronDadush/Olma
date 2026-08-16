'use strict';
// The friend-invites-friend orchestration, called right after a connection
// request is written. Two paths:
//   target already on Olma → notify them through their own outbox
//   target unknown → create a 'pending' user row (so the outbox FK works and
//     everything later attaches to the same identity) + enqueue the fixed
//     intro message, delivered through the intake session
const usersDomain = require('../domain/users');
const { enqueue } = require('../outbox/enqueue');
const { introMessage } = require('./messages');
const { ok } = require('../domain/results');

async function ensurePendingUser(client, phone) {
  const existing = await usersDomain.getByPhone(client, phone);
  if (existing) return existing;
  const created = await usersDomain.createUser(client, { phone, status: 'pending' });
  if (!created.ok) throw new Error('pending user creation failed: ' + created.error.message);
  return created.data.user;
}

async function afterConnectionRequest(client, requester, connection, targetKnown) {
  if (targetKnown) {
    await enqueue(client, {
      userId: connection.target_id, kind: 'connection_request',
      payload: {
        connectionId: Number(connection.id),
        requesterName: [requester.first_name, requester.last_name].filter(Boolean).join(' ') || requester.phone,
        reason: connection.invite_reason || null,
        message: connection.invite_message || null,
      },
      idempotencyKey: `connreq:${connection.id}`,
    });
    return ok({ notified: 'existing_user' });
  }

  const pending = await ensurePendingUser(client, connection.target_phone);
  const inviterName = [requester.first_name, requester.last_name].filter(Boolean).join(' ') || requester.phone;
  await enqueue(client, {
    userId: pending.id, kind: 'connection_intro',
    payload: {
      connectionId: Number(connection.id),
      text: introMessage({
        inviterName, inviterPhone: requester.phone,
        reason: connection.invite_reason, phone: connection.target_phone,
      }),
    },
    idempotencyKey: `connintro:${connection.id}`,
  });
  return ok({ notified: 'stranger_intro', pendingUserId: pending.id });
}

module.exports = { afterConnectionRequest, ensurePendingUser };
