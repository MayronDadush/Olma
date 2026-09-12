'use strict';
// Which calendar a person lives by, and what that implies about the days they
// are unlikely to want anything on.
//
// Pure and DB-free on purpose: the delivery gate reads it on every row and the
// check-in rung reads it to write a sentence somebody will read, so it must be
// cheap and it must give the same answer in both places. A second copy of
// "Hebrew means Saturday" in the copy and in the gate is how the message we
// send and the behaviour we deliver drift apart.

// A zone, not a country: `users.timezone` is what we actually hold, and it is
// the only field that is right about somebody who speaks English and lives in
// Tel Aviv. Sunday is a WORKING day in Israel, so guessing a Christian
// calendar for them would silence an ordinary Sunday — the expensive mistake
// in this pair, and the reason geography overrules language here.
const ISRAEL_ZONES = new Set(['Asia/Jerusalem', 'Asia/Tel_Aviv']);

function isIsrael(timezone) {
  return ISRAEL_ZONES.has(String(timezone || '').trim());
}

const CALENDARS = new Set(['jewish', 'christian', 'none']);

// jewish | christian | none.
//
// `preference` is the `holiday_calendar` preference row when there is one, and
// it wins outright — a person who has said which calendar they keep is never
// guessed about again. Nothing WRITES that key yet; the holiday layer is what
// teaches the model it exists, and reading it from the start is what keeps
// that a one-line change rather than a second decision point.
//
// There is no Muslim calendar here, and an Arabic speaker in Israel would get
// Saturday rather than Friday. That is a guess we know is wrong for them, left
// as a guess rather than invented: `quiet_days` is one sentence away and a row
// they state beats every rule in this file.
function calendarFor({ locale, timezone, preference } = {}) {
  const stated = String(preference || '').trim().toLowerCase();
  if (CALENDARS.has(stated)) return stated;
  if (String(locale || '').trim().toLowerCase().startsWith('he')) return 'jewish';
  if (isIsrael(timezone)) return 'jewish';
  return 'christian';
}

// The weekday index (0 = Sunday, matching preferences.DAY_NAMES and
// gate.weekdayInTz) that somebody on this calendar gets by default, or null
// when there is nothing to assume.
function defaultQuietDay(calendar) {
  if (calendar === 'jewish') return 6;    // Saturday
  if (calendar === 'christian') return 0; // Sunday
  return null;
}

// How that day is NAMED to the person. It lives here rather than beside the
// copy because the copy and the gate must never be able to disagree about
// which day this is — the check-in rung states it in the same message that
// announces the default hours, and the test pins the sentence to this table
// for exactly the reason it pins the hours to DEFAULT_WINDOW.
const QUIET_DAY_WORDS = {
  0: { he: 'בימי ראשון', en: 'on Sundays' },
  6: { he: 'בשבת', en: 'on Saturdays' },
};

function quietDayWord(day, locale) {
  const words = QUIET_DAY_WORDS[day];
  if (!words) return null;
  return String(locale || '').trim().toLowerCase().startsWith('en') ? words.en : words.he;
}

module.exports = {
  calendarFor, defaultQuietDay, quietDayWord,
  isIsrael, QUIET_DAY_WORDS, ISRAEL_ZONES,
};

// ---- the calendar itself ----------------------------------------------------
// Two tiers, and the difference is the whole feature:
//
//   quiet   — a day somebody may ask to receive nothing on but the reminders
//             they put there in words. Yom tov, and nothing else (owner,
//             2026-09-11): Chanukah and Purim are real and are also ordinary
//             working days, and a product that goes silent on them is broken
//             rather than respectful.
//   mention — a day Olma may acknowledge in a conversation she was having
//             anyway. It changes nothing about delivery.
//
// `solemn` is the third thing, orthogonal to both: a fast or a memorial day is
// mentioned without "happy".
const QUIET = 'quiet';
const MENTION = 'mention';

// hebcal is ESM-only and ~3.7MB of tables. Loaded on first use behind one
// cached promise rather than at require time: the MCP shim is started per
// process and spends its life answering tool calls that have nothing to do
// with a calendar, and brokerd's sweeps import this file transitively through
// preferences.js. A failed load answers "no holidays" for ever rather than
// throwing into the delivery gate — a calendar we could not read is not a day
// in trouble.
let hebcalPromise = null;
function hebcal() {
  if (!hebcalPromise) {
    hebcalPromise = import('@hebcal/core').catch((e) => {
      console.error('[holidays] @hebcal/core unavailable:', (e && e.message) || e);
      return null;
    });
  }
  return hebcalPromise;
}

