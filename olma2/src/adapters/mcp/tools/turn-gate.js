'use strict';
// turn gate — one slice of the tool registry (see ../registry.js).
const {
  users, selfInitiated, quota, reactions, audit, S, ok, captureDisplayName, stale, tool, flags,
} = require('./_shared');
const turnDomain = require('../../../domain/turn');

module.exports = [
  tool('turn_start', 'Call this FIRST on every user message, once. Counts the message toward quota and returns how to proceed: proceed | send_block_notice (send the included today view, once) | silent (do not reply at all). Pass sender_name, message_id, reply_to_id and wrote_in from the Conversation info whenever present. Any extra field in the result comes with a matching entry in hints saying what to do with it — follow it.',
    {
      sender_name: S('string', 'The `sender` field from this turn\'s Conversation info, verbatim. Fills a name we lack, as an unconfirmed guess; never overwrites one they gave.'),
      message_id: S('string', 'From this turn\'s Conversation info, verbatim, so Olma can mark their message seen, then done or scheduled. Omit if absent.'),
      message_kind: S('string', '"voice" when this message arrived as a voice note (you got a transcription); omit otherwise. Only changes the working mark to 👂.'),
      reply_to_id: S('string', 'From this turn\'s Conversation info, verbatim — there ONLY when they replied to one specific earlier message.'),
      wrote_in: S('string', 'Two-letter code of the language THIS message is written in (he, en, ru, ar…). Pass it on every call — it is how the system notices it speaks the wrong language to someone. The code only: never the text, a translation or a quote.'),
    }, [],
    async (client, user, args, ctx) => {
      if (ctx.flood && ctx.flood.isFlooding(user.id)) {
        return ok({ directive: 'silent', reason: 'flood' });
      }
      // Real activity resets the checkin backoff, and records that they are
      // awake right now — the delivery gate uses this to allow a reply during
      // quiet hours while a conversation is actually happening.
      // The self-join reads the row as it was BEFORE this statement, so
      // "have they ever written to us before" costs no extra round trip — and
      // on a 1-vCPU box every query here is latency a person is sitting
      // through. `last_inbound_at` is NULL only until someone's first ever
      // message, which makes it the cheapest honest first-turn signal we have.
      //
      // ...unless WE started this turn. An outbox delivery reaches the agent
      // through the same agent and session key as a typed message, so every
      // statement below would otherwise assert that somebody wrote to us on a
      // turn where Olma is the one talking. domain/self-initiated.js lists
      // what that cost; the shortest version is that the day-one ladder spent
      // this person's welcome on its own check-in, fifteen minutes before they
      // said anything.
      const ourTurn = selfInitiated.isActive(user.id);
      const opened = ourTurn ? { rowCount: 0, rows: [] } : await client.query(
        `UPDATE users u SET last_inbound_at = now(),
                checkin_misses = CASE WHEN u.checkin_misses > 0 THEN 0 ELSE u.checkin_misses END
           FROM users prev
          WHERE u.id = prev.id AND u.id = $1
          RETURNING prev.last_inbound_at AS prev_inbound`, [user.id]);
      const firstEverTurn = opened.rowCount > 0 && opened.rows[0].prev_inbound === null;
      // Did they use WhatsApp reply on one specific earlier message? The
      // gateway knows — it puts `reply_to_id` in Conversation info and the
      // quoted text in a "Reply target of current user message" block — and
      // nothing server-side ever sees either: like `sender`, they reach the
      // MODEL and stop there (CLAUDE.md, "OpenClaw per-turn metadata"). So
      // this rides the same road as sender_name and message_kind, and buys the
      // same thing: a field the model has to look for is a field it notices.
      //
      // We keep no part of it. The id is WhatsApp's, not ours — we never
      // recorded the ids of our own outbound messages (`--deliver` sends
      // through the agent and reports none), so it maps to nothing here. Its
      // whole job is to trigger the hint below, on the turns it applies to.
      // Measured 2026-09-05 on the eval user, gateway-shaped prompt, both arms
      // of the same conversation: with the reply block and without it, the
      // model produced the SAME answer — it acted on the newest topic and the
      // quoted one identically. The block was there and unread.
      const replyTarget = typeof (args && args.reply_to_id) === 'string'
        && args.reply_to_id.trim() !== '';
      // The inbound message id, kept on the TURN rather than in the database.
      // It is worth nothing after this turn ends — a mark belongs on the
      // message being handled right now — and a column would be one more piece
      // of per-message state to prune. `lastInboundAt` is stamped from the same
      // moment as the UPDATE above, so `markFor`'s liveness check reads the
      // value this turn just wrote instead of a row it would have to re-select.
      // A self-initiated turn carries no real inbound message, so it never has
      // a message_id to begin with — `cleanMessageId` reads that as absent and
      // this stays a no-op, the same way it always has for a bare heartbeat.
      if (ctx && ctx.turn) {
        const id = reactions.cleanMessageId(args && args.message_id);
        if (id) { ctx.turn.messageId = id; ctx.turn.lastInboundAt = Date.now(); }
        // How the message ARRIVED, for the opening mark only: 👂 for a voice
        // note, 👀 for anything typed. The model is the only thing in this call
        // that knows — a transcription reaches it, the MediaType never reaches
        // us — so it travels the same road as sender_name and message_id, and
        // is trusted exactly as little: anything but the literal 'voice' means
        // the ordinary mark, which is also what a model that never passes it
        // gets. The cost of it being wrong is one emoji.
        ctx.turn.messageKind = (args && args.message_kind) === 'voice' ? 'voice' : 'text';
        // The operator's emoji choices, read once per turn rather than per tool
        // call: every turn opens here, and the mark is placed after this
        // transaction commits, so the value is in hand by the time it is used.
        ctx.turn.reactionVocab = reactions.vocabulary(
          await flags.getFlag(client, reactions.VOCAB_FLAG));
      }
      // A person writing is awake — give every night-held row an immediate
      // re-hearing. The gate stays the only judge: inside the 15-minute
      // conversation grace it delivers; otherwise it simply re-holds until
      // the window opens, so this can never deliver something the gate would
      // refuse. Without this nudge the worker never re-reads a held row
      // before its release_after, so the gate's own mid-conversation rule
      // could not fire for overnight holds — observed live 2026-08-27: two
      // connection requests sat 'night'-held for the morning while the
      // recipient was actively chatting. Only 'night' rows: a budget hold's
      // budget is still spent, and a blocked user's rows wait for the
      // unblock summary — waking either would be overriding the gate, not
      // re-asking it.
      // Skipped on our own turn for the same reason: "they are awake" is a
      // claim about the person, and a delivery is evidence only that we sent
      // something.
      if (!ourTurn) await client.query(
        `UPDATE outbox SET release_after = now()
          WHERE user_id = $1 AND sent_at IS NULL AND hold_reason = 'night'
            AND release_after > now()`, [user.id]);
      // The WhatsApp display name is in front of the agent on EVERY turn, in the
      // gateway's "Conversation info (untrusted metadata)" block — and until
      // this line it was the one thing about a person the system watched go past
      // and never wrote down. Live proof: a user whose every turn opened with
      // `"sender": "חיים דדוש"` had first_name NULL for two days, while the
      // read-back job filed his name in the fact table as prose.
      //
      // Untrusted is exactly right and exactly why this is safe: a display name
      // is self-chosen, so it lands as an unconfirmed guess (the agent still
      // confirms it) and it is bounded by cleanName to one line of 60 chars,
      // which is what keeps it harmless where a name is interpolated into
      // another person's agent instruction (see domain/users.cleanName).
      // Nothing here can overwrite a name they actually gave us.
      let namedNow = false;
      if (!user.first_name && args && typeof args.sender_name === 'string') {
        const named = await captureDisplayName(client, user, args.sender_name);
        namedNow = named.ok;
      }

      // Which language they actually wrote in. The model is the only party
      // that can see the message — the server never does, by design (see
      // domain/language.js) — so this is a report, not a measurement, and it
      // is treated as one: a code we cannot parse simply does nothing.
      //
      // Deliberately not wrapped in a try/catch that swallows: this is one
      // UPDATE on the row we already hold, in the transaction that was going
      // to run anyway, and a failure here is a real failure worth seeing.
      let languageNudge = null;
      if (args && args.wrote_in != null) {
        const noted = await users.noteObservedLanguage(client, user, args.wrote_in);
        if (noted.ask) {
          languageNudge = { theyWriteIn: noted.observed, stored: user.locale || null, messages: noted.count };
        }
      }

      // Called SECOND, after some other tool already opened the turn? Then
      // brokerd's recovery path counted this message and recorded it (see
      // domain/turn.js), and counting again would charge one message to the
      // quota twice and double the north-star denominator. The recovery's
      // verdict stands; this call just reads it back.
      const alreadyCounted = Boolean(ctx && ctx.turn && ctx.turn.counted);
      // Our own turn is not one of their messages, so it neither spends their
      // daily allowance nor can be blocked by it: the delivery gate already
      // decided this message goes out, and re-asking the user's quota here
      // would let a person near their cap silence the check-in we chose to
      // send. The worker keeps its own daily budget for that (outbox/worker).
      const counted = ourTurn ? { data: { blocked: false } }
        : alreadyCounted ? ctx.turn.quota : await quota.countMessage(client, user.id);
      // One row per inbound message, purely so the north-star metric can exist.
      // `last_inbound_at` above is overwritten every time, so before this there
      // was no way to ask "did they answer the message we sent them" — the
      // response rate had a denominator (outbox.sent_at) and no numerator.
      // Cheap: bounded by the daily quota, classed 'routine', pruned by the
      // retention sweep like every other operational row.
      // Skipped when the recovery path already wrote it: one message, one row,
      // or the response-rate metric silently counts this person twice.
      if (!alreadyCounted && !ourTurn) await audit.record(client, user.id, 'message.received', null);
      // The one turn in a person's life where there is no conversation to
      // continue. Until this flag existed, `proceed` was all the agent ever
      // got, and the doctrine told it there is no welcome moment — so someone
      // whose first word was "היי" was answered "היי" and never onboarded,
      // for ever. Whichever entry point opened the turn is the one that saw
      // the NULL: when the gateway or another tool beat turn_start to it,
      // brokerd already overwrote `last_inbound_at`, so its verdict travels
      // here in ctx rather than being re-derived from a row that has moved.
      const firstTurn = alreadyCounted
        ? Boolean(ctx && ctx.turn && ctx.turn.firstTurn)
        : firstEverTurn;
      // Everything the model is told beyond "you were counted" — the resume
      // offer, recent reminders, the plan headline, the first-turn opener,
      // the block notice — lives in domain/turn.advise, shared with brokerd's
      // `turn_context` (the same opening, delivered in the prompt instead of
      // a tool result, for the people the turn_context_phones flag covers).
      const data = await turnDomain.advise(client, user, { counted, firstTurn, ourTurn, replyTarget, languageNudge });
      return stale(ok(data), namedNow);
    }),
];
