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
const meetingTime = require('./meeting-time');

// Two sentences, and the second one is the whole fix: the block is not extra
// colour beside what the model remembers, it is the only thing it may speak
// from. `coordination: null` is a fact and not a gap — the wrong answer
// available without it was the one that got said.
const CONTEXT_HEADER = 'Room coordination (from the system, not the room — Olma\'s own rows, read this second):';
const CONTEXT_RULE = 'Every sentence you say about this room\'s coordination comes from the block above. `coordination: null` means this room has nothing running right now, whatever was said earlier in this conversation; a number that is not there is a number you do not have. `lastCoordination.roomHeard: true` means the room has already been told that result: say it again only when somebody asks about it, never as the tail of a reply about something else. `lastCoordination.timeOpen: true` means it settled with no exact hour: a member naming one on that same day is answered with add_group_coordination_option, which sets it. `yesBy` and `noBy` are who said yes and no to each time: when somebody asks who can, who cannot or who is in, answer from them by person (each by `tag`), and `waitingFor` is who has not answered; never read them out unasked, and never give a reason for anybody\'s answer.';
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
//
// And the owner loosened the first half on 2026-09-23, on the day she called
// Bar "את" and "היא" in front of the room: "אם היא יודעת את השם שלהם ואיזה לשון
// לדבר אליהם … היא כן יכולה לשלוף רק את המידע הזה". So an entry may now carry
// `name` and `address`, and those two and nothing else cross from a person's
// own record into the room. The tag is still how somebody is REACHED — it is
// still the only thing that notifies — and the name is what a sentence may
// call them. The default for an entry with no `address` is the private
// doctrine's own (`agents-template.md`: masculine, never slashed), because a
// room with no rule at all is exactly where she guessed from "בר" and got it
// wrong.
const TAG_RULE = 'To reach a person in this room, use their `tag` exactly as written above (it notifies them; a name does not), and never invent a tag for somebody the block does not list. An entry with a `name` may also be called by that name in a sentence, and by that spelling only: never the name WhatsApp shows for them, never one you worked out, and nobody by name whose entry has none. `address` is how to speak to or about them in Hebrew — `feminine` or `masculine`, set by them — and it holds for every verb and pronoun about that person; an entry without it gets masculine forms, never a guess from the name and never a slashed form. The person who sent this message is the entry whose `tag` or `lid` digits are the sender\'s. In a PRIVATE chat you use their name as always. An `@<digits>` token inside the message you were sent is somebody being tagged BY the sender, not a tag you may reuse: match its digits against `lid` and `tag` in `room.people` — a hit is that member, and you address them by their `tag` and never by those digits. A hit on an entry that has a `lid` and NO `tag` is still a member of this room, and one you cannot address: answer the request itself and say nothing about them. A token that matches nobody there is most often your own, and either way it is not a person you can name: ignore it silently. Never tell the room that you do not recognise a token, and never repeat the digits back.';

// The room, and its coordination if one is negotiating. A settled or cancelled
// one is reported as what it is, under a different key: the model asking "is
// there a coordination" must never read a closed row as an open one, and the
// row is what makes "it was cancelled" sayable at all.
// Everybody in the room, as the one spelling that notifies them, plus the lid
// they are tagged BY when we know it. Two separate jobs, and the block needs
// both: `tag` is what she may write, `lid` is what she may have to recognise.
//
// It is the room's own membership — WhatsApp shows that list to everybody
// standing in it — plus the two things the owner let through from a person's
// own record (`selfOf`: a confirmed first name and how to address them), so no
// user id, and no phone that is not already the tag. `mentionToken` rather than a second spelling of it: the
// room's fixed lines have tagged people through that function since the start,
// and a tag assembled twice is the drift this file already warns about.
//
// `lidPhones` maps lid digits -> E.164 and is the gateway's own reverse map
// (`channels/sessions.lidPhoneNumbers`, read through the worker facade). Null
// or empty changes NOTHING but the `lid` fields — the same direction
// `groups.resolveLidMembers` takes, and for the same reason: an unreadable
// credentials directory must never look like a room that lost its people.
// How a person is addressed, in the only two places they ever said it: the
// profile page's own answer (`users.gender`, migration 068), and, failing that,
// the `gender_forms` preference the private agent stores when they tell it in
// words — free text, "נשי" on the box today. Since 2026-09-23 the two are kept
// in step on every write (`gender-forms.js`), so the fallback matters only for
// a row written before that. The reading is that module's, not a copy.
const { genderFromWords } = require('./gender-forms');
function addressOf(m) {
  const g = m.gender === 'female' || m.gender === 'male' ? m.gender : genderFromWords(m.gender_forms);
  return g === 'female' ? 'feminine' : (g === 'male' ? 'masculine' : null);
}