// What a person actually marks. Everything hebcal emits that is not in here is
// dropped, and that is the point: a full year of its output is 64 days, more
// than half of them observances nobody would ever mention ("Hebrew Language
// Day", "Rosh Hashana LaBehemot", "Yom HaAliyah School Observance"). A hint
// that fires on an ordinary Tuesday is worse than no hint — it costs tokens on
// every turn it does not apply to and teaches the model to skim past hints.
//
// Keyed on `getDesc()`, hebcal's stable English identifier, never on the
// rendered name, which carries nikud and a Hebrew year. A prefix match covers
// the numbered families (Chanukah's eight candle-rows, Chol HaMoed's romans).
const MENTIONED = [
  // The evening before a yom tov — where a greeting actually belongs.
  { prefix: 'Erev ' },
  // Chol HaMoed. The person's week genuinely changes shape.
  { prefix: 'Pesach ' }, { prefix: 'Sukkot ' },
  { prefix: 'Chanukah' },
  { desc: 'Purim' }, { desc: 'Shushan Purim' },
  { desc: 'Tu BiShvat' }, { desc: 'Lag BaOmer' }, { desc: 'Tu B\'Av' },
  { desc: 'Pesach Sheni' }, { desc: 'Sigd' },
  // Fasts and memorial days: mentioned, never congratulated.
  { desc: 'Ta\'anit Esther', solemn: true },
  { desc: 'Tzom Gedaliah', solemn: true },
  { desc: 'Asara B\'Tevet', solemn: true },
  { desc: 'Tzom Tammuz', solemn: true },
  { desc: 'Tish\'a B\'Av', solemn: true },
  { desc: 'Yom HaShoah', solemn: true },
  { desc: 'Yom HaZikaron', solemn: true },
  { desc: 'Yom HaAtzma\'ut' }, { desc: 'Yom Yerushalayim' },
];

function mentionRule(desc) {
  for (const r of MENTIONED) {
    if (r.desc && r.desc === desc) return r;
    if (r.prefix && desc.startsWith(r.prefix)) return r;
  }
  return null;
}

// hebcal renders for a calendar app; this is a sentence somebody reads on a
// phone. Three things come off: nikud, because Olma writes without it
// everywhere else and one vowelled word inside an otherwise plain sentence
// reads as a quotation from somewhere; the Hebrew year it appends to Rosh
// Hashana; and the "(CH''M)" parenthetical, which is a calendar's annotation
// and not a name. The roman numeral STAYS — which day of Sukkot it is changes
// what the person is actually doing that week.
const NIKUD = /[\u0591-\u05C7]/g;
const HEBREW_YEAR = /\s*\b5\d{3}\b\s*/g;
const CHOL_HAMOED_TAG = /\s*\([^()]{0,6}(?:M|\u05DE)\)\s*/g;

