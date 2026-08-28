'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser } = require('./helpers');
const { refreshUserCard, renderCard, CARD_TOOLS } = require('../src/intake/user-card');
const { createBrokerServer } = require('../src/brokerd/server');

let db, user, workspace;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972509100001', { firstName: 'מירון' });
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-card-'));
  await db.pool.query(
    `UPDATE users SET workspace_path = $2, timezone = 'Asia/Jerusalem', locale = 'he' WHERE id = $1`,
    [user.id, workspace]
  );
});
after(async () => {
  await db.teardown();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const cardPath = () => path.join(workspace, 'USER.md');

test('refreshUserCard renders DB state into USER.md', async () => {
  await db.pool.query(
    `INSERT INTO user_preferences (user_id, key, value) VALUES ($1, 'gender_forms', 'זכר')`,
    [user.id]
  );
  const done = await refreshUserCard(db.pool, user.id);
  assert.equal(done, true);
  const card = fs.readFileSync(cardPath(), 'utf8');
  assert.match(card, /First name: מירון/);
  assert.match(card, /Timezone: Asia\/Jerusalem \(unconfirmed/);
  assert.match(card, /- gender_forms: זכר/);
  // no digest configured → the card itself carries the offer hint
  assert.match(card, /Daily digest: not set up/);
});

test('pending intake sections below the first "## " survive a re-render', async () => {
  const pending = '## מה שכבר שיתפו לפני שהמערכת האישית הייתה מוכנה\n(טקסט) <<<לקנות חלב>>>\n';
  fs.writeFileSync(cardPath(), '# User\n\nFirst name: whatever\n\n' + pending);
  await refreshUserCard(db.pool, user.id);
  const card = fs.readFileSync(cardPath(), 'utf8');
  assert.match(card, /First name: מירון/); // stale head replaced
  assert.ok(card.includes(pending.trim()), 'intake section must be preserved verbatim');
});

test('configured digest shows times instead of the offer hint', async () => {
  await db.pool.query(
    `UPDATE users SET digest_times = '08:30,20:00', digest_scope = 'today' WHERE id = $1`, [user.id]
  );
  await refreshUserCard(db.pool, user.id);
  const card = fs.readFileSync(cardPath(), 'utf8');
  assert.match(card, /Daily digest: 08:30,20:00 \(today\)/);
  assert.doesNotMatch(card, /not set up/);
});

test('no workspace on disk → false, never a throw', async () => {
  const ghost = await makeUser(db.pool, '+972509100002');
  await db.pool.query(
    `UPDATE users SET workspace_path = '/nonexistent/olma-test' WHERE id = $1`, [ghost.id]
  );
  assert.equal(await refreshUserCard(db.pool, ghost.id), false);
  const noPath = await makeUser(db.pool, '+972509100003');
  assert.equal(await refreshUserCard(db.pool, noPath.id), false);
});

test('brokerd wiring: a successful set_my_name re-renders the card', async () => {
  const { dispatch } = createBrokerServer({ pool: db.pool });
  const res = await dispatch({
    method: 'tool_call',
    params: { name: 'set_my_name', args: { olma_identity: user.identity_token, first_name: 'ירון' } },
  });
  assert.equal(res.ok, true);
  const card = fs.readFileSync(cardPath(), 'utf8');
  assert.match(card, /First name: ירון/);
});

test('brokerd wiring: a failed call does not touch the card', async () => {
  const before = fs.readFileSync(cardPath(), 'utf8');
  const { dispatch } = createBrokerServer({ pool: db.pool });
  await dispatch({
    method: 'tool_call',
    params: { name: 'set_my_name', args: { olma_identity: 'olma_tok_' + '0'.repeat(32), first_name: 'פורץ' } },
  });
  assert.equal(fs.readFileSync(cardPath(), 'utf8'), before);
});

test('facts reach the card, and expired ones do not', async () => {
  const facts = require('../src/domain/facts');
  const client = await db.pool.connect();
  try {
    await facts.rememberFact(client, user.id, {
      category: 'family', fact: 'הבת שלו נועה מתחילה כיתה א', importance: 3,
    });
    await facts.rememberFact(client, user.id, {
      category: 'plans', fact: 'טס לאילת', expiresAt: '2020-01-01T00:00:00Z',
    });
  } finally { client.release(); }

  await refreshUserCard(db.pool, user.id);
  const card = fs.readFileSync(cardPath(), 'utf8');
  assert.match(card, /What you know about them:/);
  assert.match(card, /- \[family\] הבת שלו נועה מתחילה כיתה א/);
  assert.doesNotMatch(card, /טס לאילת/, 'an expired fact is history, not context');
});

test('brokerd wiring: remember_fact renders into the card the same turn', async () => {
  const { dispatch } = createBrokerServer({ pool: db.pool });
  const res = await dispatch({
    method: 'tool_call',
    params: {
      name: 'remember_fact',
      args: { olma_identity: user.identity_token, category: 'work', fact: 'עובד במשמרות באיכילוב', importance: 2 },
    },
  });
  assert.equal(res.ok, true);
  assert.match(fs.readFileSync(cardPath(), 'utf8'), /- \[work\] עובד במשמרות באיכילוב/);
});

test('a card with no facts carries no empty heading', () => {
  const text = renderCard({ first_name: 'דנה' }, [], []);
  assert.doesNotMatch(text, /What you know about them/);
});

test('renderCard: every card-refreshing tool is a real registry tool', async () => {
  const { BY_NAME } = require('../src/adapters/mcp/registry');
  for (const name of CARD_TOOLS) {
    assert.ok(BY_NAME.has(name), `${name} is in CARD_TOOLS but not in the registry`);
  }
  // and the pure renderer stays crash-safe on a minimal row
  const text = renderCard({ first_name: null }, []);
  assert.match(text, /First name: unknown/);
});

// ---- state the agent used to burn tool calls to discover --------------------

test('the card names calendar and connection state', async () => {
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status, access_level)
     VALUES ($1, 'google_calendar', 'connected', 'read_write')
     ON CONFLICT (user_id, provider) DO UPDATE SET status = 'connected', access_level = 'read_write'`,
    [user.id]
  );
  await refreshUserCard(db.pool, user.id);
  let card = fs.readFileSync(cardPath(), 'utf8');
  assert.match(card, /Calendar: connected \(read_write\)/);
  assert.match(card, /Connections: none yet/);

  // disconnect → the card says so on the next refresh
  await db.pool.query(
    `UPDATE integrations SET status = 'disconnected' WHERE user_id = $1`, [user.id]
  );
  await refreshUserCard(db.pool, user.id);
  card = fs.readFileSync(cardPath(), 'utf8');
  assert.match(card, /Calendar: not connected/);
});

test('an active connection shows as a count and points at the list', async () => {
  const friend = await makeUser(db.pool, '+972509100004', { firstName: 'חבר' });
  const connections = require('../src/domain/connections');
  await db.pool.connect().then(async (c) => {
    try {
      const req = await connections.requestConnection(c, user.id, friend.phone, {});
      await connections.respondToConnection(c, friend.id, req.data.connection.id, 'approve');
    } finally { c.release(); }
  });
  await refreshUserCard(db.pool, user.id);
  const card = fs.readFileSync(cardPath(), 'utf8');
  assert.match(card, /Connections: 1 active — resolve people by name via list_my_connections/);
});