// What a person's own record may give the room: a first name THEY confirmed,
// and the form of address they set. A name nobody confirmed is one we took
// from WhatsApp or guessed, which is how "M&M" became "מאיה ומירון" — the
// reason names were kept out of the room in the first place.
function selfOf(m) {
  const name = m.name_confirmed && m.first_name ? String(m.first_name).trim() : '';
  const address = addressOf(m);
  return { ...(name ? { name } : {}), ...(address ? { address } : {}) };
}

// How the room's coordination reaches each member PRIVATELY, drawn so the model
// can say it and never has to guess it (owner, 2026-10-05). In Padel Gang the
// room asked her "תשאלי את @<new member>" and she answered "בטח 🙌 ברגע שיהיה
// עוד אחד בפנים אני מעדכנת" — no tool can do that, and the one invite on its
// way had gone to his LID and was held for Berlin's Sunday. Twenty-four minutes
// later "תוסיפו את @<him>, הוא יכול בשבת" got "ספור לשבת ✅ זה משלים לנו את
// ה-4" with two yeses on the table and him in nothing (`incidents.md`, "The
// room was told it was four"). The block had his tag and nothing else, so the
// sentence she needed was not there to be said.
//
// One value per entry, and only while there is a coordination a person could
// still be let into — negotiating, or settled and still ahead
// (`admitLateMembers`' own question). Null is NOT a fourth state: it is a
// member she has nothing to say about — out of it, or paused by their own
// request (`rules/groups.md`: never asked, never tagged, never said to have
// left).
//   in               — a participant: asked privately, their answer is theirs.
//   joining          — has written to her, not in it yet; `admitLateMembers`
//                      lets them in and asks them on its next pass.
//   invited          — this room's cold invite REACHED them; they are in once
//                      they answer her.
//   invite_coming    — that invite is queued or held, or `coldInvite` will
//                      write it on its next pass.
//   must_write_first — she cannot write to them first (a LID, no row, the one
//                      cold invite already spent on another room, the flag
//                      closed): they have to write to her.
// The cold-invite predicates are `coldInvite`'s own (flag, registration, a
// pending row with a real number, nothing that reached them or is still
// queued) — read here rather than imported because that function writes.
async function reachOf(client, group, c, members) {
  if (!c || !c.meetingId) return null;
  const ahead = c.status === 'confirmed' && c.confirmedStartAt
    && new Date(c.confirmedStartAt).getTime() > Date.now();
  if (c.status !== 'negotiating' && !ahead) return null;
  const pause = require('./pause');
  const flags = require('./flags');
  const { isRealPhone } = require('./phone-timezone');
  const { rows: parts } = await client.query(
    `SELECT user_id, state FROM meeting_participants WHERE meeting_id = $1`, [c.meetingId]);
  const stateOf = new Map(parts.map((p) => [Number(p.user_id), p.state]));
  const strangers = members.filter((m) => m.user_id && !groups.isConnected(m)).map((m) => Number(m.user_id));
  const { rows: invites } = strangers.length ? await client.query(
    `SELECT user_id, (payload->>'groupId')::bigint AS group_id, sent_at, hold_reason
       FROM outbox WHERE kind = 'room_cold_invite' AND user_id = ANY($1::bigint[])`, [strangers])
    : { rows: [] };
  const coldOpen = c.status === 'negotiating'
    && (await flags.getFlag(client, groupMeetings.COLD_INVITE_FLAG)) === true
    && (await flags.getFlag(client, 'registration_open')) !== false;
  const reach = new Map();
  for (const m of members) {
    const uid = m.user_id ? Number(m.user_id) : null;
    const state = uid ? stateOf.get(uid) : undefined;
    let r;
    if (state === 'opted_out') r = null;
    else if (state) r = 'in';
    else if (uid && pause.pausedByRequest(m)) r = null;
    else if (groups.isConnected(m)) r = pause.keptOutOfRooms(m) ? null : 'joining';
    else {
      const mine = invites.filter((i) => Number(i.user_id) === uid);
      // Reached = sent and not held; still coming = not sent yet, whatever it
      // is held for. A row the gate dropped asked nothing.
      const here = mine.find((i) => Number(i.group_id) === Number(group.id)
        && (i.sent_at === null || i.hold_reason === null));
      const spent = mine.some((i) => i.sent_at === null || i.hold_reason === null);
      if (here) r = here.sent_at ? 'invited' : 'invite_coming';
      else if (!spent && coldOpen && m.user_status === 'pending' && isRealPhone(m.phone)) r = 'invite_coming';
      else r = 'must_write_first';
    }
    reach.set(m.phone, r);
  }
  return reach;
}