function cleanName(name) {
  return String(name)
    .replace(NIKUD, '')
    .replace(HEBREW_YEAR, ' ')
    .replace(CHOL_HAMOED_TAG, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// One Gregorian year of one calendar, as date → events. Memoized: the gate
// reads this per outbox row.
const jewishCache = new Map();

async function jewishYear(year, il) {
  const key = `${year}:${il ? 'il' : 'chul'}`;
  if (jewishCache.has(key)) return jewishCache.get(key);
  const built = (async () => {
    const h = await hebcal();
    const byDate = new Map();
    if (!h) return byDate;
    const events = h.HebrewCalendar.calendar({ year, isHebrewYear: false, il, numYears: 1 });
    for (const ev of events) {
      const desc = ev.getDesc();
      const isChag = Boolean(ev.getFlags() & h.flags.CHAG);
      const rule = isChag ? {} : mentionRule(desc);
      if (!rule) continue;
      const d = ev.getDate().greg();
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const entry = {
        key: desc,
        tier: isChag ? QUIET : MENTION,
        // Yom Kippur is a yom tov AND the day of the year least wished a happy
        // one, so this is read off the flags rather than off the tier.
        solemn: Boolean(rule.solemn) || Boolean(ev.getFlags() & (h.flags.MAJOR_FAST | h.flags.MINOR_FAST)),
        name: { he: cleanName(ev.render('he')), en: cleanName(ev.render('en')) },
      };
      if (!byDate.has(ymd)) byDate.set(ymd, []);
      byDate.get(ymd).push(entry);
    }
    return byDate;
  })();
  jewishCache.set(key, built);
  return built;
}

// ---- the Christian side, by hand --------------------------------------------
// Five fixed dates and one computation. A second dependency for Easter would
// be a 3MB package to answer one arithmetic question that has not changed
// since 1583 — this is Meeus/Jones/Butcher, Western (Gregorian) Easter.
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const hh = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - hh - k) % 7;
  const m = Math.floor((a + 11 * hh + 22 * l) / 451);
  const month = Math.floor((hh + l - 7 * m + 114) / 31);
  const day = ((hh + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const ymdOf = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const plusDays = (d, n) => new Date(d.getTime() + n * 86_400_000);

const christianCache = new Map();

function christianYear(year) {
  if (christianCache.has(year)) return christianCache.get(year);
  const easter = easterSunday(year);
  const rows = [
    { date: ymdOf(plusDays(easter, -2)), key: 'Good Friday', tier: QUIET, solemn: true, he: 'יום שישי הטוב', en: 'Good Friday' },
    { date: ymdOf(easter), key: 'Easter', tier: QUIET, solemn: false, he: 'פסחא', en: 'Easter Sunday' },
    { date: ymdOf(plusDays(easter, 1)), key: 'Easter Monday', tier: MENTION, solemn: false, he: 'שני של פסחא', en: 'Easter Monday' },
    { date: `${year}-12-24`, key: 'Christmas Eve', tier: MENTION, solemn: false, he: 'ערב חג המולד', en: 'Christmas Eve' },
    { date: `${year}-12-25`, key: 'Christmas', tier: QUIET, solemn: false, he: 'חג המולד', en: 'Christmas Day' },
    { date: `${year}-12-26`, key: 'Boxing Day', tier: MENTION, solemn: false, he: 'יום הקופסאות', en: 'Boxing Day' },
    { date: `${year}-12-31`, key: 'New Year\'s Eve', tier: MENTION, solemn: false, he: 'ערב השנה האזרחית', en: 'New Year\'s Eve' },
    { date: `${year}-01-01`, key: 'New Year\'s Day', tier: MENTION, solemn: false, he: 'ראש השנה האזרחית', en: 'New Year\'s Day' },
  ];
  const byDate = new Map();
  for (const r of rows) {
    const entry = { key: r.key, tier: r.tier, solemn: r.solemn, name: { he: r.he, en: r.en } };
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(entry);
  }
  christianCache.set(year, byDate);
  return byDate;
}

// ---- what callers ask ------------------------------------------------------

// Every marked event on one LOCAL calendar date, most significant first.
// `[]` means "read the calendar, nothing there"; it is never used to mean
// "could not read", which is what the load failure above turns into a logged
// empty calendar rather than a throw.
async function holidaysOn(calendar, ymd, { il = false } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return [];
  const year = Number(String(ymd).slice(0, 4));
  const byDate = calendar === 'jewish' ? await jewishYear(year, il)
    : calendar === 'christian' ? christianYear(year)
      : null;
  if (!byDate) return [];
  const found = byDate.get(ymd) || [];
  return [...found].sort((a, b) => (a.tier === QUIET ? 0 : 1) - (b.tier === QUIET ? 0 : 1));
}

const { partsInZone } = require('./datetime');

// The local calendar date in their zone, `n` days from an instant. The gate
// judges a quiet day in THEIR zone for the same reason weekdayInTz does:
// 23:00 UTC on the 24th is already the 25th in Jerusalem.
function localDate(tz, date, n = 0) {
  const p = partsInZone(tz, new Date(date.getTime() + n * 86_400_000));
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// The quiet-tier dates in the window the gate needs to look across. A window
// rather than one day because the gate has to know when to WAKE a held row,
// and Rosh Hashana runs into Shabbat often enough that "tomorrow" is not an
// answer.
async function quietDates(calendar, { tz, from = new Date(), days = 21, il = false } = {}) {
  const out = [];
  for (let n = 0; n <= days; n++) {
    const ymd = localDate(tz, from, n);
    const on = await holidaysOn(calendar, ymd, { il });
    if (on.some((e) => e.tier === QUIET)) out.push(ymd);
  }
  return out;
}

// The next quiet-tier holiday within the window, for the one-time offer.
// Returns the erev too when there is one, because the evening before is when
// somebody wants to have already decided.
async function nextQuietHoliday(calendar, { tz, from = new Date(), days = 21, il = false, locale } = {}) {
  for (let n = 0; n <= days; n++) {
    const ymd = localDate(tz, from, n);
    const on = await holidaysOn(calendar, ymd, { il });
    const chag = on.find((e) => e.tier === QUIET);
    if (chag) return { key: chag.key, date: ymd, inDays: n, name: nameFor(chag, locale), solemn: chag.solemn };
  }
  return null;
}

function nameFor(entry, locale) {
  if (!entry) return null;
  return String(locale || '').trim().toLowerCase().startsWith('en') ? entry.name.en : entry.name.he;
}

// ---- the Israeli Shabbat window (candle-lighting to havdalah) --------------
// "Saturday is quiet" as a whole calendar day is a blunt proxy for Shabbat,
// which actually starts Friday evening and ends Saturday night, both edges
// moving with sunset across the year (owner, 2026-09-12: astronomical, not a
// fixed clock hour). Scoped to `isIsrael` on purpose — a diaspora Jewish
// user's default Saturday stays a plain weekday for now, and this is what
// replaces it: one reference point stands in for the whole country, because
// `users.timezone` only ever says "Asia/Jerusalem" and never a city.
let shabbatLocationPromise = null;
function shabbatLocation() {
  if (!shabbatLocationPromise) {
    shabbatLocationPromise = hebcal().then((h) => (h ? h.Location.lookup('Tel Aviv') : null));
  }
  return shabbatLocationPromise;
}

// Candle-lighting → havdalah for the Shabbat nearest `date`, keyed by the
// Saturday's own local date so a busy Friday costs one lookup.
//
// Computed straight off `Zmanim` — sunset minus 20 (hebcal's own fallback for
// an Israeli location with no more specific city data, `overrideIsraelCandleMins`)
// for candle-lighting, tzeit at 8.5° (hebcal's own default, "three small
// stars") for havdalah — deliberately NOT `HebrewCalendar.calendar`'s own
// narrative events. Those defer Havdalah when a chag rides the same weekend
// (Rosh Hashana on Shabbat pushes it a night later), and that deferral is
// EXACTLY what `preferences.quietDays`'s `holidays` opt-in gates — chag-quiet
// is something a person asks for, never a side effect of a plain Saturday
// preference (CLAUDE.md, "A chag is QUIET only for somebody who asked for
// it"). Using the narrative events here would have silenced an ordinary
// Sunday for every Israeli user with no such opt-in, the one weekend Rosh
// Hashana falls on Shabbat. So this window is always the PLAIN Shabbat, and
// an opted-in chag riding beside it is still covered — by `quietDates`,
// exactly as before this existed, continuing the hold past `end` below.
// `null` means hebcal could not load (same fail-open shape as everywhere
// else in this file) or the sun does not set that day at all, which cannot
// happen at this latitude but `Zmanim` answers `Invalid Date` rather than
// throw, so it is checked instead of trusted.
const CANDLE_LIGHTING_MINS = 20;
const HAVDALAH_DEG = 8.5;
const shabbatCache = new Map();

async function shabbatWindow(tz, date = new Date()) {
  if (!isIsrael(tz)) return null;
  const h = await hebcal();
  const loc = await shabbatLocation();
  if (!h || !loc) return null;
  // The weekday of a Y-M-D string never depends on a clock, so the nearest
  // Saturday (today counts) is found off `localDate` rather than a second
  // zone computation. Friday is one calendar day before THAT Saturday, not a
  // second forward search off today's weekday — the forward formula wraps a
  // whole week ahead when today already IS Saturday, landing next week's
  // Friday instead of yesterday's.
  const todayYmd = localDate(tz, date, 0);
  const dow = new Date(`${todayYmd}T00:00:00Z`).getUTCDay();
  const satOffset = (6 - dow + 7) % 7;
  const satYmd = localDate(tz, date, satOffset);
  if (shabbatCache.has(satYmd)) return shabbatCache.get(satYmd);
  const built = (() => {
    const friYmd = localDate(tz, date, satOffset - 1);
    // Noon UTC on each date: `Zmanim` reads only the calendar date off
    // whatever Date it is given (hours are ignored), so this just needs to
    // land on the right Gregorian day everywhere, which noon safely does.
    const [fy, fm, fd] = friYmd.split('-').map(Number);
    const [sy, sm, sd] = satYmd.split('-').map(Number);
    const start = new h.Zmanim(loc, new Date(Date.UTC(fy, fm - 1, fd, 12)), false)
      .sunsetOffset(-CANDLE_LIGHTING_MINS, true);
    const end = new h.Zmanim(loc, new Date(Date.UTC(sy, sm - 1, sd, 12)), false)
      .tzeit(HAVDALAH_DEG);
    return (start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()))
      ? { start, end } : null;
  })();
  shabbatCache.set(satYmd, built);
  return built;
}

module.exports.QUIET = QUIET;
module.exports.MENTION = MENTION;
module.exports.holidaysOn = holidaysOn;
module.exports.quietDates = quietDates;
module.exports.nextQuietHoliday = nextQuietHoliday;
module.exports.localDate = localDate;
module.exports.nameFor = nameFor;
module.exports.easterSunday = easterSunday;
module.exports.cleanName = cleanName;
module.exports.shabbatWindow = shabbatWindow;
