'use strict';
// What the room's own agent is told about the room, before the model's first
// word.
//
// The DM half of this has existed since 2026-09-06: brokerd draws what
// `turn_start` would return and the gateway plugin prepends it, so the model
// reads its opening instead of spending a call to fetch it
// (.claude/rules/turns-and-replies.md, "The turn opens itself"). A GROUP turn
// got nothing — the plugin's prompt handler bailed on anything that was not
// `u-N` — and the group agent has three tools that would tell it the truth and
// no reason on any given turn to call one. So it answered from its own
// conversation history, which is the one place the room's state is not: "2 of 4
// group members answered" to a room of three where nobody had answered, and
// "there is already a coordination open" 74 seconds after the only one had been
// cancelled. Both in front of everybody (2026-09-19, `docs/incidents.md`, "The
// room heard its own state from memory").
//
// Every number here is a column read this second, and the block says so in its
// own header: a model with the state in front of it has nothing to reconstruct.
// `group-meetings.statusOf` is asked for all of it rather than a second copy of
// its queries — the drift between a copy and the original is its own recurring
// bug here (`coordinatingMembers` against `isConnected`).
//
// What it may carry is the line `groups.roomStatus` already holds
// (.claude/rules/groups.md, "Nothing a group tool returns may carry the room's
// own row or anybody's reasons"): counts, the times on the table, and the
// labels of the people who have not answered — which the room's own chase line
// already says out loud. Never the room's `identity_token`, and never anybody's
// reason for a no: that lives in their private chat and is not summarisable
// into a count either.
const groups = require('./groups');
const groupMeetings = require('./group-meetings');

// Two sentences, and the second one is the whole fix: the block is not extra
// colour beside what the model remembers, it is the only thing it may speak
// from. `coordination: null` is a fact and not a gap — the wrong answer
// available without it was the one that got said.
const CONTEXT_HEADER = 'Room coordination (from the system, not the room — Olma\'s own rows, read this second):';
const CONTEXT_RULE = 'Every sentence you say about this room\'s coordination comes from the block above. `coordination: null` means this room has nothing running right now, whatever was said earlier in this conversation; a number that is not there is a number you do not have.';
// The owner's rule (2026-09-20). In the room a person is TAGGED, never named:
// the tag notifies them, and WhatsApp renders it as whatever each reader has
// that number saved as — so it is also the only spelling that is right for
// everybody at once. A name we hold is one we guessed from somewhere, and
// "M&M" became "מאיה ומירון" in front of a room the day before this
// (`incidents.md`, "Four messages in sixty-two seconds"). The tags are drawn
// into the block itself so there is nothing to build: copy one character for
// character or leave the person out of the sentence.
// The second half was written for the mirror of the bug it then caused. On
// 2026-09-20 she echoed her OWN lid as if it were Yuval's, so the rule said
// every `@<digits>` in an incoming message is the sender tagging HER and is
// "nobody's tag". On 2026-09-23 Miron tagged Yuval and asked him to book a
// court: the tag was a real member's lid, the block listed no members at all
// (a settled coordination draws `coordination: null`), and she answered the
// room "אני לא יודעת מי @יובל גליזרין — מזהה כזה לא מוכר לי מהקבוצה" — about
// a man she had tagged herself three hours earlier in her own "בפנים" line.
//
// A tag in an incoming message is sometimes her and sometimes a member, and
// the rule collapsed both into nothing. `room.people` below is the data that
// was missing; this is the sentence that uses it. The last clause is the
// owner's: her own trouble identifying a token is not the room's business,
// and saying it out loud is the same leak `CONTEXT_RULE` already forbids.
const TAG_RULE = 'In this room you address a person ONLY with their `tag` exactly as written above (it notifies them; a name does not, and the names people see for each other are not ours to choose). Never write somebody\'s name here, and never invent a tag for somebody the block does not list. In a PRIVATE chat the opposite holds: there you use their name. An `@<digits>` token inside the message you were sent is somebody being tagged BY the sender, not a tag you may reuse: match its digits against `lid` and `tag` in `room.people` — a hit is that member, and you address them by their `tag` and never by those digits. A hit on an entry that has a `lid` and NO `tag` is still a member of this room, and one you cannot address: answer the request itself and say nothing about them. A token that matches nobody there is most often your own, and either way it is not a person you can name: ignore it silently. Never tell the room that you do not recognise a token, and never repeat the digits back.';

