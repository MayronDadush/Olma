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
//       looks perfectly healthy.
//
// (b) used to be written off here as "indistinguishable from a normal turn".
// It is not — the gateway logs one line per outbound WhatsApp send,
//
//   Sent message <id> -> sha256:<12 hex>
//
// where the hash is sha256("<digits>@s.whatsapp.net") of the RECIPIENT
// (verified live 2026-08-31 against a real send). So "this reply left the
// box" is checkable per user: a transcript that ends with an assistant reply
// old enough that its send cannot still be in flight, with no Sent line for
// that person since the reply was composed, is a reply the person never saw.
//
// The incident that forced this: 2026-08-31 18:23-18:36, user 11 sent seven
// messages and the agent answered every one within seconds — into a session
// lane that wedged after each run, and the gateway's own recovery freed the
// lane by aborting the run WITH its undelivered reply still aboard. Six
// composed replies, one Sent line, thirteen minutes of silence from the
// person's side. Every transcript read as perfectly healthy, so this sweep
// (case a), the lane-watchdog (tuned to the gateway REFUSING to free a lane,
// not freeing it destructively) and /health all stayed green.
const crypto = require('node:crypto');
// The worker-thread facade, not sessions.js itself: this sweep runs every
// minute inside brokerd and reads transcripts, and the main thread must not
// block on that (see channels/sessions-async.js).
const sessions = require('../channels/sessions-async');
const laneLog = require('./lane-watchdog');
const { enqueue } = require('../outbox/enqueue');
const audit = require('../domain/audit');

// Below MIN: the gateway's own recovery deserves first chance (its abort
// threshold is 75s). Above MAX: too stale to answer as if it just arrived —
// the check-in ladder is the right tool for that, not a fake live reply.
const MIN_AGE_MS = 3 * 60_000;
const MAX_AGE_MS = 45 * 60_000;
// At most one repair per person per hour, regardless of how many of their
// messages read as dropped. Learned live (2026-08-27, the morning after the
// model cutover): an outage backlog plus a busy conversation manufactured a
// repair row per message — one user got three "repairs" in eight minutes.
// The repair exists to end a silence; a drumbeat of them IS the incident.
const REPAIR_COOLDOWN_MS = 60 * 60_000;
// A Sent line can precede the reply's transcript timestamp by clock skew /
// write ordering (observed the other way round live: transcript 18:36:15.879,
// Sent 18:36:16.148). A line up to this much BEFORE the reply still counts as
// that reply's delivery.
const SENT_SLACK_MS = 15_000;
const SENT_LINE = /Sent message \S+ -> sha256:([0-9a-f]{12})/;

// A proactive delivery injects its instruction into the session as a
// `user`-role message (the DELIVERY preamble). When that turn CRASHES, the
// instruction is the transcript's last entry — role user, recent, and not
// from the person at all. Counting it as "their unanswered message" made the
// repair self-feeding: a failed repair manufactured the next repair, ~19
// rows for one user in a single morning (2026-08-27). The person's own
// messages never start with the preamble marker.
function isInjectedInstruction(m) {
  return m.role === 'user' && /^DELIVERY:/.test(String(m.text || ''));
}

function lastTurn(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (isInjectedInstruction(msgs[i])) continue;
    if (msgs[i].role === 'user' || msgs[i].role === 'assistant') return msgs[i];
  }
  return null;
}

// ---- case (b): a composed reply that never left the box --------------------

function sentHashFor(phone) {
  return crypto.createHash('sha256')
    .update(`${String(phone).replace(/^\+/, '')}@s.whatsapp.net`)
    .digest('hex').slice(0, 12);
}

