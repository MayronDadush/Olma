'use strict';
// The model's own working-out, delivered to a person as the message.
//
// Yahav, 2026-09-10 08:28, asked for a reminder at 13:00. He got a 👍 on his
// message and then this, on his phone, in two languages:
//
//   הם אמרו 13:00 — due_at נקבע ל-13:00. remind_at שמרתי 13:00, שזה הזמן שהם
//   אמרו — לא צריך להזכיר לפני, זה בדיוק בשעה שהם ביקשו. The reminder is set
//   for 13:00 their time.
//
//   Wait, let me re-check — remind_at was set to 2026-09-10T10:00:00Z which is
//   13:00 in Asia/Jerusalem. That's correct …
//
//   The hints say a 👍 was placed and the reminder is armed for the hour they
//   named, so nothing to add — unless there's an undelivered reply from before.
//
//   Looking at the turn context: it says one of their recent messages was read
//   but produced no reply …
//
// The reminder itself was right. What reached him was the deliberation that
// produced it — Olma talking about him in the third person, in English, naming
// our own columns, and ending in the sentinel decision that there was nothing
// to say. The doctrine forbids every part of it in three separate sentences
// (`agents-template.md`: "Your reply is the message, nothing else", "Never
// narrate what you did", "Any text you put in front of `NO_REPLY` is
// DELIVERED"), and this is the third time it has been ignored: the DSML
// tool-call syntax with a live `olma_identity` in it (2026-09-02) and two
// English paragraphs of working notes above a Hebrew answer (2026-09-07).
//
// So it is the rule this repo already wrote down and could not act on: a
// safety property written as a sentence in a prompt is a request, not a
// guarantee, and wherever a model's raw output reaches a person with no
// server-side gate the prompt is the only thing standing there.
//
// There IS a gate, and the belief that there was not is what left this open.
// `domain/token-leak.js` records "the gateway exposes no ... outbound message
// hook (confirmed against its published schema)" — that was read from the
// plugin catalog on 2026-09-02 and it is wrong for the version the box runs.
// OpenClaw 2026.8.1 publishes `reply_payload_sending` (Modify/gate: "Mutate or
// cancel normalized reply payloads before delivery") and `message_sending`
// (Modify/gate: "Rewrite outbound content or cancel delivery"), neither of
// which needs `allowConversationAccess`. `gateway-plugin/olma-turn` now
// registers the first, and this module is what it asks.
//
// ---- what counts as a leak, and why the list is shaped like this -----------
//
// Two tiers, because the two actions have opposite costs. DROPPING text is
// destructive — a false positive eats a real answer — so only markers that
// cannot appear in a sentence a person is meant to read may drop a line.
// REPORTING is free, so the wider shape rule reports and delivers.
//
//   drop   a frame marker (a tool-call payload, an identity token)
//          one of our own column/parameter names, from a closed list
//          an ISO-8601 UTC instant — Olma says "13:00", never "10:00:00Z"
//          the silence sentinel with words around it
//          the name of a block only the model is shown (`Turn context`)
//   report any other snake_case identifier, outside a URL, an address or a
//          quotation. Every internal name we have not thought of is this
//          shape, and it is also the shape of a word a developer might have
//          put in a task title — so it earns an audit row and a place in the
//          list above, not a cancelled reply.
//
// The closed list is what has been SEEN plus the parameters and columns beside
// them, deliberately not every identifier in the system: 88 tool names and
// ~200 columns would be a list nobody maintains, guarding against a leak
// nobody has had, at the price of a reply somebody was waiting for.
//
// The measurement this module is missing is named rather than skipped: the 383
// real messages `domain/hebrew-quality.js` was calibrated against are on the
// box and were not reachable from the session that wrote this. `tests/
// reply-leak.test.js` therefore holds the two real leaks open end to end, and
// the identifier tier is report-only precisely because it is unmeasured.

