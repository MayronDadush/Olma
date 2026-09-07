'use strict';
// Deterministic text for proactive messages that need no model turn.
//
// A reminder is the one proactive kind whose content the person chose
// themselves — their words, their time. Composing it through a full agent turn
// meant every reminder cost a cold-cache model call, and worse, DEPENDED on
// one: during the 2026-08-23 credit outage a daily medication reminder failed
// for 13 hours because the model behind it had no credit. A reminder must not
// be downstream of an LLM billing account.
//
// Tested live 2026-08-24 before building this: `openclaw message send` on the
// raw pipe delivered to a real user with zero model involvement while the
// Anthropic account was still dry. The one real cost is that a raw send never
// enters the person's agent session history (it lands under the DEFAULT
// agent's log — the v1 "--to runs on the main agent" lesson, re-verified), so
// a bare reply like "סיימתי" would reach an agent that never saw the
// reminder. turn_start closes that gap from the DB side: it returns the
// reminders delivered in the last day, because brokerd knows exactly what was
// sent without needing the session to remember it.
const templates = require('./message-templates');

// Titles are the user's own words; bound them to one message-safe line.
function cleanTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Rungs 2 and 3 of the escalation ladder ride this same raw pipe, for the same
// reason — a follow-up about medication must not be downstream of a billing
// account either. What they must NOT be is the same sentence twice: a repeat
// identical to the first message is the drum this system keeps removing. Each
// says what it is and carries its own way out.
//
// Written without grammatical gender on purpose. Deterministic text cannot
// know who it is addressing, and in Hebrew a guess is wrong for half the
// people who read it — so every verb here is an infinitive or first-person.
//
// The sentences themselves live in domain/message-templates.js (three
// templates, one per rung), where the owner can reword them from the admin
// page; `overrides` is that page's stored object, loaded by the caller.
// Which of the three rung templates a payload renders with. Exported because
// the worker groups by it: reminders that come due together go out as ONE
// message, and a message may only make the promise every line in it makes —
// mixing a first reminder with a "this is the last one I will send" would say
// something untrue about half its own lines.
function reminderTemplateKey(payload) {
  const p = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
  const attempt = Number(p.attempt) || 1;
  return attempt <= 1 ? 'reminder' : (p.finalAttempt ? 'reminder_last' : 'reminder_followup');
}

// The list form of each rung. One key per rung, for the reason above.
const LIST_TEMPLATE = {
  reminder: 'reminder_list',
  reminder_followup: 'reminder_list_followup',
  reminder_last: 'reminder_list_last',
};

// `items` is set by the worker at DELIVERY time and is never stored on the
// row: batching is a property of what happened to arrive together, not of what
// was enqueued. Enqueuing a batch would have given several reminders one
// idempotency key, and then cancelling one of them would let the sweep produce
// the whole batch again — which is the fault this system already had once, at
// half past one in the morning.
function renderReminderText(payload, overrides) {
  const p = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
  const key = reminderTemplateKey(p);
  const items = (Array.isArray(p.items) ? p.items : []).map(cleanTitle).filter(Boolean);
  if (items.length > 1) {
    return templates.render(LIST_TEMPLATE[key], { items: items.map((t) => `\u2022 ${t}`).join('\n') }, overrides);
  }
  const title = cleanTitle(p.title) || items[0];
  if (!title) return null;
  return templates.render(key, { title }, overrides);
}

// ---- group mode -------------------------------------------------------------
// Every word Olma says in a locked group is written here rather than by a
// model, for the same reason reminders are: the group agent is MUTED at the
// gateway while the group is locked (a sendPolicy deny rule), so there is no
// model output to use even if we wanted one. These go out on the raw pipe.
//
// The no-grammatical-gender rule above still holds for anything aimed at one
// person. Group text may use the Hebrew plural, because a group genuinely is
// plural — what it must never do is guess the gender of a single member.
//
// Wording owned by the owner (2026-09-05); these are his sentences, not a
// paraphrase of them. The defaults are in domain/message-templates.js and he
// rewords them from the admin page (`overrides`) — never edit them in code
// on his behalf.

// A tag only PINGS when the token is a phone number: the gateway attaches
// native mention metadata for `@+<digits>` tokens that match a current
// participant, and WhatsApp then renders each viewer's own saved name for that
// number. Writing "@דני" would look right in the source and reach the group as
// dead text nobody is notified by.
const MAX_TAGS = 8;

