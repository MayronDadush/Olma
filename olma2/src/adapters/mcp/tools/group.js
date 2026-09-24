'use strict';
// group — the tools a GROUP agent may call (see ../registry.js).
//
// Every tool in this file is `audience: 'group'`, which is not a label: a user
// token is refused by brokerd on these, and a group token is refused on every
// other tool in the registry. The two sets are disjoint on purpose. A group
// agent sits in a room with several people in it, so the question for anything
// added here is not "is this useful" but "may the whole room hear the answer".
//
// The handler signature is different too, and deliberately so: a group tool
// gets `{ group, actingUser }` where a user tool gets a user row. Nothing here
// can be handed a person by accident, and `actingUser` — the member whose tag
// started this turn — is chosen by the server from what the gateway filed,
// never by the model.
const { groups, groupMeetings, meetings, meetingFanout, users, ok, err, groupTool, S } = require('./_shared');

module.exports = [
  groupTool('group_status',
    'GROUP AGENTS ONLY. Who is in this group, and who has not written to Olma privately yet. Nothing here comes from anybody\'s private chat.',
    {}, [],
    async (client, ctx) => ok(await groups.roomStatus(client, ctx.group))),

  // The trigger. Everything after this happens in the members' PRIVATE chats,
  // on the meeting tools their own agents already have — this tool creates the
  // coordination and hands each of them the question, and that is all it does.
  // It never proposes a time itself. A time somebody SAYS in the room is theirs,
  // and `add_group_coordination_option` below puts it on the table in their
  // name — never in the room's voice.
  groupTool('start_group_coordination',
    'GROUP AGENTS ONLY. Call this the moment the room asks to arrange something — never say you are on it before calling it. Everyone is then asked PRIVATELY when suits them. One per room: asked again returns the same one (created=false) — say where it stands.',
    { what: S('string', 'What is being arranged, in the room\'s own words ("פאדל השבוע")'),
      where: S('string', 'The place, ONLY if the room said one ("אצל יוסי"); never guessed') },
    ['what'],
    async (client, ctx, a) => {
      const res = await groupMeetings.startCoordination(client, ctx.group, ctx.actingUser, a.what, { where: a.where });
      if (!res.ok) return res;
      const hints = {
        room: res.data.created
          // "asking everyone privately" was a claim, and on 2026-09-07 it was
          // untrue in the room where it was first said: both invites were
          // still queued (one held for the night, one dropped as quiet) and
          // nothing had reached anybody. The room read "שואלת את כולם בפרטי"
          // about messages that never went. The owner's wording, and the only
          // one this tool can honestly support: she will ask each of them when
          // they are available (`incidents.md`, "The room was told twice").
          ? 'Say ONE short line in the room: you are on it, and you will ask each of them privately WHEN THEY ARE AVAILABLE. Never say they have already been asked — nothing has reached anybody yet, and some of them are asleep or have stopped answering. Do not list the members and do not ask anything here. If the request itself named a time, call add_group_coordination_option for it now.'
          : 'This room already has that coordination running. Say where it stands (group_coordination_status), do not start another.',
      };
      // The one question this room is ever asked about itself, folded into
      // that same line so it is one message and not two. Asked once ever —
      // the column is already stamped, answered or not.
      if (res.data.askKind) {
        hints.ask = 'Nobody has told you what kind of group this is, so add ONE short question to that same line — does this need a minimum number of people (a game: padel, poker), or is everyone simply invited and whoever can, comes? On their answer call set_group_kind. Ask it once; if they ignore it, drop it and coordinate as if everyone is invited.';
      }
      return ok({
        meetingId: Number(res.data.meeting.id), title: res.data.meeting.title,
        // Not `asked`. The number is how many people a message is now owed
        // to, and every one of them still has to pass the delivery gate.
        //
        // `- 1` until 2026-09-19, for the person who asked: a tag in a room
        // carries no times, so they are owed the question like everybody else
        // and `startCoordination` now sends them their own row
        // (.claude/rules/groups.md, "The person who asked the ROOM for a
        // coordination is asked privately too"). The fan-out changed and the
        // number the MODEL reads did not: a count we hand over ourselves,
        // one short of the rows just written, ready to be said out loud in
        // front of the room.
        created: res.data.created, willAsk: res.data.participants, hints,
      });
    }),

  // A time said IN the room (2026-09-23). עמית asked for "שישי צהריים פוקר
  // ב-Zoom" and מירון added "חמישי ערב ושבת ערב", both in front of everyone;
  // the room's agent reached for propose_meeting_slot, was refused as a person's
  // tool, and told the room it was sending the times to everybody privately.
  // Nothing wrote them anywhere, and the coordination's page had an empty
  // table (`incidents.md`, "The times the room said went nowhere"). The agent
  // understood and the outcome had nowhere to go — so this is the missing
  // tool, not a better sentence.
  //
  // It is the person's proposal and never the room's: `actingUser` is the
  // member whose tag started the turn, chosen by the server off what the
  // gateway filed, and the option is added AS them — added_by, their yes —
  // through exactly the path the private tool takes (`meetings.proposeSlot`,
  // `meetingFanout.afterOptionAdded`), so the five-option ceiling, a duplicate
  // moment being a yes, the weekday check and the fold into a still-queued
  // private invite are all the same code.
  groupTool('add_group_coordination_option',
    'GROUP AGENTS ONLY. The member who tagged you named a time for this room\'s coordination: put it on the table as THEIR option, with their yes. The others are asked about it privately.',
    { slot_description: S('string', 'The time in their words, day included'),
      starts_at: S('string', 'The same moment and DAY, ISO-8601 with offset'),
      all_day: S('boolean', 'The whole day'), daypart: S('string', 'morning|noon|evening|night, when no hour') },
    ['slot_description', 'starts_at'],
    async (client, ctx, a) => {
      if (!ctx.actingUser) {
        return err('invalid', 'I cannot tell who said this — ask them to say it again in the group');
      }
      const meeting = await groupMeetings.currentMeeting(client, ctx.group.id);
      if (!meeting) {
        return err('invalid', 'nothing is being coordinated in this room — call start_group_coordination first');
      }
      const meetingId = Number(meeting.id);
      const res = await meetings.proposeSlot(client, ctx.actingUser.id, meetingId, a.slot_description, a.starts_at,
        { allDay: a.all_day === true, daypart: a.daypart || null });
      if (!res.ok) {
        // The full-table refusal carries every option with its per-person
        // answers keyed by user id. A room is told the times, never whose
        // answer is whose (.claude/rules/groups.md).
        if (res.error && Array.isArray(res.error.options)) {
          return err(res.error.code, res.error.message, {
            reason: res.error.reason,
            options: res.error.options.map((o) => ({ optionId: o.id, slot: o.slotText })),
          });
        }
        return res;
      }
      const out = await meetingFanout.afterOptionAdded(client, ctx.actingUser, meetingId, res);
      if (!out.ok) return out;
      // Their own private invite, if it has not gone out, must stop asking
      // them the question they just answered in front of everyone.
      await meetingFanout.noteNamedInRoom(client, ctx.actingUser.id, meetingId);
      const onTable = await meetings.options.activeCount(client, meetingId);
      return ok({
        meetingId, optionId: res.data.optionId, slot: res.data.proposedSlot,
        duplicate: res.data.duplicate, onTable,
        hints: {
          room: res.data.duplicate
            ? 'That time was already on the table; their yes to it is recorded. Say ONE short line, no names.'
            : 'Say ONE short line in the room: that time is on the table and you will ask the others about it privately. Never say they have already been asked, and never say who said yes or no.',
        },
      });
    }),

  groupTool('set_group_kind',
    'GROUP AGENTS ONLY. Record what kind of group this is, from what the room ANSWERED, never a guess. "game" (padel, poker) needs a minimum; "social" (friends, work, family) invites everyone and takes no numbers. The same call corrects it later.',
    { kind: S('string', '"game" or "social"'),
      minimum: S('number', 'game only: how many people it needs'),
      maximum: S('number', 'game only, if they said one: how many it can hold'),
      close_at_target: S('boolean', 'game only: true if reaching the maximum means it can be closed there and then') },
    ['kind'],
    async (client, ctx, a) => {
      const res = await groups.setKind(client, ctx.group.id, {
        kind: a.kind, min: a.minimum, max: a.maximum, closeAtTarget: a.close_at_target,
      }, ctx.actingUser ? ctx.actingUser.id : null);
      if (!res.ok) return res;
      // The saved settings and nothing else. The row also holds this group's
      // identity token, and a tool result is the one place a token has no
      // business being — the model has it from AGENTS.md and never needs a
      // second copy in its context.
      const g = res.data.group;
      return ok({ kind: g.kind, minimum: g.quorum_min, maximum: g.quorum_max, closeAtTarget: g.close_at_target });
    }),

  groupTool('settle_group_coordination',
    'GROUP AGENTS ONLY. Close this room\'s coordination on ONE time (option_id from group_coordination_status), when the room says so out loud. Everyone is told privately, including anyone who never said yes. Refused below a game\'s minimum — say how many are short.',
    { option_id: S('number', 'The time to close it on') }, ['option_id'],
    async (client, ctx, a) => groupMeetings.settle(client, ctx.group, ctx.actingUser, a.option_id)),

  // The place, said in the room before or after the time is set. Its own
  // tool rather than a field on settle: "אצל יוסי" arrives in any message
  // and at any point, and the calendar event may already exist.
  groupTool('set_group_coordination_place',
    'GROUP AGENTS ONLY. The room said WHERE it happens ("אצל יוסי") — save it in their words; an existing calendar event is updated too.',
    { where: S('string', 'The place, in their words') }, ['where'],
    async (client, ctx, a) => {
      const res = await groupMeetings.setPlace(client, ctx.group, ctx.actingUser, a.where);
      if (!res.ok) return res;
      return ok({
        ...res.data,
        hints: {
          room: res.data.calendarUpdated
            ? 'Say ONE short line: noted, and the calendar event now carries the place.'
            : 'Say ONE short line: noted. It goes on the calendar with the event — do not claim it is there yet.',
        },
      });
    }),

  // 2026-09-23, פחם הסעות: Amit wrote "אני גבר ואת אמורה לדעת את זה עליי",
  // she apologised, and nothing was written — the room's turn block would
  // have drawn him with no `address` on the next turn and the next one after
  // that. The owner asked for it to be kept. Only ever the SENDER, about
  // THEMSELVES: `actingUser` is chosen by the server from what the gateway
  // filed, so a member cannot set somebody else's form of address from the
  // room, and the column is the same one their own profile page writes
  // (`users.setPersonal`), so the private chat learns it too.
  groupTool('remember_sender_gender',
    'GROUP AGENTS ONLY. The member who tagged you said how to address THEM ("אני גבר", "אני אישה"): save it. Never for anybody else.',
    { gender: S('string', '"male" or "female"') }, ['gender'],
    async (client, ctx, a) => {
      if (!ctx.actingUser) {
        return err('invalid', 'I cannot tell who said this — nothing was saved');
      }
      const res = await users.setPersonal(client, ctx.actingUser.id, { gender: a.gender });
      if (!res.ok) return res;
      return ok({
        gender: res.data.gender,
        hints: { room: 'Saved. If a word is needed, ONE short line in their form — no apology speech.' },
      });
    }),

  groupTool('group_coordination_status',
    'GROUP AGENTS ONLY. Where this room\'s coordination stands: the times on the table, who said yes or no to each, who has not answered. Answers only — a REASON somebody gave lives in their private chat and is never read out here. Check it before saying anything about progress.',
    {}, [],
    async (client, ctx) => ok(await groupMeetings.coordinationStatus(client, ctx.group))),
];
