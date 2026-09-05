'use strict';
// preferences — one slice of the tool registry (see ../registry.js).
const {
  preferences, availability, S, tool,
} = require('./_shared');

module.exports = [
  tool('remember_preference', 'Persist a learned preference about how this person works (key: short lowercase slug). Availability window goes under key "availability" as "HH:MM-HH:MM".',
    { key: S('string', 'e.g. tone, availability'), value: S('string', 'The preference') }, ['key', 'value'],
    (client, user, a) => preferences.remember(client, user.id, a.key, a.value)),
  tool('forget_preference', 'Remove a learned preference.',
    { key: S('string', 'Preference key') }, ['key'],
    (client, user, a) => preferences.forget(client, user.id, a.key)),
  tool('list_my_preferences', 'List learned preferences.', {}, [],
    (client, user) => preferences.list(client, user.id)),
];
