'use strict';
// "מחר" with no hour, saved for 09:00 that nobody said.
//
// The model has no way to write "a day" except local midnight, and it does not
// reach for it: of 68 tasks dated from chat in thirty days, not one sat at
// midnight. Asked for "tomorrow", it writes tomorrow at 09:00 — 35 tasks across
// 5 people in the same thirty days, 16 of them Dov's from one evening, and
// none of his messages that night named a morning hour (owner, 2026-10-05;
// `incidents.md`, "Nine o'clock, which nobody said"). The reminder still went
// out at 08:00 either way, but the page, the digest and every list drew
// "09:00" beside things that had no hour.
//
// Whether the message named an hour is read by CODE, in the gateway hook
// (`olma-turn-open` .namesNoHour), and only the verdict travels. This module is
// the other half: given that verdict, a due moment that sits at exactly the
// model's own default hour, in THEIR zone, is the day. Two things it does not
// do, on purpose:
//   - any other hour stands. A "כן" to "לקבוע ל־10?" names no hour in its own
//     words and is still ten o'clock; only the hour the model invents is
//     treated as invented.
//   - a range stands (`ends_at`): a shift from 09:00 to 17:00 was said.
const { partsInZone, instantInZone } = require('./datetime');

const INVENTED_HOUR = 9;

// The same day at local midnight, as an ISO string, when `dueAt` sits at
// exactly 09:00:00 local; otherwise null (leave it alone). Unparseable is null.
function asDay(dueAt, timezone) {
  if (!dueAt) return null;
  const at = new Date(dueAt);
  if (!Number.isFinite(at.getTime())) return null;
  const zone = timezone || 'UTC';
  const p = partsInZone(zone, at);
  if (p.hh !== INVENTED_HOUR || p.mi !== 0 || p.ss !== 0) return null;
  return instantInZone(zone, { y: p.y, m: p.m, d: p.d, hh: 0, mi: 0, ss: 0 }).toISOString();
}

module.exports = { asDay, INVENTED_HOUR };
