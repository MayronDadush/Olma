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
const format = require('./message-format');
const { phoneShape } = require('./phone-timezone');

// Titles are the user's own words; bound them to one message-safe line — and
// take the emphasis out of them. A title carrying an asterisk arrives with
// WhatsApp rendering THEIR characters as bold, which nobody chose (the owner
// looked at it on a phone and asked for it cleaned, 2026-09-09). It happens
// here rather than at `addTask` because the words in the table stay the words
// they said: this is a rendering decision, on the one path where no model
// retypes the text. See message-format.stripUserMarkup for how narrow the
// rule is and what it deliberately leaves alone.
function cleanTitle(title) {
  return format.stripUserMarkup(String(title || '').replace(/\s+/g, ' ').trim()).slice(0, 200);
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

// The language a rung is said in. There is no model on this pipe to read
// "reply in their language" off USER.md, so the recipient's `users.locale` is
// the whole decision, made here: `en` (any variant) picks the `_en` template,
// everything else — Hebrew, nothing on file, a language we have no sentences
// for — says the Hebrew default. The same two-way rule the personal dashboard
// applies. Read at DELIVERY, off the joined users row, never stamped on the
// payload at enqueue: a person who switches language mid-ladder should hear
// the next rung in the new one.
function localizedKey(key, locale) {
  return String(locale || '').trim().toLowerCase().startsWith('en') ? `${key}_en` : key;
}

// `items` is set by the worker at DELIVERY time and is never stored on the
// row: batching is a property of what happened to arrive together, not of what
// was enqueued. Enqueuing a batch would have given several reminders one
// idempotency key, and then cancelling one of them would let the sweep produce
// the whole batch again — which is the fault this system already had once, at
// half past one in the morning.
//
// `channelType` is the recipient's platform and is read at DELIVERY for exactly
// the reason the locale is: a bulleted list is a native WhatsApp list ("- ")
// and a stray hyphen anywhere else, so the bullet CHARACTER is what a channel
// we do not know gets (domain/message-format.js). Absent, it is plain \u2014 never
// WhatsApp on the assumption that everyone is on WhatsApp today.
function renderReminderText(payload, overrides, locale, channelType) {
  const p = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
  const key = reminderTemplateKey(p);
  const items = (Array.isArray(p.items) ? p.items : []).map(cleanTitle).filter(Boolean);
  if (items.length > 1) {
    return templates.render(localizedKey(LIST_TEMPLATE[key], locale),
      { items: format.formatterFor(channelType).bullets(items) }, overrides);
  }
  const title = cleanTitle(p.title) || items[0];
  if (!title) return null;
  return templates.render(localizedKey(key, locale), { title }, overrides);
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

// …and a LID is not a phone number, so it is not a tag either. WhatsApp
// addresses a member by number OR by LID, and the roster we read arrives as a
// comma-separated list of digits with no JID on it (`domain/groups.js`, the
// `group_members` envelope), so `chat_group_members.phone` holds LIDs for some
// members with no marker to sort them by. Padel Gang was told
// "עוד מחכה ל: @+259201444126724 @+6266525098172 @+69320805752936" in front of
// four people (`incidents.md`, "The room asked three numbers that were nobody").
//
// LENGTH is the discriminator, and it is a MEASUREMENT, not a guess. The
// gateway's own LID map on the box, 2026-09-22: 2,673 LID keys at 12 (7),
// 13 (88), 14 (870) and 15 (1,708) digits, against 5,346 real numbers that top
// out at 13 (10:4, 11:128, 12:5,206, 13:8). Nothing 14 digits or longer has
// ever been a number here, which makes the cut safe in the only direction that
// matters — a real member is never silenced. The floor is the one
// `channels/sessions.js` already uses for a number it reads out of the
// gateway's map.
//
// **And since 2026-09-24 the SHAPE catches about half of what the length alone
// could not** (`phone-timezone.phoneShape`). The length cut above is blind to
// the 12-13 digit LIDs by construction; asking the dialling code as well —
// is this a country we know, at a length that country issues — answers
// 'not_phone' for **44 of those 95**, measured on the same corpus the day the
// check was written. It is only ever consulted as a REFUSAL here: 'unknown'
// (a dialling code the table has never heard of) keeps exactly today's
// behaviour, because a member from an unlisted country must not lose their tag
// to make a LID lose one. Verified in that direction too — all 34 real
// numbers on the box answer 'phone'.
//
// **What this still does NOT catch: the remaining 51** — 45 whose prefix is
// unknown and 6 that pass as a real country at a real length. The airtight
// answer is upstream — a roster that carries JIDs, or the gateway's LID map
// consulted — and neither is this change. So this is a filter, never a
// guarantee, and a caller must not read a rendered tag list as "everybody who
// is missing".
const TAGGABLE_MIN_DIGITS = 7;
const TAGGABLE_MAX_DIGITS = 13;

function isTaggableNumber(value) {
  const digits = String(value == null ? '' : value).trim().replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return false;
  if (digits.length < TAGGABLE_MIN_DIGITS || digits.length > TAGGABLE_MAX_DIGITS) return false;
  return phoneShape(digits) !== 'not_phone';
}

// One tag, for the places that hand a person to the MODEL rather than render a
// sentence (the group turn's own context block, the group tools' results).
// Same spelling in one place: a second one that dropped the `+` would look
// identical in a log and ping nobody. `null` for something that is not a
// number is the honest third state the rest of the room code already uses —
// the model is told it may address somebody only by a tag the block carries,
// so no tag means it cannot name them, which is right.
function mentionToken(phone) {
  const digits = String(phone == null ? '' : phone).trim();
  if (!isTaggableNumber(digits)) return null;
  return `@${digits.replace(/^\+?/, '+')}`;
}

function mentionTokens(phones) {
  // Filtered BEFORE the cap, so "ועוד N" counts people and never LIDs.
  const list = (phones || []).map((p) => String(p || '').trim()).filter(isTaggableNumber);
  const shown = list.slice(0, MAX_TAGS).map((phone) => mentionToken(phone));
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
// A slot is free text somebody proposed ("יום חמישי 17:00 בקפה ליד המשרד"), so
// it reaches a whole room with their punctuation in it. Same cleaning as a
// reminder title, and for the stronger reason: in a group the person whose
// asterisks would be rendered is not even the person reading them.
function slotText(slot) {
  return format.stripUserMarkup(slot);
}

function renderGroupCoordination(line, overrides) {
  if (line.kind === 'started') {
    // A COUNT, never people. Who has not written is already the gate notice's
    // sentence, and saying it twice in two voices is the one thing this family
    // of lines is careful not to do — so this line only says that such people
    // exist, and only when they do (the same rule as a base line never said to
    // nobody).
    return templates.render('group_coord_started', {
      title: slotText(line.title), asked: String(line.asked),
      outside_note: line.outside ? OUTSIDE_NOTE : '',
    }, overrides).trim();
  }
  if (line.kind === 'base' || line.kind === 'moved') {
    const lead = templates.render('group_coord_base', {
      slot: slotText(line.slot), yes: String(line.yes), missing: mentionTokens(line.missing || []),
    }, overrides);
    if (line.kind === 'base') return lead;
    // The new direction is the base line itself, carried whole as one var — so
    // a rewording of "יש כיוון" is said the same way in both places, and the
    // owner has one sentence to edit rather than two that can drift.
    return templates.render('group_coord_moved', { was: slotText(line.was), lead }, overrides).trim();
  }
  // Somebody else's words, over their TAG — never their name, the same rule
  // every room line obeys. The text was bounded and stripped where it was saved
  // (group-meetings.cleanRelay); `slotText` here is the same last pass every
  // verbatim room string gets, and it is what the slots go through too.
  //
  // Which of the three it is, is a fact and not a choice: the clause is said
  // only about a change that person actually made to this table, so a relay
  // from somebody who touched nothing carries no clause at all rather than a
  // sentence nobody can check.
  if (line.kind === 'relay') {
    const vars = { from: mentionToken(line.from) || '', what: slotText(line.what) };
    if (line.added && line.was) {
      return templates.render('group_coord_relay_swapped',
        { ...vars, was: slotText(line.was), added: slotText(line.added) }, overrides).trim();
    }
    if (line.added) {
      return templates.render('group_coord_relay_added',
        { ...vars, added: slotText(line.added) }, overrides).trim();
    }
    return templates.render('group_coord_relay', vars, overrides).trim();
  }
  if (line.kind === 'chase') {
    return templates.render('group_coord_chase', { missing: mentionTokens(line.missing || []) }, overrides);
  }
  if (line.kind === 'table') {
    // `lead` is a whole phrase, so an owner's rewording can move or drop it,
    // and a table nobody has said yes to yet draws nothing rather than an
    // empty label — the same shape as `who` on the done line below.
    return templates.render('group_coord_table', {
      // A whole phrase, not a number: Hebrew does not say "1 מועדים", and
      // agreement is the renderer's job rather than the template's.
      count: line.count === 1 ? ONE_OPTION : `*${line.count}* ${MANY_OPTIONS}`,
      lead: line.lead ? `${TABLE_LEAD} *${slotText(line.lead)}*.` : '',
    }, overrides).trim();
  }
  if (line.kind === 'dayof') return templates.render('group_coord_dayof', { slot: slotText(line.slot) }, overrides);
  if (line.kind === 'soon') return templates.render('group_coord_soon', { slot: slotText(line.slot) }, overrides);
  if (line.kind === 'calendar') return templates.render('group_coord_calendar', {}, overrides);
  // `who` is a whole phrase, so an owner's rewording can move or drop it:
  // "כולם בפנים", or the tags of those who said yes. Null draws nothing.
  const who = !line.who ? '' : line.who.all ? WHO_ALL : (line.who.phones || []).length ? `${WHO_IN} ${mentionTokens(line.who.phones)}` : '';
  return templates.render('group_coord_done', {
    slot: slotText(line.slot), who, place_ask: line.placeAsk ? PLACE_ASK : '',
  }, overrides).trim();
}
const TABLE_LEAD = 'הכי מתקדם:';
const ONE_OPTION = 'מועד אחד';
const MANY_OPTIONS = 'מועדים';
const PLACE_ASK = 'איפה נפגשים? תכתבו לי ואני אוסיף ליומן 📍';
const OUTSIDE_NOTE = 'מי שעוד לא כתב לי בפרטי לא נספר פה — ״היי״ בפרטי וזה מסתדר ☺️';
const WHO_ALL = 'כולם בפנים';
const WHO_IN = 'בפנים:';

// The single decision point the deliverer consults: a non-null return means
// "send this text on the raw pipe, no agent turn". Deliberately narrow —
// checkins and digests are conversational BY DESIGN (the whole 2026-08-20
// checkin redesign was making them personal enough to answer), and a payload
// carrying its own `instruction` is asking for a model turn by definition.
//
// `row.locale` is the recipient's, joined onto the outbox row by the worker's
// candidate query (outbox/worker.js) — the row that reaches the deliverer is
// that joined row, so the language rides along with the timezone.
//
// `channelType` comes from the deliverer's own `primaryChannel` lookup rather
// than the row, for the same reason again: it is a fact about the person at the
// moment of sending.
function rawPipeTextFor(row, overrides, channelType) {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
  // A reply OUR pipe lost, re-sent as itself (jobs/unanswered.js, case (b)).
  // It is the one text here that is neither a template nor a model's output:
  // the model already wrote it, this conversation's transcript already holds
  // it, and the only thing that failed was the send. So there is nothing to
  // render, nothing to translate — it is already in the language they were
  // being answered in — and nothing for a second model to improve on.
  // Checked before the kind gate because the row rides `checkin` deliberately:
  // that kind is what already earns a repair its way past the quiet drop, and
  // re-deciding the gate was not part of fixing the delivery.
  if (payload.verbatimReply) return String(payload.verbatimReply);
  if (row.kind !== 'reminder') return null;
  if (payload.instruction) return null;
  return renderReminderText(payload, overrides, row.locale, channelType);
}

module.exports = {
  renderReminderText, rawPipeTextFor, reminderTemplateKey, localizedKey,
  renderGroupIntro, renderGroupGateNotice, renderGroupTooLarge, renderGroupOpened,
  renderGroupCoordination, mentionTokens, mentionToken, isTaggableNumber,
  MAX_TAGS, SELF_NUMBER,
};
