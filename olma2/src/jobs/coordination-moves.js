'use strict';
// The DB half of `domain/coordination-policy`: read one room coordination's
// state, ask the policy, and — by the flag's mode for that room — record what
// it would do (`shadow`) or do it (`live`). Called from
// `jobs/groups.sweepGroupVoice`, inside its transaction, once per negotiating
// coordination per pass.
const policy = require('../domain/coordination-policy');
const groupVoice = require('../domain/group-voice');
const flags = require('../domain/flags');
const audit = require('../domain/audit');
const pause = require('../domain/pause');
const groupOutbox = require('../domain/group-outbox');
const { enqueue } = require('../outbox/enqueue');
const fanout = require('../domain/meeting-fanout');
const { MAX_TAGS, isTaggableNumber } = require('../domain/proactive-text');
const meetingTime = require('../domain/meeting-time');
const gate = require('../outbox/gate');

// Everything the policy reads, off the rows. `co` is statusOf's coordination.
async function stateFor(client, row, co) {
  const mid = Number(row.meeting_id);
  const { rows: [act] } = await client.query(
    `SELECT GREATEST(
        (SELECT max(a.answered_at) FROM meeting_option_answers a JOIN meeting_options o ON o.id = a.option_id
          WHERE o.meeting_id = $1
            -- a proposer's own yes on the time they just added is the table
            -- moving, which the next line counts anyway
            AND NOT (a.user_id = o.added_by AND abs(extract(epoch FROM a.answered_at - o.created_at)) < 5)),
        (SELECT max(GREATEST(o.created_at, o.decided_at)) FROM meeting_options o WHERE o.meeting_id = $1),
        (SELECT max(last_wrote_at) FROM chat_group_members WHERE group_id = $2),
        $3::timestamptz) AS at`,
    [mid, row.id, row.meeting_created_at]);
  // Asked — an invite or a proposal REACHED them — and answered nothing at all.
  // Somebody paused is never nudged: nothing reaches them from her.
  const { rows: silent } = await client.query(
    `SELECT p.user_id, min(ob.sent_at) AS asked_at, u.paused_at, u.paused_reason
       FROM meeting_participants p
       JOIN users u ON u.id = p.user_id
       -- the same rows statusOf calls "heard", so the nudge and the room's
       -- "asked" cannot disagree about who was reached
       JOIN outbox ob ON ob.user_id = p.user_id AND ob.kind LIKE 'meeting\\_%' ESCAPE '\\'
                     AND ob.kind <> 'meeting_nudge'
                     AND ob.sent_at IS NOT NULL AND ob.hold_reason IS NULL
                     AND (ob.payload->>'meetingId')::bigint = $1
      WHERE p.meeting_id = $1 AND p.state <> 'opted_out'
        AND NOT EXISTS (SELECT 1 FROM meeting_option_answers a JOIN meeting_options o ON o.id = a.option_id
                         -- anything at all, their own yes on a time they added
                         -- included: somebody who put a time up has not gone quiet
                         WHERE o.meeting_id = $1 AND a.user_id = p.user_id)
      GROUP BY p.user_id, u.paused_at, u.paused_reason`, [mid]);
  const { rows: nudged } = await client.query(
    `SELECT DISTINCT user_id FROM outbox WHERE kind = 'meeting_nudge' AND (payload->>'meetingId')::bigint = $1`, [mid]);
  const starts = (co.options || []).map((o) => (o.startsAt ? new Date(o.startsAt).getTime() : null)).filter(Boolean);
  return {
    chaseAt: row.group_chase_at || null,
    dropOfferAt: row.group_drop_offer_at || null,
    dropCloseAt: row.group_drop_close_at || null,
    lastActivityAt: act ? act.at : null,
    enough: groupVoice.enoughOn(groupVoice.leadingOption(co.options)),
    silent: silent.filter((r) => !r.paused_at).map((r) => ({ userId: Number(r.user_id), askedAt: r.asked_at })),
    nudged: nudged.map((r) => Number(r.user_id)),
    earliestStartAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
    // The tags the offer may carry: the chase's own rule — answered nothing,
    // and actually asked. A paused member is in `notInIt`, never here.
    silentPhones: (co.silent || []).filter((p) => p && p.asked !== false)
      .map((p) => p.phone).filter(isTaggableNumber).slice(0, MAX_TAGS),
  };
}

// A nudge still queued for somebody who has since answered anything asks a
// question they already answered. `meeting-options.answer` withdraws it at the
// answer; this is the backstop for any other way an answer is written.
async function withdrawAnswered(client, meetingId) {
  await client.query(
    `UPDATE outbox ob SET sent_at = now(), hold_reason = 'superseded'
      WHERE ob.sent_at IS NULL AND ob.kind = 'meeting_nudge' AND (ob.payload->>'meetingId')::bigint = $1
        AND EXISTS (SELECT 1 FROM meeting_option_answers a JOIN meeting_options o ON o.id = a.option_id
                     WHERE o.meeting_id = $1 AND a.user_id = ob.user_id)`, [meetingId]);
}

// Once per coordination for the room moves, once per person for a nudge.
async function shadowOnce(client, row, move, now, userId = null, extra = {}) {
  const { rows } = await client.query(
    `SELECT 1 FROM audit_log WHERE event = 'coordination.policy_shadow'
        AND (detail->>'meetingId')::bigint = $1 AND detail->>'move' = $2
        AND ($3::bigint IS NULL OR (detail->>'userId')::bigint = $3) LIMIT 1`,
    [Number(row.meeting_id), move, userId]);
  if (rows.length) return false;
  await audit.record(client, row.registered_by_user_id, 'coordination.policy_shadow', {
    // `at` is the clock the decision was made on, which `created_at` is not.
    groupId: row.id, meetingId: Number(row.meeting_id), move, at: now.toISOString(),
    ...(userId != null ? { userId } : {}), ...extra,
  });
  return true;
}

