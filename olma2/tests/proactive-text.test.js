'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderReminderText, rawPipeTextFor } = require('../src/domain/proactive-text');

// The rule under test: a reminder's content is the person's own words at the
// person's own time — the one proactive kind with nothing for a model to
// decide. Everything else stays on an agent turn on purpose.

test('a reminder renders deterministically, in the user\'s own words', () => {
  assert.equal(renderReminderText({ title: 'לקחת תרופה' }), '⏰ תזכורת: לקחת תרופה');
  // whitespace collapsed, one line — the title is interpolated into a message
  assert.equal(renderReminderText({ title: '  לקחת \n  תרופה  ' }), '⏰ תזכורת: לקחת תרופה');
  // a titleless payload renders nothing rather than an empty shell
  assert.equal(renderReminderText({}), null);
  assert.equal(renderReminderText({ title: '   ' }), null);
  // bounded: the title cannot smuggle a novel into one WhatsApp message
  const long = renderReminderText({ title: 'א'.repeat(500) });
  assert.ok(long.length < 250);
});

// Rungs 2 and 3 ride the same pipe, so if they rendered the same sentence the
// person would get "⏰ תזכורת: לקחת תרופה" three times — the drum the ladder
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
  assert.equal(rawPipeTextFor(rem), '⏰ תזכורת: לקחת תרופה');
  // payload arrives as a string from pg sometimes — same answer
  assert.equal(rawPipeTextFor({ kind: 'reminder', payload: JSON.stringify({ title: 'x' }) }), '⏰ תזכורת: x');

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
