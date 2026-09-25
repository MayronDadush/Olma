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
    'GROUP AGENTS ONLY. The member who tagged you named a time for this room\'s coordination: put it on the table as THEIR option, with their yes. The others are asked about it privately. Settled with no exact hour: this sets it.',
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
        // Settled on a whole day or a part of one, and the done line asked
        // whether they want an exact hour: this is the answer (owner,
        // 2026-09-24). Anybody in the room, the same day only.
        const last = await groupMeetings.roomMeetingFor(client, ctx.group, ctx.actingUser);
        if (last.ok && meetings.timeIsOpen(last.data)) {
          const set = await meetingFanout.afterTimeSet(client, ctx.actingUser,
            await meetings.setExactTime(client, ctx.actingUser.id, Number(last.data.id), a.slot_description, a.starts_at),
            { fromRoom: true });
          if (!set.ok) return set;
          return ok({
            meetingId: set.data.meetingId, slot: set.data.slot, timeSet: true,
            hints: { room: 'Say ONE short line in the room: the time is set. Everyone else is told privately.' },
          });
        }
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
      // In a room on more than one clock, the time as every reader will hear
      // it — the one line the model may say about it (group-turn.CLOCK_RULE).
      const st = await groupMeetings.coordinationStatus(client, ctx.group);
      const drawn = st.coordination && (st.coordination.options || [])
        .find((o) => Number(o.optionId) === Number(res.data.optionId));
      return ok({
        meetingId, optionId: res.data.optionId, slot: res.data.proposedSlot,
        ...(drawn && drawn.roomTimes ? { roomTimes: drawn.roomTimes } : {}),
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

  // ── Everything else a person can do to a coordination, from the room ──────
  // Owner, 2026-09-25: he asked the room to cancel and was told it could only
  // be done privately (`incidents.md`, "The room could not cancel its own
  // coordination"). Each tool below is a second door into exactly the domain
  // call and fan-out its private twin uses, as the member who tagged her
  // (`groupMeetings.participantFor`, which refuses anybody not in it). Every
  // result is PICKED field by field rather than passed through: the private
  // results carry hints written for a person's own agent (their calendar,
  // their dashboard), and nothing of that belongs in front of a room.
  groupTool('cancel_group_coordination',
    'GROUP AGENTS ONLY. The member who tagged you calls this room\'s coordination off for EVERYONE; all are told privately. "I can\'t make it" is leave_group_coordination — ask if unclear.',
    {}, [],
    async (client, ctx) => {
      const who = await groupMeetings.participantFor(client, ctx.group, ctx.actingUser, { statuses: ['negotiating', 'confirmed'] });
      if (!who.ok) return who;
      const res = await meetingFanout.cancelAndTell(client, who.data.user, who.data.meetingId);
      if (!res.ok) return res;
      return ok({
        meetingId: who.data.meetingId, cancelled: true, wasConfirmed: Boolean(res.data.wasConfirmed),
        hints: { room: 'Say ONE short line: it is cancelled, and everyone in it is told privately. No names, no reasons.' },
      });
    }),

  groupTool('reopen_group_coordination',
    'GROUP AGENTS ONLY. The member who tagged you reopens this room\'s SETTLED coordination so its time can change; other times stay.',
    {}, [],
    async (client, ctx) => {
      const who = await groupMeetings.participantFor(client, ctx.group, ctx.actingUser, { statuses: ['confirmed'] });
      if (!who.ok) return who;
      const res = await meetingFanout.reopenAndTell(client, who.data.user, who.data.meetingId, { fromRoom: true });
      if (!res.ok) return res;
      return ok({
        meetingId: who.data.meetingId, reopened: true, was: res.data.was,
        hints: { room: 'Say ONE short line: the time that was set is open again, the other times stay on the table, and everyone in it is asked privately.' },
      });
    }),

  groupTool('rename_group_coordination',
    'GROUP AGENTS ONLY. The member who tagged you renames this room\'s coordination.',
    { title: S('string', 'The new name, in their words') }, ['title'],
    async (client, ctx, a) => {
      const who = await groupMeetings.participantFor(client, ctx.group, ctx.actingUser, { statuses: ['negotiating', 'confirmed'] });
      if (!who.ok) return who;
      const set = await meetings.setTitle(client, who.data.user.id, who.data.meetingId, a.title);
      if (!set.ok) return set;
      const res = await meetingFanout.patchSharedEvent(client, set, { title: set.data.title });
      return ok({
        meetingId: who.data.meetingId, title: res.data.title, calendarUpdated: res.data.calendarUpdated,
        hints: { room: 'Say ONE short line with the new name.' },
      });
    }),

  groupTool('remove_group_coordination_option',
    'GROUP AGENTS ONLY. The member who tagged you takes ONE time off the table (option_id from group_coordination_status).',
    { option_id: S('number', 'The time to take off') }, ['option_id'],
    async (client, ctx, a) => {
      const who = await groupMeetings.participantFor(client, ctx.group, ctx.actingUser);
      if (!who.ok) return who;
      const res = await meetingFanout.afterOptionRemoved(client, who.data.user, who.data.meetingId,
        await meetings.options.remove(client, who.data.user.id, who.data.meetingId, a.option_id));
      if (!res.ok) return res;
      return ok({
        meetingId: who.data.meetingId, optionId: Number(a.option_id), meetingStatus: res.data.meetingStatus,
        hints: { room: res.data.meetingStatus === 'settling'
          ? 'That time is off. Everyone left agrees on another, so it closes on its own shortly — do not announce it closed.'
          : 'Say ONE short line: that time is off the table. Nobody else is messaged about it.' },
      });
    }),

  groupTool('leave_group_coordination',
    'GROUP AGENTS ONLY. The member who tagged you says THEY cannot make it: they leave, and it carries on for the others.',
    {}, [],
    async (client, ctx) => {
      const who = await groupMeetings.participantFor(client, ctx.group, ctx.actingUser, { statuses: ['negotiating', 'confirmed'] });
      if (!who.ok) return who;
      const out = await meetings.optOut(client, who.data.user.id, who.data.meetingId);
      if (!out.ok) return out;
      const res = await meetingFanout.afterOptOut(client, who.data.user, who.data.meetingId, out);
      return ok({
        meetingId: who.data.meetingId, meetingStatus: res.data.meetingStatus,
        cancelledForEveryone: Boolean(res.data.cascadeCancelled),
        hints: { room: res.data.cascadeCancelled
          ? 'Say ONE short line: with them out there are not enough people, so it is off for everyone, and everyone is told privately.'
          : 'Say ONE short line to them: noted, it carries on for the others. No reason, and nothing about anybody else.' },
      });
    }),

  // Their OWN answer, said in front of everyone — so the room hears nothing
  // it had not just heard from them. What it never hears is anybody else's:
  // the result carries this one answer and not the table's.
  groupTool('answer_group_coordination_option',
    'GROUP AGENTS ONLY. The member who tagged you says yes or no to ONE time on the table (option_id from group_coordination_status). Their own answer only.',
    { option_id: S('number', 'The time they answered'), accept: S('boolean', 'true = yes, false = no') },
    ['option_id', 'accept'],
    async (client, ctx, a) => {
      const who = await groupMeetings.participantFor(client, ctx.group, ctx.actingUser);
      if (!who.ok) return who;
      const { meetingId, user } = who.data;
      const option = (await meetings.options.list(client, meetingId))
        .find((o) => o.status === 'active' && Number(o.id) === Number(a.option_id));
      if (!option) return err('not_found', 'no such time on the table', { reason: 'option_not_active' });
      // The yes has to land on THIS option and not "whatever is newest":
      // respondToSlot finds the option by its moment, so the moment is handed
      // over from the row, never typed by a model.
      const res = await meetings.respondToSlot(client, user.id, meetingId, a.accept === true, null, null, option.startsAt);
      if (!res.ok) return res;
      await meetingFanout.afterSlotResponse(client, user, meetingId, res, { accept: a.accept === true });
      // Their private invite must stop asking what they just answered here.
      await meetingFanout.noteNamedInRoom(client, user.id, meetingId);
      return ok({
        meetingId, optionId: Number(option.id), slot: option.slotText, answer: a.accept === true ? 'yes' : 'no',
        meetingStatus: res.data.meetingStatus,
        hints: { room: res.data.meetingStatus === 'settling'
          ? 'Their yes made it unanimous: it closes on its own shortly and everyone is told. Say ONE short line, and do not announce it closed.'
          : 'Noted. If words are needed, ONE short line — never anybody else\'s answer.' },
      });
    }),

  groupTool('group_coordination_status',
    'GROUP AGENTS ONLY. Where this room\'s coordination stands: the times on the table, who said yes or no to each, who has not answered. Answers only — a REASON somebody gave lives in their private chat and is never read out here. Check it before saying anything about progress.',
    // Asked for hours that suit everyone, with places the room's own clocks do
    // not cover (פנתרה, 2026-09-25): `commonHours` is drawn by code.
    { places: S('array', 'IANA zones of cities members named, for hours that suit all (commonHours)', { items: { type: 'string' } }) }, [],
    async (client, ctx, a) => ok(await groupMeetings.coordinationStatus(client, ctx.group,
      Array.isArray(a && a.places) ? { places: a.places } : {}))),
];
