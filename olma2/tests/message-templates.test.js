'use strict';
// The fixed sentences and the one place they can be reworded without a deploy.
//
// What matters here is not that a string can be replaced — it is what an
// override CANNOT do: drop the tags out of a nudge, invent a placeholder the
// code will never fill, or make a fresh install say something other than the
// reviewed default. Every guard is exercised through the same functions the
// senders call.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const templates = require('../src/domain/message-templates');
const text = require('../src/domain/proactive-text');
const messages = require('../src/intake/messages');

test('every default passes its own validation, and keys are unique', () => {
  const seen = new Set();
  for (const t of templates.TEMPLATES) {
    assert.ok(!seen.has(t.key), `duplicate key ${t.key}`);
    seen.add(t.key);
    assert.ok(['private', 'group'].includes(t.audience), t.key);
    assert.deepEqual(templates.validate(t.key, t.text), { ok: true }, t.key);
    for (const r of t.required) assert.ok(Object.hasOwn(t.vars, r), `${t.key}: required ${r} is not a var`);
    // A default must use every placeholder it declares required — otherwise
    // an override could not be asked to keep it.
    const used = templates.placeholdersIn(t.text);
    for (const r of t.required) assert.ok(used.has(r), `${t.key}: default does not use {{${r}}}`);
  }
});

test('with nothing stored, every sender says exactly the reviewed default', () => {
  assert.equal(text.renderGroupGateNotice({ kind: 'nudge', missing: ['+972501111111'] }),
    'עוד מחכה ל: @+972501111111  🧐');
  assert.equal(text.renderReminderText({ title: 'לקחת תרופה' }), '⏰ תזכורת: לקחת תרופה');
  assert.equal(text.renderGroupTooLarge(25), templates.spec('group_too_large').text.replace('{{max}}', '25'));
  assert.match(messages.introMessage({ inviterName: 'דני', inviterPhone: '+972501', phone: '+972502' }),
    /דני \(\+972501\) ביקש\/ה להתחבר אליך דרכי\./);
  assert.match(messages.introMessage({ inviterName: 'דני', inviterPhone: '+972501', reason: 'פאדל', phone: '+972502' }),
    /דרכי — פאדל\./);
  assert.match(messages.introMessage({ inviterName: 'Dan', inviterPhone: '+1555', phone: '+1555' }), /^Hi! This is Olma/);
  assert.equal(messages.reopenMessage('+972501'), templates.spec('reopen_he').text);
  assert.equal(messages.reopenMessage('+1555'), templates.spec('reopen_en').text);
});

test('an override replaces the sentence and keeps the placeholders working', () => {
  const overrides = {
    group_gate_nudge: 'נו, {{missing}}?',
    reminder: '🔔 {{title}}',
    stranger_intro_he: '{{inviter_name}} ({{inviter_phone}}) רוצה אותך כאן{{reason}}',
    reopen_en: 'Room now. Reply here.',
  };
  assert.equal(text.renderGroupGateNotice({ kind: 'nudge', missing: ['+972501111111'] }, overrides),
    'נו, @+972501111111?');
  assert.equal(text.renderReminderText({ title: 'תרופה' }, overrides), '🔔 תרופה');
  // untouched keys still say the default
  assert.equal(text.renderReminderText({ title: 'תרופה', attempt: 2 }, overrides),
    text.renderReminderText({ title: 'תרופה', attempt: 2 }));
  assert.equal(messages.introMessage({ inviterName: 'דני', inviterPhone: '+972501', phone: '+972502' }, overrides),
    'דני (+972501) רוצה אותך כאן');
  assert.equal(messages.reopenMessage('+1555', overrides), 'Room now. Reply here.');
  assert.equal(messages.reopenMessage('+972501', overrides), templates.spec('reopen_he').text);
});

// The guard that matters most: a stored override that lost its required
// placeholder is IGNORED at render, not sent. The form refuses it too, but a
// flag row can be written by hand, and a nudge with no tags in it pings
// nobody while reading perfectly well.
test('an override missing a required placeholder never ships, even if stored', () => {
  const bad = { group_gate_nudge: 'עוד מחכים', group_intro: 'היי אני עולמה' };
  assert.equal(text.renderGroupGateNotice({ kind: 'nudge', missing: ['+972501111111'] }, bad),
    'עוד מחכה ל: @+972501111111  🧐');
  assert.match(text.renderGroupIntro(bad), /@\+\d+/, 'the intro still carries her tag');
  assert.deepEqual(templates.validate('group_gate_nudge', 'עוד מחכים'), { ok: false, reason: 'חסר {{missing}}' });
  // a placeholder the template does not know would print as-is to a person
  assert.equal(templates.validate('reminder', '{{title}} עד {{deadline}}').ok, false);
  assert.match(templates.validate('reminder', '{{title}} עד {{deadline}}').reason, /\{\{deadline\}\}/);
  // and a non-string or non-object flag is simply "no overrides"
  assert.equal(text.renderGroupOpened('nonsense'), templates.spec('group_opened').text);
  assert.equal(text.renderGroupOpened({ group_opened: 42 }), templates.spec('group_opened').text);
});

test('the form: blank and the default are not overrides, CRLF is normalised, refusals are named', () => {
  const body = {
    reminder: '',                                   // blank → default
    reminder_last: templates.spec('reminder_last').text, // the default typed back → not stored
    group_gate_nudge: 'נו {{missing}}\r\nתענו כבר  \r\n',  // textarea line endings and trailing spaces
    group_intro: 'היי',                             // lost {{me}} → refused, by name
    group_too_large: 'x'.repeat(templates.MAX_LENGTH + 1) + ' {{max}}',
    not_a_template: 'whatever',                     // unknown keys are ignored
  };
  const { overrides, rejected } = templates.parseForm(body);
  assert.deepEqual(overrides, { group_gate_nudge: 'נו {{missing}}\nתענו כבר' });
  assert.deepEqual(Object.keys(rejected).sort(), ['group_intro', 'group_too_large']);
  assert.match(rejected.group_intro, /\{\{me\}\}/);
  assert.match(rejected.group_too_large, /ארוך/);
  assert.deepEqual(templates.parseForm({}), { overrides: {}, rejected: {} });
  assert.deepEqual(templates.parseForm(null), { overrides: {}, rejected: {} });
});
