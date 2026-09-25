'use strict';
// One moment, said in every zone the people hearing it live in.
//
// Until 2026-09-25 nothing in the system converted a meeting time to anybody's
// zone: what a person read was `slot_text`, the proposer's own words or a
// string built in the proposer's zone, stored once and passed on unchanged.
// פנתרה is the room that showed it — two members in Israel, one abroad on a
// +972 number, and a fourth in Australia — where "יום שבת 26.9 20:00" reached a
// man for whom it was ten in the morning (`incidents.md`, "פנתרה: one time,
// four clocks"). The owner's rule: in a room whose members span more than one
// zone, every time she says there is said in each of them, by city.
//
// Pure, no database, so every render site reads the same answer. Three rules
// carry the weight:
//
//   * Only a time that NAMES a clock is converted. "יום שלישי בערב" became
//     19:00 on its way into `starts_at` as a representative hour, and turning
//     that into "12:00 ניו יורק" would be precision nobody said. A daypart, an
//     all-day option or text with no HH:MM stays in its author's words.
//   * Zones that show the same wall clock at THAT instant are one zone. Israel
//     and Athens are the same hour in summer and not in every winter week, so
//     the merge is decided per moment, never per pair.
//   * A city name comes from ICU (`shortGeneric` in Hebrew gives "שעון ניו
//     יורק"), measured identical on this Mac and on the box (ICU 78.3,
//     2026-09-25). A build without Hebrew zone names falls back to the IANA
//     city, so a label is never a raw "GMT-4".
const { partsInZone, zoneOffsetMs, weekdayOfParts } = require('./datetime');
const { statedHour } = require('./stated-hour');

const DAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function pad(n) { return String(n).padStart(2, '0'); }

function validZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

// "ניו יורק" for America/New_York. The fallback is the IANA city with its
// underscores opened, which is English — better an honest English city than a
// raw offset nobody can place.
function zoneLabel(tz) {
  if (!validZone(tz)) return '';
  try {
    const part = new Intl.DateTimeFormat('he', { timeZone: tz, timeZoneName: 'shortGeneric' })
      .formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    const name = part ? String(part.value).replace(/^שעון\s+/, '').trim() : '';
    if (name && !/^(GMT|UTC)|[+-]\d/.test(name)) return name;
  } catch { /* fall through to the IANA city */ }
  return tz.split('/').pop().replace(/_/g, ' ');
}

// "יום שבת 26.9" — the same shape `meeting-option-moment.momentFor` writes, so
// a converted line reads like the ones people already know.
function dayOf(parts) {
  return `יום ${DAYS_HE[weekdayOfParts(parts)]} ${parts.d}.${parts.m}`;
}

// "יום שבת 26.9 20:00" in `tz`.
function localSlot(startsAt, tz) {
  const at = startsAt ? new Date(startsAt) : null;
  if (!at || Number.isNaN(at.getTime()) || !validZone(tz)) return null;
  const p = partsInZone(tz, at);
  return `${dayOf(p)} ${pad(p.hh)}:${pad(p.mi)}`;
}

// Whether a slot may be converted at all: it names a clock, it is not a whole
// day, and it is not a daypart the page picked. See the header.
function convertible(moment) {
  if (!moment || !moment.startsAt) return false;
  if (moment.allDay || moment.daypart) return false;
  if (moment.slot !== undefined && !statedHour(moment.slot)) return false;
  const at = new Date(moment.startsAt);
  return !Number.isNaN(at.getTime());
}

// The distinct clocks among `tzs` at one instant, the room's own zone first
// and the rest by offset, west to east. Zones sharing an offset collapse into
// one entry whose label joins their cities ("ישראל, יוון"), so nobody's city is
// dropped and nobody reads the same hour twice.
function distinctZones(tzs, instant, roomTz) {
  const at = instant instanceof Date ? instant : new Date(instant);
  const byOffset = new Map();
  const ordered = [roomTz, ...(tzs || [])].filter(validZone);
  for (const tz of ordered) {
    const offset = zoneOffsetMs(tz, at);
    const label = zoneLabel(tz);
    const entry = byOffset.get(offset);
    if (!entry) byOffset.set(offset, { tz, offset, labels: [label] });
    else if (!entry.labels.includes(label)) entry.labels.push(label);
  }
  const all = [...byOffset.values()];
  const roomOffset = validZone(roomTz) ? zoneOffsetMs(roomTz, at) : null;
  return all.sort((a, b) => {
    if (a.offset === roomOffset) return -1;
    if (b.offset === roomOffset) return 1;
    return a.offset - b.offset;
  }).map((z) => ({ tz: z.tz, label: z.labels.join(', ') }));
}

