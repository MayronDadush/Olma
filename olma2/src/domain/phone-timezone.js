'use strict';
// Phone dialling code -> timezone guess. Ported from v1 (broker/phone-timezone.js),
// which got the reasoning right and was simply left behind by the cutover.
//
// WhatsApp does not expose a user's timezone — verified in v1: the peer
// directory carries no locale/tz field and the pairing payload has only a push
// name. The dialling code is the only signal available at provisioning time.
//
// Why this matters more in v2 than it did in v1: here `users.timezone` is read
// by the outbox delivery gate and the digest sweep. NULL falls back to UTC, so
// an Israeli user's 09:00-20:00 quiet-hours window silently ran 12:00-23:00
// local, and every scheduled digest fired three hours late. Every v2 user row
// had NULL until this was wired in (2026-08-18).
//
// `ambiguous: true` = the country spans several zones, so the guess is a
// starting point the agent must confirm rather than an answer. Provisioning
// therefore always stores it with timezone_confirmed = false.

// `lang` is the language most likely spoken there — used ONLY when the
// person's own text carries no language signal at all (see domain/language.js).
// Real text always wins over this guess.
//
// `len` is the TOTAL digit count of an E.164 number from that country, country
// code included, and it is here rather than in a table of its own so there is
// one row per country to keep right (`CLAUDE.md`, "A test that asserts on a
// replica of a query cannot fail when the original drifts" — the same argument
// about a second copy of anything). It exists for `phoneShape` below, not for
// the timezone guess, which never cared how long the number was.
//
// **Mobile lengths, deliberately.** WhatsApp only registers a mobile number,
// so a landline plan that happens to be shorter or longer is not a number that
// can reach us. Several countries genuinely issue more than one mobile length
// and carry both; narrowing those would silence a real person, which is the one
// direction that must never be wrong.
const PREFIXES = [
  // longest-first matching matters, so keep specific codes above generic ones
  { code: '972', country: 'ישראל', tz: 'Asia/Jerusalem', lang: 'he', len: [12] },
  { code: '970', country: 'פלסטין', tz: 'Asia/Hebron', lang: 'ar', len: [12] },
  { code: '971', country: 'איחוד האמירויות', tz: 'Asia/Dubai', lang: 'ar', len: [12] },
  { code: '44', country: 'בריטניה', tz: 'Europe/London', lang: 'en', len: [12] },
  { code: '33', country: 'צרפת', tz: 'Europe/Paris', lang: 'fr', len: [11] },
  { code: '49', country: 'גרמניה', tz: 'Europe/Berlin', lang: 'de', len: [12, 13] },
  { code: '39', country: 'איטליה', tz: 'Europe/Rome', lang: 'it', len: [12, 13] },
  { code: '34', country: 'ספרד', tz: 'Europe/Madrid', lang: 'es', len: [11] },
  { code: '31', country: 'הולנד', tz: 'Europe/Amsterdam', lang: 'nl', len: [11] },
  { code: '32', country: 'בלגיה', tz: 'Europe/Brussels', lang: 'nl', len: [11] },
  { code: '41', country: 'שווייץ', tz: 'Europe/Zurich', lang: 'de', len: [11] },
  { code: '43', country: 'אוסטריה', tz: 'Europe/Vienna', lang: 'de', len: [12, 13] },
  { code: '30', country: 'יוון', tz: 'Europe/Athens', lang: 'el', len: [12] },
  { code: '351', country: 'פורטוגל', tz: 'Europe/Lisbon', lang: 'pt', len: [12] },
  { code: '353', country: 'אירלנד', tz: 'Europe/Dublin', lang: 'en', len: [12] },
  { code: '380', country: 'אוקראינה', tz: 'Europe/Kyiv', lang: 'uk', len: [12] },
  { code: '48', country: 'פולין', tz: 'Europe/Warsaw', lang: 'pl', len: [11] },
  { code: '90', country: 'טורקיה', tz: 'Europe/Istanbul', lang: 'tr', len: [12] },
  { code: '20', country: 'מצרים', tz: 'Africa/Cairo', lang: 'ar', len: [12] },
  { code: '27', country: 'דרום אפריקה', tz: 'Africa/Johannesburg', lang: 'en', len: [11] },
  { code: '212', country: 'מרוקו', tz: 'Africa/Casablanca', lang: 'ar', len: [12] },
  { code: '91', country: 'הודו', tz: 'Asia/Kolkata', lang: 'hi', len: [12] },
  { code: '81', country: 'יפן', tz: 'Asia/Tokyo', lang: 'ja', len: [12] },
  { code: '82', country: 'דרום קוריאה', tz: 'Asia/Seoul', lang: 'ko', len: [12] },
  { code: '65', country: 'סינגפור', tz: 'Asia/Singapore', lang: 'en', len: [10] },
  { code: '852', country: 'הונג קונג', tz: 'Asia/Hong_Kong', lang: 'zh', len: [11] },
  { code: '66', country: 'תאילנד', tz: 'Asia/Bangkok', lang: 'th', len: [11] },
  { code: '55', country: 'ברזיל', tz: 'America/Sao_Paulo', ambiguous: true, lang: 'pt', len: [12, 13] },
  { code: '52', country: 'מקסיקו', tz: 'America/Mexico_City', ambiguous: true, lang: 'es', len: [12, 13] },
  { code: '54', country: 'ארגנטינה', tz: 'America/Argentina/Buenos_Aires', lang: 'es', len: [12, 13] },
  { code: '61', country: 'אוסטרליה', tz: 'Australia/Sydney', ambiguous: true, lang: 'en', len: [11] },
  { code: '64', country: 'ניו זילנד', tz: 'Pacific/Auckland', lang: 'en', len: [11, 12] },
  { code: '7', country: 'רוסיה/קזחסטן', tz: 'Europe/Moscow', ambiguous: true, lang: 'ru', len: [11] },
  { code: '86', country: 'סין', tz: 'Asia/Shanghai', lang: 'zh', len: [13] },
  { code: '1', country: 'ארה"ב/קנדה', tz: 'America/New_York', ambiguous: true, lang: 'en', len: [11] },
];

