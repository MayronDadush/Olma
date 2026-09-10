'use strict';
// digest — one slice of the tool registry (see ../registry.js).
const {
  digest, users, S, tool, ok,
} = require('./_shared');
const digestBlock = require('../../../domain/digest-block');

module.exports = [
  tool('get_my_digest', 'Assemble the current picture. scope: summary (counts) | full (every open task) | today (due/overdue today).',
    { scope: S('string', 'summary | full | today') }, [],
    async (client, user, a) => {
      const res = await digest.assemble(client, user.id, a.scope || user.digest_scope || 'summary');
      if (!res.ok || !res.data || !(res.data.events || res.data.tasks)) return res;
      // The layout of a digest is the same every morning; only the sentence
      // about it changes. So the list is DRAWN here and handed over finished
      // (domain/digest-block.js) rather than retyped, and the hint below is
      // the whole contract: send it as it stands, add the one thing a model
      // is actually for. The channel decides the styling and the locale the
      // words, both read here rather than assumed.
      const ch = await users.primaryChannel(client, user.id);
      const block = digestBlock.renderDigestBlock(res.data, {
        locale: user.locale,
        timezone: user.timezone,
        channelType: ch.ok ? ch.data.channel.channel_type : null,
      });
      if (!block) return res;
      return ok({
        ...res.data,
        block,
        hints: {
          ...(res.data.hints || {}),
          block: 'The `block` above is the list, already laid out and already in their language. '
            + 'Put it in your reply EXACTLY as it is — same lines, same order, same characters — '
            + 'and do NOT rewrite it, reorder it, summarise it or repeat any of it as prose. '
            + 'Everything you add is ONE short sentence around it: a greeting before, or the single '
            + 'thing that moves the day after. If you have nothing true to add, send the block alone.',
        },
      });
    }),
  tool('set_digest_preferences', 'Set when the user gets their daily digest, and how much detail. times are LOCAL "HH:MM" (max 4); an empty array turns the digest off. Ask them, never guess.',
    { times: S('array', 'Local times, e.g. ["09:00","20:00"]. [] turns it off.', { items: { type: 'string' } }),
      scope: S('string', 'summary | full | today') }, [],
    (client, user, a) => digest.setPreferences(client, user.id, a.times, a.scope)),
];