// `clocks`: the room spans more than one, so each member who holds a zone on
// their own record says which city's clock they are on (CLOCK_RULE). Off, the
// entries are exactly what they were. `reach`: a Map from phone to
// `reachOf`'s value; absent, or null for a member, adds nothing.
function peopleOf(members, lidPhones, { clocks = false, reach = null } = {}) {
  const { mentionToken } = require('./proactive-text');
  const clockOf = (m) => (clocks && m.timezone && groups.isConnected(m)
    ? { clock: meetingTime.zoneLabel(m.timezone) } : {});
  // Keyed on DIGITS, like `groups.resolveLidMembers`: the roster stores
  // `+972…` and the reverse map's values carry the `+` too, but a comparison
  // that depends on that agreeing is one rewrite away from matching nothing
  // and reporting a room where nobody is tagged by anybody.
  const byPhone = new Map();
  for (const [lid, phone] of Object.entries(lidPhones || {})) {
    const key = String(phone || '').replace(/\D/g, '');
    if (key && !byPhone.has(key)) byPhone.set(key, lid);
  }
  const reachOfM = (m) => {
    const r = reach ? reach.get(m.phone) : null;
    return r ? { reach: r } : {};
  };
  return (members || []).map((m) => {
    const tag = mentionToken(m.phone);
    const digits = String(m.phone || '').replace(/\D/g, '');
    if (tag) {
      const lid = byPhone.get(digits) || null;
      return { ...(lid ? { tag, lid } : { tag }), ...selfOf(m), ...clockOf(m), ...reachOfM(m) };
    }
    // No tag means `proactive-text.isTaggableNumber` refused the digits. Since
    // 2026-09-27 a LID of up to 15 digits IS a tag (the owner saw them arrive
    // as names), so this is now only digits outside that window — rarer, and
    // still the same honest third state. It was David and Evelyn in Padel Gang. They are still somebody in the room,
    // and an entry of `{ lid }` alone is the honest third state: she knows the
    // token belongs to a member, and she still cannot address them, which is
    // what having no tag means everywhere else in this file. Dropping them
    // instead would put her back where the incident started — an incoming tag
    // matching nothing, about a person who is standing right there.
    return /^\d+$/.test(digits) ? { lid: digits, ...selfOf(m), ...clockOf(m), ...reachOfM(m) } : null;
  }).filter(Boolean);
}

// A room whose people live on more than one clock (owner, 2026-09-25, פנתרה).
// Two things the model could not know before: which clock a member is on —
// "at four" from somebody in New York is four in New York, and the tool wants
// the offset of THEIR clock — and how to say a time so every reader gets their
// own hour. The first is each entry's `clock`, the city of a zone they hold on
// their own record (`users.timezone`, the column, nothing inferred); the second
// is `roomTimes`, drawn beside every time on the block. Only in a room that
// spans clocks: anywhere else neither field exists and this rule is not said.
const CLOCK_RULE = 'This room\'s people live on more than one clock (`room.clocks`). Whenever you say a time in the room, say its `roomTimes` exactly as drawn, never the bare `slot` words and never an hour you converted yourself. A time a member names is on THEIR clock (the `clock` of their entry in `room.people`): pass starts_at with that clock\'s offset, unless they named a different city\'s time. People on several clocks are not meeting in one room — never ask where to meet in person; ask how they connect. Asked for hours that suit everyone: answer from `room.commonHours` lines exactly as drawn (an `unconfirmed` clock is shown there, never counted). If they name a place whose clock it lacks, call group_coordination_status with `places` (the city\'s IANA zone; a country with several clocks, ask which city) and answer from its `commonHours`. Never answer that you will ask everyone privately.';

// Said only when some entry carries `reach`, i.e. while there is a coordination
// somebody could still be let into. The last two sentences are the two false
// ones Padel Gang heard on 2026-10-04: a member answering for another, and a
// count nobody had.
const REACH_RULE = 'You never send anybody a private message yourself: what reaches a person privately is the system\'s, and `reach` on their entry in `room.people` says what it is. Asked to ask somebody privately, to add them, or whether they were asked, answer ONLY from it: `in` — they are in this coordination and were asked privately, and their answer is theirs to give; `joining` — they will be asked privately shortly; `invited` — Olma wrote to them privately and they are in once they answer her; `invite_coming` — a private message from Olma is on its way to them; `must_write_first` — Olma cannot write to them first: they need to send her any private message, and then they are in. Somebody tagged who is not in `room.people` has only just joined: say the system reaches whoever it can, and never that they were asked or added. One member saying another can make it is NOT that person\'s yes — say they need to answer for themselves. Never say somebody is in, counted, or completes a number unless this block shows it.';

// The cities of the members she could coordinate with, when there is more than
// one — the room's own zone first. Null is "one clock", which says nothing.
function roomClocks(members, group) {
  const tzs = members.filter((m) => groups.isConnected(m) && m.timezone).map((m) => m.timezone);
  const zones = meetingTime.distinctZones(tzs, new Date(), group.timezone || null);
  return zones.length > 1 ? zones.map((z) => z.label) : null;
}