// The room, and its coordination if one is negotiating. A settled or cancelled
// one is reported as what it is, under a different key: the model asking "is
// there a coordination" must never read a closed row as an open one, and the
// row is what makes "it was cancelled" sayable at all.
// Everybody in the room, as the one spelling that notifies them, plus the lid
// they are tagged BY when we know it. Two separate jobs, and the block needs
// both: `tag` is what she may write, `lid` is what she may have to recognise.
//
// It is the room's own membership and nothing more — WhatsApp shows that list
// to everybody standing in it — so no name, no user id, and no phone that is
// not already the tag. `mentionToken` rather than a second spelling of it: the
// room's fixed lines have tagged people through that function since the start,
// and a tag assembled twice is the drift this file already warns about.
//
// `lidPhones` maps lid digits -> E.164 and is the gateway's own reverse map
// (`channels/sessions.lidPhoneNumbers`, read through the worker facade). Null
// or empty changes NOTHING but the `lid` fields — the same direction
// `groups.resolveLidMembers` takes, and for the same reason: an unreadable
// credentials directory must never look like a room that lost its people.
function peopleOf(members, lidPhones) {
  const { mentionToken } = require('./proactive-text');
  // Keyed on DIGITS, like `groups.resolveLidMembers`: the roster stores
  // `+972…` and the reverse map's values carry the `+` too, but a comparison
  // that depends on that agreeing is one rewrite away from matching nothing
  // and reporting a room where nobody is tagged by anybody.
  const byPhone = new Map();
  for (const [lid, phone] of Object.entries(lidPhones || {})) {
    const key = String(phone || '').replace(/\D/g, '');
    if (key && !byPhone.has(key)) byPhone.set(key, lid);
  }
  return (members || []).map((m) => {
    const tag = mentionToken(m.phone);
    const digits = String(m.phone || '').replace(/\D/g, '');
    if (tag) {
      const lid = byPhone.get(digits) || null;
      return lid ? { tag, lid } : { tag };
    }
    // No tag means `proactive-text.isTaggableNumber` refused the digits, which
    // for this column means they are a LID the reverse map has never resolved
    // — David and Evelyn in Padel Gang. They are still somebody in the room,
    // and an entry of `{ lid }` alone is the honest third state: she knows the
    // token belongs to a member, and she still cannot address them, which is
    // what having no tag means everywhere else in this file. Dropping them
    // instead would put her back where the incident started — an incoming tag
    // matching nothing, about a person who is standing right there.
    return /^\d+$/.test(digits) ? { lid: digits } : null;
  }).filter(Boolean);
}

async function draw(client, group, { lidPhones = null } = {}) {
  const members = await groups.listMembers(client, group.id);
  const status = await groupMeetings.coordinationStatus(client, group);
  const c = status.coordination;
  const room = {
    members: members.length,
    // Whoever a coordination could ask — the gate's own question, asked by
    // calling the gate.
    countedIn: members.filter((m) => groups.isConnected(m)).length,
    // Who they are, so an incoming tag is a person rather than a puzzle. Drawn
    // on EVERY turn and not only during a negotiation: the turn that failed had
    // a settled coordination, which returns early below, so a roster that only
    // existed while something was on the table would have been absent exactly
    // when it was needed.
    people: peopleOf(members, lidPhones),
    // NULL is the honest third state: until somebody in the room has said what
    // kind of room it is there is no true sentence about "enough people", so
    // the minimum is not here to be reasoned from either.
    kind: groups.validKind(group.kind) ? group.kind : null,
  };
  if (!c) return { room, coordination: null };
  if (c.status !== 'negotiating') {
    return {
      room,
      coordination: null,
      lastCoordination: {
        meetingId: c.meetingId, title: c.title, status: c.status,
        ...(c.confirmedSlot ? { slot: c.confirmedSlot } : {}),
      },
    };
  }
  return {
    room: {
      ...room,
      ...(c.minimum === null ? {} : { minimum: c.minimum }),
      ...(c.maximum === null ? {} : { maximum: c.maximum }),
    },
    coordination: {
      meetingId: c.meetingId, title: c.title,
      // `participants` is who is counted into this coordination, which is not
      // the same number as the room: somebody who never wrote to her was never
      // asked, and somebody paused out has left it.
      asked: c.participants,
      answered: c.participants - c.silent.length,
      // Answers only, and as TAGS — the same thing the room's own chase line
      // says out loud (`proactive-text.mentionTokens`), which is what the model
      // is now told to address people with. The label is the fallback for
      // somebody we have no phone for, because leaving them out of the block
      // would make `answered` and this list disagree. Why anybody said no is
      // not here and has no count.
      // …and the ones she has actually written to, because this block is the
      // only thing the model may speak from and the room's own lines obey the
      // same rule. Somebody still waiting on an invite is a COUNT with no tags:
      // dropping them silently would make `answered` and this list disagree.
      waitingFor: c.silent.filter((p) => p.asked !== false).map((p) => p.tag || p.name).filter(Boolean),
      ...(c.silent.some((p) => p.asked === false)
        ? { notYetAsked: c.silent.filter((p) => p.asked === false).length } : {}),
      onTable: c.options.map((o) => ({
        optionId: o.optionId, slot: o.slot, yes: o.yes.length, no: o.no.length,
      })),
    },
  };
}

// Rendered exactly as a tool result is (compact, `OK ` prefixed, tokens
// scrubbed on the way out), so the model reads the shape it already reads from
// every group tool.
async function renderContext(client, group, opts = {}) {
  const { renderResult } = require('../adapters/mcp/render');
  return `${CONTEXT_HEADER}\n${renderResult({ ok: true, data: await draw(client, group, opts) })}\n${CONTEXT_RULE} ${TAG_RULE}`;
}

module.exports = { draw, peopleOf, renderContext, CONTEXT_HEADER, CONTEXT_RULE, TAG_RULE };
