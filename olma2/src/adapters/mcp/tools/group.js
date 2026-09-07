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
    'GROUP AGENTS ONLY. The room asked you to arrange something — start coordinating it. Every member is then asked PRIVATELY when suits them; you never collect times in the room. Say in one line what you started. One coordination per room at a time: asked again while one is running, you get that one back (created=false) — tell them what is already being arranged instead of starting a second.',
    { what: S('string', 'What is being arranged, in the room\'s own words ("פאדל השבוע")') }, ['what'],
    async (client, ctx, a) => {
      const res = await groupMeetings.startCoordination(client, ctx.group, ctx.actingUser, a.what);
      if (!res.ok) return res;
      return ok({
        meetingId: Number(res.data.meeting.id), title: res.data.meeting.title,
        created: res.data.created, asked: res.data.participants - 1,
        hints: {
          room: res.data.created
            ? 'Say ONE short line in the room: you are on it and you are asking everyone privately. Do not list the members and do not ask anything here.'
            : 'This room already has that coordination running. Say where it stands (group_coordination_status), do not start another.',
        },
      });
    }),

  groupTool('group_coordination_status',
    'GROUP AGENTS ONLY. Where this room\'s coordination stands: the times on the table, who said yes or no to each, who has not answered at all. Answers only — the REASON somebody gave lives in their private chat and is never read out here. Use it before you say anything about progress, and never guess a name that is not in the result.',
    {}, [],
    async (client, ctx) => ok(await groupMeetings.coordinationStatus(client, ctx.group))),
];
