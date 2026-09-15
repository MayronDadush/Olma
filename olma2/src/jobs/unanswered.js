'use strict';
// Repair pass for messages the gateway swallowed — a person must not sit
// unanswered because a session lane wedged (an OpenClaw bug, not ours;
// lane-watchdog.js is the fast half).
//
// Two failures produce the same silence, and both are detectable:
//   (a) never processed — the transcript's last entry is the user's;
//   (b) composed and never dispatched — the transcript ends with an assistant
//       reply old enough that its send cannot be in flight, and the gateway
//       log has no `Sent message <id> -> sha256:<12 hex>` for that person
//       since (the hash is of the recipient jid; verified live 2026-08-31);
//   (c) the turn ran and produced nothing — the gateway logged `no queued
//       reply payloads` against that message id.
//
// (a) and (b) both read the END of the transcript, which is why (c) exists.
// Yahav, 2026-09-05: his 23:00 message was swallowed, a check-in rung landed
// two seconds later, he answered THAT, and it was answered normally — so by
// the time any sweep looked, the transcript ended in a delivered reply and
// both nets read the conversation as healthy. The dropped message sat in the
// middle of it, invisible to a rule that only ever looks at the last turn.
// (c) is keyed on the message the gateway named, so its place in the history
// does not matter.
//
// Deliberately NOT folded into checkin.js: repair on a minutes rhythm and
// outreach on an hours-to-days rhythm would fight over one tick. Stories:
// docs/incidents.md, "Wedged session lanes (the live bug v2 works around)"
// and "Six replies composed, one delivered — the wedge that beat every
// detector (2026-08-31)".
const crypto = require('node:crypto');
// The worker-thread facade, not sessions.js itself: this sweep runs every
// minute inside brokerd and reads transcripts, and the main thread must not
// block on that (see channels/sessions-async.js).
const sessions = require('../channels/sessions-async');
// parseKey only — pure string work, no disk, so it does not belong behind the
// worker facade. lane-watchdog.js loads the same module in the same process.
const { parseKey } = require('../channels/sessions');
const laneLog = require('./lane-watchdog');
const { enqueue } = require('../outbox/enqueue');
const audit = require('../domain/audit');
const replyLeak = require('../domain/reply-leak');

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

