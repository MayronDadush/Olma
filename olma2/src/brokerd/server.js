'use strict';
// The brokerd core: a unix-socket server dispatching tool calls into the
// domain, one transaction per call, over a shared pg pool. Line-delimited
// JSON: {id, method, params} → {id, ok, ...}.
//
// This process outliving turns is the point: connection pool (managed
// Postgres allows ~22 connections — a pool of 10 serves hundreds of users),
// in-memory flood counters, and (Phase D) the outbox worker.
const net = require('node:net');
const fs = require('node:fs');
const { withTx } = require('../db/pool');
const usersDomain = require('../domain/users');
const { BY_NAME } = require('../adapters/mcp/registry');
const { renderResult } = require('../adapters/mcp/render');
const { FloodCounter } = require('./flood');
const { refreshUserCard, CARD_TOOLS } = require('../intake/user-card');

function createBrokerServer({ pool, flood }) {
  flood = flood || new FloodCounter();

  async function handleToolCall(name, args) {
    const tool = BY_NAME.get(name);
    if (!tool) return { ok: false, text: `ERROR not_found: unknown tool ${name}` };
    try {
      let actorId = null;
      const result = await withTx(pool, async (client) => {
        const auth = await usersDomain.resolveByToken(client, args && args.identity_token);
        if (!auth.ok) {
          // Every auth failure is on the record: a bug or an attempt, and in
          // both cases something the dashboard should surface.
          await require('../domain/audit').record(client, null, 'auth.failed', {
            tool: name, reason: auth.error.message,
          });
          return auth;
        }
        const { identity_token, ...rest } = args || {};
        actorId = auth.data.user.id;
        return tool.handler(client, auth.data.user, rest, { flood });
      });
      // Identity-shaping calls re-render the user's USER.md card — outside
      // the transaction on purpose, so the card always reflects committed
      // state and a file hiccup can never fail the tool call itself.
      // Two ways a call can leave the card stale: the tool always changes a
      // card field (CARD_TOOLS), or the handler decided this particular call
      // did (result.cardStale — see registry.stale, used by turn_start, which
      // runs on every message and so must not re-render on every message).
      if (actorId && result && result.ok && (CARD_TOOLS.has(name) || result.cardStale)) {
        await refreshUserCard(pool, actorId);
      }
      return { ok: true, text: renderResult(result) };
    } catch (e) {
      // Never leak internals to the agent; full error goes to the journal.
      console.error(`[brokerd] ${name} failed:`, e);
      return { ok: false, text: 'ERROR internal: tool failed, try again or report' };
    }
  }

  async function dispatch(msg) {
    if (!msg || typeof msg !== 'object') return { ok: false, error: 'bad message' };
    switch (msg.method) {
      case 'ping':
        return { ok: true, pong: true, pid: process.pid };
      case 'tool_call': {
        const { name, args } = msg.params || {};
        return handleToolCall(name, args);
      }
      default:
        return { ok: false, error: `unknown method ${msg.method}` };
    }
  }

  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > 8 * 1024 * 1024) { // bound per-connection memory
        buf = '';
        socket.destroy();
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { socket.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n'); continue; }
        const res = await dispatch(msg);
        socket.write(JSON.stringify({ id: msg.id, ...res }) + '\n');
      }
    });
    socket.on('error', () => { /* client vanished mid-write; nothing to do */ });
  });

  function listen(sockPath) {
    fs.mkdirSync(require('node:path').dirname(sockPath), { recursive: true }); // run/ may not survive deploys
    if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); // stale socket from a crash
    return new Promise((resolve) => server.listen(sockPath, () => {
      // The socket is an unauthenticated door into every user's data — the
      // only thing guarding it is the filesystem. Owner-only, explicitly.
      try { fs.chmodSync(sockPath, 0o600); } catch { /* best effort */ }
      resolve(server);
    }));
  }

  return { server, listen, dispatch, flood };
}

module.exports = { createBrokerServer };
