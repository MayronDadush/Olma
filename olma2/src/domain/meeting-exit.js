'use strict';
// "בחוץ" — a person leaving a coordination in one word.
//
// Yuval, 2026-10-01 (incidents.md, "בחוץ"): the room "חייב קבוצה לפוקר" was
// arranging poker, he was asked privately when suits him, and he answered
// "בחוץ". The model wrote "Got it — you're out. When would work for you?",
// called no tool, and the next question about the same poker reached him
// twelve minutes later. The model understood and the outcome had nowhere to
// go — the tool it needed says "Confirm with the user first", and nothing told
// it the confirmation was already the message.
//
// The owner's rule, which is the whole design:
//   1. an answer to a GENERAL question — the invite, "when suits you", the
//      table as a whole — is leaving: they are opted out, nothing is asked;
//   2. an answer to ONE time ("can you do Saturday?") is ambiguous — out of
//      Saturday or out of the poker — so ONE short question, and nothing is
//      written, not even a decline of that time.
//
// Which of the two it answered is not in the words. It is in the outbox: the
// last thing that reached them. The gateway hook reads only whether the
// message is nothing but "out" (`outOnly`, a boolean), and this decides the
// rest off rows the system wrote itself. Three guards keep the reading to the
// case the rule describes:
//   - the coordination question is the LAST thing delivered to them (any
//     kind) — a reminder after it makes "בחוץ" an answer to the reminder;
//   - this message is the FIRST thing they wrote since it arrived — after
//     another exchange the last thing Olma said was a reply, not the question;
//   - they are still in a coordination that is still negotiating.
// Anything else returns null and the turn is an ordinary one, which is exactly
// today's behaviour.
const audit = require('./audit');
const meetings = require('./meetings');
const meetingFanout = require('./meeting-fanout');

// Kinds whose question is about the coordination as a whole.
const GENERAL_KINDS = new Set(['meeting_invite', 'meeting_nudge']);
// How far back a question may be and still be the one they answered. The
// same day recentMeetings looks back over.
const WINDOW = '24 hours';

// What the last delivered row asked, or null when it was not a coordination
// question at all. `meeting_slot_proposed` is ONE time unless the fold turned
// it into a question about the whole table (`tableChanged`); the check-in
// ladder's `stuck_meeting` rung always names one.
function questionShape(row) {
  const p = row.payload || {};
  if (GENERAL_KINDS.has(row.kind)) return 'general';
  if (row.kind === 'meeting_slot_proposed') return p.tableChanged ? 'general' : 'one';
  if (row.kind === 'checkin' && p.rung === 'stuck_meeting') return 'one';
  return null;
}

async function lastQuestion(client, userId) {
  const { rows: [row] } = await client.query(
    `SELECT id, kind, payload, sent_at FROM outbox
      WHERE user_id = $1 AND sent_at IS NOT NULL AND hold_reason IS NULL
        AND sent_at > now() - interval '${WINDOW}'
      ORDER BY sent_at DESC, id DESC LIMIT 1`, [userId]);
  if (!row) return null;
  const shape = questionShape(row);
  const meetingId = Number(row.payload && row.payload.meetingId);
  if (!shape || !meetingId) return null;
  // The message being answered now has already been recorded by the opener;
  // a second one means they said something else first.
  const { rows: [heard] } = await client.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE actor_id = $1 AND event = 'message.received' AND created_at > $2`, [userId, row.sent_at]);
  if (heard.n > 1) return null;
  const { rows: [m] } = await client.query(
    `SELECT m.title, m.status, m.proposed_slot, mp.state
       FROM meetings m JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.user_id = $2
      WHERE m.id = $1`, [meetingId, userId]);
  if (!m || m.status !== 'negotiating' || m.state === 'opted_out') return null;
  const slot = row.kind === 'meeting_slot_proposed' ? row.payload.slot : m.proposed_slot;
  return { shape, kind: row.kind, meetingId, title: m.title, slot: slot || null };
}

// Called by brokerd when the hook said the message is only "out", inside the
// opener's transaction. Returns what the turn is told, or null.
//   { outcome: 'left', meetingId, title, meetingStatus, hint? }  — opted out
//   { outcome: 'ask',  meetingId, title, slot }                  — nothing written
async function onOut(client, userId) {
  const q = await lastQuestion(client, userId);
  if (!q) return null;
  if (q.shape === 'one') {
    await audit.record(client, userId, 'meeting.exit_word', { meetingId: q.meetingId, outcome: 'ask', kind: q.kind });
    return { outcome: 'ask', meetingId: q.meetingId, title: q.title, slot: q.slot };
  }
  // The same two calls opt_out_of_meeting makes, with the whole user row as
  // that tool hands it (rules/turns-and-replies.md: never a projection).
  const { rows: [user] } = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
  const res = await meetings.optOut(client, userId, q.meetingId);
  if (!res.ok) return null;
  const out = await meetingFanout.afterOptOut(client, user, q.meetingId, res);
  await audit.record(client, userId, 'meeting.exit_word', { meetingId: q.meetingId, outcome: 'left', kind: q.kind });
  return {
    outcome: 'left', meetingId: q.meetingId, title: q.title,
    meetingStatus: out.data.meetingStatus,
    ...(out.data.hint ? { hint: out.data.hint } : {}),
  };
}

module.exports = { onOut, lastQuestion, questionShape };
