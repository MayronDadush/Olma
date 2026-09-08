'use strict';
// What the gateway told the model about the newest message in a group —
// stored by brokerd, read by the group sweep.
//
// Group mode needs four things per group message that only the gateway
// knows: the roster, the subject, whether she was actually tagged, and the
// message's id. On OpenClaw 2026.8.1 they exist in exactly one place: the
// `Conversation info` block the gateway composes into the model's input for
// that turn. It is NOT in the transcript (the store keeps the bare text —
// measured 2026-09-06, the day group mode went live and registered nothing),
// not in the internal `message:preprocessed` hook's context (the mapper
// drops `GroupMembers`), and `openclaw directory groups members` answers
// "not supported" for WhatsApp.
//
// So the plugin (gateway-plugin/olma-turn) reads it on `llm_input` — the
// hook that receives the model's input verbatim — and sends it here as
// `group_context`. That keeps the trust path where the design put it: the
// block is the gateway's own description of the envelope, written before
// the model sees anything, and nothing the model says can change it.
//
// One row per session, replaced on each message. The sweep wants the newest
// tag, the same thing it used to want from the newest transcript event.
const SESSION_KEY_RE = /^agent:(ggreet|g-\d+):whatsapp:group:([^:\s]+@g\.us)$/;
const CONVERSATION_INFO_RE = /Conversation info[^\n]*\n```json\n([\s\S]*?)\n```/;
const MAX_TEXT = 4000;

// The `Conversation info` JSON out of any text the gateway hands a hook —
// the prompt, the system prompt, or a message's text parts. Null when there
// is none or it does not parse; never throws.
function parseConversationInfo(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') {
    const m = CONVERSATION_INFO_RE.exec(value);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = parseConversationInfo(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) {
      const found = parseConversationInfo(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function str(v, max = MAX_TEXT) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

// The block, reduced to what the sweep reads and checked against the session
// it claims to describe. `chat_id` may arrive channel-prefixed
// ("whatsapp:<jid>") or bare; either must name THIS session's group, or the
// row is refused — the greeter serves every unregistered group at once, and
// a roster filed under the wrong group would open one on another's members.
function fromConversationInfo(agentId, sessionKey, info, { at } = {}) {
  const key = SESSION_KEY_RE.exec(String(sessionKey || ''));
  if (!key || key[1] !== agentId) return { ok: false, reason: 'not a group session of that agent' };
  if (!info || typeof info !== 'object') return { ok: false, reason: 'no conversation info' };
  const jid = key[2];
  const chatId = str(info.chat_id, 200);
  if (chatId && chatId !== jid && !chatId.endsWith(`:${jid}`)) return { ok: false, reason: 'chat_id names another group' };
  const sender = info.sender && typeof info.sender === 'object' ? info.sender : {};
  const when = at instanceof Date ? at : new Date(at || Date.now());
  return {
    ok: true,
    row: {
      sessionKey: key[0], agentId, chatId,
      subject: str(info.group_subject, 500),
      members: str(info.group_members),
      senderE164: str(sender.e164 || sender.id, 40),
      senderName: str(sender.name, 200),
      wasMentioned: info.was_mentioned === true,
      messageId: str(info.message_id, 120),
      at: Number.isFinite(when.getTime()) ? when : new Date(),
    },
  };
}

async function store(client, row) {
  await client.query(
    `INSERT INTO group_inbound_context
       (session_key, agent_id, chat_id, subject, members, sender_e164, sender_name, was_mentioned, message_id, at, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (session_key) DO UPDATE SET
       agent_id = EXCLUDED.agent_id, chat_id = EXCLUDED.chat_id, subject = EXCLUDED.subject,
       members = EXCLUDED.members, sender_e164 = EXCLUDED.sender_e164, sender_name = EXCLUDED.sender_name,
       was_mentioned = EXCLUDED.was_mentioned, message_id = EXCLUDED.message_id, at = EXCLUDED.at,
       received_at = now()`,
    [row.sessionKey, row.agentId, row.chatId, row.subject, row.members, row.senderE164, row.senderName,
      row.wasMentioned, row.messageId, row.at]);
}

// The same shape `sessions.readGroupContext` returned, so the sweep does not
// know which source it is reading. Null is "nothing stored", never "an
// empty group".
async function read(client, agentId, sessionKey) {
  const { rows } = await client.query(
    `SELECT subject, members, sender_e164, sender_name, was_mentioned, message_id, at
       FROM group_inbound_context WHERE session_key = $1 AND agent_id = $2`,
    [sessionKey, agentId]);
  const r = rows[0];
  if (!r) return null;
  return {
    subject: r.subject, members: r.members,
    senderE164: r.sender_e164, senderName: r.sender_name,
    wasMentioned: r.was_mentioned === true, messageId: r.message_id,
    at: r.at ? new Date(r.at).getTime() : null,
  };
}

// A member wrote in the room, and that is now a fact with a consequence: it
// opens the delivery gate's 15-minute conversation window for the coordination
// that room is running (outbox/gate.js, `wroteInTheRoom`). The owner's rule,
// 2026-09-08 — a person who just spoke is awake, whichever chat they spoke in.
//
// Written here because this is the ONLY place a group sender is ever learned,
// and it inherits that source's blind spot exactly: a registered room is
// `requireMention: true`, so what does not name her never arrives, and this
// column stays silent for it. Silence here is "she was not shown a message",
// never "nobody wrote".
//
// Keyed by phone, and her own number can never match one: `syncSenderGate`
// keeps her out of the sender list, and `chat_group_members` is the room's
// people. `greatest` because the clock on the block is the gateway's and a
// late-arriving turn must not move the stamp backwards.
async function noteMemberWrote(client, row) {
  const jid = String(row.chatId || '').split(':').pop();
  const digits = String(row.senderE164 || '').replace(/\D/g, '');
  if (!jid || digits.length < 7 || digits.length > 15) return false;
  const { rowCount } = await client.query(
    `UPDATE chat_group_members m
        SET last_wrote_at = greatest(coalesce(m.last_wrote_at, to_timestamp(0)), $3)
       FROM chat_groups g
      WHERE g.id = m.group_id AND g.external_id = $1 AND m.phone = $2 AND m.left_at IS NULL`,
    [jid, `+${digits}`, row.at]);
  return rowCount > 0;
}

module.exports = { SESSION_KEY_RE, parseConversationInfo, fromConversationInfo, store, read, noteMemberWrote };