// The silence sentinel, trimmed — a trailing newline must not turn a decision
// into a delivery fault. Exact match on purpose: the doctrine says the entire
// reply is the sentinel and that anything in front of it IS delivered, so
// "בוצע NO_REPLY" is a real reply and must stay repairable.
const SILENCE = 'NO_REPLY';
// A reply is re-sent as ITSELF or not at all (see the enqueue for case (b)).
// The one shape that cannot survive the raw pipe is an attachment: `MEDIA:` on
// its own line is a convention the GATEWAY reads off an agent's reply, and
// `openclaw message send` has no such reading — the path would go out to the
// person as literal text with no image behind it. So a lost schedule card is
// counted and left alone rather than half-sent.
const MEDIA_LINE_RE = /^\s*MEDIA:\s*\S/m;
function resendableVerbatim(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, why: 'empty' };
  if (MEDIA_LINE_RE.test(t)) return { ok: false, why: 'media' };
  // The second shape, and it is this sweep's own doing: since 2026-09-10 the
  // reply gate (`domain/reply-leak.js`, via the plugin) CANCELS a reply that
  // is the model's working-out, which leaves exactly the fingerprint case (b)
  // reads as a delivery fault — an assistant turn in the transcript with no
  // `Sent` line behind it. Re-sending it verbatim would put on Yahav's phone
  // the very thing the gate had just kept off it, from the one path with no
  // gate in it (the raw pipe). What the gate would deliver is what may be
  // re-sent, and when that is nothing, nothing is.
  const verdict = replyLeak.gateReply(t);
  if (verdict.action === 'cancel') return { ok: false, why: 'leak' };
  if (verdict.action === 'trim') return { ok: true, text: verdict.text, gated: true };
  return { ok: true, text: t };
}
function isSilence(m) {
  return m.role === 'assistant' && String(m.text || '').trim() === SILENCE;
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

// Both readers want the same two tails, and each is 512KB off a file on a
// 1-vCPU box — read once, parse twice.
function readLogTails(now) {
  return [
    { raw: laneLog.readTail(laneLog.todayLogPath(now - 24 * 3600_000)), openEnded: false },
    { raw: laneLog.readTail(laneLog.todayLogPath(now)), openEnded: true },
  ];
}

function readSentEventsFromLog(now, chunks) {
  return parseSentEvents(chunks || readLogTails(now));
}

// ---- case (c): the turn produced nothing at all ----------------------------

// Indexed by the peer the session key names, so a user is matched by their own
// phone rather than by an agent id — agent ids are recycled (u-18 was somebody
// else's four days before Yahav got it) and a stale line under a reused id
// would otherwise be repaired to the wrong person.
function droppedTurnsByPeer(chunks) {
  const byPeer = new Map();
  for (const { raw } of chunks || []) {
    for (const d of laneLog.parseDroppedTurns(raw)) {
      const parsed = parseKey(d.sessionKey);
      const peer = parsed && parsed.peer;
      if (!peer) continue;
      if (!byPeer.has(peer)) byPeer.set(peer, []);
      byPeer.get(peer).push(d);
    }
  }
  return byPeer;
}

// The newest dropped turn for this person that is old enough to be a real
// silence and young enough to still answer as if it had just arrived — the
// same window as case (a), for the same reasons.
function droppedTurnFor(byPeer, phone, now) {
  const list = byPeer.get(phone) || [];
  let best = null;
  for (const d of list) {
    const age = now - d.at;
    if (!(age >= MIN_AGE_MS && age <= MAX_AGE_MS)) continue;
    if (!best || d.at > best.at) best = d;
  }
  return best;
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
  // A DECISION to stay quiet is not a reply that got lost. `NO_REPLY` is the
  // silence sentinel, and since the reaction doctrine it is the CORRECT answer
  // to a large and growing class of messages: brokerd puts a 👍 on the message,
  // `hints.markPlaced` says the mark carries the whole fact, and the model
  // rightly says nothing. Every one of those lands in the transcript as an
  // assistant turn after a user turn with no send event behind it — which is
  // this function's entire definition of a lost reply.
  //
  // Yahav, 2026-09-09: "בוצע הפקדת צק" → task completed, 👍 placed, `NO_REPLY`.
  // Three minutes later this declared the silence a delivery fault and ran a
  // repair turn, and he read "No conversation history is accessible to me in
  // this session" — in English, about our internals, on a conversation that
  // had worked perfectly.
  //
  // Same shape as the fix in channels/sessions.js, which drops
  // FAILED_TURN_MARKER because a dead turn was indistinguishable from a reply
  // and blinded THIS function the other way (2026-08-20). Twice now the
  // transcript's shape has failed to carry the turn's meaning; the sentinel is
  // checked here rather than in the shared reader because a deliberate silence
  // is real history — the admin conversation view and the metrics rollup each
  // decide what it means to them.
  if (isSilence(last)) return null;
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
  return delivered ? null : { composedAt: last.at, age, text: last.text };
}

// deps.readMessages(agentId, peer) → [{role, text, at}] so tests never touch disk.
//
// The peer is not optional. Silent housekeeping turns (fact extraction, memory
// consolidation) open sessions of their own on the same agent, and a peer-less
// read returns whichever session was last active — which is one of those, whose
// last text-bearing message is the JOB's own instruction, in the `user` role.
// That reads exactly like an unanswered message and would send the person a
// "repair" reply to a conversation that was never broken.
async function sweepUnanswered(client, { readMessages, readSentEvents, readDroppedTurns, now = Date.now() } = {}) {
  const read = readMessages
    || ((agentId, peer) => sessions.readRecentMessages(agentId, 6, undefined, peer));
  // Read lazily, once for the whole sweep — the log tail does not change per
  // user, and most ticks never reach a case-(b) candidate at all.
  let tails;
  const chunks = () => {
    if (tails === undefined) tails = readLogTails(now);
    return tails;
  };
  let sentEvents;
  const sent = () => {
    if (sentEvents === undefined) {
      sentEvents = readSentEvents ? readSentEvents() : readSentEventsFromLog(now, chunks());
    }
    return sentEvents;
  };
  let dropped;
  const droppedTurns = () => {
    if (dropped === undefined) {
      dropped = readDroppedTurns ? readDroppedTurns() : droppedTurnsByPeer(chunks());
    }
    return dropped;
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
  // Real losses this pass could not re-send as themselves, by reason.
  const unsendable = {};
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

    // case (c): the gateway named a message of theirs that got nothing back.
    // Checked before (b) because it is direct evidence about ONE message
    // rather than an inference from the shape of the transcript's tail, and
    // because (a) and (b) have both already declined to see it.
    //
    // No "but they were sent something afterwards" guard. That is exactly what
    // happened to Yahav — a rung landed two seconds later and his own reply to
    // it was answered — and treating unrelated later traffic as an answer to
    // THIS message is how the silence went unnoticed in the first place. The
    // instruction below carries the escape instead: the model reads the
    // conversation and says NO_REPLY if the thing was in fact answered.
    const drop = droppedTurnFor(droppedTurns(), u.phone, now);
    if (drop) {
      const res = await enqueue(client, {
        userId: u.id, kind: 'checkin', urgency: 'urgent',
        expiresAt: new Date(now + MAX_AGE_MS).toISOString(),
        payload: {
          rung: 'unanswered_repair',
          repairKind: 'dropped_turn',
          checkinInstruction: [
            'One of their recent messages was read but produced no reply at all — a fault on our side, not theirs.',
            'It is NOT necessarily the last thing they wrote: look back through the conversation for a message of',
            'theirs that nothing ever responded to, including one buried above later exchanges.',
            'If everything they asked for has in fact been answered or acted on since, reply with exactly NO_REPLY and nothing else.',
            'Otherwise answer that message now, normally, as if you had just read it.',
            'If you CANNOT see the conversation — empty history, a failed read, a tool refusing you —',
            'reply with exactly NO_REPLY. Never guess what they wanted, never turn notes or memory into a message.',
            'Do not apologise for a delay, do not mention a technical problem or system issue, do not explain yourself —',
            'from their side this should simply read as your reply arriving.',
          ].join(' '),
        },
        // The message id the gateway named: one repair per swallowed message,
        // and a re-run of the sweep over the same log tail is a no-op.
        idempotencyKey: `dropped:${u.id}:${drop.messageId}`,
      });
      if (res.data.enqueued) {
        await audit.record(client, u.id, 'delivery.unanswered_repair', {
          kind: 'dropped_turn', messageId: drop.messageId,
          cause: drop.cause, ageSeconds: Math.round((now - drop.at) / 1000),
        });
        repaired.push(u.id);
      }
      continue;
    }

    // case (b): the reply exists in the transcript and its send never happened
    const lost = undeliveredReply(msgs, sent(), u.phone, now);
    if (!lost) continue;

    // The answer is already written. Until 2026-09-09 this ran a MODEL turn and
    // asked it to "send the substance of that answer again" — which is asking a
    // second model to reconstruct, from a conversation it has to re-read, a
    // reply the transcript is holding word for word. It bought nothing and cost
    // three things: a cold-cache call, a dependency on the model being up at
    // the moment our own pipe was proven broken, and a free-text turn on a
    // --deliver session where EVERY block reaches the phone. Yahav read the
    // third one — "No conversation history is accessible to me in this
    // session", in English, about our internals (incidents.md, "A silence read
    // as a delivery fault"). The guard against exactly that was in the
    // instruction, in words, and the model went past it.
    //
    // So the reply goes out as ITSELF, on the raw pipe, with no model in the
    // path — the same argument reminders were moved for. Two things fall out of
    // it that the model turn could not have:
    //   - The transcript already contains this reply, and a raw send does not
    //     write to the session (channels/openclaw.js). Re-sending verbatim
    //     makes the phone match the history. The model turn APPENDED a second
    //     assistant turn saying roughly the same thing, so the conversation
    //     then held the answer twice and only one of them had been delivered.
    //   - The instruction's "if their later messages changed what a good answer
    //     is, answer the newest state" clause is gone with it. It guarded a
    //     case this detector already excludes: `undeliveredReply` fires only
    //     when the assistant's reply is the LAST thing in the transcript, so
    //     there is no newer state by construction.
    const body = resendableVerbatim(lost.text);
    if (!body.ok) {
      // Detected a real loss and cannot re-send it as itself. Nothing is
      // improvised in its place: the person's own next message and the check-in
      // ladder are the fallbacks, and both are better than a guess. Counted on
      // the sweep's heartbeat so a path that declines still says so — no audit
      // row, because with no outbox row there is no cooldown either and this
      // would file one every tick for up to MAX_AGE_MS.
      unsendable[body.why] = (unsendable[body.why] || 0) + 1;
      continue;
    }

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
        // Read by proactive-text.rawPipeTextFor, which is the ONE place that
        // decides raw-pipe-or-agent-turn. Non-empty by the guard above, so the
        // row can never fall through to a model turn.
        verbatimReply: body.text,
      },
      idempotencyKey: `undelivered:${u.id}:${lost.composedAt}`,
    });
    if (res.data.enqueued) {
      await audit.record(client, u.id, 'delivery.unanswered_repair', {
        kind: 'undelivered_reply', ageSeconds: Math.round(lost.age / 1000), verbatim: true,
      });
      repaired.push(u.id);
    }
  }
  return { repaired, ...(Object.keys(unsendable).length ? { unsendable } : {}) };
}

module.exports = {
  sweepUnanswered, sentHashFor, undeliveredReply, resendableVerbatim,
  readSentEventsFromLog, parseSentEvents, covers,
  readLogTails, droppedTurnsByPeer, droppedTurnFor,
  MIN_AGE_MS, MAX_AGE_MS, SENT_SLACK_MS,
};
