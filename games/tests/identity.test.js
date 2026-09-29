'use strict';
// The brokerd client: one line out, one line back, and every way the socket
// can fail is a rejection — never a silent pass and never a hang.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { resolveIdentity } = require('../src/identity');

function fakeBroker(t, onLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'games-id-'));
  const sock = path.join(dir, 'b.sock');
  const server = net.createServer(c => {
    let buf = '';
    c.on('data', ch => { buf += ch; const i = buf.indexOf('\n'); if (i >= 0) onLine(JSON.parse(buf.slice(0, i)), c); });
  });
  t.after(() => new Promise(r => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); })));
  return new Promise(r => server.listen(sock, () => r(sock)));
}

test('asks brokerd identity_resolve as games, and hands back its answer', async t => {
  let seen;
  const sock = await fakeBroker(t, (msg, c) => { seen = msg; c.write(JSON.stringify({ id: msg.id, ok: true, user: { id: 7 }, packs: [] }) + '\n'); });
  const out = await resolveIdentity('olma_tok_x', { sock });
  assert.deepEqual(seen, { id: 1, method: 'identity_resolve', params: { token: 'olma_tok_x', caller: 'games' } });
  assert.deepEqual(out, { id: 1, ok: true, user: { id: 7 }, packs: [] });
});

test('no socket, a hang-up and silence are each a rejection', async t => {
  await assert.rejects(resolveIdentity('t', { sock: path.join(os.tmpdir(), 'no-such-games.sock') }));
  const closes = await fakeBroker(t, (msg, c) => c.end());
  await assert.rejects(resolveIdentity('t', { sock: closes }), /closed/);
  const silent = await fakeBroker(t, () => {});
  await assert.rejects(resolveIdentity('t', { sock: silent, timeoutMs: 100 }), /timeout/);
});
