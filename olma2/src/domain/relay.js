'use strict';
// Person-to-person messages passed through Olma — the 'messages' feature.
// The outbox row IS the whole mechanism: the recipient's own agent delivers
// it through the same respectful gate as everything else (quiet hours, pause,
// daily budget), which is exactly the product promise — "Olma passes it on
// when they're reachable", never a raw midnight buzz. Urgent, like the live
// meeting events: a person wrote this for a person, so it should not fold
// into tomorrow's digest over a budget counter — but it still waits for the
// recipient's own hours.
//
// Deliberately NOT a chat channel: one message, one row, attributed to the
// sender by name. Scheduling stays with the meeting tools (doctrine — a
// relayed "אז יום שלישי?" must never become the way a meeting gets agreed).
const crypto = require('node:crypto');
const { ok, err } = require('./results');
const audit = require('./audit');
const grants = require('./grants');
const { enqueue } = require('../outbox/enqueue');

// This text is written by one user and interpolated (fenced) into another
// user's agent turn — same reasoning as cleanName and meeting constraints,
// scaled up to a message. Refuse over-length rather than truncate: a silently
// shortened personal message changes what the person said.
const MAX_MESSAGE_CHARS = 1000;

async function relayMessage(client, sender, target, text) {
  const gate = await grants.requireFeatureBetween(client, Number(sender.id), Number(target.id), 'messages');
  if (!gate.ok) return gate;

  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!body) return err('invalid', 'message text is empty');
  if (body.length > MAX_MESSAGE_CHARS) {
    return err('invalid',
      `message too long (${body.length} chars, max ${MAX_MESSAGE_CHARS}) — ask the user to shorten it; never trim it yourself`);
  }

  const connectionId = Number(gate.data.connection.id);
  const fromName = [sender.first_name, sender.last_name].filter(Boolean).join(' ') || sender.phone;

  // Identical text, same day, same direction → one row. Guards the double-call
  // (an agent retrying its own tool call) without ever blocking a genuine
  // "תגיד לו שוב מחר".
  const digest = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  const day = new Date().toISOString().slice(0, 10);
  const res = await enqueue(client, {
    userId: Number(target.id), kind: 'relayed_message', urgency: 'urgent',
    payload: { fromName, fromUserId: Number(sender.id), connectionId, text: body },
    idempotencyKey: `relay:${connectionId}:${sender.id}:${day}:${digest}`,
  });
  if (!res.data.enqueued) {
    return err('conflict', 'this exact message is already on its way to them (sent today)');
  }

  // Content lives only in the outbox row (pruned like every operational row);
  // the audit trail records that a message crossed, not what it said.
  await audit.record(client, Number(sender.id), 'relay.sent', {
    connectionId, toUserId: Number(target.id), chars: body.length,
  });
  return ok({
    queued: true, outboxId: res.data.outboxId,
    hint: 'Queued — their Olma delivers it when they are reachable (their quiet hours are respected). Tell the user it is on its way, never that it already arrived.',
  });
}

module.exports = { relayMessage, MAX_MESSAGE_CHARS };
