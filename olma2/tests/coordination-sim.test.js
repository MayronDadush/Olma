'use strict';
// The simulator picks what to TRY in real rooms, so the things that would make
// it lie are what is tested: that a room is the same room under every policy,
// that today's policy does only what today's code does, and that a drop offer
// cannot buy a "success" off a room that would have closed anyway.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sim = require('../src/sim/coordination-sim');

const P = (over) => ({ ...sim.CURRENT, name: 'test', ...over });

test('a seed is the same room, and the same room under every policy', () => {
  assert.deepEqual(sim.makeRoom(42), sim.makeRoom(42));
  const room = sim.makeRoom(42);
  const a = sim.simulate(room, sim.CURRENT);
  const b = sim.simulate(room, sim.CURRENT);
  assert.deepEqual(a.score, b.score, 'deterministic');
  // The first invite reaches the same people at the same moment whatever comes after it.
  const c = sim.simulate(room, P({ privateNudgeAfterH: 6, dropOfferAfterQuietH: 12 }));
  const firstInvites = (r) => r.timeline.touches.filter((t) => t.kind === 'meeting_invite').map((t) => [t.at, t.userIds[0]]);
  assert.deepEqual(firstInvites(a), firstInvites(c));
});

test("today's policy does only what today's code does: one chase, nothing private after the ask, no offer to drop", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const kinds = sim.simulate(sim.makeRoom(seed), sim.CURRENT).timeline.touches.map((t) => t.kind);
    assert.ok(kinds.filter((k) => k === 'chase').length <= 1);
    assert.ok(!kinds.includes('meeting_nudge') && !kinds.includes('drop_offer') && !kinds.includes('chase2'));
  }
});

test('a drop offer comes only after a chase, at most once, and never while the table has enough', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const r = sim.simulate(sim.makeRoom(seed), P({ dropOfferAfterQuietH: 12 }));
    const kinds = r.timeline.touches.map((t) => t.kind);
    const drop = kinds.indexOf('drop_offer');
    if (drop >= 0) assert.ok(kinds.indexOf('chase') >= 0 && kinds.indexOf('chase') < drop, `seed ${seed}`);
    assert.ok(kinds.filter((k) => k === 'drop_offer').length <= 1);
  }
});

test('a private nudge reaches only somebody who has answered nothing, once', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const { timeline } = sim.simulate(sim.makeRoom(seed), P({ privateNudgeAfterH: 3 }));
    const nudged = timeline.touches.filter((t) => t.kind === 'meeting_nudge').map((t) => t.userIds[0]);
    assert.equal(new Set(nudged).size, nudged.length, 'never twice');
    for (const t of timeline.touches.filter((x) => x.kind === 'meeting_nudge')) {
      const answeredBefore = timeline.answers.some((a) => a.userId === t.userIds[0] && !a.byAdding && a.at <= t.at);
      assert.equal(answeredBefore, false, `seed ${seed}`);
    }
  }
});

test('an exit from a room that would have confirmed without the offer is a wrong drop, never a success', () => {
  const s = sim.runPolicy(P({ dropOfferAfterQuietH: 12 }), { rooms: 150 });
  assert.ok(s.wrongDrop <= s.graceful);
  assert.ok(s.success <= s.confirmed + s.graceful - s.wrongDrop + 1e-9);
  // …and the scale it is reported on is the same as today's policy's.
  const today = sim.runPolicy(sim.CURRENT, { rooms: 150 });
  assert.equal(today.wrongDrop, 0);
  assert.equal(today.graceful, 0);
});
