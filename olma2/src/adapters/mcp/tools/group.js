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
const { groups, ok, groupTool } = require('./_shared');

module.exports = [
  groupTool('group_status',
    'GROUP AGENTS ONLY. Who is in this group, and who has not written to Olma privately yet. Nothing here comes from anybody\'s private chat.',
    {}, [],
    async (client, ctx) => ok(await groups.roomStatus(client, ctx.group))),
];
