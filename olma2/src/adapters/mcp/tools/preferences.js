'use strict';
// preferences — one slice of the tool registry (see ../registry.js).
const {
  preferences, S, tool,
} = require('./_shared');

module.exports = [
  // Two keys here are not free-form — the delivery gate parses them — so both
  // are named, and named as briefly as the surface can afford (36 chars of the
  // 47 the ceiling had left; see tests/tool-schema-budget.test.js). What the
  // values MEAN is spelled out where the model is standing when it first needs
  // them: the discovery ladder's timezone rung, which is an outbox payload and
  // costs nothing on the turns it does not apply to. The key name has to be
  // here anyway, because "אל תכתבי לי בשבת" can arrive on any turn at all, and
  // a preference saved under an invented key is a promise nothing reads.
  tool('remember_preference', 'Persist a learned preference about how this person works (key: short lowercase slug). Availability window goes under key "availability" as "HH:MM-HH:MM". Days off: "quiet_days" as "fri,sat".',
    { key: S('string', 'e.g. tone, availability'), value: S('string', 'The preference') }, ['key', 'value'],
    (client, user, a) => preferences.remember(client, user.id, a.key, a.value)),
  tool('forget_preference', 'Remove a learned preference.',
    { key: S('string', 'Preference key') }, ['key'],
    // The whole user, not just the id: forgetting `quiet_days` restores a
    // DEFAULT that depends on their language and their zone, and the result
    // says which day came back (domain/preferences.forget).
    (client, user, a) => preferences.forget(client, user.id, a.key, user)),
  tool('list_my_preferences', 'List learned preferences.', {}, [],
    (client, user) => preferences.list(client, user.id)),
];
