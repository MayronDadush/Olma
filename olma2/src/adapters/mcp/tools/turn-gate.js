'use strict';
// turn gate — one slice of the tool registry (see ../registry.js).
const {
  users, onboardingDomain, selfInitiated, digest, quota, reactions, audit, S, ok, captureDisplayName, stale, tool, flags,
} = require('./_shared');

// The per-field guidance for turn_start's optional fields. In the RESULT and
// not in the description: the description is injected on every turn for every
// user, these fields show up on a handful of turns in a person's life.
function turnHints({ offerResume, languageNudge, recentReminders, planHeadline, replyTarget, genderForms }) {
  const hints = {};
  if (genderForms === 'feminine') {
    // The doctrine already says "hold the stored preference"; the nightly
    // evals kept catching one masculine verb in an otherwise feminine reply
    // ("בא לך" is fine, "תרצה" is not). A cheap model attends to the result
    // it just read far better than to a rule 40k chars up, so the reminder
    // rides here, on exactly the people it applies to, and nowhere else.
    hints.genderForms = 'They asked to be addressed in FEMININE Hebrew forms. Every verb and '
      + 'pronoun aimed at them is feminine — תרצי, את יכולה, תוכלי, שלך — never תרצה, אתה, '
      + 'תוכל. Reread the whole reply before sending; a single masculine form is a failure.';
  }
  if (replyTarget) {
    hints.replyTarget = 'They used WhatsApp reply on ONE earlier message, and the '
      + '"Reply target of current user message" block above holds its text. Answer THAT '
      + 'message — "סיימתי" on a reply to a rent reminder closes the rent task, not the '
      + 'newest thing either of you said. If the quoted text no longer matches anything '
      + 'you can act on, ask about it rather than guessing at the latest topic.';
  }
  if (offerResume) {
    hints.offerResume = 'First message since they paused: answer what they actually asked, then add '
      + 'ONE line asking if they would like Olma to start reaching out again.';
  }
  if (recentReminders && recentReminders.length) {
    // "probably the newest one" is a guess, and a quote is not — so when both
    // are on the same turn this one steps aside rather than arguing with the
    // hint above. Both fire on exactly the case the reply bug was reported
    // for: a bare "סיימתי" sent as a reply to yesterday's rent reminder.
    hints.recentReminders = 'Reminders Olma already delivered in the last day — a bare reply like '
      + '"סיימתי" or "עשיתי" is probably about the newest one'
      + (replyTarget ? ', UNLESS the quoted message names another: it wins.' : '.');
  }
  if (planHeadline) {
    hints.planHeadline = 'The headline of today\'s overnight plan; the full plan is in your USER.md '
      + '— read it and lead with it when they ask about their day or plans.';
  }
  if (languageNudge) {
    hints.languageNudge = 'They have written several messages running in a language other than the '
      + 'one stored for them: ask ONE short question, IN THE LANGUAGE THEY ARE WRITING IN, whether '
      + 'they would like Olma to switch — call set_my_language if they say yes. Ask once; if they '
      + 'do not take it up, drop it.';
  }
  return Object.keys(hints).length ? { hints } : {};
}

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

      // A paused person who writes gets answered — pausing stops Olma
      // INITIATING, not answering (see domain/pause.js) — but before this, that
      // answer was the whole reply. They were then back to relying on their OWN
      // memory that resume_olma exists, exactly the asymmetry that caused
      // 'pause' to exist in the first place: Olma has a structured way to know
      // they are paused, and they do not. So the FIRST message they send after
      // pausing gets one extra thing: an offer to turn Olma back on.
      //
      // Never a second time in the same pause period — asking on every message
      // while paused is the pitch-to-retain pattern the stop doctrine forbids,
      // and if they ignored the first offer, an unread reminder they never
      // asked for is not an improvement. The WHERE clause makes this atomic and
      // self-limiting: comparing against paused_at, not clearing the column on
      // resume, means a leftover value from an earlier pause cycle reads as
      // "not offered this time" for free.
      const offered = await client.query(
        `UPDATE users SET resume_offer_sent_at = now()
          WHERE id = $1 AND paused_at IS NOT NULL
            AND (resume_offer_sent_at IS NULL OR resume_offer_sent_at < paused_at)
          RETURNING id`, [user.id]);
      const offerResume = offered.rowCount > 0;

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
      // Reminders now go out on the raw pipe (channels/openclaw.js), which
      // never touches this person's session history — so a bare reply like
      // "סיימתי" would otherwise reach an agent that has no idea a reminder
      // just fired (the exact v1 "improvises incorrect context" incident).
      // brokerd knows what it sent without needing the session to remember:
      // the outbox row IS the record. Only the last day, only actually-sent
      // rows, and the field is omitted entirely when empty — which is nearly
      // every turn, so this costs nothing in the common case.
      const { rows: recentRem } = await client.query(
        `SELECT payload, sent_at FROM outbox
          WHERE user_id = $1 AND kind = 'reminder' AND hold_reason IS NULL
            AND sent_at > now() - interval '24 hours'
          ORDER BY sent_at DESC LIMIT 3`, [user.id]);
      const recentReminders = recentRem
        .map((r) => {
          const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload || {});
          return p.title ? { title: String(p.title).slice(0, 200), sentAt: r.sent_at } : null;
        })
        .filter(Boolean);

      // The overnight plan's headline, through the same every-turn channel as
      // recentReminders — and for the same reason: USER.md is injected on
      // session START only (contextInjection: continuation-skip), so a plan
      // built while a session sleeps is invisible to it for the session's
      // whole remaining life. Observed live on the feature's first evening —
      // "מה התוכניות שלי להיום" answered from the digest tool while a
      // fresh plan sat unread in the card. Headline only (~20 tokens); the
      // full plan is in USER.md, which the agent can read when it matters.
      // Paused users get none: leaning forward is what they declined.
      const { rows: planRow } = user.paused_at ? { rows: [] } : await client.query(
        `SELECT headline FROM user_plans
          WHERE user_id = $1 AND built_at > now() - interval '26 hours'`, [user.id]);
      const planHeadline = planRow[0] ? planRow[0].headline : null;
      // Stored by remember_preference when they asked to be addressed as a
      // woman (or said so themselves). Read here, not from the card: the card
      // is a fact the model may or may not attend to, the result is a
      // sentence it has just read. Masculine is the doctrine's default and
      // gets no hint — the hint exists for the register that keeps slipping.
      const { rows: genderRow } = await client.query(
        `SELECT value FROM user_preferences WHERE user_id = $1 AND key = 'gender_forms'`, [user.id]);
      const genderForms = genderRow[0] && /נקבה|feminine|female|woman/i.test(String(genderRow[0].value))
        ? 'feminine' : null;

      // USER.md is re-rendered only when something on it moved. turn_start runs
      // on every single message, so it cannot join CARD_TOOLS wholesale — it
      // flags the card itself, on the one turn in a person's life that fills in
      // their name (see brokerd/server.js).
      // The one turn in a person's life where there is no conversation to
      // continue. Until this flag existed, `proceed` was all the agent ever
      // got, and the doctrine told it there is no welcome moment — so someone
      // whose first word was "היי" was answered "היי" and never onboarded,
      // for ever. The greeter-conversation path that doctrine assumes only
      // fires when the person wrote something worth carrying across; a
      // one-word opener carries nothing, and that is the common case.
      //
      // Whichever entry point opened the turn is the one that saw the NULL:
      // when a tool beat turn_start to it, brokerd's recovery already
      // overwrote `last_inbound_at`, so its verdict travels here in ctx rather
      // than being re-derived from a row that has already moved.
      const firstTurn = alreadyCounted
        ? Boolean(ctx && ctx.turn && ctx.turn.firstTurn)
        : firstEverTurn;
      // Stamped once, only here — the one place that actually hands the
      // model onboarding.sendVerbatim, whether firstTurn came from this call's
      // own self-join or from an earlier recovery in the same turn (see the
      // comment above). Anchors the 60-second "did they answer the welcome"
      // nudge (jobs/sweeps.sweepNameConfirm): neither `last_inbound_at` (moves
      // on their every message, including this one) nor `onboarded_at` (set at
      // provisioning, before they have necessarily written a word) names this
      // moment.
      if (firstTurn) {
        await client.query(`UPDATE users SET first_turn_at = now() WHERE id = $1`, [user.id]);
      }

      // The instruction rides in the RESULT, not in AGENTS.md, and that is a
      // budget decision rather than a style one: the doctrine renders to 39249
      // of the 39250 chars the gateway will inject, so a paragraph added there
      // is a paragraph silently deleted from the middle of some other section
      // on every turn for every user (tests/intake.test.js guards this).
      // Here it costs ~60 tokens once in a person's lifetime, and it arrives at
      // the exact moment it applies — which for a cheap model beats a rule
      // buried in 40k chars it only partly attends to.
      if (!counted.data.blocked) {
        return stale(ok({
          directive: 'proceed', locale: user.locale,
          ...(firstTurn ? {
            firstTurn: true,
            onboarding: {
              sendVerbatim: onboardingDomain.openingMessage(user.locale),
              instruction: 'Their first ever message. Open your reply with '
                + 'sendVerbatim, character for character — do not translate, reword, '
                + 'shorten, or add to it. If they actually asked for something, answer '
                + 'it below those lines; otherwise stop there. No feature tour, no menu, '
                + 'and no follow-up question this turn.',
            },
          } : {}),
          ...(offerResume ? { offerResume: true } : {}),
          ...(languageNudge ? { languageNudge } : {}),
          ...(recentReminders.length ? { recentReminders } : {}),
          ...(planHeadline ? { planHeadline } : {}),
          ...(replyTarget ? { replyTarget: true } : {}),
          ...(genderForms ? { genderForms } : {}),
          // What to do with each of those, said only when it is there. This
          // used to be four sentences in the tool description — paid on every
          // turn by every user, for fields that appear on a handful of turns
          // in a person's life. Same budget rule as `onboarding` above.
          ...turnHints({ offerResume, languageNudge, recentReminders, planHeadline, replyTarget, genderForms }),
        }), namedNow);
      }
      const shouldNotice = await quota.shouldSendBlockNotice(client, user.id);
      if (!shouldNotice) return stale(ok({ directive: 'silent', reason: 'blocked_already_notified' }), namedNow);
      const view = await digest.assemble(client, user.id, 'block_view');
      return stale(ok({ directive: 'send_block_notice', blockView: view.data }), namedNow);
    }),
];
