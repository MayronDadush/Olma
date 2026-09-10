'use strict';
// digest — one slice of the tool registry (see ../registry.js).
const {
  digest, users, flags, S, tool, ok,
} = require('./_shared');
const digestBlock = require('../../../domain/digest-block');

// The block and a drawn card are two renderings of the SAME list, and a turn
// that holds both sends both — the same evening twice, once as characters and
// once as a picture. Miron read his at 18:01 and again at 18:02 on 2026-09-10.
//
// Nothing about that was the model disobeying. It was told, in the delivery
// instruction, that a card REPLACES the block and never to send both; and then
// this tool — the very call that instruction orders on the card path — handed
// back a block with "Put it in your reply EXACTLY as it is" attached to it.
// An unconditional instruction to write, arriving mid-turn on a tool result,
// against a conditional one from the top of the prompt: the same shape as the
// hint that outvoted `markPlaced`, for the third time.
//
// So the choice is made HERE, in code, and the two can no longer coexist: this
// returns EITHER a `block` to send as it stands OR an order to draw, never
// both, and the delivery instruction now only relays whichever came back.
// A sentence in a prompt asking a model not to send two things is a request;
// not giving it two things is a guarantee.
function cardOrder(itemCount) {
  return `This list is ${itemCount} lines — long enough to be worth an IMAGE, so there is NO block this turn. `
    + 'Call render_schedule_card off the events and tasks in THIS result, then reply with one short '
    + 'sentence plus "MEDIA: <path>" on its own line. Do not write the items out as text as well: '
    + 'the card is the list, and a list beside it is the same picture twice.';
}

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
      const items = digestBlock.blockItemCount(res.data);
      const min = await flags.getFlag(client, 'digest_card_min_items');
      if (digestBlock.drawInsteadOfBlock(items, min)) {
        return ok({
          ...res.data,
          hints: { ...(res.data.hints || {}), card: cardOrder(items) },
        });
      }
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
          // Said out loud on the short mornings too, because the doctrine also
          // tells the agent to draw a long list and this is the one place that
          // knows this list is not one.
          card: 'This list is short enough to read: do NOT draw a card this turn — the block below IS the message.',
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
