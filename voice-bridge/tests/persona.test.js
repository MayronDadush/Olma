'use strict';
// The pure half of the bridge: what a caller hears first and in which
// register. No Twilio, no audio, no database — the one part of a phone call
// a test runner can check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../lib/persona');

test('the default persona is the feminine אולמה, and its voice is the chosen one', () => {
  assert.deepEqual(p.DEFAULT_PERSONA, { gender: 'female', name: 'אולמה' });
  assert.equal(p.personaVoice(p.DEFAULT_PERSONA), p.VOICE_BY_GENDER.female);
  assert.equal(p.personaVoice({ gender: 'male' }), p.VOICE_BY_GENDER.male);
  assert.equal(p.personaVoice({ gender: 'other' }), p.VOICE_BY_GENDER.female, 'an unknown gender falls back, never to no voice');
});

test('gFor picks the feminine or masculine form, never mixes', () => {
  assert.equal(p.gFor({ gender: 'female' })('בודקת', 'בודק'), 'בודקת');
  assert.equal(p.gFor({ gender: 'male' })('בודקת', 'בודק'), 'בודק');
});

test('the default name is spoken with its ear-spelling, a custom name exactly as given', () => {
  const saved = process.env.VOICE_SPOKEN_NAME;
  delete process.env.VOICE_SPOKEN_NAME;
  try {
    assert.equal(p.spokenName(p.DEFAULT_PERSONA), p.DEFAULT_SPOKEN_NAME);
    assert.equal(p.spokenName({ gender: 'female', name: 'נועה' }), 'נועה');
    // The ear-spelling is a config line, read when spoken — not frozen at require.
    process.env.VOICE_SPOKEN_NAME = 'אוּלְמָה';
    assert.equal(p.spokenName(p.DEFAULT_PERSONA), 'אוּלְמָה');
  } finally {
    if (saved === undefined) delete process.env.VOICE_SPOKEN_NAME; else process.env.VOICE_SPOKEN_NAME = saved;
  }
});

test('the greeting names the person when known and speaks in the persona\'s register', () => {
  const saved = process.env.VOICE_SPOKEN_NAME;
  delete process.env.VOICE_SPOKEN_NAME;
  try {
    assert.equal(p.greetingText({ first_name: 'מירון' }, p.DEFAULT_PERSONA), `היי מירון, זאת ${p.DEFAULT_SPOKEN_NAME}. מה קורה?`);
    assert.equal(p.greetingText({ first_name: null }, { gender: 'male', name: 'רונן' }), 'היי, זה רונן. מה קורה?');
  } finally {
    if (saved === undefined) delete process.env.VOICE_SPOKEN_NAME; else process.env.VOICE_SPOKEN_NAME = saved;
  }
});
