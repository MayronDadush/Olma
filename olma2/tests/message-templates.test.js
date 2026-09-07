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
  // the English rung is its own box: rewording the Hebrew one leaves it alone
  assert.equal(text.renderReminderText({ title: 'pills' }, overrides, 'en'), '⏰ Reminder: pills');
  assert.equal(text.renderReminderText({ title: 'pills' }, { reminder_en: '🔔 {{title}}' }, 'en'), '🔔 pills');
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

// The opening copy was the one verbatim message outside this file; since
// 2026-09-08 it is a template like the others, and `OPENING` is its defaults.
test('the opening is a template: OPENING is its default, an override is what a stranger reads', () => {
  const onboarding = require('../src/domain/onboarding');
  assert.equal(onboarding.OPENING.he, templates.spec('opening_he').text);
  assert.equal(onboarding.OPENING.en, templates.spec('opening_en').text);
  assert.equal(onboarding.openingMessage('he'), onboarding.OPENING.he);
  assert.equal(onboarding.openingMessage('fr'), onboarding.OPENING.en, 'anything not Hebrew is English');
  const reworded = { opening_he: 'היי, אני עולמה 👋\n\nבואו נעשה סדר.' };
  assert.equal(onboarding.openingMessage('he', reworded), reworded.opening_he);
  assert.equal(onboarding.openingMessage('en', reworded), onboarding.OPENING.en, 'the other language is untouched');
  assert.equal(onboarding.openingMessage('he', { opening_he: '' }), onboarding.OPENING.he, 'a blank override is the default');
});

test('families: a Hebrew template and its English twin are one message with two boxes', () => {
  const fam = Object.fromEntries(templates.families().map((f) => [f.id, f]));
  assert.equal(fam.reminder.he.key, 'reminder');
  assert.equal(fam.reminder.en.key, 'reminder_en');
  assert.equal(fam.stranger_intro.he.key, 'stranger_intro_he');
  assert.equal(fam.stranger_intro.en.key, 'stranger_intro_en');
  assert.equal(fam.opening.he.key, 'opening_he');
  assert.equal(fam.group_intro.en, null, 'a group message has no English twin, and says so rather than inventing one');
  // label and help come from the Hebrew member, so the twins never disagree
  assert.equal(fam.reminder.label, templates.spec('reminder').label);
  for (const f of templates.families()) {
    if (f.he && f.en) assert.equal(f.he.label, f.en.label, `${f.id}: the twins carry one label`);
    assert.ok(f.label && f.help, `${f.id} has a label and a help line`);
  }
  // every template is in exactly one family
  const members = templates.families().flatMap((f) => [f.he, f.en].filter(Boolean).map((t) => t.key));
  assert.deepEqual(members.sort(), templates.TEMPLATES.map((t) => t.key).sort());
});
