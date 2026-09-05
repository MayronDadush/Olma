'use strict';
// The words Olma says in a group. All of them are written in code rather than
// by a model, because while a group is locked the group agent is muted at the
// gateway — there is no model output to use even if we wanted one.
//
// The one thing here that is easy to get wrong and impossible to notice from
// the source: a tag only pings when the token is a PHONE NUMBER. "@דני" reads
// perfectly in the code and arrives in the group as dead text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const text = require('../src/domain/proactive-text');

test('the intro says who she is and how to reach her, and nothing else', () => {
  const intro = text.renderGroupIntro();
  assert.match(intro, /עולמה/);
  assert.match(intro, /תתייגו אותי/);
  assert.ok(intro.split('\n').length <= 4, 'a first impression is not a manual');
});

test('a tag is a phone token, so the gateway turns it into a real mention', () => {
  const notice = text.renderGroupGateNotice({
    kind: 'explain', missing: ['+972501111111', '972502222222'],
  });
  assert.match(notice, /@\+972501111111/);
  // A missing "+" is repaired rather than emitted as an unmatched token.
  assert.match(notice, /@\+972502222222/);
  assert.ok(!/@[א-ת]/.test(notice), 'a name-shaped tag would reach the group as dead text');
});

test('the nudge is shorter than the explanation and still carries the tags', () => {
  const missing = ['+972501111111'];
  const explain = text.renderGroupGateNotice({ kind: 'explain', missing });
  const nudge = text.renderGroupGateNotice({ kind: 'nudge', missing });
  assert.ok(nudge.length < explain.length / 2, 'the tenth tag must not repeat the first one');
  assert.match(nudge, /@\+972501111111/);
});

// Twenty tags in one message is not a nudge, it is a pile-on.
test('a long list of missing people is capped, and the rest are counted', () => {
  const many = Array.from({ length: 12 }, (_, i) => `+97250000000${i}`);
  const rendered = text.mentionTokens(many);
  assert.equal((rendered.match(/@\+/g) || []).length, text.MAX_TAGS);
  assert.match(rendered, /ועוד 4/);
});

test('nobody missing renders no stray tag punctuation', () => {
  assert.equal(text.mentionTokens([]), '');
  assert.equal(text.mentionTokens(null), '');
});

// The cap is a dashboard flag. A sentence with 25 baked into it would keep
// quoting 25 after somebody raised it to 40.
test('the too-large line quotes the live cap, not a constant', () => {
  assert.match(text.renderGroupTooLarge(25), /עד 25 אנשים/);
  assert.match(text.renderGroupTooLarge(40), /עד 40 אנשים/);
});

// Deterministic text cannot know who it is addressing. Group text may use the
// plural — a group really is plural — but it must never guess one member's
// gender, which in Hebrew is wrong for half the people who read it.
test('no line guesses the gender of a single person', () => {
  const all = [
    text.renderGroupIntro(),
    text.renderGroupGateNotice({ kind: 'explain', missing: ['+972501111111'] }),
    text.renderGroupGateNotice({ kind: 'nudge', missing: ['+972501111111'] }),
    text.renderGroupTooLarge(25),
  ].join('\n');
  // Second-person singular endings are the trap: "אתה", "שלך", "תשלח".
  assert.ok(!/\bאתה\b|\bאת\b|\bשלך\b/.test(all), all);
});
