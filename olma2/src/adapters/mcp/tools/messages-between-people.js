'use strict';
// messages between people — one slice of the tool registry (see ../registry.js).
const {
  relay, S, tool, connectedUserByPhone,
} = require('./_shared');

module.exports = [
  tool('send_message_to_connection', 'Pass ONE message from YOUR user to a connected person ("תגיד ל…", "תעביר לו ש…"). Their own Olma delivers it when they are reachable — never during their quiet hours — clearly attributed to your user. The text is your user\'s message: keep their meaning exactly; polish wording only with their ok. NOT for scheduling — arranging a time happens ONLY through the meeting tools. Delivery is queued: say it is on its way, never that it already arrived.',
    { phone: S('string', 'Their E.164 phone'),
      message: S('string', 'The message to pass on, in the user\'s own language') },
    ['phone', 'message'],
    async (client, user, a) => {
      const who = await connectedUserByPhone(client, user.id, a.phone, 'messages');
      if (!who.ok) return who;
      return relay.relayMessage(client, user, who.data.target, a.message);
    }),
];
