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
const { groups, groupMeetings, ok, groupTool, S } = require('./_shared');

module.exports = [
  groupTool('group_status',
    'GROUP AGENTS ONLY. Who is in this group, and who has not written to Olma privately yet. Nothing here comes from anybody\'s private chat.',
    {}, [],
    async (client, ctx) => ok(await groups.roomStatus(client, ctx.group))),

  // The trigger. Everything after this happens in the members' PRIVATE chats,
  // on the meeting tools their own agents already have — this tool creates the
  // coordination and hands each of them the question, and that is all it does.
  // It never proposes a time: a time proposed from the room would be one
  // person's suggestion wearing the room's voice.
  groupTool('start_group_coordination',
    'GROUP AGENTS ONLY. The room asked you to arrange something — start coordinating it. Everyone is then asked PRIVATELY when suits them; you never collect times in the room. One per room: asked again while one runs you get that one back (created=false), so say what is already being arranged instead of starting a second.',
    { what: S('string', 'What is being arranged, in the room\'s own words ("פאדל השבוע")') }, ['what'],
    async (client, ctx, a) => {
      const res = await groupMeetings.startCoordination(client, ctx.group, ctx.actingUser, a.what);
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
          ? 'Say ONE short line in the room: you are on it, and you will ask each of them privately WHEN THEY ARE AVAILABLE. Never say they have already been asked — nothing has reached anybody yet, and some of them are asleep or have stopped answering. Do not list the members and do not ask anything here.'
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
        created: res.data.created, willAsk: res.data.participants - 1, hints,
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

  groupTool('group_coordination_status',
    'GROUP AGENTS ONLY. Where this room\'s coordination stands: the times on the table, who said yes or no to each, who has not answered. Answers only — a REASON somebody gave lives in their private chat and is never read out here. Check it before saying anything about progress.',
    {}, [],
    async (client, ctx) => ok(await groupMeetings.coordinationStatus(client, ctx.group))),
];
