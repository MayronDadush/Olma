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
const PREFIXES = [
  // longest-first matching matters, so keep specific codes above generic ones
  { code: '972', country: 'ישראל', tz: 'Asia/Jerusalem', lang: 'he' },
  { code: '970', country: 'פלסטין', tz: 'Asia/Hebron', lang: 'ar' },
  { code: '971', country: 'איחוד האמירויות', tz: 'Asia/Dubai', lang: 'ar' },
  { code: '44', country: 'בריטניה', tz: 'Europe/London', lang: 'en' },
  { code: '33', country: 'צרפת', tz: 'Europe/Paris', lang: 'fr' },
  { code: '49', country: 'גרמניה', tz: 'Europe/Berlin', lang: 'de' },
  { code: '39', country: 'איטליה', tz: 'Europe/Rome', lang: 'it' },
  { code: '34', country: 'ספרד', tz: 'Europe/Madrid', lang: 'es' },
  { code: '31', country: 'הולנד', tz: 'Europe/Amsterdam', lang: 'nl' },
  { code: '32', country: 'בלגיה', tz: 'Europe/Brussels', lang: 'nl' },
  { code: '41', country: 'שווייץ', tz: 'Europe/Zurich', lang: 'de' },
  { code: '43', country: 'אוסטריה', tz: 'Europe/Vienna', lang: 'de' },
  { code: '30', country: 'יוון', tz: 'Europe/Athens', lang: 'el' },
  { code: '351', country: 'פורטוגל', tz: 'Europe/Lisbon', lang: 'pt' },
  { code: '353', country: 'אירלנד', tz: 'Europe/Dublin', lang: 'en' },
  { code: '380', country: 'אוקראינה', tz: 'Europe/Kyiv', lang: 'uk' },
  { code: '48', country: 'פולין', tz: 'Europe/Warsaw', lang: 'pl' },
  { code: '90', country: 'טורקיה', tz: 'Europe/Istanbul', lang: 'tr' },
  { code: '20', country: 'מצרים', tz: 'Africa/Cairo', lang: 'ar' },
  { code: '27', country: 'דרום אפריקה', tz: 'Africa/Johannesburg', lang: 'en' },
  { code: '212', country: 'מרוקו', tz: 'Africa/Casablanca', lang: 'ar' },
  { code: '91', country: 'הודו', tz: 'Asia/Kolkata', lang: 'hi' },
  { code: '81', country: 'יפן', tz: 'Asia/Tokyo', lang: 'ja' },
  { code: '82', country: 'דרום קוריאה', tz: 'Asia/Seoul', lang: 'ko' },
  { code: '65', country: 'סינגפור', tz: 'Asia/Singapore', lang: 'en' },
  { code: '852', country: 'הונג קונג', tz: 'Asia/Hong_Kong', lang: 'zh' },
  { code: '66', country: 'תאילנד', tz: 'Asia/Bangkok', lang: 'th' },
  { code: '55', country: 'ברזיל', tz: 'America/Sao_Paulo', ambiguous: true, lang: 'pt' },
  { code: '52', country: 'מקסיקו', tz: 'America/Mexico_City', ambiguous: true, lang: 'es' },
  { code: '54', country: 'ארגנטינה', tz: 'America/Argentina/Buenos_Aires', lang: 'es' },
  { code: '61', country: 'אוסטרליה', tz: 'Australia/Sydney', ambiguous: true, lang: 'en' },
  { code: '64', country: 'ניו זילנד', tz: 'Pacific/Auckland', lang: 'en' },
  { code: '7', country: 'רוסיה/קזחסטן', tz: 'Europe/Moscow', ambiguous: true, lang: 'ru' },
  { code: '86', country: 'סין', tz: 'Asia/Shanghai', lang: 'zh' },
  { code: '1', country: 'ארה"ב/קנדה', tz: 'America/New_York', ambiguous: true, lang: 'en' },
];

// Longest code first, so 972 wins over 97 and 351 over 35.
const SORTED = [...PREFIXES].sort((a, b) => b.code.length - a.code.length);

function lookupTimezone(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  for (const e of SORTED) {
    if (digits.startsWith(e.code)) {
      return { country: e.country, timezone: e.tz, lang: e.lang, ambiguous: Boolean(e.ambiguous) };
    }
  }
  return null;
}

// Just the zone, for callers that only need somewhere sane to start.
function timezoneForPhone(phone) {
  const hit = lookupTimezone(phone);
  return hit ? hit.timezone : null;
}

module.exports = { lookupTimezone, timezoneForPhone, PREFIXES };
