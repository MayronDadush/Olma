'use strict';
// One coordination as the rows it left behind, in the shape
// `coordination-score.scoreCoordination` reads. Read-only: every statement is
// a SELECT, so the report can run on the box against the live database.
//
// What counts as a TOUCH — something of ours that reached a person:
//  - a room line: `audit_log 'group.coordination_said'`, its `detail.kind`
//    (the hand-sent lines of 2026-09-28 are there too, as `manual_*`);
//  - a private message: an `outbox` row whose payload names the coordination
//    and whose `sent_at` is set. A held or cancelled row reached nobody.
//
// A proposer's own yes on the time they just added is not an ANSWER to
// anything we did — `options.add` writes it in the same moment — so it is
// marked `byAdding` and the score leaves it out of response and effect.

const BY_ADDING_MS = 5_000;
const LEGACY_OPTION = -1;

async function timelineFor(client, meetingId) {
  const id = Number(meetingId);
  const { rows: [m] } = await client.query(
    `SELECT m.id, m.group_id, m.initiator_id, m.status, m.created_at, m.closed_at, m.confirmed_start_at,
            m.quorum_min, g.quorum_max
       FROM meetings m LEFT JOIN chat_groups g ON g.id = m.group_id WHERE m.id = $1`, [id]);
  if (!m) return null;

  // One after another: a pg client runs one statement at a time anyway.
  const { rows: participants } = await client.query(
    'SELECT user_id, state, confirmed_at FROM meeting_participants WHERE meeting_id = $1', [id]);
  const { rows: options } = await client.query(
    'SELECT id, starts_at, all_day, added_by, created_at, status FROM meeting_options WHERE meeting_id = $1', [id]);
  const { rows: answers } = await client.query(
      `SELECT a.option_id, a.user_id, a.answer, a.answered_at, o.added_by, o.created_at AS option_at
         FROM meeting_option_answers a JOIN meeting_options o ON o.id = a.option_id
        WHERE o.meeting_id = $1`, [id]);
  const { rows: room } = await client.query(
      `SELECT created_at, detail->>'kind' AS kind FROM audit_log
        WHERE event = 'group.coordination_said' AND (detail->>'meetingId')::bigint = $1`, [id]);
  const { rows: priv } = await client.query(
      `SELECT user_id, kind, sent_at FROM outbox
        WHERE (payload->>'meetingId')::bigint = $1 AND sent_at IS NOT NULL AND kind LIKE 'meeting%'`, [id]);
  const { rows: events } = await client.query(
      `SELECT event, actor_id, created_at, detail FROM audit_log
        WHERE (detail->>'meetingId')::bigint = $1
          AND event IN ('meeting.confirmed', 'meeting.settled_by_hand', 'group.coordination_settled',
                        'meeting.cancelled', 'meeting.reopened', 'meeting.opted_out', 'meeting.withdrew')
        ORDER BY created_at`, [id]);

  let roomSize = null;
  if (m.group_id != null) {
    const { rows: [r] } = await client.query(
      'SELECT count(*)::int AS n FROM chat_group_members WHERE group_id = $1 AND left_at IS NULL', [m.group_id]);
    roomSize = r ? r.n : null;
  }

  const settles = events.filter((e) => ['meeting.confirmed', 'meeting.settled_by_hand', 'group.coordination_settled'].includes(e.event));
  const lastSettle = settles[settles.length - 1] || null;
  let confirmedOptionId = null;
  if (m.status === 'confirmed') {
    const named = settles.map((e) => e.detail && e.detail.optionId).filter((x) => x != null);
    if (named.length) confirmedOptionId = Number(named[named.length - 1]);
    else if (m.confirmed_start_at) {
      const hit = options.find((o) => o.starts_at && new Date(o.starts_at).getTime() === new Date(m.confirmed_start_at).getTime());
      if (hit) confirmedOptionId = Number(hit.id);
    }
  }
  // Before the options table (migration 039) a coordination had ONE time and
  // the answer lived on the participant row. Read it as one option, id
  // LEGACY_OPTION, so the score has a single shape to read.
  const legacy = options.length === 0;
  if (legacy && m.status === 'confirmed') confirmedOptionId = LEGACY_OPTION;
  const legacyAnswers = !legacy ? [] : participants
    .filter((p) => p.state === 'confirmed_current' || p.state === 'declined_current')
    // The initiator's yes is the proposal itself: it counts toward who is in,
    // never as an answer to anything we did.
    .map((p) => ({ optionId: LEGACY_OPTION, userId: Number(p.user_id), answer: p.state === 'confirmed_current' ? 'y' : 'n',
      at: p.confirmed_at, byAdding: Number(p.user_id) === Number(m.initiator_id) }));

  const starts = options.filter((o) => o.starts_at && o.status !== 'deleted').map((o) => new Date(o.starts_at).getTime());

  return {
    meetingId: id,
    groupId: m.group_id == null ? null : Number(m.group_id),
    initiatorId: m.initiator_id == null ? null : Number(m.initiator_id),
    status: m.status,
    startedAt: m.created_at,
    closedAt: m.status === 'confirmed' && lastSettle ? lastSettle.created_at : m.closed_at,
    settledAt: lastSettle ? lastSettle.created_at : null,
    settledByHand: events.some((e) => e.event === 'meeting.settled_by_hand'),
    undoneAt: events.filter((e) => e.event === 'meeting.cancelled' || e.event === 'meeting.reopened').map((e) => e.created_at),
    confirmedOptionId,
    confirmedStartAt: m.confirmed_start_at,
    earliestStartAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
    roomSize,
    // How many is ENOUGH: a game's top, else the minimum they set, else nobody said.
    target: m.quorum_max != null ? Number(m.quorum_max) : m.quorum_min != null ? Number(m.quorum_min) : null,
    legacy,
    participants: participants.map((p) => ({ userId: Number(p.user_id), state: p.state })),
    answers: [...legacyAnswers, ...answers.map((a) => ({
      optionId: Number(a.option_id), userId: Number(a.user_id), answer: a.answer, at: a.answered_at,
      byAdding: Number(a.user_id) === Number(a.added_by)
        && Math.abs(new Date(a.answered_at) - new Date(a.option_at)) <= BY_ADDING_MS,
    }))],
    touches: [
      ...room.map((r) => ({ at: r.created_at, channel: 'room', kind: r.kind || 'unknown', userIds: [] })),
      ...priv.map((p) => ({ at: p.sent_at, channel: 'private', kind: p.kind, userIds: [Number(p.user_id)] })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at)),
    exits: events.filter((e) => e.event === 'meeting.opted_out' || e.event === 'meeting.withdrew')
      .map((e) => ({ userId: Number(e.actor_id), at: e.created_at, cause: (e.detail && e.detail.cause) || null })),
  };
}

// Every coordination worth scoring: nobody in it is the eval user.
async function coordinationIds(client, { roomsOnly = false } = {}) {
  const { rows } = await client.query(
    `SELECT m.id FROM meetings m
      WHERE ($1::boolean IS FALSE OR m.group_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM meeting_participants p JOIN users u ON u.id = p.user_id
                         WHERE p.meeting_id = m.id AND u.is_eval)
      ORDER BY m.id`, [roomsOnly]);
  return rows.map((r) => Number(r.id));
}

module.exports = { timelineFor, coordinationIds, BY_ADDING_MS, LEGACY_OPTION };
