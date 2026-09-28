'use strict';
// Who the assistant is on the phone — the pure half, with no database and no
// audio, so it can be tested without Twilio. Gender picks the voice AND the
// grammar (Hebrew has no neutral register — a male voice speaking in the
// feminine is wrong in every sentence), and the user may rename the
// assistant. The persona itself is read from the users row per call (server.js,
// loadPersona): the SAME columns WhatsApp's set_assistant_persona writes, so
// the two surfaces can never disagree.

const VOICE_BY_GENDER = {
  female: '2821fd0c-35c7-4adf-9c42-32e394bf85cb', // עדי — Miron's pick, tour #7
  male: '921f4026-af53-4761-ac56-1c32e44856e8',   // רונן — tour #12
};

// The persona is per USER, so it is per CALL — never a module global. Two
// people on the line at once may run opposite genders, and a shared global
// would have each call rewriting the other's voice mid-sentence.
const DEFAULT_PERSONA = { gender: 'female', name: 'עולמה' };
// Either Hebrew spelling counts as "the default name": עולמה is current, אולמה
// was the spelling for months and may still sit in assistant_name. Both are
// pronounced identically, so both take the phonetic default.
const DEFAULT_NAME_RE = /^[אע]ולמה$/;

function personaVoice(persona) {
  return VOICE_BY_GENDER[persona.gender] || VOICE_BY_GENDER.female;
}

// gFor(persona)(feminine, masculine) — every gendered word in
// prompt/greeting/fillers goes through this one switch.
const gFor = (persona) => (f, m) => (persona.gender === 'male' ? m : f);

// The default name is SPELLED differently for the ear than for the eye:
// Miron defined the pronunciation as "אול" + "מה" joined, and the spelling
// below is what steers the TTS closest to it. It lives in .env because
// picking it is an EAR decision made against a live engine, re-opened
// whenever the voice or the model changes — a config line, not a code edit.
// Read at call time, not at require time: server.js loads the .env files
// after its requires, and a value captured earlier would be the fallback.
// A custom name is spoken exactly as given.
const DEFAULT_SPOKEN_NAME = 'אוֹל מָה';
function spokenName(persona) {
  if (DEFAULT_NAME_RE.test(persona.name || '')) return process.env.VOICE_SPOKEN_NAME || DEFAULT_SPOKEN_NAME;
  return persona.name;
}

// Compliance review, 2026-09-28 (finding 5): the first sentence of a call now
// says she is not a person and that the call is transcribed. A human name in
// a human-sounding voice is exactly the case EU AI Act art. 50(1) is about,
// and the transcript is kept (server.js, `transcripts/`), so the person on
// the line is told before they say anything. Saying it costs one sentence
// once per call; the greeting is the only place it can be said before the
// first word of theirs is recorded.
//
// The text changed, so a frozen take keyed on the old text no longer
// matches and the greeting is spoken live until a new take is frozen
// (freeze-greeting.js) — the name's pronunciation rides that take.
function greetingText(user, persona) {
  const g = gFor(persona);
  return `היי${user.first_name ? ' ' + user.first_name : ''}, ${g('זאת', 'זה')} ${spokenName(persona)}, `
    + `${g('העוזרת הדיגיטלית', 'העוזר הדיגיטלי')} שלך. `
    + `אני ${g('מתמללת', 'מתמלל')} את השיחה כדי לשמור מה שנסכם. מה קורה?`;
}

module.exports = {
  VOICE_BY_GENDER, DEFAULT_PERSONA, DEFAULT_NAME_RE, DEFAULT_SPOKEN_NAME,
  personaVoice, gFor, spokenName, greetingText,
};
