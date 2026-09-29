'use strict';
// Every fixed sentence Olma says is held to the brand book's readable voice
// rules: at most one "!" in a message and never "!!", no "סגור!", and at most
// one emoji on a line. The failing cases are kept so the check can still go
// red — a check that cannot fail is not one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { voiceFlaws } = require('../src/domain/voice-rules');
const { flawsIn } = require('../src/domain/hebrew-quality');
const { TEMPLATES } = require('../src/domain/message-templates');

const kinds = (s) => voiceFlaws(s).map((f) => f.kind);

test('every default template keeps the voice rules', () => {
  const bad = TEMPLATES.map((t) => ({ key: t.key, flaws: voiceFlaws(t.text) }))
    .filter((r) => r.flaws.length);
  assert.deepEqual(bad, []);
});

test('every default template is free of the hebrew-quality slips too', () => {
  const bad = TEMPLATES.map((t) => ({ key: t.key, flaws: flawsIn(t.text) }))
    .filter((r) => r.flaws.length);
  assert.deepEqual(bad, []);
});

test('the check still goes red', () => {
  assert.deepEqual(kinds('מעולה!! הפגישה נקבעה'), ['double_exclamation']);
  // The two defaults this check changed, as they were.
  assert.deepEqual(kinds('היי! כאן עולמה. עכשיו נפתח מקום! אם עדיין רלוונטי'), ['exclamation']);
  assert.deepEqual(kinds('סגור! חמישי 20:00'), ['closed_exclamation']);
  assert.deepEqual(kinds('כולם כאן 🎉🥳'), ['emoji']);
  assert.deepEqual(kinds('מעולה!! 🎉🎉 הפגישה שלך נקבעה בהצלחה!'), ['double_exclamation', 'emoji']);
});

test('what the softened rules allow', () => {
  assert.deepEqual(voiceFlaws('יש! כולם כאן ואפשר להתחיל 🎉'), []);
  assert.deepEqual(voiceFlaws('היי! אני עולמה, עוזרת AI 👋 אני עוזרת לקבוצה'), [], 'one "!" and one emoji mid-line');
  assert.deepEqual(voiceFlaws('שורה אחת 👋\nשורה שנייה 🎉'), [], 'one emoji per line, two lines');
  assert.deepEqual(voiceFlaws('היי! השורה "יש! כולם כאן" לא נאמרת'), [], 'a quoted "!" is somebody else\'s');
  assert.deepEqual(voiceFlaws('סגור. חמישי 20:00'), []);
  assert.deepEqual(voiceFlaws(''), []);
  assert.deepEqual(voiceFlaws(null), []);
});