// `roomFree`: the room's own hours, and no other line about this coordination
// in this pass. An offer and a close are both things the room would notice at
// 03:00, so neither happens then; a nudge goes through the person's own gate,
// which holds it for THEIR night.
async function run(client, row, co, { now = new Date(), roomFree = true, full = null, window = null } = {}) {
  if (!co || co.status !== 'negotiating') return { mode: 'off', moves: [] };
  // Withdrawn whatever the mode, so turning the flag off never strands one.
  await withdrawAnswered(client, Number(row.meeting_id));
  const flag = await flags.getFlag(client, 'coordination_policy');
  const mode = policy.modeFor(flag, row);
  if (mode === 'off') return { mode, moves: [] };
  const s = await stateFor(client, row, co);
  // In shadow nothing is stamped or queued, so what shadow already DECIDED
  // stands in for it — otherwise it would decide the same offer every pass and
  // never reach the close, which is half of what it is there to measure.
  if (mode === 'shadow') {
    const { rows: sh } = await client.query(
      `SELECT detail->>'move' AS move, (detail->>'userId')::bigint AS user_id, min((detail->>'at')::timestamptz) AS at, min((detail->>'closeAt')::timestamptz) AS close_at
         FROM audit_log WHERE event = 'coordination.policy_shadow' AND (detail->>'meetingId')::bigint = $1
        GROUP BY 1, 2`, [Number(row.meeting_id)]);
    const offer = sh.find((r) => r.move === 'drop_offer');
    if (offer && !s.dropOfferAt) {
      s.dropOfferAt = offer.at;
      s.dropCloseAt = offer.close_at;
    }
    for (const r of sh) if (r.move === 'nudge' && r.user_id != null) s.nudged.push(Number(r.user_id));
  }
  const params = policy.paramsOf(flag);
  const moves = policy.nextMoves(s, now.getTime(), params);
  const done = [];

  for (const m of moves) {
    if (m.kind === 'nudge') {
      for (const uid of m.userIds) {
        if (mode === 'shadow') { if (await shadowOnce(client, row, 'nudge', now, uid)) done.push({ kind: 'nudge', userId: uid }); continue; }
        const paused = await pause.isPaused(client, uid);
        if (paused) continue;
        await enqueue(client, {
          userId: uid, kind: 'meeting_nudge',
          payload: { meetingId: Number(row.meeting_id), title: (full && full.title) || co.title, groupSubject: row.subject || null },
          idempotencyKey: `mnudge:${row.meeting_id}:${uid}`,
        });
        await audit.record(client, uid, 'meeting.nudged', { meetingId: Number(row.meeting_id), groupId: row.id });
        done.push({ kind: 'nudge', userId: uid });
      }
      continue;
    }
    if (!roomFree) continue;
    // The moment the offer will name, fixed now and stored: the room reads it,
    // so the close has to keep it.
    const tz = row.timezone || 'Asia/Jerusalem';
    const closeAt = m.kind === 'drop_offer'
      ? new Date(policy.closeMomentFor(now.getTime(), params,
        window ? (d) => gate.msUntilWindowOpen(window, tz, d) : null))
      : null;
    if (mode === 'shadow') {
      if (await shadowOnce(client, row, m.kind, now, null, closeAt ? { closeAt: closeAt.toISOString() } : {})) done.push({ kind: m.kind });
      continue;
    }
    if (m.kind === 'drop_offer') {
      const round = row.reopened_at ? `:r${new Date(row.reopened_at).getTime()}` : '';
      await groupOutbox.enqueue(client, {
        groupId: row.id, kind: 'coordination',
        payload: { line: {
          kind: 'drop_offer', title: co.title, missing: s.silentPhones,
          closeAt: closeAt.toISOString(), saidAt: now.toISOString(), roomTz: tz,
          // A room on several clocks hears the moment in each (group-voice.withClocks).
          ...(meetingTime.spansZones(co.zones || [], tz, closeAt) ? { multiZone: true, zones: co.zones } : {}),
        } },
        idempotencyKey: `g${row.id}:m${row.meeting_id}:drop_offer${round}`,
      });
      await client.query('UPDATE meetings SET group_drop_offer_at = $2, group_drop_close_at = $3 WHERE id = $1',
        [row.meeting_id, now, closeAt]);
      await audit.record(client, row.registered_by_user_id, 'group.coordination_said', {
        groupId: row.id, meetingId: Number(row.meeting_id), kind: 'drop_offer',
      });
      done.push({ kind: 'drop_offer', spoke: true });
    } else if (m.kind === 'drop_close') {
      // Quietly (owner, 2026-09-28): no line of its own. Its ending rides the
      // next digest of whoever was in it, like any other close.
      const upd = await client.query(
        `UPDATE meetings SET status = 'no_match', updated_at = $2, closed_at = $2
          WHERE id = $1 AND status = 'negotiating'`, [row.meeting_id, now]);
      if (!upd.rowCount) continue;
      await fanout.supersedeQueuedMeetingRows(client, Number(row.meeting_id), ['meeting_slot_proposed', 'meeting_invite']);
      await audit.record(client, row.registered_by_user_id, 'meeting.dropped_quiet', {
        groupId: row.id, meetingId: Number(row.meeting_id), offeredAt: s.dropOfferAt,
      });
      done.push({ kind: 'drop_close' });
    }
  }
  return { mode, moves: done };
}

module.exports = { run, stateFor, withdrawAnswered };
