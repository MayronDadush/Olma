'use strict';
// cards — one slice of the tool registry (see ../registry.js).
const {
  scheduleCard, cardStore, selfInitiated, S, ok, err, scrubTokens, ICON_NAMES, tool,
} = require('./_shared');
const repeatGuard = require('../../../domain/repeat-guard');

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
      big_tasks: S('object', 'Optional footer group for undated themes: {title, chips:[{icon, text}]}. Each chip text is ONE or TWO words ("בריאות", "עבודה"), never a list or a sentence — longer is cut mid-word.'),
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

      // ── The same picture does not go out twice in two minutes ─────────────
      // The owner's rule (2026-09-10). On a `--deliver` turn every text block
      // the model emits is a WhatsApp message of its own, so a turn that draws
      // the same card twice puts it on the phone twice, and no outbox row is
      // involved in either — the delivery gate cannot see this and the model's
      // own instruction not to is a request. Identical content is what makes
      // it decidable: a redraw the doctrine actually asks for (the tool refused
      // on too many items, so narrow the range and draw again) is a DIFFERENT
      // card and passes untouched.
      //
      // Only on a turn Olma started. A person who asks to see their week twice
      // has asked twice, and the second answer is an answer — refusing it would
      // be the assistant arguing with them about what they already read. The
      // rule is about Olma repeating herself, and `selfInitiated` is the one
      // bit that knows which of the two this is.
      const sig = repeatGuard.signature(clean);
      const ours = selfInitiated.isActive(user.id);
      const age = ours ? repeatGuard.repeatAge(user.id, sig) : null;
      if (age !== null) {
        return err('conflict', 'this exact card was drawn for them moments ago and has already gone out', {
          secondsAgo: Math.round(age / 1000),
          next_step: 'It is on their phone. Do not draw it again and do not describe it in words — '
            + 'reply with exactly NO_REPLY unless you have something to say that the card does not carry.',
        });
      }

      const rendered = scheduleCard.renderPng(clean);
      if (!rendered.ok) return rendered;
      const saved = cardStore.saveCard(user, rendered.data.png);
      if (!saved.ok) return saved;
      // Remembered only once a card really exists on disk: a refusal or a
      // failed write is not something that went out, and marking it as one
      // would block the retry that fixes it.
      repeatGuard.remember(user.id, sig);
      return ok({
        path: saved.data.path,
        width: rendered.data.width,
        height: rendered.data.height,
        next_step: 'Reply with one short sentence, then "MEDIA: ' + saved.data.path + '" on its own line. Do not repeat the items as text.',
      });
    }),
];