function mentionTokens(phones) {
  const list = (phones || []).map((p) => String(p || '').trim()).filter(Boolean);
  const shown = list.slice(0, MAX_TAGS).map((phone) => `@${phone.replace(/^\+?/, '+')}`);
  const rest = list.length - shown.length;
  // A 25-person group with twenty missing would otherwise produce a wall of
  // tags. Judgement call, not an owner decision — say the rest as a number.
  return rest > 0 ? `${shown.join(' ')} ועוד ${rest}` : shown.join(' ');
}

// Olma's own WhatsApp number, so the intro can tag HER — a tag people can
// actually press, rather than a bare "@" that teaches nothing. Overridable by
// env for a second deployment; the literal is the live account (the same
// number `adapters/http/public-pages.js` puts on the public page).
//
// THE HAZARD THIS OPENS, and the guard that closes it: a message tagging her
// is exactly what wakes her, and her own outbound message tags her. The
// gateway drops the echo of a recent outbound of its own
// (`shouldSkipRecentOutboundEcho`, keyed on the message id), but that
// tracking has a lifetime, and a late echo would arrive as a group message
// that mentions her — through the mention gate, into a turn, whose reply tags
// her again. **Her own number must therefore never appear in
// `groupAllowFrom`**: the sender allowlist is the one check that runs before
// mention gating, and it is what makes the loop unreachable rather than
// merely unlikely. `groupAllowFrom` carries the phone numbers of Olma's
// USERS, and she is not one of them.
const SELF_NUMBER = process.env.OLMA_WA_NUMBER || '972559347282';

// The first thing said in a group, on the first message there from anyone.
function renderGroupIntro(overrides) {
  return templates.render('group_intro', { me: mentionTokens([SELF_NUMBER]) }, overrides);
}

// kind comes from groups.decideNotice: 'explain' the first time, 'nudge' after.
function renderGroupGateNotice({ kind, missing }, overrides) {
  const key = kind === 'nudge' ? 'group_gate_nudge' : 'group_gate_explain';
  return templates.render(key, { missing: mentionTokens(missing) }, overrides);
}

// Said once, when the last person finally writes and the group opens. Held to
// the group's quiet hours like any other proactive message — she is starting
// this conversation, not answering one. Approved as written by the owner,
// 2026-09-06.
function renderGroupOpened(overrides) {
  return templates.render('group_opened', {}, overrides);
}

// The cap is a flag (`group_max_members`), so the number is passed in rather
// than written into the sentence — a raised cap must not leave her quoting 25.
function renderGroupTooLarge(maxMembers, overrides) {
  return templates.render('group_too_large', { max: maxMembers }, overrides);
}

// The three lines a room hears about its own coordination (domain/group-voice
// decides WHICH, and the sweep decides whether the hour allows it). Everything
// tagged goes through mentionTokens for the same reason the gate notice does:
// only a phone-number token pings anybody.
function renderGroupCoordination(line, overrides) {
  if (line.kind === 'base') {
    return templates.render('group_coord_base', {
      slot: line.slot, yes: String(line.yes), missing: mentionTokens(line.missing || []),
    }, overrides);
  }
  if (line.kind === 'chase') {
    return templates.render('group_coord_chase', { missing: mentionTokens(line.missing || []) }, overrides);
  }
  if (line.kind === 'dayof') return templates.render('group_coord_dayof', { slot: line.slot }, overrides);
  if (line.kind === 'soon') return templates.render('group_coord_soon', { slot: line.slot }, overrides);
  return templates.render('group_coord_done', { slot: line.slot }, overrides);
}

// The single decision point the deliverer consults: a non-null return means
// "send this text on the raw pipe, no agent turn". Deliberately narrow —
// checkins and digests are conversational BY DESIGN (the whole 2026-08-20
// checkin redesign was making them personal enough to answer), and a payload
// carrying its own `instruction` is asking for a model turn by definition.
function rawPipeTextFor(row, overrides) {
  if (row.kind !== 'reminder') return null;
  const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
  if (p.instruction) return null;
  return renderReminderText(p, overrides);
}

module.exports = {
  renderReminderText, rawPipeTextFor, reminderTemplateKey,
  renderGroupIntro, renderGroupGateNotice, renderGroupTooLarge, renderGroupOpened,
  renderGroupCoordination, mentionTokens, MAX_TAGS, SELF_NUMBER,
};