// The gateway's own outbound log — the same per-day file, read the same way,
// as jobs/lane-watchdog.js. Returns null when nothing could be read at all:
// "no evidence of a send" and "no evidence at all" must never look alike, or
// one rotated/missing log file would spray a repair at every user whose agent
// replied recently. Both today's and yesterday's files are read so a reply
// composed just before midnight is still judged against its own Sent line.
//
// It also reports WHEN it could see, not only what it saw. readTail() takes a
// fixed 512KB off the end of a file that grows to ~6MB a day, so the read
// reaches back ~100 minutes on a normal day and far less during a burst or
// after a gateway restart reopened the file. Without that, "the window opened
// after the reply was composed" and "the reply was never sent" are the same
// empty array — this project collapsing could-not-see into did-not-happen
// once more, and the reason user 8 was sent a delivered answer a second time
// at 00:53 on 2026-09-02.
//
// Pure, and separate from the read so the window arithmetic is testable
// without a file on disk — the same split lane-watchdog keeps between
// readTail() and parseEvents().
//
// One window PER FILE, never a single span across both. Each tail is 512KB off
// the end of its own day, so the two do not meet: measured live on 2026-09-04,
// yesterday's reached 22:00-23:59 and today's 07:19-now, with seven unread
// hours between them. A lowest-of-both horizon would have called that gap
// covered — the same could-not-see-scored-as-did-not-happen mistake one level
// further in.
//
// The current file is still being appended to, so its window runs to now
// rather than to its last line: a quiet ten minutes is not a blind ten
// minutes. A finished day's file ends where it ends.
function parseSentEvents(chunks) {
  const events = [];
  const windows = [];
  for (const { raw, openEnded } of chunks) {
    let from = null;
    let to = null;
    for (const line of String(raw || '').split('\n')) {
      // readTail slices mid-line, so the first line of each tail is usually a
      // fragment. Every timestamped line dates the window, not only Sent ones.
      if (!line.startsWith('{')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const t = Date.parse(o.time || '');
      if (Number.isNaN(t)) continue;
      if (from === null || t < from) from = t;
      if (to === null || t > to) to = t;
      const m = SENT_LINE.exec(String(o.message || ''));
      if (m) events.push({ at: t, hash: m[1] });
    }
    if (from !== null) windows.push({ from, to: openEnded ? Infinity : to });
  }
  // Read something, but could not date any of it: the window is unknown, which
  // is not the same as empty.
  return windows.length ? { events, windows } : null;
}

// Was the log demonstrably being read at this moment? Not "is it near the
// window" — inside one contiguous window, or the answer is unknown.
function covers(sent, at) {
  return !!sent && Array.isArray(sent.windows)
    && sent.windows.some((w) => w.from <= at && at <= w.to);
}

function readSentEventsFromLog(now) {
  return parseSentEvents([
    { raw: laneLog.readTail(laneLog.todayLogPath(now - 24 * 3600_000)), openEnded: false },
    { raw: laneLog.readTail(laneLog.todayLogPath(now)), openEnded: true },
  ]);
}

// An undelivered reply is only repaired when it was a reply to the PERSON —
// the previous turn is a real user message, not an injected proactive
// instruction. A lost proactive delivery is the outbox's own row and its own
// retry ladder; a second voice re-sending it from here would race that.
function undeliveredReply(msgs, sent, phone, now) {
  if (!sent || !Array.isArray(sent.events)) return null;
  const seq = (msgs || []).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.at);
  const last = seq[seq.length - 1];
  const prev = seq[seq.length - 2];
  if (!last || last.role !== 'assistant') return null;
  if (!prev || prev.role !== 'user' || isInjectedInstruction(prev)) return null;

  const composedAt = Date.parse(last.at);
  if (Number.isNaN(composedAt)) return null;
  const age = now - composedAt;
  if (!(age >= MIN_AGE_MS && age <= MAX_AGE_MS)) return null;

  // The window has to have been open when the send would have happened, or its
  // silence is not evidence. This is the check that was missing on 2026-09-02,
  // when user 8's delivered reply was declared lost 26 minutes later and sent
  // to her a second time, at 00:53, inside her quiet hours. Refusing here can
  // miss a genuine loss — that trade is deliberate: a duplicate of an answer
  // somebody already read is worse than a late one, and case (a) above still
  // catches the commoner failure with no log at all.
  if (!covers(sent, composedAt - SENT_SLACK_MS)) return null;

  const hash = sentHashFor(phone);
  const delivered = sent.events.some((e) => e.hash === hash && e.at >= composedAt - SENT_SLACK_MS);
  return delivered ? null : { composedAt: last.at, age };
}

