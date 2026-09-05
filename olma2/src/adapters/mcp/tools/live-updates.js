'use strict';
// live updates — one slice of the tool registry (see ../registry.js).
const {
  liveUpdates, S, tool,
} = require('./_shared');

module.exports = [
  // "עדכן אותי על..." — subscriptions to structured live sources, delivered
  // proactively on a cadence through the outbox gate. Sources are API-backed
  // (never web crawling); the sweep diffs in code and summarises with the
  // cheap background model only when something actually changed.
  tool('subscribe_live_updates',
    'Subscribe the user to a recurring proactive update from ONE structured source, sent at their chosen hour: weather (a short forecast for a city, every time), news_topic and sports_summary (real headlines, only when something is new), openrouter_models (new AI models, only when there are any), mail_query (their OWN mailbox, hourly, headers only — the only way to watch a mailbox; search_my_email is for a question asked right now, never for checking whether something arrived). Use it when they ask to be kept updated ("עדכן אותי כל בוקר על מזג האוויר", "עדכן אותי על ברצלונה"). Anything not on this list: say plainly it is not available yet and file it with report_issue as a feature request.',
    {
      source: S('string', 'One of: ' + Object.keys(liveUpdates.SOURCES).join(', ')),
      city: S('string', 'For source=weather: the city name, in any language'),
      topic: S('string', 'For source=news_topic: the topic, in any language'),
      team: S('string', 'For source=sports_summary: optional team/league name — leave empty for general sports'),
      mail_query: S('string', 'For source=mail_query: a Gmail search built from what THEY described (from:, subject:, has:attachment work), e.g. "from:amazon.com delivery". Needs their email connected. Say it back to them in words: one that matches nothing fails silently, one that matches everything is a nuisance.'),
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
