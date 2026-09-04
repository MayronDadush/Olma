'use strict';
// live updates — one slice of the tool registry (see ../registry.js).
const {
  mail, liveUpdates, S, tool,
} = require('./_shared');

module.exports = [
  // "עדכן אותי על..." — subscriptions to structured live sources, delivered
  // proactively on a cadence through the outbox gate. Sources are API-backed
  // (never web crawling); the sweep diffs in code and summarises with the
  // cheap background model only when something actually changed.
  tool('subscribe_live_updates',
    'Subscribe the user to a recurring live update, delivered as its own proactive message at their '
    + 'chosen hour. Available sources: "openrouter_models" (new AI models appearing on OpenRouter, with '
    + 'a note when something is relevant to Olma itself — only sends when there ARE new models), '
    + '"weather" (short 3-day forecast for a city, sent every time), "news_topic" (real headlines on a '
    + 'topic the user names, e.g. "בורסה", "בינה מלאכותית" — only sends when there IS something new), '
    + 'and "sports_summary" (real sports headlines, optionally for one team/league — leave team empty '
    + 'for general sports; only sends when there IS something new), and "mail_query" (watch their OWN '
    + 'mailbox for mail matching a search THEY describe, and tell them when it arrives — "update me when '
    + 'Amazon emails me about the delivery", "תגיד לי כשמגיע מייל מבית הספר". Needs their email connected. '
    + 'Checked hourly, headers only, and it never opens anything. This is the ONLY way to watch a mailbox: '
    + 'search_my_email is for a question they are asking right now, and must never be used to go and see '
    + 'whether something came in). Use when the user asks to be kept '
    + 'updated about one of these ("עדכן אותי כל בוקר על מזג האוויר", "עדכן אותי על ברצלונה", "עדכן אותי '
    + 'פעם בשבוע על מה שקורה עם X"). For anything not in this list, say plainly it is not available yet '
    + 'and log it with report_issue as a feature request.',
    {
      source: S('string', 'One of: ' + Object.keys(liveUpdates.SOURCES).join(', ')),
      city: S('string', 'For source=weather: the city name, in any language'),
      topic: S('string', 'For source=news_topic: the topic, in any language'),
      team: S('string', 'For source=sports_summary: optional team/league name — leave empty for general sports'),
      mail_query: S('string', 'For source=mail_query: a Gmail search for the mail they want to hear about — from:, subject:, has:attachment all work. Build it from what THEY described ("from:amazon.com delivery"); confirm it back to them in words, since a query that matches nothing fails silently and one that matches everything is a nuisance.'),
      cadence: S('string', 'hourly, daily (default) or weekly. hourly is only for mail_query.'),
      local_hour: S('number', 'Hour of day in the user\'s own timezone, 0-23. Default 9.'),
    }, ['source'],
    (client, user, a) => liveUpdates.subscribe(client, user, {
      source: a.source, params: { city: a.city, topic: a.topic, team: a.team, query: a.mail_query },
      cadence: a.cadence, local_hour: a.local_hour,
    })),
  tool('list_my_live_updates', 'The user\'s active live-update subscriptions.', {}, [],
    (client, user) => liveUpdates.listSubscriptions(client, user.id)),
  tool('cancel_live_update', 'Cancel one live-update subscription (get the id from list_my_live_updates).',
    { subscription_id: S('number', 'Subscription id') }, ['subscription_id'],
    (client, user, a) => liveUpdates.unsubscribe(client, user.id, a.subscription_id)),
];
