'use strict';
// Every fixed sentence Olma says is held to the brand book's two readable
// voice rules: no "!", and at most one emoji on a line. The failing cases are
// kept so the check can still go red — a check that cannot fail is not one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { voiceFlaws } = require('../src/domain/voice-rules');
const { flawsIn } = require('../src/domain/hebrew-quality');
const { TEMPLATES } = require('../src/domain/message-templates');

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
  assert.deepEqual(voiceFlaws('יש! כולם כאן 🎉').map((f) => f.kind), ['exclamation']);
  assert.deepEqual(voiceFlaws('כולם כאן 🎉🥳').map((f) => f.kind), ['emoji']);
  assert.deepEqual(voiceFlaws('Hi! 👋 🎉').map((f) => f.kind), ['exclamation', 'emoji']);
});

test('what the softened rule allows', () => {
  assert.deepEqual(voiceFlaws('כולם כאן. אפשר להתחיל 🎉'), []);
  assert.deepEqual(voiceFlaws('היי 👋 אני עולמה'), [], 'one emoji mid-line');
  assert.deepEqual(voiceFlaws('שורה אחת 👋\nשורה שנייה 🎉'), [], 'one per line, two lines');
  assert.deepEqual(voiceFlaws('השורה "יש! כולם כאן" לא נאמרת'), [], 'a quoted "!" is somebody else\'s');
  assert.deepEqual(voiceFlaws(''), []);
  assert.deepEqual(voiceFlaws(null), []);
});
