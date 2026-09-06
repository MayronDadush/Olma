'use strict';
// Where the group roster actually comes from, since 2026-09-06.
//
// The design read it off the gateway's transcript; on OpenClaw 2026.8.1 the
// transcript keeps the bare text, and group mode went live and registered
// nothing. Now the gateway plugin reads the `Conversation info` block out of
// the model's input on `llm_input`, brokerd files it (`group_context`), and
// the sweep reads the row. Three things have to hold: the plugin finds the
// block wherever the gateway puts it and only for group sessions; brokerd
// refuses a block filed by the wrong agent or for the wrong group; and the
// sweep, with nothing injected, registers a group from the row alone.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const groupContext = require('../src/domain/group-context');
const groupsDomain = require('../src/domain/groups');
const pg = require('../src/intake/provision-group');
const job = require('../src/jobs/groups');
process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `group-context-plugin-test-${process.pid}.log`);

let db, broker, plugin, tmp, configPath;
before(async () => {
  db = await freshDb();
  broker = createBrokerServer({ pool: db.pool, placeMark: () => ({ attempted: false }) });
  plugin = await import('../gateway-plugin/olma-turn/index.js');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-group-context-'));
  process.env.OLMA_OPENCLAW_HOME = tmp;
  configPath = path.join(tmp, 'openclaw.json');
});
after(async () => {
  delete process.env.OLMA_OPENCLAW_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.teardown();
});
beforeEach(() => {
  fs.writeFileSync(configPath, JSON.stringify({
    agents: { entries: { main: { name: 'main' } } },
    channels: { whatsapp: { accounts: { default: { dmPolicy: 'open', allowFrom: ['*'] } } } },
    session: { dmScope: 'per-channel-peer' },
    bindings: [],
  }, null, 2));
  pg.installGreeter({ configPath });
});

const JID = '120363401085388776@g.us';
const KEY = `agent:ggreet:whatsapp:group:${JID}`;
const block = (info) => `Conversation info: ⟦openclaw:ctx⟧\n\`\`\`json\n${JSON.stringify(info)}\n\`\`\``;
const info = (extra = {}) => ({
  chat_id: `whatsapp:${JID}`, message_id: '3AD99E29DEB9A7799A3B',
  sender: { id: '+972526269826', name: 'M&M' }, timestamp: '2026-09-06 18:09',
  group_subject: 'פאדל שלישי', group_members: 'M&M (+972526269826), +972603000011',
  is_group_chat: true, was_mentioned: true, ...extra,
});

// A fake brokerd socket: the plugin's askBroker talks newline-JSON to it,
// and the test answers with what dispatch() says.
function fakeSocket(calls) {
  return () => {
    const { EventEmitter } = require('node:events');
    const s = new EventEmitter();
    s.write = (line) => {
      const msg = JSON.parse(line);
      calls.push(msg);
      broker.dispatch(msg).then((res) => s.emit('data', JSON.stringify({ id: msg.id, ...res }) + '\n'));
    };
    s.end = () => {}; s.destroy = () => {};
    setImmediate(() => s.emit('connect'));
    return s;
  };
}

test('the plugin finds the block wherever the gateway puts it, newest history entry first, and only for group sessions', async () => {
  const calls = [];
  const logs = [];
  const handler = plugin.buildGroupContextHandler({ connect: fakeSocket(calls), log: (l) => logs.push(l) });
  const ctx = { sessionKey: KEY, agentId: 'ggreet' };

  // in the prompt
  await handler({ prompt: `${block(info())}\n\n@232040725262501 היי עולמה` }, ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'group_context');
  assert.equal(calls[0].params.agentId, 'ggreet');
  assert.equal(calls[0].params.info.group_members, 'M&M (+972526269826), +972603000011');
  assert.equal(logs.at(-1).where, 'prompt');
  assert.equal(logs.at(-1).outcome, 'stored');

  // in the history snapshot: the runtime-context message rides last, and an
  // OLDER block in the same snapshot must not win
  await handler({
    prompt: 'היי',
    historyMessages: [
      { role: 'user', content: block(info({ message_id: 'OLD', was_mentioned: false })) },
      { role: 'assistant', content: 'NO_REPLY' },
      { role: 'user', content: [{ type: 'text', text: block(info({ message_id: 'NEW' })) }] },
    ],
  }, ctx);
  assert.equal(calls.at(-1).params.info.message_id, 'NEW');
  assert.equal(logs.at(-1).where, 'history');

  // in the system prompt
  await handler({ prompt: 'היי', systemPrompt: `doctrine…\n\n${block(info({ message_id: 'SYS' }))}` }, ctx);
  assert.equal(calls.at(-1).params.info.message_id, 'SYS');
  assert.equal(logs.at(-1).where, 'system');

  // no block at all: one trace line, no call
  const n = calls.length;
  await handler({ prompt: 'bare text' }, ctx);
  assert.equal(calls.length, n);
  assert.equal(logs.at(-1).outcome, 'no-block');

  // a DM session is not this handler's business, block or not
  await handler({ prompt: block(info()) }, { sessionKey: 'agent:u-3:whatsapp:direct:+972526269826' });
  await handler({ prompt: block(info()) }, { sessionKey: 'agent:main:main' });
  assert.equal(calls.length, n);

  // the plugin's copy of the parser agrees with the domain's
  for (const v of [block(info()), { a: [{ text: block(info({ message_id: 'X' })) }] }, 'nothing', null, 42]) {
    assert.deepEqual(plugin.findConversationInfo(v), groupContext.parseConversationInfo(v));
  }
});

