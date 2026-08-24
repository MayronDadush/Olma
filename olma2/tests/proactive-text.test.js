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
