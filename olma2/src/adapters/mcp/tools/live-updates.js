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
    'Subscribe the user to a recurring proactive update from ONE structured source at their chosen hour: weather (every time), news_topic and sports_summary (real headlines, only when new), openrouter_models (new models). Anything else: not available yet — report_issue.',
    {
      source: S('string', 'One of: ' + Object.keys(liveUpdates.SOURCES).join(', ')),
      city: S('string', 'For source=weather: the city name, in any language'),
      topic: S('string', 'For source=news_topic: the topic, in any language'),
      team: S('string', 'For source=sports_summary: optional team/league name — leave empty for general sports'),
      cadence: S('string', 'daily (default) or weekly.'),
      local_hour: S('number', 'Hour of day in the user\'s own timezone, 0-23. Default 9.'),
    }, ['source'],
    (client, user, a) => liveUpdates.subscribe(client, user, {
      source: a.source, params: { city: a.city, topic: a.topic, team: a.team },
      cadence: a.cadence, local_hour: a.local_hour,
    })),
  tool('list_my_live_updates', 'The user\'s active live-update subscriptions.', {}, [],
    (client, user) => liveUpdates.listSubscriptions(client, user.id)),
  tool('cancel_live_update', 'Cancel one live-update subscription (get the id from list_my_live_updates).',
    { subscription_id: S('number', 'Subscription id') }, ['subscription_id'],
    (client, user, a) => liveUpdates.unsubscribe(client, user.id, a.subscription_id)),
];
