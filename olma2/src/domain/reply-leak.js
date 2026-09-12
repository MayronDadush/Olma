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
const BLOCK_RE = /\b(?:Turn context|Conversation info|Reply target of current user message|OpenClaw heartbeat poll|unknown identity token)\b|^\s*DELIVERY:/im;

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
function leaksIn(line) {
  const raw = String(line || '');
  const text = scannable(raw);
  const out = [];
  const frame = FRAME_RE.exec(raw); // a frame marker is ours wherever it sits
  if (frame) out.push({ kind: 'frame', at: redact(frame[0].slice(0, 40)) });
  const internal = INTERNAL_RE.exec(text);
  if (internal) out.push({ kind: 'internal', at: internal[1] });
  const block = BLOCK_RE.exec(text);
  if (block) out.push({ kind: 'block', at: block[0].trim().slice(0, 40) });
  const instant = INSTANT_RE.exec(text);
  if (instant) out.push({ kind: 'instant', at: instant[0] });
  const sentinel = SENTINEL_RE.exec(text);
  if (sentinel) out.push({ kind: 'sentinel', at: sentinel[0] });
  // Only when nothing above matched: the wide tier exists to name what the
  // closed list is missing, and a line already dropped has nothing to add.
  if (!out.length) {
    const id = IDENTIFIER_RE.exec(text);
    if (id) out.push({ kind: 'identifier', at: id[1] });
  }
  return out;
}

// The kinds that leave their line standing: `identifier` because it is the
// unmeasured tier and only reports, `sentinel` because it is stripped in place.
// Everything else condemns the paragraph it sits in, which is the destructive
// half — so only the closed, unmistakable markers are allowed in here.
const KEEPS_LINE = new Set(['identifier', 'sentinel']);
function drops(leaks) { return leaks.some((l) => !KEEPS_LINE.has(l.kind)); }

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
function gateReply(text) {
  const raw = String(text == null ? '' : text);
  if (raw.trim() === SENTINEL) return { action: 'pass', text: raw, leaks: [], reported: [] };
  const lines = raw.split('\n');
  const found = lines.map(leaksIn);
  const reported = [];
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    for (const l of found[i]) reported.push({ ...l, line: i });
    if (drops(found[i])) last = Math.max(last, paragraphEnd(lines, i));
  }
  // What changed the message. `identifier` never does — it is the tier that
  // exists to be read on the dashboard, not to act.
  const leaks = reported.filter((l) => l.kind !== 'identifier');
  if (!leaks.length) return { action: 'pass', text: raw, leaks, reported };
  // Whatever survives the cut still goes out without the stray sentinel in it.
  const kept = lines.slice(last + 1).join('\n').replace(SENTINEL_STRIP_RE, ' ').trim();
  if (!kept) return { action: 'cancel', text: '', leaks, reported };
  return { action: 'trim', text: kept, leaks, reported };
}

module.exports = {
  leaksIn, gateReply, drops, scannable, redact, paragraphEnd,
  FRAME_RE, INTERNAL_RE, BLOCK_RE, INSTANT_RE, SENTINEL_RE, IDENTIFIER_RE,
  INTERNAL_NAMES, SENTINEL, KEEPS_LINE,
};
