'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderReminderText, rawPipeTextFor } = require('../src/domain/proactive-text');

// The rule under test: a reminder's content is the person's own words at the
// person's own time — the one proactive kind with nothing for a model to
// decide. Everything else stays on an agent turn on purpose.

test('a reminder renders deterministically, in the user\'s own words', () => {
  assert.equal(renderReminderText({ title: 'לקחת תרופה' }), '⏰ תזכורת: *לקחת תרופה*');
  // whitespace collapsed, one line — the title is interpolated into a message
  assert.equal(renderReminderText({ title: '  לקחת \n  תרופה  ' }), '⏰ תזכורת: *לקחת תרופה*');
  // a titleless payload renders nothing rather than an empty shell
  assert.equal(renderReminderText({}), null);
  assert.equal(renderReminderText({ title: '   ' }), null);
  // bounded: the title cannot smuggle a novel into one WhatsApp message
  const long = renderReminderText({ title: 'א'.repeat(500) });
  assert.ok(long.length < 250);
});

// Rungs 2 and 3 ride the same pipe, so if they rendered the same sentence the
// person would get "⏰ תזכורת: *לקחת תרופה*" three times — the drum the ladder
// exists to avoid. Each rung has to say what it is and name the way out.
test('a follow-up rung does not repeat the first message', () => {
  const first = renderReminderText({ title: 'לקחת תרופה' });
  const second = renderReminderText({ title: 'לקחת תרופה', attempt: 2 });
  const last = renderReminderText({ title: 'לקחת תרופה', attempt: 3, finalAttempt: true });

  assert.notEqual(second, first);
  assert.notEqual(last, second);
  for (const t of [first, second, last]) assert.match(t, /לקחת תרופה/);

  // the exits, in the person's own language, on the rungs that have them
  assert.match(second, /להפסיק להזכיר/);
  assert.match(last, /האחרונה/);
  assert.match(last, /לא אזכיר שוב/);

  // Deterministic text cannot know who it is addressing, so it must not guess:
  // gendered second-person forms are what an eval already exists to catch.
  for (const t of [second, last]) {
    assert.doesNotMatch(t, /תוכלי|תוכל |עשית|סיימת|רוצה ש|תגידי|תכתבי/);
  }
});

test('only a plain reminder rides the raw pipe — everything conversational stays on the model', () => {
  const rem = { kind: 'reminder', payload: { taskId: 7, title: 'לקחת תרופה' } };
  assert.equal(rawPipeTextFor(rem), '⏰ תזכורת: *לקחת תרופה*');
  // payload arrives as a string from pg sometimes — same answer
  assert.equal(rawPipeTextFor({ kind: 'reminder', payload: JSON.stringify({ title: 'x' }) }), '⏰ תזכורת: *x*');

  // checkins are the product: the 2026-08-20 redesign made them personal
  // enough to answer, and a template would undo exactly that
  assert.equal(rawPipeTextFor({ kind: 'checkin', payload: { checkinInstruction: 'hi' } }), null);
  assert.equal(rawPipeTextFor({ kind: 'digest', payload: {} }), null);
  assert.equal(rawPipeTextFor({ kind: 'unblock_summary', payload: {} }), null);
  // a payload that carries its own instruction is asking for a model turn
  assert.equal(rawPipeTextFor({ kind: 'reminder', payload: { title: 'x', instruction: 'do things' } }), null);
  // a reminder with no title has nothing deterministic to say — fall through
  // to the agent turn rather than delivering an empty shell
  assert.equal(rawPipeTextFor({ kind: 'reminder', payload: {} }), null);
});

// Sarah wrote to Olma in English for a month and every reminder arrived in
// Hebrew: the raw pipe has no model to read "their language" off USER.md, and
// the ladder had one set of sentences. The recipient's locale is the whole
// decision, and it is taken at render.
test('a reminder is said in the language on file — English rungs for an en locale, Hebrew for everyone else', () => {
  const en = {
    first: renderReminderText({ title: 'call mom' }, undefined, 'en'),
    second: renderReminderText({ title: 'call mom', attempt: 2 }, undefined, 'en-US'),
    last: renderReminderText({ title: 'call mom', attempt: 3, finalAttempt: true }, undefined, 'EN'),
  };
  for (const t of Object.values(en)) {
    assert.match(t, /call mom/);
    assert.doesNotMatch(t, /[\u0590-\u05FF]/, 'Hebrew reached an English speaker: ' + t);
  }
  // the same promises the Hebrew rungs make, in the language they are read in
  assert.notEqual(en.second, en.first);
  assert.notEqual(en.last, en.second);
  assert.match(en.second, /stop reminding/i);
  assert.match(en.last, /last reminder/i);
  assert.match(en.last, /won't bring it up again/i);

  // the list forms too — a batch may only make the promise every line makes
  const list = renderReminderText({ items: ['call mom', 'pay rent'], attempt: 3, finalAttempt: true }, undefined, 'en');
  assert.match(list, /• call mom\n• pay rent/);
  assert.match(list, /last reminders/i);
  assert.doesNotMatch(list, /[\u0590-\u05FF]/);

  // Hebrew, nothing on file, and a language we have no sentences for all say
  // the Hebrew default — the same two-way rule the dashboard applies
  for (const locale of ['he', null, undefined, '', 'fr']) {
    assert.equal(renderReminderText({ title: 'תרופה' }, undefined, locale), '⏰ תזכורת: *תרופה*', String(locale));
  }

  // and the deliverer reads it off the row the worker joined, not the payload
  assert.equal(rawPipeTextFor({ kind: 'reminder', locale: 'en', payload: { title: 'x' } }), '⏰ Reminder: *x*');
  assert.equal(rawPipeTextFor({ kind: 'reminder', payload: { title: 'x', locale: 'en' } }), '⏰ תזכורת: *x*',
    'a locale smuggled in the payload must not pick the language — it is read at delivery, from the person');
});