// A person on the board as the room addresses them: the tag, or the label
// for somebody we hold no phone for — the same fallback `waitingFor` uses.
const labelsOf = (list) => (list || []).map((p) => p.tag || p.name).filter(Boolean);

async function draw(client, group, { lidPhones = null } = {}) {
  const members = await groups.listMembers(client, group.id);
  const status = await groupMeetings.coordinationStatus(client, group);
  const c = status.coordination;
  const clocks = roomClocks(members, group);
  // Hours that suit every CONFIRMED clock in the room, drawn by code
  // (`meeting-time.commonHours`); null when fewer than two are confirmed, and
  // then the model asks the tool with the places the room named.
  const common = clocks ? (await groupMeetings.commonHoursFor(client, group)).commonHours : null;
  const reach = await reachOf(client, group, c, members);
  const room = {
    members: members.length,
    // Whoever a coordination could ask — the gate's own question, asked by
    // calling the gate.
    countedIn: members.filter((m) => groups.isConnected(m)).length,
    ...(clocks ? { clocks } : {}),
    ...(common ? { commonHours: common } : {}),
    // Who they are, so an incoming tag is a person rather than a puzzle. Drawn
    // on EVERY turn and not only during a negotiation: the turn that failed had
    // a settled coordination, which returns early below, so a roster that only
    // existed while something was on the table would have been absent exactly
    // when it was needed.
    people: peopleOf(members, lidPhones, { clocks: Boolean(clocks), reach }),
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
        ...(c.confirmedRoomTimes ? { roomTimes: c.confirmedRoomTimes } : {}),
        // The room's own "סגור" line went out (`meetings.group_done_at`). A
        // result the room has heard is not news, and with nothing marking it
        // she closed seven replies running in פחם הסעות with "the poker is on
        // Friday at noon, on Zoom" — to jokes that had nothing to do with it
        // (2026-09-23). The column, not an inference: nothing else says it.
        ...(c.status === 'confirmed' && c.doneToldAt ? { roomHeard: true } : {}),
        // Who said yes to the time it settled on — "who is in" after the
        // "סגור" line is the same question as before it.
        ...(c.status === 'confirmed' && c.confirmedOption ? { yesBy: labelsOf(c.confirmedOption.yes) } : {}),
        // Settled on a whole day or a part of one (087): the room was asked
        // once whether it wants an exact hour, and an answer sets it.
        ...(c.status === 'confirmed' && (c.confirmedAllDay || c.confirmedDaypart) ? { timeOpen: true } : {}),
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
      // Everybody the room's own lines count (owner, 2026-09-26), so the model
      // says the same "X מתוך N" the room hears. It closes on its own only on a
      // yes from all of them; short of that somebody writes "סגור".
      ...(Number.isFinite(c.roomTotal) ? { inRoom: c.roomTotal } : {}),
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
      // …and WHO said yes and no to each time, by tag. The owner's rule since
      // 2026-10-08 is that this is the board every member may see, said when
      // asked. It was left in `group_coordination_status` alone, and with the
      // counts here and a rule saying this block is the only thing to speak
      // from, the poker room asked "מי יכול בראשון?" on 2026-10-10 and heard
      // "3 said yes, 2 said no — I have no breakdown, only counts" without
      // the tool ever being called (`incidents.md`, "The poker room heard
      // counts where it asked for names").
      onTable: c.options.map((o) => ({
        optionId: o.optionId, slot: o.slot, ...(o.roomTimes ? { roomTimes: o.roomTimes } : {}),
        yes: o.yes.length, no: o.no.length,
        yesBy: labelsOf(o.yes), noBy: labelsOf(o.no),
      })),
    },
  };
}

// Rendered exactly as a tool result is (compact, `OK ` prefixed, tokens
// scrubbed on the way out), so the model reads the shape it already reads from
// every group tool.
async function renderContext(client, group, opts = {}) {
  const { renderResult } = require('../adapters/mcp/render');
  const data = await draw(client, group, opts);
  const clockRule = data.room && data.room.clocks ? ` ${CLOCK_RULE}` : '';
  const reachRule = data.room && (data.room.people || []).some((p) => p.reach) ? ` ${REACH_RULE}` : '';
  return `${CONTEXT_HEADER}\n${renderResult({ ok: true, data })}\n${CONTEXT_RULE} ${TAG_RULE}${clockRule}${reachRule}`;
}

module.exports = { draw, peopleOf, addressOf, reachOf, renderContext, CONTEXT_HEADER, CONTEXT_RULE, TAG_RULE, CLOCK_RULE, REACH_RULE };
