'use strict';
// One vocabulary for "a datetime that carries its own UTC offset", shared by
// every place that accepts a time from the model.
//
// Calendar events already refused a bare local time rather than guessing at
// it — an event three hours off is worse than no event. Meetings then grew
// the same need for the same reason, and a second copy of this rule living in
// meetings.js is exactly how the two drift apart. Same lesson as
// reminders.normalizeRepeatRule: one vocabulary, one file.
const { err } = require('./results');

// …Z or ±HH:MM. A bare "2026-08-21T20:00" is refused, never interpreted
// against whatever timezone the reader happens to assume.
const OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function hasOffset(value) {
  return typeof value === 'string' && OFFSET_RE.test(value.trim());
}

function badTime(label, value) {
  return err('invalid',
    `${label} must be a full ISO-8601 datetime WITH a UTC offset, e.g. 2026-08-20T09:00:00+03:00 (got ${String(value).slice(0, 40)})`,
    { reason: 'missing_offset' });
}

module.exports = { OFFSET_RE, hasOffset, badTime };
