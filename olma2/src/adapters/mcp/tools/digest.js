'use strict';
// digest — one slice of the tool registry (see ../registry.js).
const {
  digest, S, tool,
} = require('./_shared');

module.exports = [
  tool('get_my_digest', 'Assemble the current picture. scope: summary (counts) | full (every open task) | today (due/overdue today).',
    { scope: S('string', 'summary | full | today') }, [],
    (client, user, a) => digest.assemble(client, user.id, a.scope || user.digest_scope || 'summary')),
  tool('set_digest_preferences', 'Set when the user gets their daily digest, and how much detail. times are LOCAL "HH:MM" (max 4); an empty array turns the digest off. Ask them, never guess.',
    { times: S('array', 'Local times, e.g. ["09:00","20:00"]. [] turns it off.', { items: { type: 'string' } }),
      scope: S('string', 'summary | full | today') }, [],
    (client, user, a) => digest.setPreferences(client, user.id, a.times, a.scope)),
];
