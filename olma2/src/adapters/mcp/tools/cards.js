'use strict';
// cards — one slice of the tool registry (see ../registry.js).
const {
  scheduleCard, cardStore, S, ok, scrubTokens, ICON_NAMES, tool,
} = require('./_shared');

module.exports = [
  // Draws a schedule the person can take in at a glance instead of reading.
  // This tool does NOT send anything — it returns a file path, and the agent
  // attaches it by putting `MEDIA: <path>` on its own line in the reply. That
  // distinction is what keeps it clear of the double-send rule in
  // channels/openclaw.js: the reply is still the one and only delivery.
  tool('render_schedule_card',
    'Draw a long list (5+ items or several weeks) as an image. Returns a path, sends nothing — attach with "MEDIA: <path>" on its own line plus one short sentence, and never also repeat the list as text. Compose sections from data fetched THIS turn, grouped as a person would think ("this week", "September"), in their language.',
    {
      title: S('string', 'Card heading, e.g. "תמונת מצב". Keep it short.'),
      subtitle: S('string', 'Optional line under the title, e.g. the date range.'),
      stats: S('array', 'Optional headline counts: [{icon, text}], max 4.', { items: { type: 'object' } }),
      sections: S('array', 'Required. [{title, items:[{date, text, icon, tag}]}]. date is a short label like "19 באוג׳"; tag is an optional source badge like "יומן". icon must be one of: ' + [...ICON_NAMES].sort().join(', ') + '.', { items: { type: 'object' } }),
      big_tasks: S('object', 'Optional footer group for themes with no specific date: {title, chips:[{icon, text}]}. Each chip text is a ONE- OR TWO-WORD label ("בריאות", "עבודה") — never a list of items and never a sentence. Anything longer is cut off mid-word and reads as broken.'),
      footer_note: S('string', 'Optional small line at the bottom.'),
    },
    ['sections'],
    async (client, user, a) => {
      // Defence in depth: this text is baked into pixels, where no later layer
      // can redact it. scrubTokens is the same guard the text path gets.
      const clean = JSON.parse(scrubTokens(JSON.stringify({
        title: a.title, subtitle: a.subtitle, stats: a.stats,
        sections: a.sections, big_tasks: a.big_tasks, footer_note: a.footer_note,
      })));
      const rendered = scheduleCard.renderPng(clean);
      if (!rendered.ok) return rendered;
      const saved = cardStore.saveCard(user, rendered.data.png);
      if (!saved.ok) return saved;
      return ok({
        path: saved.data.path,
        width: rendered.data.width,
        height: rendered.data.height,
        next_step: 'Reply with one short sentence, then "MEDIA: ' + saved.data.path + '" on its own line. Do not repeat the items as text.',
      });
    }),
];
