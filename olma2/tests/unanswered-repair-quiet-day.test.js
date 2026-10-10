'use strict';
// Bar, Friday night 2026-10-09: the gateway's opener timed out on his message,
// the model answered in English, the reply gate rightly cancelled it, and the
// repair queued four minutes later was held as `quiet_day` until it expired.
// A repair answers something the person WROTE; it is not Olma deciding to
// speak, so neither the night, nor a quiet day, nor a holiday holds it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../src/outbox/gate');

const NIGHT = new Date('2026-10-09T23:30:00Z'); // 02:30 Saturday in Jerusalem
const base = {
  plan: 'free', blocked: false, window: { start: '09:00', end: '21:00' }, tz: 'Asia/Jerusalem',
  sentToday: 0, budget: 4, now: NIGHT, quietDays: ['sat'],
};
const repair = (extra = {}) => ({
  kind: 'checkin', urgency: 'urgent', payload: { rung: 'unanswered_repair', repairKind: 'dropped_turn', ...extra },
});

test('an unanswered-repair passes a quiet day and the night', () => {
  assert.equal(decide({ ...base, row: repair() }).action, 'deliver');
  // The same row in a different rung is still held: only the repair is exempt.
  const other = decide({ ...base, row: { kind: 'checkin', urgency: 'urgent', payload: { rung: 'silence' } } });
  assert.equal(other.action, 'hold');
});

test('a verbatim re-send of a lost reply is a repair too', () => {
  assert.equal(decide({ ...base, row: repair({ repairKind: 'undelivered_reply', verbatimReply: 'שלום' }) }).action, 'deliver');
});

test('the exemption does not reach a paused or blocked person', () => {
  assert.notEqual(decide({ ...base, blocked: true, row: repair() }).action, 'deliver');
});
