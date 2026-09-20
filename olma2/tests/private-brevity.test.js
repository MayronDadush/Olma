'use strict';
// The length of a private message about a coordination comes from the
// instruction, not from the model (owner and Yuval, 2026-09-20): told to
// explain, ask, check, mention and offer, it did all five in order. Every
// negotiation instruction now ends on the same budget, and the checks stay
// things the model does rather than says.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { instructionFor, BRIEF } = require('../src/channels/openclaw');

const NEGOTIATION = [
  { kind: 'meeting_invite', payload: { meetingId: 5, title: 'ים', byName: 'מירון' } },
  { kind: 'meeting_invite', payload: { meetingId: 5, title: 'ים', byName: 'מירון', groupSubject: 'בדיקה' } },
  { kind: 'meeting_invite', payload: { meetingId: 5, title: 'ים', byName: 'מירון', groupSubject: 'בדיקה', askedItYourself: true } },
  { kind: 'meeting_slot_proposed', payload: { meetingId: 5, title: 'ים', byName: 'מירון', slot: 'שישי בבוקר' } },
  { kind: 'meeting_slot_proposed', payload: { meetingId: 5, title: 'ים', byName: 'מירון', tableChanged: true } },
  { kind: 'meeting_slot_declined', payload: { meetingId: 5, title: 'ים', byName: 'מירון' } },
];

test('every negotiation instruction ends on the length budget and no longer explains how answering works', () => {
  assert.match(BRIEF, /one sentence of context and one question/);
  for (const row of NEGOTIATION) {
    const body = instructionFor(row);
    assert.ok(body.endsWith(BRIEF.trim()) || body.includes(BRIEF), `${row.kind}: budget missing`);
    assert.doesNotMatch(body, /answering here in chat works/, `${row.kind}: the how-to-answer sentence is back`);
  }
});

test('a coordination that came out of a room is told to count heads for a game; a private one is not', () => {
  const room = instructionFor({ kind: 'meeting_slot_proposed', payload: { meetingId: 5, title: 'פוקר', byName: 'מירון', slot: 'חמישי 19:00', groupSubject: 'פוקר' } });
  assert.match(room, /room\.kind "game"/);
  const dm = instructionFor({ kind: 'meeting_slot_proposed', payload: { meetingId: 5, title: 'קפה', byName: 'מירון', slot: 'חמישי 19:00' } });
  assert.doesNotMatch(dm, /room\.kind/);
});

test('the table question says two are a sentence and three or more are the block', () => {
  const body = instructionFor({ kind: 'meeting_slot_proposed', payload: { meetingId: 5, title: 'ים', byName: 'מירון', tableChanged: true } });
  assert.match(body, /three or more options come as a numbered block/);
  assert.match(body, /two are one sentence/);
});