test('brokerd files the row for the session the block names, and refuses the rest', async () => {
  const stored = await broker.dispatch({ id: 1, method: 'group_context', params: { agentId: 'ggreet', sessionKey: KEY, info: info() } });
  assert.deepEqual(stored, { ok: true, stored: true, members: true, wasMentioned: true });
  const row = await withTx(db.pool, (c) => groupContext.read(c, 'ggreet', KEY));
  assert.equal(row.members, 'M&M (+972526269826), +972603000011');
  assert.equal(row.subject, 'פאדל שלישי');
  assert.equal(row.senderE164, '+972526269826');
  assert.equal(row.senderName, 'M&M');
  assert.equal(row.wasMentioned, true);
  assert.equal(row.messageId, '3AD99E29DEB9A7799A3B');

  // a later message replaces it — the sweep wants the newest tag
  await broker.dispatch({ id: 2, method: 'group_context', params: { agentId: 'ggreet', sessionKey: KEY, info: info({ message_id: 'LATER', was_mentioned: false }) } });
  const again = await withTx(db.pool, (c) => groupContext.read(c, 'ggreet', KEY));
  assert.equal(again.messageId, 'LATER');
  assert.equal(again.wasMentioned, false);
  const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM group_inbound_context`);
  assert.equal(rows[0].n, 1);

  // refusals: a user agent, a DM key, another agent's key, a block naming another group
  const bad = [
    { agentId: 'u-3', sessionKey: 'agent:u-3:whatsapp:group:' + JID, info: info() },
    { agentId: 'ggreet', sessionKey: 'agent:ggreet:whatsapp:direct:+972526269826', info: info() },
    { agentId: 'ggreet', sessionKey: 'agent:g-7:whatsapp:group:' + JID, info: info() },
    { agentId: 'ggreet', sessionKey: KEY, info: info({ chat_id: 'whatsapp:120363000000000009@g.us' }) },
    { agentId: 'ggreet', sessionKey: KEY, info: null },
  ];
  for (const params of bad) {
    const r = await broker.dispatch({ id: 3, method: 'group_context', params });
    assert.equal(r.ok, false, JSON.stringify(params));
  }
  // a bare chat_id (no channel prefix) is the same group
  const bare = await broker.dispatch({ id: 4, method: 'group_context', params: { agentId: 'ggreet', sessionKey: KEY, info: info({ chat_id: JID }) } });
  assert.equal(bare.ok, true);
  // nothing stored is null, never an empty group
  assert.equal(await withTx(db.pool, (c) => groupContext.read(c, 'ggreet', 'agent:ggreet:whatsapp:group:1@g.us')), null);
});

// The founding case, replayed: the first live group message (2026-09-06
// 15:09 UTC) — a session the store lists, a block the plugin filed, and no
// transcript worth reading. With nothing injected but the session listing
// and the pipe, the sweep must register the group and introduce her.
test('the sweep registers a group from the filed row alone, and answers the tag as a reply to it', async () => {
  const a = await makeUser(db.pool, '+972603000010');
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [a.id]);
  const jid = '120363400000000001@g.us';
  const key = `agent:ggreet:whatsapp:group:${jid}`;
  const sent = [];
  const at = Date.now();
  const deps = {
    configPath,
    listGroupSessions: () => [{ key, agentId: 'ggreet', channel: 'whatsapp', chatType: 'group', peer: jid, lastInteractionAt: at }],
    send: async (target, body, opts) => { sent.push({ target, body, replyTo: opts && opts.replyTo }); return true; },
  };

  // before anything was filed: unreadable, silent, no row
  let out = await withTx(db.pool, (c) => job.sweepGroups(c, deps));
  assert.equal(out.unreadable, 1);
  assert.deepEqual(sent, []);

  // the plugin files the first message (not a tag — she wakes on anything before registration)
  await broker.dispatch({ id: 1, method: 'group_context', params: { agentId: 'ggreet', sessionKey: key, info: info({ chat_id: `whatsapp:${jid}`, message_id: 'FIRST', was_mentioned: false, group_members: `דני (${a.phone}), +972603000011` }) } });
  out = await withTx(db.pool, (c) => job.sweepGroups(c, deps));
  assert.deepEqual(out.registered, [jid]);
  assert.equal(out.intros, 1);
  assert.match(sent[0].body, /נעים מאוד/);
  const row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', jid));
  assert.equal(row.state, 'locked');

  // a tag, one message later: the notice, quoted under the tag
  deps.listGroupSessions = () => [{ key, agentId: 'ggreet', channel: 'whatsapp', chatType: 'group', peer: jid, lastInteractionAt: at + 60_000 }];
  await broker.dispatch({ id: 2, method: 'group_context', params: { agentId: 'ggreet', sessionKey: key, info: info({ chat_id: `whatsapp:${jid}`, message_id: 'TAG-1', was_mentioned: true, group_members: `דני (${a.phone}), +972603000011` }) } });
  out = await withTx(db.pool, (c) => job.sweepGroups(c, deps));
  assert.equal(out.notices, 1);
  assert.equal(sent.at(-1).replyTo, 'TAG-1');
  assert.match(sent.at(-1).body, /@\+972603000011/);
});
