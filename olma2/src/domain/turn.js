'use strict';
// Opening a turn — the bookkeeping that must happen on every inbound
// message, whether or not the model remembered to call `turn_start`.
// Correctness must not depend on model discipline (D-007): brokerd sees
// every tool call, so a turn that opened without `turn_start` gets its
// bookkeeping done here.
//
//   STATE  — recovered: count the message, stamp the person awake, wake
//            night-held rows, record `message.received`.
//   ADVICE — never recovered: `offerResume` (stamping it would burn a
//            once-per-pause offer the model never made), name capture (needs
//            `sender_name`, which only the model sees), `recentReminders`,
//            `planHeadline`. A correct database and a less-informed reply is
//            the honest trade.
//
// Story: docs/incidents.md, "turn_start skipped on the stop turn, under two
// models and two rewordings (2026-08-30)".
const quota = require('./quota');
const audit = require('./audit');
const flags = require('./flags');
const selfInitiated = require('./self-initiated');

// Rollout control. Absent/empty = off everywhere, so deploying this changes
// nothing until someone turns it on: a fix for an invisible defect must not
// arrive at the same moment as its own blast radius. Value is 'all', or a
// comma-separated E.164 list (the media_gen_phones precedent).
const FLAG = 'implicit_turn_start';

function coveredBy(value, phone) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return false;
  if (raw === 'all') return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(String(phone));
}

async function isEnabledFor(client, user) {
  return coveredBy(await flags.getFlag(client, FLAG), user.phone);
}

// Do what `turn_start` would have done to the RECORD, and nothing it would
// have done to the CONVERSATION. Returns what was recovered so the caller can
// tell `turn_start` not to count the same message twice if the model gets
// around to calling it later in the turn.
async function openTurnImplicitly(client, user, { firstTool } = {}) {
  // A turn Olma started is not a message from the person, and the recovery
  // path has to know that as surely as turn_start does — a delivery turn whose
  // model reached for a tool before turn_start would otherwise write the whole
  // inbound record here instead, which is the same bug through the other door.
  // Nothing is recovered and nothing is counted; the caller is told the turn is
  // open so it is not re-opened, and that this message was not counted so a
  // later turn_start does not think it was.
  if (selfInitiated.isActive(user.id)) {
    await audit.record(client, user.id, 'turn.opened_implicitly',
      { firstTool: firstTool || null, selfInitiated: true });
    return { counted: false, quota: null, firstTurn: false };
  }
  // Identical to turn_start's own statement. A person writing is active, and
  // a check-in ladder that had backed off should reset on real activity —
  // both are true regardless of which tool the model reached for.
  // Identical to turn_start's statement, self-join included: whichever of the
  // two runs FIRST is the only one that can still see a NULL last_inbound_at,
  // so this path has to capture the first-turn verdict and carry it back — see
  // the `firstTurn` return below.
  const opened = await client.query(
    `UPDATE users u SET last_inbound_at = now(),
            checkin_misses = CASE WHEN u.checkin_misses > 0 THEN 0 ELSE u.checkin_misses END
       FROM users prev
      WHERE u.id = prev.id AND u.id = $1
      RETURNING prev.last_inbound_at AS prev_inbound`, [user.id]);
  const firstTurn = opened.rowCount > 0 && opened.rows[0].prev_inbound === null;

  // Night-held rows get their re-hearing. The gate stays the only judge: this
  // only makes the worker re-read them, it cannot deliver anything the gate
  // would refuse (see the 2026-08-27 entry).
  await client.query(
    `UPDATE outbox SET release_after = now()
      WHERE user_id = $1 AND sent_at IS NULL AND hold_reason = 'night'
        AND release_after > now()`, [user.id]);

  const counted = await quota.countMessage(client, user.id);
  await audit.record(client, user.id, 'message.received', null);

  // The skip itself is recorded, not just repaired. A defect that is silently
  // compensated for is a defect nobody ever measures — and the whole reason
  // this existed unnoticed is that the only symptom was an absence. This row
  // is what makes "how often does the model skip turn_start, and before which
  // tool" answerable from the dashboard instead of from a transcript hunt.
  await audit.record(client, user.id, 'turn.opened_implicitly',
    { firstTool: firstTool || null });

  // The verdict itself travels back, not a re-derived copy of it. If the model
  // does call `turn_start` later in the same turn it reads this rather than
  // asking the quota a second question — the counter has already moved, so a
  // fresh read would be a different (and wrong) answer.
  // `firstTurn` rides along for the same reason `quota` does: this path has
  // already consumed the evidence, so a later turn_start cannot re-derive it.
  return { counted: true, quota: counted, firstTurn };
}

module.exports = { openTurnImplicitly, isEnabledFor, coveredBy, FLAG };