// The whole answer for one moment, or null when there is nothing to convert:
// a single clock among the people hearing it, or a slot that names no clock.
//   day:    "יום שבת 26.9", in the room's zone
//   lines:  ["20:00 ישראל", "13:00 ניו יורק", "03:00 סידני (יום ראשון 27.9)"]
//   inline: "יום שבת 26.9 · 20:00 ישראל · 13:00 ניו יורק · 03:00 סידני (יום ראשון 27.9)"
// A zone that lands on another calendar day says which one, because "03:00"
// alone in Sydney is the wrong night.
function roomTimes(moment, tzs, roomTz) {
  if (!convertible(moment)) return null;
  const at = new Date(moment.startsAt);
  const zones = distinctZones(tzs, at, roomTz);
  if (zones.length < 2) return null;
  const home = partsInZone(zones[0].tz, at);
  const homeDay = dayOf(home);
  const lines = zones.map((z) => {
    const p = partsInZone(z.tz, at);
    const other = p.y !== home.y || p.m !== home.m || p.d !== home.d;
    return `${pad(p.hh)}:${pad(p.mi)} ${z.label}${other ? ` (${dayOf(p)})` : ''}`;
  });
  return { day: homeDay, lines, inline: [homeDay, ...lines].join(' · ') };
}

// For ONE reader: the slot in their own clock, or null when their clock and
// the author's agree at that instant (or the slot names no clock). This is
// what a private message adds beside the proposer's words. An unknown author
// clock is null too: a row queued before payloads carried one says nothing
// rather than a guess about whose hour the words were in.
function readerSlot(moment, readerTz, authorTz) {
  if (!convertible(moment) || !validZone(readerTz) || !validZone(authorTz)) return null;
  const at = new Date(moment.startsAt);
  if (zoneOffsetMs(readerTz, at) === zoneOffsetMs(authorTz, at)) return null;
  const mine = partsInZone(readerTz, at);
  const theirs = partsInZone(authorTz, at);
  const sameDay = mine.y === theirs.y && mine.m === theirs.m && mine.d === theirs.d;
  return {
    slot: localSlot(at, readerTz),
    // Just the clock when the day is the same on both sides — "אצלך 10:00"
    // beside "יום שבת 26.9 20:00" says everything, and the day twice is noise.
    short: sameDay ? `${pad(mine.hh)}:${pad(mine.mi)}` : localSlot(at, readerTz),
    city: zoneLabel(readerTz),
  };
}

// Whether the people hearing a moment are on more than one clock right now —
// what decides which template a room line is drawn from.
function spansZones(tzs, roomTz, at = new Date()) {
  return distinctZones(tzs, at, roomTz).length > 1;
}

