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
  // The title is the anchor of the sentence and carries the emphasis (owner,
  // 2026-09-09). The words are unchanged; only the markers are new.
  assert.equal(text.renderReminderText({ title: 'לקחת תרופה' }), '⏰ תזכורת: *לקחת תרופה*');
  assert.equal(text.renderGroupTooLarge(25), templates.spec('group_too_large').text.replace('{{max}}', '25'));
  assert.match(messages.introMessage({ inviterName: 'דני', inviterPhone: '+972501', phone: '+972502' }),
    /\*דני\* \(\+972501\) ביקש\/ה להתחבר אליך דרכי\./);
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
  assert.equal(text.renderReminderText({ title: 'pills' }, overrides, 'en'), '⏰ Reminder: *pills*');
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

// ---- the page shows the message, not a legend ------------------------------
// 2026-09-09: the owner reads these boxes to decide how a sentence READS, and
// a sentence full of `{{ }}` cannot be read that way. Every template therefore
// carries a sample beside the placeholders it fills.
test('every placeholder a template can use has a sample to show it with', () => {
  for (const t of templates.TEMPLATES) {
    const sample = t.sample || {};
    for (const name of Object.keys(t.vars)) {
      assert.ok(Object.hasOwn(sample, name),
        `${t.key} has no sample for {{${name}}} — the page would print an empty gap`);
    }
    // ...and the rendered example really is free of them, which is the point.
    const shown = templates.example(t.key, {});
    assert.doesNotMatch(shown, /\{\{/, `${t.key} still shows a placeholder: ${shown}`);
    assert.ok(shown.trim(), `${t.key} renders to nothing`);
  }
});

// ---- emphasis, added 2026-09-09 --------------------------------------------
test('a wrapped placeholder is bolded only when the value can carry it', () => {
  // WhatsApp has no escape character, so wrapping a title that already holds a
  // marker makes half a sentence bold. The template asks; this decides.
  assert.equal(templates.render('reminder', { title: 'לקחת תרופה' }), '⏰ תזכורת: *לקחת תרופה*');
  assert.equal(templates.render('reminder', { title: 'לקנות 5* ביצים' }), '⏰ תזכורת: לקנות 5* ביצים');
  assert.equal(templates.render('reminder', { title: 'report_final_v2' }), '⏰ תזכורת: report_final_v2');
  // An empty value takes the markers with it rather than leaving `**` behind.
  assert.equal(templates.render('reminder', { title: '  ' }), '⏰ תזכורת: ');
});

test('a mention tag is never wrapped, or it stops pinging anybody', () => {
  // A tag only notifies when the token is a bare @+digits. This is the one
  // placeholder emphasis must never touch, in any group template.
  for (const t of templates.TEMPLATES) {
    for (const marker of ['*', '_', '~']) {
      assert.ok(!t.text.includes(`${marker}{{missing}}${marker}`),
        `${t.key} wraps {{missing}} in ${marker} — that tag would notify nobody`);
      assert.ok(!t.text.includes(`${marker}{{me}}${marker}`), `${t.key} wraps {{me}} in ${marker}`);
    }
  }
});

test('the reworded sentence is the one the page previews, not the default', () => {
  const shown = templates.example('reminder', { reminder: '🔔 {{title}} — עכשיו' });
  assert.equal(shown, '🔔 לקחת את הרכב לטסט — עכשיו');
});

// ---- two languages, and only two (owner, 2026-09-09) -----------------------
test('every message said in PRIVATE exists in both languages', () => {
  // Sarah wrote in English for a month and her reminders arrived in Hebrew,
  // because a verbatim sentence has no model to read a language off. The fix
  // was per-template twins; this is what stops the NEXT private template
  // shipping with only one of them.
  for (const f of templates.families()) {
    if (f.audience !== 'private') continue;
    assert.ok(f.he, `${f.id} has no Hebrew`);
    assert.ok(f.en, `${f.id} has no English — an English speaker would read Hebrew`);
  }
  // A room is Hebrew by design and says so on the page rather than offering a
  // box nothing would ever send. Asserted so that "no English" stays a
  // decision rather than becoming an oversight nobody notices.
  const groups = templates.families().filter((f) => f.audience === 'group');
  assert.ok(groups.length >= 5);
  for (const f of groups) assert.equal(f.en, null, `${f.id} grew an English twin — decide what sends it`);
});

test('a locale variant is still that language, in both readers', () => {
  const { openingKey } = require('../src/domain/onboarding');
  // `set_my_language` stores any ISO code lowercased, so he-il and en-us are
  // ordinary values. An exact match on 'he' gave he-il an ENGLISH opening and
  // Hebrew reminders for ever after — two opposite fallbacks for one decision.
  for (const he of ['he', 'he-il', 'HE', '  he  ']) {
    assert.equal(openingKey(he), 'opening_he', String(he));
    assert.equal(text.localizedKey('reminder', he), 'reminder', String(he));
  }
  for (const en of ['en', 'en-us', 'EN']) {
    assert.equal(openingKey(en), 'opening_en', String(en));
    assert.equal(text.localizedKey('reminder', en), 'reminder_en', String(en));
  }
  // Nothing on file is the house language, exactly as createUser COALESCEs it.
  for (const none of [null, undefined, '']) assert.equal(openingKey(none), 'opening_he', String(none));
  // And a third language meets the English opening the greeter would have
  // sent it — the one place the two rules point different ways, on purpose.
  assert.equal(openingKey('ru'), 'opening_en');
  assert.equal(text.localizedKey('reminder', 'ru'), 'reminder', 'no Russian rungs exist to send');
});
