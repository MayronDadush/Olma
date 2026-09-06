'use strict';
// Several candidate times per meeting, each answered on its own.
//
// The rules, from the owner (2026-09-05):
//   - anyone still in the meeting may add an option, up to MAX_ACTIVE (4);
//   - a fifth from someone other than the initiator is `pending` until the
//     initiator approves it (naming which active one it replaces) or rejects;
//   - the initiator may swap an active option for a new one at any time;
//   - adding is agreeing: the adder's own answer to it is yes;
//   - one active option with a yes from every active participant ARMS the
//     meeting; it settles a minute later, and a mind changed inside that
//     minute takes the arming back. Nobody announces agreement; the system
//     does, once, when the minute is up (owner, 2026-09-06);
//   - and the initiator may settle on an option by hand at any time, agreed
//     or not — "everyone wants Tuesday, one person cannot make it, and it
//     happens anyway". That one is immediate: it is already a decision.
//
// The single-slot columns on `meetings` and `state` on meeting_participants
// are MIRRORS of the newest active option (see mirrorCurrent). Every reader
// that predates options — the check-in rung, the digest, the dashboard until
// it learns options, the chat tools until theirs — keeps reading them.
const { ok, err } = require('./results');
const audit = require('./audit');
const { hasOffset, badTime, weekdayClash } = require('./datetime');

const MAX_ACTIVE = 4;

async function participant(client, meetingId, userId) {
  const { rows } = await client.query(
    `SELECT p.user_id, p.state, m.status AS meeting_status, m.initiator_id
       FROM meeting_participants p JOIN meetings m ON m.id = p.meeting_id
      WHERE p.meeting_id = $1 AND p.user_id = $2`, [meetingId, userId]);
  return rows[0] || null;
}

// Options on the table (active, newest first) and the ones waiting on the
// initiator, each with its answers as { userId: 'y' | 'n' }.
async function list(client, meetingId) {
  const { rows } = await client.query(
    `SELECT o.id, o.slot_text, o.starts_at, o.all_day, o.daypart, o.added_by, o.status, o.created_at,
            coalesce(json_object_agg(a.user_id, a.answer) FILTER (WHERE a.user_id IS NOT NULL), '{}'::json) AS answers
       FROM meeting_options o
       LEFT JOIN meeting_option_answers a ON a.option_id = o.id
      WHERE o.meeting_id = $1 AND o.status IN ('active', 'pending')
      GROUP BY o.id
      ORDER BY o.status = 'active' DESC, o.id DESC`, [meetingId]);
  return rows.map((o) => ({
    id: Number(o.id), slotText: o.slot_text, startsAt: o.starts_at, allDay: o.all_day, daypart: o.daypart || null,
    addedBy: o.added_by === null ? null : Number(o.added_by), status: o.status,
    createdAt: o.created_at, answers: o.answers || {},
  }));
}

