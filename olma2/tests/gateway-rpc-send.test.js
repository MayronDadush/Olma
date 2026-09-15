'use strict';
// The raw pipe moved from a fresh `openclaw` process to the gateway's own
// WebSocket RPC (channels/gateway-rpc.js). What is asserted here is not the
// speed — it is the one thing that can go wrong when a message has two pipes:
// saying a sentence twice, or recording a sent one as unsent.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendRawMessage } = require('../src/channels/openclaw');

function cliSpy() {
  const calls = [];
  return { calls, run: async (args) => { calls.push(args); return { ok: true, viaCli: true }; } };
}

test('a sentence the gateway accepted never reaches the CLI', async () => {
  const cli = cliSpy();
  const seen = [];
  const res = await sendRawMessage(
    { channel: 'whatsapp', target: '+972500000001', message: 'שלום' },
    { gatewaySend: async (p) => { seen.push(p); return {}; }, runOpenclaw: cli.run },
  );
  assert.equal(res.ok, true);
  assert.equal(res.via, 'gateway');
  assert.equal(cli.calls.length, 0);
  assert.deepEqual(seen, [{ channel: 'whatsapp', to: '+972500000001', message: 'שלום' }]);
});

test('a request that never left falls back to the CLI, with the same arguments', async () => {
  const cli = cliSpy();
  const res = await sendRawMessage(
    { channel: 'whatsapp', target: '123@g.us', message: 'hi', replyTo: 'MSG7' },
    {
      gatewaySend: async () => { throw Object.assign(new Error('no socket'), { dispatched: false }); },
      runOpenclaw: cli.run,
    },
  );
  assert.equal(res.ok, true);
  assert.equal(res.viaCli, true);
  assert.deepEqual(cli.calls[0], [
    'message', 'send', '--channel', 'whatsapp', '--target', '123@g.us',
    '--message', 'hi', '--reply-to', 'MSG7',
  ]);
});

// The room-told-twice case. Once the frame is on the wire the gateway has
// very likely already handed the message to WhatsApp, so a second attempt on
// the other pipe is a second message — the exact failure `runOpenclaw`'s own
// `timedOut` flag exists to prevent (2026-09-06).
test('a send that timed out on the wire is never retried on the CLI, and says so', async () => {
  const cli = cliSpy();
  const res = await sendRawMessage(
    { channel: 'whatsapp', target: '123@g.us', message: 'the gate explanation' },
    {
      gatewaySend: async () => { throw Object.assign(new Error('send timed out after 45000ms'), { dispatched: true }); },
      runOpenclaw: cli.run,
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.equal(cli.calls.length, 0);
});

// A gateway that ANSWERED with an error delivered nothing and would tell the
// CLI the same thing, so this is a plain failure the outbox can retry on its
// own schedule — never a timeout, which would have the caller treat it as said.
test('a send the gateway refused is a plain failure, not a maybe', async () => {
  const cli = cliSpy();
  const res = await sendRawMessage(
    { channel: 'whatsapp', target: 'nobody', message: 'hi' },
    {
      gatewaySend: async () => {
        throw Object.assign(new Error('INVALID_REQUEST: unknown target'), { dispatched: true, refused: true });
      },
      runOpenclaw: cli.run,
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, undefined);
  assert.match(res.error, /unknown target/);
  assert.equal(cli.calls.length, 0);
});

test('the quoted message rides the gateway call as replyToId', async () => {
  const seen = [];
  await sendRawMessage(
    { channel: 'whatsapp', target: '123@g.us', message: 'answer', replyTo: 42 },
    { gatewaySend: async (p) => { seen.push(p); return {}; }, runOpenclaw: async () => ({ ok: true }) },
  );
  assert.equal(seen[0].replyToId, '42');
});

// A test process must never open a socket to the live gateway — `deploy.sh
// --restart` runs this suite ON THE BOX, where 127.0.0.1:18789 serves real
// people, and a socket has no temp-directory equivalent the way the config
// path does. So the module refuses before it reads anything, and the refusal
// is `dispatched: false`, which is the CLI's licence to take the send exactly
// as it did before this module existed.
test('inside the suite the gateway client declines rather than reaching production', async () => {
  const gatewayRpc = require('../src/channels/gateway-rpc');
  assert.equal(gatewayRpc.available(), false);
  await assert.rejects(
    () => gatewayRpc.sendMessage({ channel: 'whatsapp', to: '+972500000001', message: 'x' }),
    (err) => err.dispatched === false,
  );
});

// The switch that does not need a deploy: OLMA_GATEWAY_RPC_SEND=off in
// /opt/olma2/.env puts every sentence back on the CLI.
test('the kill switch is readable at call time, not captured at load', async () => {
  const gatewayRpc = require('../src/channels/gateway-rpc');
  const before = process.env.OLMA_GATEWAY_RPC_SEND;
  process.env.OLMA_GATEWAY_RPC_SEND = 'off';
  try { assert.equal(gatewayRpc.available(), false); }
  finally {
    if (before === undefined) delete process.env.OLMA_GATEWAY_RPC_SEND;
    else process.env.OLMA_GATEWAY_RPC_SEND = before;
  }
});