// Longest code first, so 972 wins over 97 and 351 over 35.
const SORTED = [...PREFIXES].sort((a, b) => b.code.length - a.code.length);

// +1 spans six zones, and the three digits after it say which one far better
// than "New York" does: u-40, an Israeli in Los Angeles on a 213 number, was
// stored on Eastern time and every check-in reached him three hours early
// (2026-09-30). An area code is where the number was ISSUED, not where its
// owner is today, so the answer stays `ambiguous` and unconfirmed exactly as
// before — this only moves the starting guess. Only codes whose whole area
// keeps one clock are listed; a split code takes the zone most of its people
// live on (Idaho's 208 is Boise, Mountain). Anything unlisted — the East
// Coast, Ontario, Quebec, the Caribbean — keeps America/New_York.
const NANP_ZONES = {
  'America/Los_Angeles': [
    // California
    209, 213, 279, 310, 323, 341, 350, 408, 415, 424, 442, 510, 530, 559, 562,
    619, 626, 628, 650, 657, 661, 669, 707, 714, 747, 760, 805, 818, 820, 831,
    840, 858, 909, 916, 925, 949, 951,
    206, 253, 360, 425, 509, 564, // Washington
    458, 503, 541, 971, // Oregon
    702, 725, 775, // Nevada
  ],
  'America/Vancouver': [236, 250, 604, 672, 778],
  'America/Denver': [
    303, 719, 720, 970, 983, // Colorado
    385, 435, 801, // Utah
    505, 575, // New Mexico
    307, 406, 208, 986, // Wyoming, Montana, Idaho
    915, // El Paso
  ],
  'America/Edmonton': [368, 403, 587, 780, 825],
  // No daylight saving: Denver would be an hour off half the year.
  'America/Phoenix': [480, 520, 602, 623, 928],
  'America/Regina': [306, 474, 639],
  'America/Chicago': [
    // Texas (El Paso is Mountain, above)
    210, 214, 254, 281, 325, 346, 361, 409, 430, 432, 469, 512, 682, 713, 726,
    737, 806, 817, 830, 832, 903, 936, 940, 945, 956, 972, 979,
    // Illinois
    217, 224, 309, 312, 331, 447, 464, 618, 630, 708, 730, 773, 779, 815, 847, 872,
    262, 274, 353, 414, 534, 608, 715, 920, // Wisconsin
    218, 320, 507, 612, 651, 763, 952, // Minnesota
    319, 515, 563, 641, 712, // Iowa
    235, 314, 417, 557, 573, 636, 660, 816, 975, // Missouri
    327, 479, 501, 870, // Arkansas
    225, 318, 337, 504, 985, // Louisiana
    228, 601, 662, 769, // Mississippi
    205, 251, 256, 334, 659, 938, // Alabama
    405, 539, 572, 580, 918, // Oklahoma
    316, 620, 785, 913, // Kansas
    308, 402, 531, // Nebraska
    605, 701, // the Dakotas
    615, 629, 731, 901, 931, // Tennessee, west of the Cumberland Plateau
    270, 364, // western Kentucky
    448, 850, // the Florida panhandle
    219, // north-west Indiana
  ],
  'America/Winnipeg': [204, 431],
  'America/Halifax': [506, 782, 902],
  'America/St_Johns': [709, 879],
  'America/Anchorage': [907],
  'Pacific/Honolulu': [808],
};