async function activeCount(client, meetingId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM meeting_options WHERE meeting_id = $1 AND status = 'active'`, [meetingId]);
  return rows[0].n;
}

// The single-slot columns follow the newest active option, and every active
// participant's `state` follows their answer to THAT option. Readers written
// for one slot at a time see exactly what they always saw.
async function mirrorCurrent(client, meetingId) {
  const { rows } = await client.query(
    `SELECT id, slot_text, starts_at FROM meeting_options
      WHERE meeting_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`, [meetingId]);
  const cur = rows[0];
  if (!cur) {
    await client.query(
      `UPDATE meetings SET proposed_slot = NULL, proposed_start_at = NULL, updated_at = now() WHERE id = $1`, [meetingId]);
    await client.query(
      `UPDATE meeting_participants SET state = 'awaiting', confirmed_at = NULL
        WHERE meeting_id = $1 AND state <> 'opted_out'`, [meetingId]);
    return null;
  }
  await client.query(
    `UPDATE meetings SET proposed_slot = $2, proposed_start_at = $3, updated_at = now() WHERE id = $1`,
    [meetingId, cur.slot_text, cur.starts_at]);
  await client.query(
    `UPDATE meeting_participants p
        SET state = CASE a.answer WHEN 'y' THEN 'confirmed_current' WHEN 'n' THEN 'declined_current' ELSE 'awaiting' END,
            confirmed_at = CASE WHEN a.answer = 'y' THEN coalesce(p.confirmed_at, a.answered_at) ELSE NULL END
       FROM (SELECT mp.user_id, oa.answer, oa.answered_at
               FROM meeting_participants mp
               LEFT JOIN meeting_option_answers oa ON oa.option_id = $2 AND oa.user_id = mp.user_id
              WHERE mp.meeting_id = $1) a
      WHERE p.meeting_id = $1 AND p.user_id = a.user_id AND p.state <> 'opted_out'`,
    [meetingId, cur.id]);
  return { id: Number(cur.id), slotText: cur.slot_text, startsAt: cur.starts_at };
}

async function validSlot(client, userId, label, slotText, startsAt) {
  if (!slotText || !slotText.trim()) return err('invalid', 'slot description required');
  if (!hasOffset(startsAt)) return badTime(label, startsAt);
  if (new Date(startsAt).getTime() < Date.now()) {
    return err('invalid', 'that slot is already in the past — propose a future time', { reason: 'slot_in_past' });
  }
  const { rows } = await client.query('SELECT timezone FROM users WHERE id = $1', [userId]);
  const clash = weekdayClash(label, slotText, startsAt, rows[0] && rows[0].timezone);
  if (clash) return clash;
  return null;
}

// Add a candidate. Returns { option, pending } — `pending` true when it went
// to the initiator for approval instead of onto the table.
async function add(client, userId, meetingId, slotText, startsAt, { allDay = false, daypart = null, label = 'slot_description' } = {}) {
  const p = await participant(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (p.meeting_status !== 'negotiating') return err('invalid', 'meeting is not negotiating');
  if (p.state === 'opted_out') return err('invalid', 'you opted out of this meeting');
  const bad = await validSlot(client, userId, label, slotText, startsAt);
  if (bad) return bad;
  // The same moment twice is one option, not two: the second person to name
  // it is agreeing to it.
  const { rows: same } = await client.query(
    `SELECT id FROM meeting_options WHERE meeting_id = $1 AND status = 'active' AND starts_at = $2::timestamptz`,
    [meetingId, startsAt]);
  if (same[0]) {
    await answer(client, userId, meetingId, Number(same[0].id), 'y');
    return ok({ option: (await list(client, meetingId)).find((o) => o.id === Number(same[0].id)), pending: false, duplicate: true });
  }
  const isInitiator = Number(p.initiator_id) === Number(userId);
  const n = await activeCount(client, meetingId);
  let status = 'active';
  if (n >= MAX_ACTIVE) {
    if (isInitiator) {
      return err('invalid', `${MAX_ACTIVE} options are the maximum — swap one out (swapOption) to add another`, { reason: 'options_full' });
    }
    status = 'pending';
  }
  const { rows } = await client.query(
    `INSERT INTO meeting_options (meeting_id, slot_text, starts_at, all_day, daypart, added_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [meetingId, slotText.trim(), startsAt, Boolean(allDay), daypart || null, userId, status]);
  const optionId = Number(rows[0].id);
  // Adding is agreeing — recorded even on a pending one, so that approval
  // does not have to ask the proposer again.
  await client.query(
    // clock_timestamp(), not now(): now() is TRANSACTION time, and two answers
    // inside one transaction would tie — the confirmation ORDER (who becomes
    // the successor) is read off these stamps and must be a total order.
    `INSERT INTO meeting_option_answers (option_id, user_id, answer, answered_at) VALUES ($1, $2, 'y', clock_timestamp())`, [optionId, userId]);
  await audit.record(client, userId, status === 'pending' ? 'meeting.option_pending' : 'meeting.slot_proposed',
    { meetingId: Number(meetingId), optionId, slot: slotText.trim(), startsAt });
  if (status === 'active') await mirrorCurrent(client, meetingId);
  const option = (await list(client, meetingId)).find((o) => o.id === optionId);
  return ok({ option, pending: status === 'pending', initiatorId: Number(p.initiator_id) });
}

