'use strict';
// A WhatsApp reply points at ONE earlier message, and until 2026-09-05 nothing
// in this system knew that. The gateway was never the problem: it puts
// `reply_to_id` in Conversation info and the quoted text in a "Reply target of
// current user message" block, both in front of the model on the turn. What
// was missing was anyone telling the model they meant anything — measured that
// day on the eval user, gateway-shaped prompt, the same two-topic conversation
// run twice: WITH the reply block and WITHOUT it the model produced the same
// answer, acting on the newest topic and the quoted one identically.
//
// The fix is a field the model has to go and look for, and a hint that arrives
// mid-turn — before the reply is written — saying what it changes. Both halves
// are cheap enough to lose in a budget trim, so they are held open here.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { freshDb, makeUser } = require('./helpers');
const { createBrokerServer } = require('../src/brokerd/server');
const { toolDefinitions } = require('../src/adapters/mcp/registry');

let db, broker;
before(async () => { db = await freshDb(); broker = createBrokerServer({ pool: db.pool }); });
after(async () => { await db.teardown(); });

async function turnStart(user, args = {}) {
  const res = await broker.dispatch(
    { id: 1, method: 'tool_call',
      params: { name: 'turn_start', args: { olma_identity: user.identity_token, ...args } } },
    { opened: false, counted: false });
  assert.equal(res.ok, true, res.text);
  return JSON.parse(res.text.replace(/^OK /, ''));
}

test('an ordinary turn says nothing about replies', async () => {
  const u = await makeUser(db.pool, '+972611009001');
  const data = await turnStart(u);
  assert.equal(data.replyTarget, undefined);
  assert.equal(data.hints && data.hints.replyTarget, undefined,
    'the hint costs tokens only on the turns it applies to');
});

test('a reply_to_id turns into the hint that says what to do with the quote', async () => {
  const u = await makeUser(db.pool, '+972611009002');
  const data = await turnStart(u, { reply_to_id: '3EB0A1B2C3D4E5F60718' });
  assert.equal(data.replyTarget, true);
  const hint = data.hints && data.hints.replyTarget;
  assert.ok(hint, 'the flag never travels without its instruction');
  // The block is what the model has to go back and read; naming it exactly is
  // the whole point, because it is the string the gateway actually prints.
  assert.match(hint, /Reply target of current user message/);
  assert.match(hint, /Answer THAT/);
});

test('the reminder hint stops guessing once a quote is on the turn', async () => {
  // Both hints fire on the exact case this was reported for — a bare "סיימתי"
  // replying to yesterday's rent reminder — and left alone they disagree:
  // "probably the newest one" against "answer the quoted one". A guess must
  // never argue with a fact the person actually pointed at.
  const u = await makeUser(db.pool, '+972611009004');
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, sent_at)
     VALUES ($1, 'reminder', '{"title":"לשלם ארנונה"}'::jsonb, now() - interval '3 hours')`,
    [u.id]);
  const plain = await turnStart(u);
  assert.ok(plain.hints && plain.hints.recentReminders, 'the reminder hint still fires on its own');
  assert.doesNotMatch(plain.hints.recentReminders, /UNLESS/);

  const quoted = await turnStart(u, { reply_to_id: '3EB0A1B2C3D4E5F60718' });
  assert.match(quoted.hints.recentReminders, /UNLESS the quoted message names another/);
});

test('a blank reply_to_id is no reply at all', async () => {
  const u = await makeUser(db.pool, '+972611009003');
  // A model that passes the field unconditionally would otherwise put every
  // turn into "they quoted something", which is worse than never looking:
  // the hint would send it hunting for a block that is not there.
  for (const value of ['', '   ', null, 42]) {
    const data = await turnStart(u, { reply_to_id: value });
    assert.equal(data.replyTarget, undefined, `reply_to_id=${JSON.stringify(value)}`);
  }
});

test('the model is told to look for reply_to_id in both places it reads every turn', () => {
  const turnStartTool = toolDefinitions().find((d) => d.name === 'turn_start');
  assert.ok(turnStartTool.inputSchema.properties.reply_to_id,
    'the schema is what makes the model look at the metadata block');
  assert.match(turnStartTool.description, /reply_to_id/,
    'and the description is what tells it to pass the thing it found');
  const doctrine = fs.readFileSync(require('../src/intake/provision').TEMPLATE_PATH, 'utf8');
  assert.match(doctrine, /`reply_to_id`/,
    'AGENTS.md used to say "two of its fields", which actively argued against a third');
});
