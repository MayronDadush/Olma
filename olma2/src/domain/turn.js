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
const digest = require('./digest');
const onboardingDomain = require('./onboarding');

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

// Phase B of "the turn opens itself": for the people this flag covers, what
// `turn_start` would have RETURNED is prepended to the prompt by the
// gateway plugin (gateway-plugin/olma-turn, `before_prompt_build` → brokerd
// `turn_context`), and their doctrine says not to call the tool at all. Same
// value shape as FLAG. Off everywhere until set — the doctrine variant and
// the plugin's answer are both gated on it, so a half-deployed state is the
// old behaviour, not a broken one.
const CONTEXT_FLAG = 'turn_context_phones';

async function contextEnabledFor(client, user) {
  return coveredBy(await flags.getFlag(client, CONTEXT_FLAG), user.phone);
}

// Do what `turn_start` would have done to the RECORD, and nothing it would
// have done to the CONVERSATION. Returns what was recovered so the caller can
// tell `turn_start` not to count the same message twice if the model gets
// around to calling it later in the turn.
// The record side of "a person just wrote to us", shared by every opener:
// last_inbound_at, the check-in backoff reset, night-held rows re-heard,
// the quota count, the message.received row. Whichever of the openers runs
// FIRST is the only one that can still see a NULL last_inbound_at, so the
// first-turn verdict is captured here and handed back.
// `wake` — whether this opener has EVIDENCE that a person just wrote, as
// opposed to a turn that merely happened on their agent. Only the waking half
// is gated: the record half (last_inbound_at, the backoff reset, the count)
// stays unconditional, because a turn that reached the model is still activity
// worth recording even when we cannot name what started it.
//
// Sarah, 2026-09-03: a gateway heartbeat poll ran a turn on her agent, the
// model reached for `list_my_tasks` before `turn_start`, and the implicit
// opener — which cannot tell a heartbeat from a person — released her
// night-held check-in. The gate then saw an inbound 8 seconds old, applied the
// mid-conversation grace, and delivered "Good morning!" at 01:26 her time.
// Heartbeats are off since 2026-09-05, but the hole is the opener, not the
// heartbeat: anything that runs a turn without a real inbound message can
// still reach this. Waking someone is the one thing here that must never be
// done on an inference (`incidents.md`, "Good morning at half past one").
async function openRecord(client, user, { wake = false } = {}) {
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
  if (wake) await client.query(
    `UPDATE outbox SET release_after = now()
      WHERE user_id = $1 AND sent_at IS NULL AND hold_reason = 'night'
        AND release_after > now()`, [user.id]);

  const counted = await quota.countMessage(client, user.id);
  await audit.record(client, user.id, 'message.received', null);

  return { counted: true, quota: counted, firstTurn };
}

// Opened by the gateway's own message:preprocessed hook (gateway-hooks/
// olma-turn-open), BEFORE the model's first call — so the person is counted,
// marked awake and shown a 👀 while the model is still reading the prompt.
// A turn Olma started is not a message from the person, here as everywhere.
async function openFromGateway(client, user, { messageId, kind } = {}) {
  if (selfInitiated.isActive(user.id)) {
    await audit.record(client, user.id, 'turn.opened_by_gateway', { selfInitiated: true, messageId: messageId || null });
    return { counted: false, quota: null, firstTurn: false, skipped: 'self_initiated' };
  }
  // The gateway hook fires on `message:preprocessed` — an accepted inbound
  // message and nothing else — so this opener, alone, may wake the queue.
  const rec = await openRecord(client, user, { wake: true });
  await audit.record(client, user.id, 'turn.opened_by_gateway', { messageId: messageId || null, kind: kind || 'text' });
  return rec;
}

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
  // `wake` stays off here on purpose: this path is the FALLBACK, reached
  // whenever the model skipped turn_start, and it has no message id, no
  // gateway event and no way to tell a person from a system turn. The cost of
  // not waking is that a night-held row waits for the window to open, which is
  // the gate's own default; the cost of waking wrongly is a message at 01:26.
  const rec = await openRecord(client, user, { wake: false });
  const { counted, quota, firstTurn } = { counted: rec.counted, quota: rec.quota, firstTurn: rec.firstTurn };
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
  return { counted, quota, firstTurn };
}

// What each optional field in the opening means, said only when it is there.
// This used to be four sentences in turn_start's description — paid on every
// turn by every user, for fields that appear on a handful of turns in a
// person's life. The budget rule (CLAUDE.md, "Doctrine"): guidance about a
// RESULT rides the result.
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

// The CONVERSATION side of opening a turn: everything `turn_start` tells the
// model beyond "you were counted". One function because it now has two
// callers with identical needs — turn_start itself, and brokerd's
// `turn_context` for the people whose prompt carries the opening instead —
// and a hint that reaches one of them and not the other is a defect nobody
// would see until a transcript hunt.
//
//   counted   — the quota verdict for this message ({ data: { blocked } }),
//               or the self-initiated stand-in that is never blocked.
//   firstTurn — their first message ever, as judged by whichever opener saw
//               the NULL (see openRecord).
//   ourTurn   — Olma started this turn: nothing here may assert that the
//               person did anything.
//   replyTarget, languageNudge — what only the model (or the gateway) could
//               see about this message; null when nobody reported them.
async function advise(client, user, { counted, firstTurn, ourTurn, replyTarget, languageNudge }) {
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
  const offered = ourTurn ? { rowCount: 0 } : await client.query(
    `UPDATE users SET resume_offer_sent_at = now()
      WHERE id = $1 AND paused_at IS NOT NULL
        AND (resume_offer_sent_at IS NULL OR resume_offer_sent_at < paused_at)
      RETURNING id`, [user.id]);
  const offerResume = offered.rowCount > 0;

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

  // Stamped once, only here — the one place that actually hands the
  // model onboarding.sendVerbatim, whichever opener saw the NULL. Anchors
  // the 60-second "did they answer the welcome" nudge
  // (jobs/sweeps.sweepNameConfirm): neither `last_inbound_at` (moves on
  // their every message, including this one) nor `onboarded_at` (set at
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
    return {
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
      ...turnHints({ offerResume, languageNudge, recentReminders, planHeadline, replyTarget, genderForms }),
    };
  }
  const shouldNotice = await quota.shouldSendBlockNotice(client, user.id);
  if (!shouldNotice) return { directive: 'silent', reason: 'blocked_already_notified' };
  const view = await digest.assemble(client, user.id, 'block_view');
  return { directive: 'send_block_notice', blockView: view.data };
}

// The opening as prompt text, for the people whose turn is opened by the
// gateway plugin instead of by a tool call. The JSON is rendered exactly as
// a tool result would be (compact, `OK ` prefix) so the model reads the
// shape it has always read; the two lines around it are the only things
// the doctrine variant relies on: the block's name, and "not the person".
const CONTEXT_HEADER = 'Turn context (from the system, not the person — what turn_start would return; do not call turn_start this turn):';
function renderContext(data) {
  const { renderResult } = require('../adapters/mcp/render');
  return `${CONTEXT_HEADER}\n${renderResult({ ok: true, data })}`;
}

module.exports = {
  openTurnImplicitly, openFromGateway, openRecord, isEnabledFor, coveredBy, FLAG,
  contextEnabledFor, CONTEXT_FLAG, advise, turnHints, renderContext, CONTEXT_HEADER,
};