const NANP = new Map();
for (const [tz, codes] of Object.entries(NANP_ZONES)) {
  for (const code of codes) NANP.set(String(code), tz);
}

function lookupTimezone(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  for (const e of SORTED) {
    if (digits.startsWith(e.code)) {
      // `code` travels with the answer because a caller that wants to SHOW
      // its reasoning ("your number starts +972") cannot re-derive which
      // prefix matched — the codes vary from one digit to three, and slicing
      // a fixed number off the phone produces "+9725".
      const tz = (e.code === '1' && NANP.get(digits.slice(1, 4))) || e.tz;
      return { code: e.code, country: e.country, timezone: tz, lang: e.lang, ambiguous: Boolean(e.ambiguous) };
    }
  }
  return null;
}

// Just the zone, for callers that only need somewhere sane to start.
function timezoneForPhone(phone) {
  const hit = lookupTimezone(phone);
  return hit ? hit.timezone : null;
}

// ---- is this a phone number at all? ----------------------------------------

// WhatsApp hands us a member of a group either by number or by an internal LID,
// in the same field, with no marker to sort them by — `chat_group_members.phone`
// holds both (`domain/groups.resolveLidMembers`). Everything downstream then
// treats a LID as an address: `users.phone` is UNIQUE and feeds
// `user_channels.channel_identifier`, `timezoneForPhone` above answers a LID
// with a confident WRONG country, and a queued message to one is retried every
// ten minutes for ever, because the delivery gate has no "this person cannot be
// reached" (`outbox/worker.js`, the backoff caps at ten minutes).
//
// THREE answers, not two, for the reason the group code already gives for
// everything else (`rules/groups.md`, "NULL is the honest third state and a
// guess never acts"):
//
//   'phone'     — a dialling code we know, at a length that country issues.
//   'not_phone' — a dialling code we know, at a length it does not. Confident.
//   'unknown'   — no dialling code we know. We cannot say, and a caller that
//                 needs certainty must refuse it while one that only wants to
//                 avoid a confident mistake may let it through.
//
// **Measured against the only corpus of real LIDs that exists** — the 2,673
// reverse mappings the gateway itself had resolved on the box, 2026-09-24:
// 1,654 'not_phone', 1,013 'unknown', and **6 'phone'** (0.22%), all six in
// Italy, Germany, Mexico and Brazil, the countries whose two mobile lengths are
// both carried above. Zero Israeli, zero British, zero American. Against the
// other side — every one of the 30 real users plus every live roster number, 34
// distinct values — **34 of 34 answered 'phone'**, so nothing here silences
// anybody who exists today. It is a filter, never a guarantee; the airtight
// answer is still upstream, in the gateway's own map.
function phoneShape(value) {
  const digits = String(value == null ? '' : value).trim().replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return 'not_phone';
  const hit = SORTED.find((e) => digits.startsWith(e.code));
  if (!hit) return 'unknown';
  return hit.len.includes(digits.length) ? 'phone' : 'not_phone';
}

// The strict question, for a caller about to write the value somewhere it can
// never be taken back — a `users` row, an allow-list, a send. 'unknown' is a
// no here on purpose: a row created on a guess outlives the guess.
function isRealPhone(value) {
  return phoneShape(value) === 'phone';
}

module.exports = { lookupTimezone, timezoneForPhone, phoneShape, isRealPhone, PREFIXES, NANP_ZONES };
