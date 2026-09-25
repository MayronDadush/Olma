'use strict';
// The welcome follow-up (owner, 2026-09-25): seconds after the greeter
// introduces her, a new person's OWN agent acts on what they wrote there and
// hands over their page. jobs/intake.js queues it (tests/intake.test.js holds
// that half); this file holds the rest — what the gate lets through and when,
// what the model is told, that it answers their words exactly once, and that
// every other road into a first turn still carries the page.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { decide } = require('../src/outbox/gate');
const { drainOnce } = require('../src/outbox/worker');
const { enqueue } = require('../src/outbox/enqueue');
const { instructionFor, offersDashboardLink } = require('../src/channels/openclaw');
const turn = require('../src/domain/turn');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// ---- the gate ---------------------------------------------------------------
// 00:00 UTC is 03:00 in Jerusalem — night — and 2026-09-26 is a Saturday.
const NIGHT = new Date('2026-09-26T00:00:00Z');
const facts = {
  plan: 'free', blocked: false, window: { start: '09:00', end: '21:00' }, tz: 'Asia/Jerusalem',
  sentToday: 0, budget: 4, now: NIGHT,
};
const welcome = { kind: 'welcome_followup', urgency: 'normal', expires_at: null, payload: { hasNote: true } };
const justGreeted = new Date(NIGHT.getTime() - 60_000).toISOString();
const longAgo = new Date(NIGHT.getTime() - 60 * 60_000).toISOString();

test('the rest of the greeter\'s reply goes out at 03:00 — they are awake and talking', () => {
  assert.equal(decide({ ...facts, greetedAt: justGreeted, row: welcome }).action, 'deliver');
  assert.equal(decide({ ...facts, greetedAt: longAgo, row: welcome }).holdReason, 'night',
    'past the conversation window it waits like everything else');
  assert.equal(decide({ ...facts, row: welcome }).holdReason, 'night', 'no greeting on record, no grace');
});

test('…and on their quiet day, inside the same window and not after it', () => {
  const saturday = { ...facts, quietDays: [6], now: new Date('2026-09-26T09:00:00Z') };
  const greeted = new Date(saturday.now.getTime() - 60_000).toISOString();
  assert.equal(decide({ ...saturday, greetedAt: greeted, row: welcome }).action, 'deliver');
  const stale = new Date(saturday.now.getTime() - 60 * 60_000).toISOString();
  assert.equal(decide({ ...saturday, greetedAt: stale, row: welcome }).holdReason, 'quiet_day');
  assert.equal(decide({ ...saturday, greetedAt: greeted, row: { ...welcome, kind: 'checkin' } }).holdReason, 'quiet_day',
    'the grace is this kind\'s alone');
});

test('if they wrote to their own agent first, that turn answered — the follow-up is dropped', () => {
  const v = decide({ ...facts, greetedAt: justGreeted, lastInboundAt: justGreeted, row: welcome });
  assert.deepEqual(v, { action: 'drop', holdReason: 'answered_in_turn' });
});

// ---- what the model is told ------------------------------------------------
test('the instruction points at their words, never carries them, and hands over the link\'s characters', () => {
  const row = { kind: 'welcome_followup', payload: { hasNote: true, greeterReply: 'היי, אני עולמה 👋' } };
  assert.equal(offersDashboardLink(row), true, 'the worker mints a page for it at delivery');
  const url = 'https://allma.world/d/AbCdEfGhIjKlMnOpQrStUv';
  const text = instructionFor(row, url);
  assert.match(text, /Do not introduce yourself/);
  assert.match(text, /מה שכבר שיתפו לפני שהמערכת האישית הייתה מוכנה/, 'the USER.md section, by name');
  assert.match(text, /<<<היי, אני עולמה 👋>>>/, 'what the greeter said, fenced, so it is not said twice');
  assert.ok(text.includes(url), 'the characters themselves');
  assert.match(text, /language they wrote in/);

  const bare = instructionFor({ kind: 'welcome_followup', payload: { hasNote: false } }, null);
  assert.doesNotMatch(bare, /USER\.md/, 'no carryover, no section to point at');
  assert.doesNotMatch(bare, /https?:/, 'no link minted, no link — never an invented one');
});

// ---- the worker ------------------------------------------------------------
async function newPerson(phone) {
  const u = await makeUser(db.pool, phone);
  await db.pool.query(
    `UPDATE users SET agent_id = $2, opening_sent_at = now(), intake_note_at = now(), timezone = 'Etc/UTC'
      WHERE id = $1`, [u.id, `u-${u.id}`]);
  return u;
}

test('once it is out, their words are answered — the first turn is not told they are waiting', async () => {
  const u = await newPerson('+972501880001');
  await withTx(db.pool, (c) => enqueue(c, {
    userId: u.id, kind: 'welcome_followup', payload: { hasNote: true }, idempotencyKey: `welcome_followup:${u.id}`,
  }));
  const seen = [];
  await drainOnce(db.pool, async (row) => { seen.push(row.kind); return { ok: true }; },
    new Date(), { checkChannels: async () => ({ status: 'up', channels: [] }) });
  assert.deepEqual(seen, ['welcome_followup']);
  const { rows } = await db.pool.query(`SELECT intake_note_at FROM users WHERE id = $1`, [u.id]);
  assert.equal(rows[0].intake_note_at, null);
});

// ---- the first turn ---------------------------------------------------------
async function adviseFirstTurn(u) {
  return withTx(db.pool, async (c) => {
    const { rows } = await c.query(`SELECT * FROM users WHERE id = $1`, [u.id]);
    const counted = { ok: true, data: { blocked: false } };
    return turn.advise(c, rows[0], { counted, firstTurn: true, now: new Date() });
  });
}

test('a first turn with no follow-up behind it carries the page, handed over as characters', async () => {
  const u = await newPerson('+972501880002');
  const out = await adviseFirstTurn(u);
  assert.match(out.onboarding.pageLink, /\/d\/[A-Za-z0-9]{22}$/);
  assert.ok(out.onboarding.instruction.includes(out.onboarding.pageLink));
});

test('…and one that the follow-up already reached does not hand it over twice', async () => {
  const u = await newPerson('+972501880003');
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, sent_at) VALUES ($1, 'welcome_followup', '{}', now())`, [u.id]);
  const out = await adviseFirstTurn(u);
  assert.equal(out.onboarding.pageLink, undefined);
  assert.doesNotMatch(out.onboarding.instruction, /\/d\//);

  // A follow-up the gate DROPPED delivered nothing, so it does not count.
  const v = await newPerson('+972501880004');
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, sent_at, hold_reason)
     VALUES ($1, 'welcome_followup', '{}', now(), 'answered_in_turn')`, [v.id]);
  assert.ok((await adviseFirstTurn(v)).onboarding.pageLink);
});
