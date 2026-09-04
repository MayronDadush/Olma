'use strict';
// users.setAssistantPersona + the card line + the tool doctrine. The persona
// is the user's choice of who the assistant IS (gender register + name); the
// contract under test: only explicit values change anything, the default
// renders NO card line (cost), and a non-default renders instructions the
// agent can follow without a second lookup.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const users = require('../src/domain/users');
const { renderCard, CARD_TOOLS } = require('../src/intake/user-card');
const registry = require('../src/adapters/mcp/registry');

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972500000701', { firstName: 'מירון' });
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}
const row = () => withClient(async (c) =>
  (await c.query(`SELECT * FROM users WHERE id = $1`, [user.id])).rows[0]);

test('defaults: female, no name, and NO persona line on the card', async () => {
  const u = await row();
  assert.equal(u.assistant_gender, 'female');
  assert.equal(u.assistant_name, null);
  assert.ok(!renderCard(u, []).includes('Assistant persona'),
    'the default persona must not spend card tokens');
});

test('gender flips to male, audits, and the card says MASCULINE with no mixing', async () => {
  const r = await withClient((c) => users.setAssistantPersona(c, user.id, { gender: 'male' }));
  assert.equal(r.ok, true);
  assert.equal(r.data.gender, 'male');
  assert.equal(r.data.name, 'עולמה'); // default name reported, not null
  const u = await row();
  const card = renderCard(u, []);
  assert.match(card, /Assistant persona/);
  assert.match(card, /MASCULINE/);
  const audited = await withClient((c) =>
    c.query(`SELECT detail FROM audit_log WHERE event = 'user.assistant_persona_set' AND actor_id = $1`, [user.id]));
  assert.equal(audited.rows[0].detail.gender, 'male');
});

test('a rename keeps the gender, and clearing the name restores the default', async () => {
  let r = await withClient((c) => users.setAssistantPersona(c, user.id, { name: '  נועה  ' }));
  assert.equal(r.data.name, 'נועה'); // trimmed
  let u = await row();
  assert.equal(u.assistant_gender, 'male', 'a name change must not touch gender');
  assert.match(renderCard(u, []), /"נועה"/);
  // '' resets — the caller does not need to know the default name to undo.
  r = await withClient((c) => users.setAssistantPersona(c, user.id, { name: '' }));
  assert.equal(r.data.name, 'עולמה');
  u = await row();
  assert.equal(u.assistant_name, null);
});

test('bad gender and an empty change are refused; nothing is written', async () => {
  const bad = await withClient((c) => users.setAssistantPersona(c, user.id, { gender: 'robot' }));
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'invalid');
  const empty = await withClient((c) => users.setAssistantPersona(c, user.id, {}));
  assert.equal(empty.ok, false);
  const u = await row();
  assert.equal(u.assistant_gender, 'male'); // untouched by either refusal
});

test('back to female clears the register line from the card', async () => {
  await withClient((c) => users.setAssistantPersona(c, user.id, { gender: 'female' }));
  const u = await row();
  assert.ok(!renderCard(u, []).includes('Assistant persona'),
    'female + default name IS the default again — no line');
});

test('the tool is registered, refreshes the card, and carries the doctrine', () => {
  const def = registry.TOOLS.find((t) => t.name === 'set_assistant_persona');
  assert.ok(def, 'set_assistant_persona must be in the registry');
  assert.ok(CARD_TOOLS.has('set_assistant_persona'),
    'a persona change must refresh USER.md the same turn');
  // The rules that keep this from being pitched or half-applied:
  assert.match(def.description, /never offer/i);
  assert.match(def.description, /no mixing/i);
});
