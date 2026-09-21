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
  const { rows } = await client.query(
    `UPDATE chat_group_members m
        SET last_wrote_at = greatest(coalesce(m.last_wrote_at, to_timestamp(0)), $3)
       FROM chat_groups g
      WHERE g.id = m.group_id AND g.external_id = $1 AND m.phone = $2 AND m.left_at IS NULL
    RETURNING m.group_id, m.user_id`,
    [jid, `+${digits}`, row.at]);
  if (!rows.length) return false;
  if (rows[0].user_id) await rehearHeldCoordinationRows(client, rows[0], row.at);
  return true;
}

// ── The stamp is worthless until somebody LOOKS at the row again ─────────────
// The gate has exempted a coordination row from the night and the quiet day
// for a member who just wrote in the room since 2026-09-08 (`inRoomGrace`,
// outbox/gate.js) — and on 2026-09-19 that exemption had never once run,
// because a held row is not a CANDIDATE. `outbox/worker.drainOnce` selects
// `release_after IS NULL OR release_after <= now()`, and all three of those
// holds set one: 'night' to the window's next open, 'quiet_day' and
// 'quiet_holiday' to the end of the run of days. So a row held at 08:38 on a
// Saturday was next read at havdalah, and every judgement the gate was ready
// to make in between happened to nothing. The comment above the quiet-day
// branch said `inRoomGrace` exempts a meeting row "from this one too"; it was
// the third comment this week asserting coverage the code did not have.
//
// `turn.openRecord({ wake: true })` is the same move for a DM and is the
// shape copied here, with its two differences stated: it re-hears 'night'
// alone, because a DM at 03:00 is not evidence that somebody's Shabbat is
// over, while a message in the room that is running the coordination is the
// owner's own rule for Saturday (2026-09-19: "אם אותו משתמש מתכתב בקבוצה בזמן
// שיש תיאום פתוח עולמה יכולה לשלוח לו הודעות רק בנוגע לתיאום"); and it is
// whole-person, while this is scoped to rows naming a meeting THIS room is
// running, which is what keeps it from being a general reopening.
//
// It only makes the worker re-read them. The gate stays the only judge — it
// re-runs in full, `groupWroteAt` is still what opens the window and is still
// null for anything else, a pause is still refused above that line, and a row
// whose fifteen minutes have passed by the time the tick comes simply holds
// again with a fresh release time.
//
// Dated by WHEN THEY WROTE rather than by `now()`, which is the one place this
// differs from `turn.js`: it is the same moment the stamp above carries and the
// same moment the gate measures its fifteen minutes from, so the three cannot
// drift apart, and a test may pin a Saturday without the statement reaching for
// the real clock underneath it.
async function rehearHeldCoordinationRows(client, { group_id: groupId, user_id: userId }, at) {
  // `mt.id::text = ...` rather than a cast of the payload: `meetingId` is the
  // model's to write, a row without one must not fail the whole stamp, and
  // Postgres gives no ordering promise that would let a `~ '^[0-9]+$'` guard
  // run before the cast it is guarding.
  await client.query(
    `UPDATE outbox o SET release_after = $3
       FROM meetings mt
      WHERE o.user_id = $1 AND o.sent_at IS NULL
        AND o.hold_reason IN ('night', 'quiet_day', 'quiet_holiday')
        AND o.release_after > $3
        AND mt.id::text = o.payload->>'meetingId'
        AND mt.group_id = $2`,
    [userId, groupId, at]);
}


// ── A message in the room that never named her ───────────────────────────────
// The owner's ask, twice (2026-09-19): *"אני רציתי שאם היא כותבת הודעה בקבוצה
// החלון של 15 הדקות נפתח."* Writing in the room is evidence the person is
// awake, and that is the whole argument the fifteen-minute window rests on —
// a tag is not part of it.
//
// It has not been possible until now for one reason. A registered room is
// `requireMention: true`, so the gateway drops an un-mentioning group message
// before anything of ours runs: no hook, no plugin, no stamp. Turning that off
// was measured the same day and produced the thing the owner then said must
// never happen — she ANSWERED an untagged message — because
// `messages.groupChat.unmentionedInbound: "room_event"` does not keep her
// quiet (measured, not assumed).
//
// What makes it possible is `before_dispatch`, a CLAIMING hook: a handler
// answering `{handled: true}` ends the message there, and no model turn is ever
// started. So silence is not a sentence in a prompt asking her not to speak —
// there is nothing running that could speak. Same argument as the reply gate.
//
// The cost is that the decision becomes OURS: at `before_dispatch` the gateway
// has not yet said whether she was mentioned (`was_mentioned` is born later, in
// the `Conversation info` block). This is that decision, and it errs in ONE
// direction — anything that might be addressed to her is let through, because
// the failure of a false "addressed" is the behaviour we already have, and the
// failure of a false "not addressed" is her going silent on somebody who really
// did ask her something.
const SELF_DIGITS = () => String(process.env.OLMA_WA_NUMBER || '972559347282').replace(/\D/g, '');

// A WhatsApp tag puts her own number in the body text, and a REPLY to one of
// her messages is a second way of addressing her the owner tested and asked to
// keep (`memory`, "Group reply addresses her"). Digits only on both sides: the
// body may carry the tag as `@972559347282`, with or without punctuation, and a
// number written out in words of the message is a false "addressed", which is
// the safe side.
function addressedToHer({ body, replyToSender } = {}, selfDigits = SELF_DIGITS()) {
  const self = String(selfDigits || '').replace(/\D/g, '');
  if (self.length < 7) return true;  // we do not know who we are → never claim
  const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
  return digits(replyToSender).includes(self) || digits(body).includes(self);
}

// The sender of a group message, as a phone, or null. A WhatsApp `senderId` is
// `<digits>@s.whatsapp.net` — and it can also be a LID (`<digits>@lid`), which
// is NOT a phone number and must never be treated as one: the mapping lives in
// the channel's own store and reading it was rejected as a source. A null here
// costs a window that does not open; a wrong one would stamp the wrong member.
function senderPhone(senderId) {
  const raw = String(senderId || '');
  if (/@lid\b/i.test(raw)) return null;
  const digits = raw.split('@')[0].replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
}

// Which rooms may have a message of theirs CLAIMED. Empty (the default) means
// none, so every half-state is today's behaviour: the stamp is always correct
// and always taken, and only the silencing waits for somebody to name the room.
// It is flipped together with that room's `requireMention` and never before the
// trace has shown this module's verdict agreeing with the gateway's own
// `was_mentioned` on real traffic.
const UNTAGGED_FLAG = 'group_untagged_rooms';
function roomClaimEnabled(flagValue, jid) {
  const raw = String(flagValue == null ? '' : flagValue).trim();
  if (!raw) return false;
  if (raw === 'all') return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(String(jid || '').trim());
}

module.exports = {
  SESSION_KEY_RE, parseConversationInfo, fromConversationInfo, store, read, noteMemberWrote,
  addressedToHer, senderPhone, roomClaimEnabled, UNTAGGED_FLAG, SELF_DIGITS,
};