// The cities, in the room's order, for the opening line ("ישראל, ניו יורק
// וסידני"). Hebrew joins the last one with ו and no comma.
function citiesPhrase(tzs, roomTz, at = new Date()) {
  const labels = distinctZones(tzs, at, roomTz).map((z) => z.label);
  if (labels.length < 2) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} ו${labels[labels.length - 1]}`;
}

// ---- hours that suit every clock ---------------------------------------------
//
// Asked in פנתרה (2026-09-25): "את יכולה להציע שעות שמתאימות גם לאוסטרליה גם
// לניו יורק וגם לישראל". She had nothing to answer from and said she would ask
// everybody privately. This is the answer, computed rather than reasoned: every
// whole hour in the coming days at which it is a waking hour on every clock.
//
// The owner's three decisions (2026-09-25):
//   * a waking hour is 08:00-22:00 local, the hour a meeting STARTS; a day with
//     none is tried again at 07:00-23:00 and says it was widened;
//   * a clock that is only GUESSED (`timezone_confirmed` false) is shown beside
//     the answer and never counted into it — a wrong guess would otherwise
//     choose the hours for everybody;
//   * the result is drawn text, so the model repeats it instead of converting.
//
// `zones` is [{ tz, confirmed }]. Returns null when fewer than two distinct
// clocks are counted: one clock has no question to answer.
const COMMON_WINDOW = [8, 22];
const COMMON_WIDE = [7, 23];

function inWindow(hour, [lo, hi]) { return hour >= lo && hour <= hi; }

function sameDate(a, b) { return a.y === b.y && a.m === b.m && a.d === b.d; }

// "15:00" or "14:00–16:00" in one zone, plus the day when it is not the home
// day at the range's start.
function spanIn(tz, label, first, last, homeParts) {
  const a = partsInZone(tz, first);
  const b = partsInZone(tz, last);
  const hours = first.getTime() === last.getTime()
    ? `${pad(a.hh)}:00` : `${pad(a.hh)}:00–${pad(b.hh)}:00`;
  return `${hours} ${label}${sameDate(a, homeParts) ? '' : ` (${dayOf(a)})`}`;
}

function commonHours(zones, roomTz, { from = new Date(), days = 7 } = {}) {
  const list = (zones || []).filter((z) => z && validZone(z.tz));
  const counted = [...new Set(list.filter((z) => z.confirmed !== false).map((z) => z.tz))];
  const guessed = [...new Set(list.filter((z) => z.confirmed === false).map((z) => z.tz))]
    .filter((tz) => !counted.includes(tz));
  const home = validZone(roomTz) ? roomTz : counted[0];
  if (!home || distinctZones(counted, from, home).length < 2) return null;

  // Whole UTC hours from the next one on, grouped by the home clock's date.
  const start = new Date(Math.ceil(from.getTime() / 3600e3) * 3600e3);
  const byDay = new Map();
  for (let t = start.getTime(); t < start.getTime() + days * 86400e3; t += 3600e3) {
    const at = new Date(t);
    const key = dayOf(partsInZone(home, at));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(at);
  }

  const out = [];
  for (const [day, hours] of byDay) {
    const fits = (w) => hours.filter((at) => [home, ...counted]
      .every((tz) => inWindow(partsInZone(tz, at).hh, w)));
    let wide = false;
    let ok = fits(COMMON_WINDOW);
    if (!ok.length) { ok = fits(COMMON_WIDE); wide = ok.length > 0; }
    // Consecutive hours become one range.
    const ranges = [];
    for (const at of ok) {
      const r = ranges[ranges.length - 1];
      if (r && at.getTime() - r.last.getTime() === 3600e3) r.last = at;
      else ranges.push({ first: at, last: at });
    }
    const said = ranges.map(({ first, last }) => {
      const homeParts = partsInZone(home, first);
      const zs = distinctZones(counted, first, home);
      const line = zs.map((z) => spanIn(z.tz, z.label, first, last, homeParts)).join(' · ');
      const note = guessed.map((tz) => spanIn(tz, zoneLabel(tz), first, last, homeParts));
      return note.length ? `${line} (לא מאושר: ${note.join(', ')})` : line;
    });
    // A day the walk only clipped — today asked late in the evening, or the
    // last few hours of the range — and found nothing in is not news about
    // that day, and would lead or trail the answer with "no hour suits".
    if (said.length || hours.length >= 23) out.push({ day, wide, hours: said });
  }

  // Days that read the same collapse into one line, so a week of 15:00 is one
  // sentence and the day the clocks change stands out on its own.
  const lines = [];
  for (let i = 0; i < out.length;) {
    let j = i;
    const same = (a, b) => a.wide === b.wide && a.hours.join('|') === b.hours.join('|');
    while (j + 1 < out.length && same(out[j + 1], out[i])) j += 1;
    const when = i === j ? out[i].day : `${out[i].day} עד ${out[j].day}`;
    const what = out[i].hours.length
      ? out[i].hours.join(' / ') + (out[i].wide ? ' (מחוץ ל־08:00–22:00, בטווח 07:00–23:00)' : '')
      : 'אין שעה שמתאימה לכולם';
    lines.push(`${when}: ${what}`);
    i = j + 1;
  }
  return {
    clocks: distinctZones(counted, from, home).map((z) => z.label),
    ...(guessed.length ? { unconfirmed: guessed.map(zoneLabel) } : {}),
    lines,
  };
}

module.exports = {
  zoneLabel, localSlot, distinctZones, roomTimes, readerSlot, spansZones, citiesPhrase,
  convertible, commonHours, validZone, DAYS_HE, COMMON_WINDOW, COMMON_WIDE,
};
