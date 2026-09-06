'use strict';
// "Remind me at seven" — and something else was armed.
//
// This is the standing half of the fault that opened `onboarding-review.js`.
// That file reads what Olma SAID back and holds it against the data, three
// hours into a new person's life. It found Yahav's 19:00 promise against an
// 18:00 reminder. Then Miron — not a new user, nobody watching — said "תזכיר
// לי עוד שעתיים" at 11:29 and had 12:29 armed for him, and nothing in the
// system noticed for six hours, until a person read the conversation by hand.
//
// So this check watches the other side of the exchange, for everybody, every
// day: what the PERSON asked for, against what was actually armed a moment
// later. That is a far tighter question than what Olma said. "The meeting is
// at 19:00, I'll remind you" is ambiguous prose no regex should judge; "תזכיר
// לי ב-19:00" is an instruction with one correct outcome.
//
// It judges only when it can see BOTH halves — a moment they named, and a
// reminder armed in response to it. A request that produced no reminder at
// all is a different fault (or a conversation this reader cannot follow), and
// guessing at it is how a detector starts crying wolf.
const { partsInZone } = require('./datetime');

// The ask. Deliberately narrower than onboarding-review's REMINDER_WORDS: that
// one asks "is this sentence about a reminder", which is right for judging
// Olma's prose. Here we need "did they INSTRUCT one", so a bare mention of the
// noun does not qualify.
const ASK_RE = /תזכיר(י)?\s+ל[יינו]|תזכורת\s+ל?ב?-?\s*\d|remind\s+me|set\s+a\s+reminder/i;

// A clock time as people write it. Same shape as onboarding-review's, kept
// here rather than imported so the two can diverge if one needs to: they are
// answering different questions about different authors.
const TIME_RE = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g;
// "ב-19", "בשעה 7" — an hour with no minutes, which people write far more
// often than the full form when they are giving an instruction.
const BARE_HOUR_RE = /(?:בשעה|ב-|ב\s|at)\s*([01]?\d|2[0-3])(?![\d:.,])/gi;

// "עוד שעתיים", "בעוד חצי שעה", "in 2 hours". The moment is relative to when
// they wrote it, so this only means anything with the message's own timestamp.
const REL_HOURS = [
  [/בעוד\s+רבע\s+שעה|עוד\s+רבע\s+שעה/, 0.25],
  [/בעוד\s+חצי\s+שעה|עוד\s+חצי\s+שעה/, 0.5],
  [/(?:בעוד|עוד)\s+שעה\s+וחצי/, 1.5],
  [/(?:בעוד|עוד)\s+שעתיים/, 2],
  [/(?:בעוד|עוד)\s+שלוש\s+שעות/, 3],
  [/(?:בעוד|עוד)\s+ארבע\s+שעות/, 4],
  [/(?:בעוד|עוד)\s+(\d{1,2})\s+שעות/, null],
  [/in\s+(\d{1,2})\s+hours?/i, null],
  [/(?:בעוד|עוד)\s+שעה(?!\s*וחצי)/, 1],
];
const REL_MINUTES = [
  [/(?:בעוד|עוד)\s+(\d{1,3})\s+דקות/, null],
  [/in\s+(\d{1,3})\s+minutes?/i, null],
];

const hhmm = (ms, tz) => {
  const p = partsInZone(tz || 'UTC', new Date(ms));
  return `${String(p.hh).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
};

// Every moment this message could be asking for, as hh:mm in their clock.
// A SET, not a single answer: "תזכיר לי ב-7 או ב-8" is two acceptable
// outcomes, and a check that picked one of them would invent a fault.
function momentsAsked(text, atMs, tz) {
  const s = String(text || '');
  const out = new Set();
  for (const m of s.matchAll(TIME_RE)) {
    out.add(`${String(Number(m[1])).padStart(2, '0')}:${m[2]}`);
  }
  for (const m of s.matchAll(BARE_HOUR_RE)) {
    out.add(`${String(Number(m[1])).padStart(2, '0')}:00`);
  }
  if (Number.isFinite(atMs)) {
    for (const [re, fixed] of REL_HOURS) {
      const m = re.exec(s);
      if (!m) continue;
      const hours = fixed === null ? Number(m[1]) : fixed;
      if (Number.isFinite(hours) && hours > 0 && hours <= 24) out.add(hhmm(atMs + hours * 3600_000, tz));
      break;
    }
    for (const [re, fixed] of REL_MINUTES) {
      const m = re.exec(s);
      if (!m) continue;
      const mins = fixed === null ? Number(m[1]) : fixed;
      if (Number.isFinite(mins) && mins > 0 && mins <= 600) out.add(hhmm(atMs + mins * 60_000, tz));
      break;
    }
  }
  return out;
}

// How long after their message a reminder still counts as the answer to it.
// The turn itself takes seconds; five minutes is generous enough to cover a
// slow model and short enough that the next request is a different request.
const RESPONSE_WINDOW_MS = 5 * 60_000;

// evidence: { user:{id,timezone}, inbound:[{at,text}], reminders:[{id,remindAt,createdAt,cancelledAt}] }
function checkPromises(evidence) {
  const e = evidence || {};
  const tz = (e.user && e.user.timezone) || 'UTC';
  const out = [];
  for (const m of e.inbound || []) {
    if (!ASK_RE.test(String(m.text || ''))) continue;
    const atMs = Date.parse(m.at);
    if (!Number.isFinite(atMs)) continue;
    const asked = momentsAsked(m.text, atMs, tz);
    if (asked.size === 0) continue;               // they asked, but named no moment

    // What was armed in response. Cancelled rows are excluded: a reminder that
    // was set and then withdrawn was still the right answer at the time.
    const answered = (e.reminders || [])
      .filter((r) => !r.cancelledAt)
      .filter((r) => {
        const c = Date.parse(r.createdAt);
        return Number.isFinite(c) && c >= atMs && c - atMs <= RESPONSE_WINDOW_MS;
      });
    // Nothing armed at all is NOT reported here. It may be a request this
    // reader misparsed, a task saved without one, or a question Olma asked
    // back — three different stories, and only one of them is a fault.
    if (!answered.length) continue;

    const armed = answered.map((r) => ({ id: r.id, at: hhmm(Date.parse(r.remindAt), tz) }));
    if (armed.some((a) => asked.has(a.at))) continue;          // they got what they asked for

    out.push({
      id: 'asked_hour_not_armed',
      userId: e.user && e.user.id,
      at: m.at,
      asked: [...asked],
      armed,
      text: String(m.text).slice(0, 300),
    });
  }
  return out;
}

module.exports = { checkPromises, momentsAsked, ASK_RE, RESPONSE_WINDOW_MS };
