'use strict';
// Opening a turn — the bookkeeping that must happen on every inbound message,
// whether or not the model remembered to ask for it.
//
// `turn_start` is the tool the doctrine tells the agent to call first on every
// message, and for most turns it does. But on 2026-08-30 the behavioral evals
// caught it skipping the call entirely on the stop-confirmation turn: the stop
// section is a vivid, numbered three-step plan whose step 2 says to call
// `pause_olma` "THAT TURN, before you write anything back", and it beats a
// universal preamble sitting far above it. Two rounds of rewording failed, and
// `deepseek-v4-pro` — the stronger, dearer sibling already configured as the
// first fallback — failed identically. Two models, two doctrine versions, one
// failure: a specific urgent instruction outranking a general one is a property
// of models, not of any one model.
//
// So this is the project's own rule applied again (D-007, and the
// identity-token self-healing in bin/olma-mcp.js): **correctness must not
// depend on model discipline.** brokerd already sees every tool call, and the
// gateway spawns one MCP shim per turn holding one socket — so the server can
// notice a turn that opened without `turn_start` and do the bookkeeping itself.
//
// What this deliberately does NOT do, and why the split matters:
//
//   STATE — recovered here. Counting the message, stamping that the person is
//   awake, waking night-held rows, recording the north-star `message.received`.
//   None of it needs the model's cooperation and all of it is wrong to skip.
//
//   ADVICE — never recovered. `offerResume` is the sharpest case: stamping
//   `resume_offer_sent_at` here would burn a once-per-pause offer that the
//   model never saw and therefore cannot make, which is strictly worse than
//   not stamping it — the person would be left waiting for an offer the
//   database believes was already delivered. Name capture needs `sender_name`,
//   which only the model can see; `recentReminders` and `planHeadline` are
//   answers to a question nobody asked. A turn that skipped `turn_start` gets
//   a correct database and a less well-informed reply, which is the honest
//   trade rather than a silent pretence that nothing was lost.
const quota = require('./quota');
const audit = require('./audit');
const flags = require('./flags');

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
  // Identical to turn_start's own statement. A person writing is active, and
  // a check-in ladder that had backed off should reset on real activity —
  // both are true regardless of which tool the model reached for.
  await client.query(
    `UPDATE users SET last_inbound_at = now(),
            checkin_misses = CASE WHEN checkin_misses > 0 THEN 0 ELSE checkin_misses END
      WHERE id = $1`, [user.id]);

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
  return { counted: true, quota: counted };
}

module.exports = { openTurnImplicitly, isEnabledFor, coveredBy, FLAG };