// deps.readMessages(agentId, peer) → [{role, text, at}] so tests never touch disk.
//
// The peer is not optional. Silent housekeeping turns (fact extraction, memory
// consolidation) open sessions of their own on the same agent, and a peer-less
// read returns whichever session was last active — which is one of those, whose
// last text-bearing message is the JOB's own instruction, in the `user` role.
// That reads exactly like an unanswered message and would send the person a
// "repair" reply to a conversation that was never broken.
async function sweepUnanswered(client, { readMessages, readSentEvents, now = Date.now() } = {}) {
  const read = readMessages
    || ((agentId, peer) => sessions.readRecentMessages(agentId, 6, undefined, peer));
  // Read lazily, once for the whole sweep — the log tail does not change per
  // user, and most ticks never reach a case-(b) candidate at all.
  let sentEvents;
  const sent = () => {
    if (sentEvents === undefined) {
      sentEvents = readSentEvents ? readSentEvents() : readSentEventsFromLog(now);
    }
    return sentEvents;
  };
  const { rows } = await client.query(
    `SELECT id, agent_id, phone FROM users
     WHERE status = 'active' AND agent_id IS NOT NULL AND onboarded_at IS NOT NULL
       AND quota_blocked_until IS NULL
       -- Pause has no exceptions, and this is the one that argues hardest for
       -- being one: the repair exists to finish a conversation the person
       -- themselves started. It stays out anyway — "Olma never initiates" is
       -- only a promise if it has no clauses. They can write again, and the
       -- live path answers a paused user normally.
       AND paused_at IS NULL AND NOT is_eval`
  );

  // The cooldown counts any repair ROW this hour — sent, pending, or expired.
  // A pending row means the last repair has not even landed yet; enqueueing a
  // second is the exact pile-up this guard exists for.
  const { rows: cooling } = await client.query(
    `SELECT DISTINCT user_id FROM outbox
      WHERE payload->>'rung' = 'unanswered_repair'
        AND created_at > now() - ($1 || ' milliseconds')::interval`,
    [String(REPAIR_COOLDOWN_MS)]
  );
  const coolingIds = new Set(cooling.map((r) => r.user_id));

  const repaired = [];
  for (const u of rows) {
    if (coolingIds.has(u.id)) continue;
    let msgs;
    try { msgs = await read(u.agent_id, u.phone); } catch { continue; } // unreadable transcript is not this job's problem
    const last = lastTurn(msgs || []);

    if (last && last.role === 'user' && last.at) {
      // case (a): the message was never processed at all
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
            'If you CANNOT see their message — empty history, a failed read, a tool refusing you —',
            'reply with exactly NO_REPLY. Never guess what they wanted, never turn notes or memory',
            'into a message, never send anything you would have to preface with an explanation.',
            'Do not apologise for a delay, do not mention a technical problem or system issue, do not explain yourself —',
            'from their side this should simply read as your reply arriving.',
          ].join(' '),
        },
        idempotencyKey: `unanswered:${u.id}:${last.at}`,
      });
      if (res.data.enqueued) {
        await audit.record(client, u.id, 'delivery.unanswered_repair', { ageSeconds: Math.round(age / 1000) });
        repaired.push(u.id);
      }
      continue;
    }

    // case (b): the reply exists in the transcript and its send never happened
    const lost = undeliveredReply(msgs, sent(), u.phone, now);
    if (!lost) continue;

    const res = await enqueue(client, {
      userId: u.id, kind: 'checkin', urgency: 'urgent',
      expiresAt: new Date(now + MAX_AGE_MS).toISOString(),
      payload: {
        // Same rung on purpose: the hourly cooldown must cover BOTH repair
        // kinds together — today's incident would have qualified under both
        // shapes within minutes of each other, and two voices answering one
        // silence is the duplicate-message complaint this area started with.
        rung: 'unanswered_repair',
        repairKind: 'undelivered_reply',
        checkinInstruction: [
          'Your last reply in this conversation was composed but never delivered — the person never saw it.',
          'A delivery fault on our side, not theirs.',
          'Read the conversation and send the substance of that answer again, naturally, as your reply now.',
          'If their later messages changed what a good answer is, answer the newest state rather than repeating the old one.',
          'If you CANNOT see the conversation — empty history, a failed read, a tool refusing you —',
          'reply with exactly NO_REPLY. Never guess, never turn notes or memory into a message.',
          'Do not apologise for a delay, do not mention a technical problem or system issue —',
          'from their side this should simply read as your reply arriving.',
        ].join(' '),
      },
      idempotencyKey: `undelivered:${u.id}:${lost.composedAt}`,
    });
    if (res.data.enqueued) {
      await audit.record(client, u.id, 'delivery.unanswered_repair', {
        kind: 'undelivered_reply', ageSeconds: Math.round(lost.age / 1000),
      });
      repaired.push(u.id);
    }
  }
  return { repaired };
}

module.exports = {
  sweepUnanswered, sentHashFor, undeliveredReply, readSentEventsFromLog, parseSentEvents, covers,
  MIN_AGE_MS, MAX_AGE_MS, SENT_SLACK_MS,
};