// The model's own frame arriving as text. Moved here from hebrew-quality.js,
// which now reads it from this module: one owner, so the eval's `markup` flaw
// and the delivery gate can never come to disagree about what a frame is.
const FRAME_RE = /<[｜|]DSML[｜|]|<\|?tool_calls?\|?>|\bolma_(?:tok|grp)_[0-9a-f]{8,}\b|\{"name":\s*"olma_[a-z_]+"/;

// Ours, and unmistakable. Tool parameters (registry.js schemas), the columns
// the model reads in a result, and the one tool name it is told to call by
// name. Sorted by where they come from, not alphabetically, so the next
// addition lands next to its kin.
const INTERNAL_NAMES = [
  // moments and their columns
  'due_at', 'new_due_at', 'remind_at', 'starts_at', 'ends_at', 'accepted_starts_at',
  'counter_starts_at', 'expires_at', 'sent_at', 'last_inbound_at', 'paused_at',
  'opening_sent_at', 'timezone_asked_at', 'holiday_quiet_asked_at', 'first_turn_at', 'last_wrote_at',
  // the outbox and the gate
  'hold_reason', 'paused_reason', 'idempotency_key', 'checkin_misses', 'quiet_days',
  'auto_reminder', 'is_eval', 'name_confirmed', 'holiday_calendar',
  // identity and the turn
  'olma_identity', 'identity_token', 'agent_id', 'session_key', 'user_id',
  'message_id', 'message_kind', 'reply_to_id', 'sender_name', 'turn_start',
  // rows the model names
  'task_id', 'parent_task_id', 'reminder_id', 'meeting_id', 'event_id',
  'contact_id', 'connection_id', 'fact_id', 'share_id', 'option_id',
  'first_name', 'last_name', 'repeat_rule',
];
const INTERNAL_RE = new RegExp(`(?:^|[^A-Za-z0-9_])(${INTERNAL_NAMES.join('|')})(?![A-Za-z0-9_])`, 'i');

// A block only the model is ever shown. `Conversation info` and `Turn context`
// are the gateway's and ours; `DELIVERY:` opens the instruction on a turn Olma
// started; the last two are strings from the doctrine itself.
// `hints` is ours too — the object `domain/turn.turnHints` builds and hands the
// model. A reply that cites what it says is quoting our machinery exactly as
// `Turn context` does. It was already in Yahav's third paragraph ("The hints
// say a 👍 was placed…"), which dropped only because a LATER line did, and it
// came back on 2026-09-15 as the whole reason a message was written at all
// ("Since the hint says a bare 'תודה' is probably about the newest reminder").
// `AGENTS.md`, `USER.md` and `MEMORY.md` are the doctrine and the memory files
// — the model reads them and nobody else ever sees their names. "Per
// AGENTS.md, 'cancel the reminder' and 'cancel the thing' are the same
// sentence" reached Miron three times on 2026-09-14 (the 14-day measurement
// below found them and nothing here had a name for them).
const BLOCK_RE = /\b(?:Turn context|Conversation info|Reply target of current user message|OpenClaw heartbeat poll|unknown identity token|the hints? says?|(?:AGENTS|USER|MEMORY)\.md)\b|^\s*DELIVERY:/im;

// The reaction vocabulary, named as something to SEND. Marks travel through
// `domain/reactions.placeMark` on a path the reply text never touches, so words
// that hand one of these emoji to an act of replying are describing the
// machinery rather than talking to anybody. This is what caught the 2026-09-15
// Hebrew leak, whose every other word was ordinary Hebrew: "תודה פשוטה — 👍
// בחזרה". It DROPS, so the bar was the module's own — a marker that cannot
// appear in a sentence a person is meant to read — and it is met by the OBJECT
// position, not by the emoji: a sign-off ("סגור 👍", "אענה לך אחרי הפגישה 🙏")
// puts no mark in anyone's hands and stays untouched. Measured against every
// ordinary shape in the test plus eight sign-offs and near-misses written to
// break it: 3 leaks caught, 0 moved.
const VOCAB_RE = '👀|👂|👍|⏰|🙏|❓|⚠️';
const MARK_RE = new RegExp(
  `(?:${VOCAB_RE})\\s*(?:בחזרה|חזרה בתגובה|בתגובה)`
  + `|(?:אשיב|אענה|אגיב|אשלח)\\s+(?:לו|לה|להם|)\\s*(?:${VOCAB_RE})`
  + `|(?:reply|respond|answer|react|send)(?:ing|s|ed)?\\s+(?:back\\s+)?(?:with|using)\\s+(?:a\\s+)?(?:${VOCAB_RE})`,
  'i');

// Olma writes TO the person. A reply that opens by attributing speech to a bare
// third-person pronoun is describing the conversation instead of continuing it,
// and it is the one shape all three recorded leaks share, across two languages
// and three incidents: "הם אמרו 13:00" (2026-09-10), "הוא אמר \"תודה\""
// (2026-09-15 14:37), "He said \"תודה\" again" (2026-09-15 15:03).
//
// Anchored on the QUOTATION, because the bare opening alone is a real sentence:
// "They asked me to remind you tomorrow" and "הם אמרו שיגיעו מחר" are things
// Olma says, and both went quiet once the verb had to be followed by a quote or
// a number — the model handing the person their own message back. `\b` is no
// help on the Hebrew half: Hebrew letters are not `\w`, so there is no boundary
// between a letter and a space and every `\b` after a Hebrew word silently
// fails. The negative lookahead is what replaces it.
//
// REPORTED, never dropped. It reads 3/3 and 0/16 on the corpus above, but that
// corpus is sixteen strings somebody wrote by hand — the 383 real messages this
// module's header already names as the measurement it is missing are still on
// the box. Same reasoning as the identifier tier: unmeasured means report.
const NARRATION_RE = /^[\s"״'׳]*(?:הוא|היא|הם|הן)\s+(?:אמרו|אמרה|אמר|כתבו|כתבה|כתב)(?![֐-׿])\s*["״'׳\d]|^\s*(?:he|she|they)\s+(?:said|wrote|replied)\s+["״'\d]/i;

// The model talking about what it is about to do, or about the reader in the
// third person, in English. This is the tier the header above named as
// missing, and it was chosen from traffic rather than guessed: on 2026-09-15
// `scripts/measure-reply-gate.js` read every assistant message on the box for
// 14 days — 33 agents, 1,156 messages, 2,247 paragraphs — and 151 paragraph
// hits were read one by one (`incidents.md`, "The working-out, measured"). 107
// of the 113 distinct paragraphs were working-out, and the gate as it stood
// delivered 94 of them (`pass`). The other six were the reason a drop tier had
// to be measured first: two real English replies to English-speaking users
// ("Hey Yuval — the group is arranging…", "its all good 👍") that a bare "no
// Hebrew in it" rule would have deleted, and four preambles to an English
// speaker ("I'll check what's most urgent for you this week.") that a drop
// costs nothing on, because the answer follows in the next block.
//
// So it DROPS, on four shapes, each with the guard the corpus asked for:
//
//   opener   a line that STARTS with the model's own next step ("Let me check",
//            "I'll save", "Now I", "But first", "Looking at the turn
//            context") — 40 of the 107. `Let me` needs a verb off a
//            closed list, because "Let me know if that works" is a sentence
//            to a person; "know" is not on it.
//   mid      "Let me <verb>" or "I'll save/set/add/create" ANYWHERE in the line
//            — 29 more, the working-out that begins with the fact it was
//            reasoning from ("The number doesn't match anyone obvious in his
//            contacts. Let me check."). To an English speaker "Sure, let me
//            check and get back to you" is a preamble, and losing it loses
//            nothing: the answer is the next block.
//   third    a line that STARTS by describing the reader in the third person
//            ("He said", "They asked", "The user is") — 16 of the 107, every
//            one about the reader — AND carries a tell that it is working-out:
//            the reader's own words quoted back in Hebrew, one of our nouns
//            (task, reminder, the hint, dashboard…), or a first-person step.
//            Without the tell it stays: "They asked me to remind you
//            tomorrow" and "He asked me to pass on that he is running late"
//            are relays, and the same shape.
//   soft     "Actually," / "Wait," / "OK," / "So" openings — 6 of the 107 —
//            only when the line also carries a first-person step or the
//            reader in the third person. "Actually, the meeting moved to 6pm"
//            is a sentence to a person and stays.
//
// 99 of 107 caught by these (six of the eight missed only ever appear between
// paragraphs the cut already takes), 0 of the two real English replies touched, and the
// hand-written ordinary corpus in `tests/reply-leak.test.js` — which now has
// fifteen English sentences written to break exactly this — unmoved. Every
// list here is closed and was read off real messages, same as INTERNAL_NAMES;
// the measurement script is in the repo so the next addition is read off the
// box too, not off a hunch.
const DELIB_VERBS = 'check|see|look|verify|re-?check|figure|find|get|read|re-?read|try|compose|deliver|save|cancel|write|remove|update|confirm|start|first|also|just|search|call|fetch|proceed|think|handle|do|make|give|send|reply|respond|answer|draft|set|ask|follow|merge|create|add|mark|use|note|pull|run|open|archive';
const DELIB_LET_ME = `Let me(?: not| just| also| first)? (?:${DELIB_VERBS})`;
const DELIB_OPENER_RE = new RegExp('^\\s*(?:'
  + `${DELIB_LET_ME}|I'll (?:check|look|just|go|start|first|proceed|save|set|search|add|create|mention)`
  + '|Now I |But first|First, I\'ll|Now (?:create|save|check)|Also need to|Also,? I |No user message'
  + '|This (?:turn|is a delivery turn)|So they |Looking at the (?:turn context|today block|meeting status|context|hints?)'
  + '|The (?:intake note|reply target|reply was to|reminders? (?:were|was))'
  + ')\\b', 'i');
const DELIB_MID_RE = new RegExp(`\\b(?:${DELIB_LET_ME}|I'll (?:save|set|add|create|proceed))\\b`, 'i');
const DELIB_THIRD_RE = /^\s*(?:He|She|They|The user|The person)(?:'s)? (?:sent|asked|wants?|said|replied|wrote|has|hasn't|is|was|stated|message)\b/i;
// The tell, for `third`: against the RAW line, because the Hebrew quotation
// is the signal and `scannable` strips quotations by design (same reason
// NARRATION_RE reads raw).
const DELIB_TELL_RE = /["״'][^"״'\n]*[֐-׿][^"״'\n]*["״']|`|\b(?:tasks?|reminders?|the hints?|turn|digest|dashboard|contacts?|onboarding|meeting|opted|delete|archive|Let me|I'll|I should|I need|I replied|I answered)\b/i;
const DELIB_SOFT_RE = /^\s*(?:Actually|Wait|Hmm|OK|Okay|So)\b[,—\s-]*/i;
const DELIB_CUE_RE = /\b(?:let me|I need|I should|I can|I see|I don't|I answered|I asked|I never|he |she |they |him |his |their |the hints?|the turn|the intake)\b/i;

function deliberationIn(raw, text) {
  const opener = DELIB_OPENER_RE.exec(text);
  if (opener) return opener[0];
  const mid = DELIB_MID_RE.exec(text);
  if (mid) return mid[0];
  const third = DELIB_THIRD_RE.exec(text);
  if (third && DELIB_TELL_RE.test(raw)) return third[0];
  const soft = DELIB_SOFT_RE.exec(text);
  if (soft && DELIB_CUE_RE.test(text)) return soft[0];
  return null;
}

// The tier the 2026-09-15 measurement rejected, with the one fact it was
// missing: WHO IS READING.
//
// That measurement asked "would `no Hebrew in it` work" and answered no — it
// would have deleted two real English replies to English-speaking users. Every
// lexical tier above was written instead, and each of them knows the
// vocabulary of the leak it came from. On 2026-09-22 the gate was measured
// again over eight days (37 agents, 255 assistant messages, 639 paragraphs):
// TWELVE English paragraphs were delivered with no finding at all, and reading
// them by hand splits them cleanly in two.
//
//   nine leaks, all to people who write Hebrew — "Now write the reply — one
//   short message, one offer, the zone statement, then the name question."
//   (u-36), "I can't see the image content with this model." (u-37), "No
//   contacts named padel. I need to ask Gal who's in the group" (u-37), "Now
//   for the update — deliver the OpenRouter new models update as subscribed."
//   (u-3, the owner's own phone);
//
//   three real replies, all to the two people who actually write English —
//   u-12, whose `locale` is `en`, and u-13, whose `locale` says `he` and whose
//   `locale_observed` says `en`.
//
// So the discriminator was never the language of the paragraph. It is the
// language of the PERSON, and nothing here had it: `gateReply` decides
// locally with no socket (see the plugin), so the reader had to be handed in.
// brokerd answers it on the same `turn_context` call that already carries the
// opening (`turn.readerWritesHebrew`), the plugin caches it per agent, and it
// is a TRI-STATE — `true` only when their own columns agree, `null` whenever
// they do not, and a null never acts. u-13 is exactly why: a person filed as
// Hebrew who writes English is not somebody this may be run against.
//
// Measured on that corpus: 9 of 9 caught, 0 of 3 real replies touched.
//
// Guards, each for a line that must survive:
//   * a MEDIA: line is the gateway's own convention for attaching a file
//     (`agents-template.md`), not a sentence, and the one in a schedule-card
//     reply carries the card;
//   * one Hebrew letter ANYWHERE in the raw line means it is not this, and raw
//     is deliberate — `scannable` strips quotations, and a Hebrew phrase
//     quoted back is still Hebrew on the page;
//   * MIN_WORDS keeps a bare name, a label, a list bullet and an emoji line
//     out of a DROP tier. Four is the shortest real leak on the corpus ("No
//     contacts named padel.") and nothing shorter was a leak;
//   * a `>` line is RELAYED text — somebody else's message, a subscribed
//     update, the digest block — and never Olma's own sentence. The first
//     measurement of this tier caught it: Miron's OpenRouter update is a
//     quoted block whose model-name line ("> Xiaomi MiMo-V2.6-Pro-UltraSpeed
//     ($4.35/$8.70), MiMo-V2.6-Flash …") carries no Hebrew at all, the tier
//     condemned it, and the cut reached back and took the whole update he had
//     subscribed to. `digest-block-relayed-untouched` is an eval scenario for
//     the same rule arriving from the other direction.
const ENGLISH_WORD_RE = /[A-Za-z]{2,}/g;
const HEBREW_LETTER_RE = /[֐-׿]/;
const MEDIA_LINE_RE = /^\s*MEDIA:/i;
const RELAYED_LINE_RE = /^\s*>/;
const MIN_ENGLISH_WORDS = 4;

function englishToHebrewReader(raw, text, readerWritesHebrew) {
  if (readerWritesHebrew !== true) return null;
  if (MEDIA_LINE_RE.test(raw)) return null;
  if (RELAYED_LINE_RE.test(raw)) return null;
  if (HEBREW_LETTER_RE.test(raw)) return null;
  const words = text.match(ENGLISH_WORD_RE) || [];
  if (words.length < MIN_ENGLISH_WORDS) return null;
  return words.slice(0, 6).join(' ');
}

// 2026-09-10T10:00:00Z. A time crossing a tool boundary carries an explicit
// offset (CLAUDE.md, "Data you must not get wrong") and a time reaching a
// person is the hour in their own zone. Only one of those two is ever spoken.
const INSTANT_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/;

// The silence sentinel, travelling with words. Alone it is not a leak at all:
// it is the decision to stay quiet, the gateway drops such a row by itself
// (`docs/gateway/protocol.md`: pure silent-token rows are omitted), and
// calling it an incident would file one on every 👍 Olma correctly says
// nothing after. With words it is a stray token, and it is STRIPPED rather
// than used to drop its line — `jobs/unanswered.js` reads "בוצע NO_REPLY" as a
// real reply on purpose, and a gate that cancelled it would delete the one
// word the person was owed.
const SENTINEL_RE = /\bNO_REPLY\b/;
const SENTINEL_STRIP_RE = /\s*\bNO_REPLY\b\s*/g;

// ---- a link that goes nowhere ----------------------------------------------
//
// 2026-09-22: three people in one minute were each sent a different invented
// domain for the same coordination — `dashboard.olma.ai/meetings/40`,
// `dash.olma.app/meetings/40`, `dashboard.openclaw.ai/meetings/40` — none of
// which is anybody's page, and no link had been minted for that meeting at
// all. Eight of these are in the transcripts, across five people and four
// weeks. The instruction that asked for them is fixed elsewhere (the url is
// handed over now, not requested); this is the half that does not depend on
// anyone getting an instruction right, and it is the only one that would have
// NOTICED. Nothing in Postgres can: there is no row for a link that was never
// minted, so every detector we have reads clean while the message is wrong.
//
// Two shapes, and both are checkable rather than judged:
//
//   a host that claims to be US and is not one of the two hostnames we serve
//   — `olma`, `allma` or `openclaw` as a whole label, so `olmafarm.com` is
//   somebody's farm and stays;
//
//   our OWN hostname carrying a path nothing serves. The Caddyfile passes a
//   named allowlist and everything else 404s before it reaches the app
//   (`rules/dashboard-and-domains.md`), so "a path that is not on the list" is
//   a dead link by definition, not an opinion. It is what caught the retired
//   `/pick/` link Olma sent on 2026-09-05, ten days after that page went 410.
//
// Deliberately NOT "any URL the tools did not mint this turn": a news
// headline, a Google consent screen and a search result are all real links
// this gate never sees the provenance of, and a rule that cannot tell them
// from an invention would delete the ones that work. The cost is named: an
// invented link on a domain that does not sound like ours — a `base44.app`
// sandbox went out on 2026-09-06 — reads exactly like a real external link
// and passes here.
//
// It STRIPS rather than condemning its paragraph. The sentence around the link
// is the message: an invite that loses its dead line still asks when suits
// them, and cutting the paragraph would take the question with it.
const OUR_HOSTS = new Set(['allma.world', 'www.allma.world', 'olmachat.duckdns.org']);
const OUR_PATHS = /^\/(?:d\/(?:[A-Za-z0-9]{22}|[a-f0-9]{64})|me|privacy|terms|health|ready)?\/?$/;
const CLAIMS_US_RE = /(?:^|[.-])(?:olma|allma|openclaw)(?:[.-]|$)/i;
const ANY_URL_RE = /\bhttps?:\/\/[^\s<>"'׳״)\]]+/gi;

function deadLink(u) {
  let x;
  try { x = new URL(String(u)); } catch { return false; }
  const host = x.hostname.toLowerCase();
  if (OUR_HOSTS.has(host)) return !OUR_PATHS.test(x.pathname);
  return CLAIMS_US_RE.test(host);
}

function firstDeadLink(raw) {
  for (const u of String(raw || '').match(ANY_URL_RE) || []) if (deadLink(u)) return u;
  return null;
}

// The wide tier. Anything shaped like one of our names that the closed list
// has not heard of — reported, delivered. Leading `/` and `@` are excluded so
// a path segment and an address local-part stay out even if the strippers
// below miss one; a trailing `.` is deliberately allowed, because a name at
// the end of a sentence is still the name (`… the due_at.`).
const IDENTIFIER_RE = /(?:^|[^A-Za-z0-9_/@])([a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+)(?![A-Za-z0-9_])/;

// What a value we did not write may not be judged as ours. A URL is minted by
// `domain/search-link.js` and by Google, an address is a person's, and a
// quotation is somebody else's words — "כתבת 'due_at'" is the person's own
// sentence coming back, not Olma's frame going out. Replaced by a space
// rather than removed so the boundary classes above still hold.
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const ADDRESS_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const QUOTED_RE = /["״'][^"״'\n]{1,80}["״']/g;

function scannable(line) {
  return String(line || '').replace(URL_RE, ' ').replace(ADDRESS_RE, ' ').replace(QUOTED_RE, ' ');
}

// A live credential is the one thing a frame marker can BE, so the phrase that
// tripped the detector is never carried out of here in the clear —
// `domain/token-leak.js` learned that first: a detector for a leaked
// credential must not become a second place the credential is written down.
const TOKEN_RE = /\bolma_(?:tok|grp)_[0-9a-f]{8,}/g;
function redact(at) { return String(at || '').replace(TOKEN_RE, 'olma_***'); }

// Every leak in one line, most serious first. `at` is the phrase that tripped
// it — for the audit row, and for a reader on the dashboard checking that the
// count is not lying (the same contract as hebrew-quality.flawsIn).
function leaksIn(line, { readerWritesHebrew = null } = {}) {
  const raw = String(line || '');
  const text = scannable(raw);
  const out = [];
  const frame = FRAME_RE.exec(raw); // a frame marker is ours wherever it sits
  if (frame) out.push({ kind: 'frame', at: redact(frame[0].slice(0, 40)) });
  // Against the RAW line: `scannable` replaces every URL with a space, which
  // is right for every other tier here and would erase this one entirely.
  const dead = firstDeadLink(raw);
  if (dead) out.push({ kind: 'link', at: dead.slice(0, 60) });
  const internal = INTERNAL_RE.exec(text);
  if (internal) out.push({ kind: 'internal', at: internal[1] });
  const block = BLOCK_RE.exec(text);
  if (block) out.push({ kind: 'block', at: block[0].trim().slice(0, 40) });
  const mark = MARK_RE.exec(text);
  if (mark) out.push({ kind: 'mark', at: mark[0].trim().slice(0, 40) });
  // Against the RAW line, not `text`: this one is anchored on the quotation,
  // and `scannable` strips quotations by design (somebody else's words are not
  // ours to judge). Here the quotation IS the tell — it is the person's own
  // message being handed back to them — so the stripper would erase the signal.
  const narration = NARRATION_RE.exec(raw);
  if (narration) out.push({ kind: 'narration', at: narration[0].trim().slice(0, 40) });
  const deliberation = deliberationIn(raw, text);
  if (deliberation) out.push({ kind: 'deliberation', at: deliberation.trim().slice(0, 40) });
  const instant = INSTANT_RE.exec(text);
  if (instant) out.push({ kind: 'instant', at: instant[0] });
  const sentinel = SENTINEL_RE.exec(text);
  if (sentinel) out.push({ kind: 'sentinel', at: sentinel[0] });
  // Only when nothing above matched, and for the same reason twice over: the
  // lexical tiers name WHAT leaked, which is the better audit row, and a line
  // already condemned has nothing to gain from a second verdict.
  if (!out.length) {
    const english = englishToHebrewReader(raw, text, readerWritesHebrew);
    if (english) out.push({ kind: 'english', at: english.slice(0, 40) });
  }
  // The wide tier exists to name what the closed list is missing, and a line
  // already dropped has nothing to add.
  if (!out.length) {
    const id = IDENTIFIER_RE.exec(text);
    if (id) out.push({ kind: 'identifier', at: id[1] });
  }
  return out;
}

// The kinds that leave their line standing: `identifier` because it is the
// unmeasured tier and only reports, `sentinel` because — ON ITS OWN, with
// nothing said before it — it is stripped in place rather than condemning its
// paragraph (the extra condition is `hasEarlierContent` below), `narration`
// because a bare third-person opening is a real sentence when the quotation
// after it is somebody else's and not the reader's own words back. Everything
// else condemns the paragraph it sits in, which is the destructive half — so
// only the closed, unmistakable markers are allowed in here.
// `link` is here for the same reason `sentinel` is: it is taken OUT of its
// line and the line stays. The words around a dead link are the message.
const KEEPS_LINE = new Set(['identifier', 'sentinel', 'narration', 'link']);

// The subset of those that also change NOTHING about the text. `sentinel` is
// not in here: it leaves its line standing but is stripped out of it, so it is
// a real change and belongs in `leaks`.
const REPORT_ONLY = new Set(['identifier', 'narration']);
function drops(leaks) { return leaks.some((l) => !KEEPS_LINE.has(l.kind)); }

// Is there real content BEFORE line `i` — any earlier line that is not blank?
// This is the one fact that tells "בוצע NO_REPLY" (a real short answer with
// the sentinel trailing the SAME, only, line — nothing said before it) apart
// from Miron's shape (paragraphs of narration, and only the LAST one happens
// to carry the token). The doctrine's own words are "nothing before them and
// nothing after" — `SENTINEL_RE` already enforces "nothing after" by never
// keeping what follows a leaking paragraph; this is "nothing before".
function hasEarlierContent(lines, i) {
  for (let j = 0; j < i; j++) if (lines[j].trim()) return true;
  return false;
}
// KNOWN GAP, left open rather than guessed at: this reads LINES, so a single
// unbroken line of narration ending in the sentinel with no line break at all
// is not "earlier content" and only strips the token in place, same as
// "בוצע NO_REPLY". Both real incidents on file are multi-line (models write
// reasoning as separate sentences or paragraphs), so there is nothing to
// measure a fix against yet (tests/reply-leak.test.js pins this as a KNOWN
// GAP rather than silently passing) — the project's own rule against shipping
// an unmeasured detector cuts both ways.

const SENTINEL = 'NO_REPLY';

// Where the paragraph containing line `i` ends — the last line before the next
// blank one, or the last line there is. A marker condemns its whole paragraph,
// not its own line: working notes are written in paragraphs and only some of
// their sentences name a column. Yahav's third paragraph ("The hints say a 👍
// was placed…") carries no marker at all, and neither does the second line of
// the 2026-09-07 notes ("The task is there and the reminder is armed").
function paragraphEnd(lines, i) {
  let end = i;
  while (end + 1 < lines.length && lines[end + 1].trim()) end += 1;
  return end;
}

// The decision, for one outgoing reply.
//
//   pass    nothing found, or nothing that changes the text — delivered as is
//   trim    what follows the LAST leaking paragraph is delivered
//   cancel  nothing was left
//
// "Everything up to and including the last leaking paragraph" rather than
// "the leaking paragraphs" is the whole rule, and it is read off the doctrine:
// "Work through tools in silence, then write the message only." Narration
// comes FIRST, so anything between two paragraphs of it is narration too.
// The 2026-09-07 shape then works the other way round: working notes above a
// real Hebrew answer lose the notes and keep the answer.
//
// The cost of that reading is a reply whose narration came LAST, which would
// lose the answer in front of it. It is the right way round anyway: the two
// leaks on file are both narration-first, the doctrine tells the model to
// write in that order, and of the two mistakes only one puts our columns on
// somebody's phone.
//
// Miron, 2026-09-15: this gate ran, found exactly one leak — `sentinel`, on
// the last line — and delivered every word in front of it anyway, because
// `sentinel` never condemned a paragraph and nothing else in his draft
// (plain English narration, no column name, no frame, no instant) matched
// anything else here. The result was the whole draft with the literal string
// "NO_REPLY" removed: "...I should reply ." — exactly what reached his phone
// (`incidents.md`, "The sentinel that only stripped itself"). `hasEarlierContent`
// closes it without touching the case this was built to protect: a sentinel
// on the FIRST line, nothing before it, still only strips in place.
// `readerWritesHebrew` is the one fact this cannot work out for itself, and it
// is a tri-state: `true` when the person's own columns agree that they write
// Hebrew, `false` when they do not, `null` when nothing can say. Only `true`
// arms the `english` tier; both other values leave it exactly as it was before
// 2026-09-22. Every caller that does not pass it gets the old behaviour, which
// is what keeps `intake` and `ggreet` — who speak to people whose language
// nobody knows yet — out of a drop tier built on knowing it.
function gateReply(text, { readerWritesHebrew = null } = {}) {
  const raw = String(text == null ? '' : text);
  if (raw.trim() === SENTINEL) return { action: 'pass', text: raw, leaks: [], reported: [] };
  const lines = raw.split('\n');
  const found = lines.map((l) => leaksIn(l, { readerWritesHebrew }));
  const reported = [];
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    for (const l of found[i]) reported.push({ ...l, line: i });
    const sentinelAfterNarration = found[i].some((l) => l.kind === 'sentinel') && hasEarlierContent(lines, i);
    if (drops(found[i]) || sentinelAfterNarration) last = Math.max(last, paragraphEnd(lines, i));
  }
  // What changed the message. The report-only kinds never do — they exist to be
  // read on the dashboard, not to act. Keeping them out of `leaks` is what makes
  // "found something, changed nothing" a `pass` that delivers byte for byte,
  // rather than a `trim` whose own `.trim()` would quietly eat the whitespace.
  const leaks = reported.filter((l) => !REPORT_ONLY.has(l.kind));
  if (!leaks.length) return { action: 'pass', text: raw, leaks, reported };
  // Whatever survives the cut still goes out without the stray sentinel in it.
  const kept = lines.slice(last + 1).join('\n')
    .replace(SENTINEL_STRIP_RE, ' ')
    // A link that goes nowhere is lifted out where it stands; what it sat in
    // is delivered. Blank lines it leaves behind are folded so the message
    // does not arrive with a hole in it.
    .replace(ANY_URL_RE, (u) => (deadLink(u) ? '' : u))
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!kept) return { action: 'cancel', text: '', leaks, reported };
  return { action: 'trim', text: kept, leaks, reported };
}

module.exports = {
  leaksIn, gateReply, drops, scannable, redact, paragraphEnd, hasEarlierContent,
  deadLink, firstDeadLink, OUR_HOSTS,
  FRAME_RE, INTERNAL_RE, BLOCK_RE, INSTANT_RE, SENTINEL_RE, IDENTIFIER_RE,
  MARK_RE, NARRATION_RE, deliberationIn, englishToHebrewReader,
  INTERNAL_NAMES, SENTINEL, KEEPS_LINE, REPORT_ONLY, MIN_ENGLISH_WORDS,
};