// One person's answer to one option. Confirms the meeting when this makes an
// option unanimous.
async function answer(client, userId, meetingId, optionId, value) {
  if (value !== 'y' && value !== 'n') return err('invalid', 'answer must be y or n');
  const p = await participant(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (p.meeting_status !== 'negotiating') return err('invalid', 'meeting is not negotiating');
  if (p.state === 'opted_out') return err('invalid', 'you opted out of this meeting');
  const { rows } = await client.query(
    `SELECT id, slot_text FROM meeting_options WHERE id = $1 AND meeting_id = $2 AND status = 'active'`,
    [optionId, meetingId]);
  if (!rows[0]) return err('not_found', 'no such option on the table', { reason: 'option_not_active' });
  await client.query(
    `INSERT INTO meeting_option_answers (option_id, user_id, answer, answered_at) VALUES ($1, $2, $3, clock_timestamp())
     ON CONFLICT (option_id, user_id) DO UPDATE SET answer = EXCLUDED.answer,
       -- a repeated yes keeps its place in the order; a changed mind restamps
       answered_at = CASE WHEN meeting_option_answers.answer = EXCLUDED.answer THEN meeting_option_answers.answered_at ELSE clock_timestamp() END`,
    [optionId, userId, value]);
  await audit.record(client, userId, value === 'y' ? 'meeting.slot_accepted' : 'meeting.slot_declined',
    { meetingId: Number(meetingId), optionId: Number(optionId), slot: rows[0].slot_text });
  await mirrorCurrent(client, meetingId);
  const c = await tryConfirm(client, meetingId);
  // The last yes no longer ends the meeting — it starts the minute. Nobody is
  // told yet, on purpose: the announcement is the thing the grace exists to
  // hold back. `settleDue` makes it once, when the minute is up.
  if (c.settling) {
    return ok({
      meetingId: Number(meetingId), meetingStatus: 'settling', optionId: Number(optionId),
      answer: value, slot: c.slot, settleDueAt: c.settleDueAt,
    });
  }
  return ok({
    meetingId: Number(meetingId), meetingStatus: 'negotiating', optionId: Number(optionId),
    answer: value, ...(c.disarmed ? { unsettled: true } : {}),
  });
}

// The grace between the last yes and the meeting being over. A minute, and it
// exists because the alternative was measured against real use: a mis-tap on a
// phone list closed the negotiation and told five people, and the only way
// back was to cancel a meeting that had just been announced. A minute costs
// nobody anything and makes a wrong tap a private mistake.
const SETTLE_GRACE_MS = 60 * 1000;

// The hard gate, unchanged in what it asks: one active option with a yes from
// every active participant. Two people at least — a meeting of one cannot
// settle. It no longer WRITES anything; the two callers below decide what a
// yes here means.
async function unanimousOption(client, meetingId) {
  const { rows } = await client.query(
    `WITH active AS (
       SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND state <> 'opted_out')
     SELECT o.id, o.slot_text, o.starts_at
       FROM meeting_options o
      WHERE o.meeting_id = $1 AND o.status = 'active'
        AND (SELECT count(*) FROM active) >= 2
        AND NOT EXISTS (
          SELECT 1 FROM active a
           WHERE NOT EXISTS (SELECT 1 FROM meeting_option_answers oa
                              WHERE oa.option_id = o.id AND oa.user_id = a.user_id AND oa.answer = 'y'))
      ORDER BY o.id LIMIT 1`, [meetingId]);
  return rows[0] || null;
}

// Closing the meeting, on a named option. The only writer of `status =
// 'confirmed'`, reached from exactly two places: the sweep when a grace runs
// out, and the initiator settling by hand. `byUserId` is null for the first
// and a person for the second, and that is the difference between "everyone
// agreed" and "somebody decided" for every message written afterwards.
async function confirmOn(client, meetingId, option, byUserId = null) {
  const upd = await client.query(
    `UPDATE meetings SET status = 'confirmed', confirmed_slot = $2, confirmed_start_at = $3,
            proposed_slot = $2, proposed_start_at = $3, settled_by = $4,
            settle_due_at = NULL, settling_option_id = NULL,
            updated_at = now(), closed_at = now()
      WHERE id = $1 AND status = 'negotiating'`,
    [meetingId, option.slot_text, option.starts_at, byUserId]);
  if (upd.rowCount === 0) return { confirmed: false };
  return {
    confirmed: true, slot: option.slot_text, startsAt: option.starts_at,
    optionId: Number(option.id), settledBy: byUserId === null ? null : Number(byUserId),
  };
}

// Called after anything that could move an answer. Arms the grace when an
// option has become unanimous, takes the arming back when it stops being one,
// and — deliberately — never closes anything itself.
//
// Re-arming on an option ALREADY counting down would push the moment away
// every time somebody re-sent a yes they had already given, so the clock is
// left alone unless the option under it changed.
async function tryConfirm(client, meetingId, { graceMs = SETTLE_GRACE_MS } = {}) {
  const win = await unanimousOption(client, meetingId);
  const { rows } = await client.query(
    `SELECT settle_due_at, settling_option_id FROM meetings WHERE id = $1 AND status = 'negotiating'`,
    [meetingId]);
  const m = rows[0];
  if (!m) return { confirmed: false, settling: false };

  if (!win) {
    if (!m.settle_due_at) return { confirmed: false, settling: false };
    await client.query(
      `UPDATE meetings SET settle_due_at = NULL, settling_option_id = NULL, updated_at = now()
        WHERE id = $1 AND status = 'negotiating'`, [meetingId]);
    return { confirmed: false, settling: false, disarmed: true };
  }
  if (m.settle_due_at && Number(m.settling_option_id) === Number(win.id)) {
    return {
      confirmed: false, settling: true, settleDueAt: m.settle_due_at,
      slot: win.slot_text, startsAt: win.starts_at, optionId: Number(win.id),
    };
  }
  const armed = await client.query(
    `UPDATE meetings SET settle_due_at = clock_timestamp() + make_interval(secs => $2::float8),
            settling_option_id = $3, updated_at = now()
      WHERE id = $1 AND status = 'negotiating' RETURNING settle_due_at`,
    [meetingId, graceMs / 1000, win.id]);
  if (!armed.rows[0]) return { confirmed: false, settling: false };
  await audit.record(client, null, 'meeting.settling', {
    meetingId: Number(meetingId), optionId: Number(win.id), slot: win.slot_text,
    dueAt: armed.rows[0].settle_due_at,
  });
  return {
    confirmed: false, settling: true, settleDueAt: armed.rows[0].settle_due_at,
    slot: win.slot_text, startsAt: win.starts_at, optionId: Number(win.id), armed: true,
  };
}

// The other half of the grace: every meeting whose minute is up. It re-asks
// unanimity rather than trusting the armed row — the disarm above runs only on
// paths that call tryConfirm, and a participant removed by some future path
// that does not would otherwise leave a meeting armed on an option nobody
// still agrees to.
async function settleDue(client, limit = 50) {
  const { rows } = await client.query(
    `SELECT id FROM meetings
      WHERE status = 'negotiating' AND settle_due_at IS NOT NULL AND settle_due_at <= clock_timestamp()
      ORDER BY settle_due_at LIMIT $1`, [limit]);
  const settled = [];
  for (const { id } of rows) {
    const win = await unanimousOption(client, id);
    if (!win) {
      await client.query(
        `UPDATE meetings SET settle_due_at = NULL, settling_option_id = NULL, updated_at = now()
          WHERE id = $1 AND status = 'negotiating'`, [id]);
      continue;
    }
    const c = await confirmOn(client, id, win, null);
    if (!c.confirmed) continue;
    await audit.record(client, null, 'meeting.confirmed', {
      meetingId: Number(id), slot: c.slot, unanimous: true,
    });
    settled.push({ meetingId: Number(id), ...c });
  }
  return settled;
}

// Initiator only, and immediate: settle on an option whatever the answers say.
// The case is the owner's own — everyone wants Tuesday, one person cannot make
// it, and the meeting happens anyway — so this deliberately does NOT check
// agreement. What it does check is that the option is really on the table, so
// a meeting cannot be closed onto a time nobody ever saw.
async function settleNow(client, userId, meetingId, optionId) {
  const p = await participant(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (Number(p.initiator_id) !== Number(userId)) {
    return err('forbidden', 'only the person who opened the coordination settles it',
      { reason: 'not_initiator' });
  }
  if (p.meeting_status !== 'negotiating') {
    return err('invalid', 'meeting is not negotiating', { reason: 'not_negotiating' });
  }
  const { rows } = await client.query(
    `SELECT id, slot_text, starts_at FROM meeting_options
      WHERE id = $1 AND meeting_id = $2 AND status = 'active'`, [optionId, meetingId]);
  if (!rows[0]) return err('not_found', 'no such option on the table', { reason: 'option_not_active' });
  const c = await confirmOn(client, meetingId, rows[0], userId);
  if (!c.confirmed) return err('invalid', 'meeting is not negotiating', { reason: 'not_negotiating' });
  // Who was still missing when it was settled. Not a gate — a fact the
  // messages need, because "it is set" reads very differently to somebody who
  // never said yes.
  const { rows: waiting } = await client.query(
    `SELECT p.user_id FROM meeting_participants p
      WHERE p.meeting_id = $1 AND p.state <> 'opted_out'
        AND NOT EXISTS (SELECT 1 FROM meeting_option_answers oa
                         WHERE oa.option_id = $2 AND oa.user_id = p.user_id AND oa.answer = 'y')`,
    [meetingId, rows[0].id]);
  const withoutYes = waiting.map((r) => Number(r.user_id));
  await audit.record(client, userId, 'meeting.settled_by_hand', {
    meetingId: Number(meetingId), optionId: Number(optionId), slot: c.slot, withoutYes,
  });
  return ok({
    meetingId: Number(meetingId), meetingStatus: 'confirmed', slot: c.slot,
    startsAt: c.startsAt, optionId: Number(optionId), settledBy: Number(userId),
    withoutYes, unanimous: withoutYes.length === 0,
  });
}

// Initiator only: a pending option comes onto the table. When the table is
// full it must name which active option makes room.
async function approve(client, userId, meetingId, optionId, replaceOptionId = null) {
  const p = await participant(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (Number(p.initiator_id) !== Number(userId)) return err('forbidden', 'only the initiator decides on pending options');
  if (p.meeting_status !== 'negotiating') return err('invalid', 'meeting is not negotiating');
  const { rows } = await client.query(
    `SELECT id, slot_text, added_by FROM meeting_options WHERE id = $1 AND meeting_id = $2 AND status = 'pending'`,
    [optionId, meetingId]);
  if (!rows[0]) return err('not_found', 'no such pending option');
  const n = await activeCount(client, meetingId);
  if (n >= MAX_ACTIVE) {
    if (!replaceOptionId) return err('invalid', `${MAX_ACTIVE} options are already on the table — name the one this replaces`, { reason: 'replace_required' });
    const rep = await client.query(
      `UPDATE meeting_options SET status = 'replaced', decided_at = now()
        WHERE id = $1 AND meeting_id = $2 AND status = 'active' RETURNING id`, [replaceOptionId, meetingId]);
    if (rep.rowCount === 0) return err('not_found', 'the option to replace is not on the table');
  }
  await client.query(
    `UPDATE meeting_options SET status = 'active', decided_at = now() WHERE id = $1`, [optionId]);
  await audit.record(client, userId, 'meeting.option_approved',
    { meetingId: Number(meetingId), optionId: Number(optionId), replaced: replaceOptionId ? Number(replaceOptionId) : null });
  await mirrorCurrent(client, meetingId);
  const c = await tryConfirm(client, meetingId);
  return ok({
    meetingId: Number(meetingId), optionId: Number(optionId), proposerId: Number(rows[0].added_by),
    slot: rows[0].slot_text, replaced: replaceOptionId ? Number(replaceOptionId) : null,
    meetingStatus: c.settling ? 'settling' : 'negotiating',
    ...(c.settling ? { settlingSlot: c.slot, settleDueAt: c.settleDueAt } : {}),
  });
}

async function reject(client, userId, meetingId, optionId) {
  const p = await participant(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (Number(p.initiator_id) !== Number(userId)) return err('forbidden', 'only the initiator decides on pending options');
  const { rows } = await client.query(
    `UPDATE meeting_options SET status = 'rejected', decided_at = now()
      WHERE id = $1 AND meeting_id = $2 AND status = 'pending' RETURNING slot_text, added_by`, [optionId, meetingId]);
  if (!rows[0]) return err('not_found', 'no such pending option');
  await audit.record(client, userId, 'meeting.option_rejected', { meetingId: Number(meetingId), optionId: Number(optionId) });
  return ok({ meetingId: Number(meetingId), optionId: Number(optionId), proposerId: Number(rows[0].added_by), slot: rows[0].slot_text });
}

// Initiator only: take one option off the table and put a new one on.
async function swap(client, userId, meetingId, replaceOptionId, slotText, startsAt, { allDay = false, daypart = null } = {}) {
  const p = await participant(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (Number(p.initiator_id) !== Number(userId)) return err('forbidden', 'only the initiator swaps options');
  if (p.meeting_status !== 'negotiating') return err('invalid', 'meeting is not negotiating');
  const bad = await validSlot(client, userId, 'slot_description', slotText, startsAt);
  if (bad) return bad;
  const rep = await client.query(
    `UPDATE meeting_options SET status = 'replaced', decided_at = now()
      WHERE id = $1 AND meeting_id = $2 AND status = 'active' RETURNING slot_text`, [replaceOptionId, meetingId]);
  if (rep.rowCount === 0) return err('not_found', 'the option to replace is not on the table');
  const added = await add(client, userId, meetingId, slotText, startsAt, { allDay, daypart });
  if (!added.ok) return added;
  await audit.record(client, userId, 'meeting.option_swapped',
    { meetingId: Number(meetingId), out: Number(replaceOptionId), in: added.data.option.id });
  return ok({ ...added.data, replaced: Number(replaceOptionId), replacedSlot: rep.rows[0].slot_text });
}

module.exports = {
  MAX_ACTIVE, SETTLE_GRACE_MS, list, add, answer, approve, reject, swap,
  tryConfirm, unanimousOption, confirmOn, settleDue, settleNow, mirrorCurrent, activeCount,
};
