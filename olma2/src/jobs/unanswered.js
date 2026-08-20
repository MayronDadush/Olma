'use strict';
// Repair pass for messages the gateway swallowed.
//
// Observed three times on live users: a session lane is never released after a
// run, so everything the person writes afterwards queues behind it. The
// gateway's own watchdog frees it, but only after its abort threshold (we
// lowered that from 360s to 75s; see scripts/set-recovery-thresholds.js). The
// bug is inside OpenClaw and not ours to fix — this job limits how long a
// person can sit unanswered because of it.
//
// NOT folded into checkin.js despite the one-sweeper rule: check-in is outreach
// on an hours-to-days rhythm, this is repair on a minutes rhythm, and the two
// would fight over the same tick. Deliberate exception, not an oversight.
//
// What it can and cannot see. Two distinct failures produce the same silence:
//
//   (a) the message was never processed  → the transcript's last entry is the
//       user's. Provable, and repaired here.
//   (b) the reply WAS generated and then never dispatched → the transcript
//       looks perfectly healthy. Indistinguishable from a normal turn.
//
// Only (a) is repaired. Guessing at (b) means telling the agent to say
// something again that it may well have already said — which is exactly the
// duplicate-message complaint this whole area started with. Silence you can
// prove beats a duplicate you cannot.
const sessions = require('../channels/sessions');
const { enqueue } = require('../outbox/enqueue');
const audit = require('../domain/audit');

// Below MIN: the gateway's own recovery deserves first chance (its abort
// threshold is 75s). Above MAX: too stale to answer as if it just arrived —
// the check-in ladder is the right tool for that, not a fake live reply.
const MIN_AGE_MS = 3 * 60_000;
const MAX_AGE_MS = 45 * 60_000;

function lastTurn(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' || msgs[i].role === 'assistant') return msgs[i];
  }
  return null;
}

// deps.readMessages(agentId, peer) → [{role, text, at}] so tests never touch disk.
//
// The peer is not optional. Silent housekeeping turns (fact extraction, memory
// consolidation) open sessions of their own on the same agent, and a peer-less
// read returns whichever session was last active — which is one of those, whose
// last text-bearing message is the JOB's own instruction, in the `user` role.
// That reads exactly like an unanswered message and would send the person a
// "repair" reply to a conversation that was never broken.
async function sweepUnanswered(client, { readMessages, now = Date.now() } = {}) {
  const read = readMessages
    || ((agentId, peer) => sessions.readRecentMessages(agentId, 6, undefined, peer));
  const { rows } = await client.query(
    `SELECT id, agent_id, phone FROM users
     WHERE status = 'active' AND agent_id IS NOT NULL AND onboarded_at IS NOT NULL
       AND quota_blocked_until IS NULL`
  );

  const repaired = [];
  for (const u of rows) {
    let msgs;
    try { msgs = read(u.agent_id, u.phone); } catch { continue; } // unreadable transcript is not this job's problem
    const last = lastTurn(msgs || []);
    if (!last || last.role !== 'user' || !last.at) continue;

    const age = now - Date.parse(last.at);
    if (!(age >= MIN_AGE_MS && age <= MAX_AGE_MS)) continue;

    // Keyed on the message's own timestamp: one repair per dropped message,
    // and a re-run of this sweep is a no-op rather than a second nudge.
    const res = await enqueue(client, {
      userId: u.id, kind: 'checkin', urgency: 'urgent',
      // Expire rather than deliver hours later behind a quiet-hours hold: an
      // apology for a message from this morning is worse than none.
      expiresAt: new Date(now + MAX_AGE_MS).toISOString(),
      payload: {
        rung: 'unanswered_repair',
        checkinInstruction: [
          'Their last message appears to have gone unanswered — a delivery fault on our side, not theirs.',
          'Read the conversation. If you genuinely already answered it, reply with exactly NO_REPLY and nothing else.',
          'Otherwise answer it now, normally, as if you had just read it.',
          'Do not apologise for a delay, do not mention a technical problem, do not explain yourself —',
          'from their side this should simply read as your reply arriving.',
        ].join(' '),
      },
      idempotencyKey: `unanswered:${u.id}:${last.at}`,
    });
    if (res.data.enqueued) {
      await audit.record(client, u.id, 'delivery.unanswered_repair', { ageSeconds: Math.round(age / 1000) });
      repaired.push(u.id);
    }
  }
  return { repaired };
}

module.exports = { sweepUnanswered, MIN_AGE_MS, MAX_AGE_MS };
