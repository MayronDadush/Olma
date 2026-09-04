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
const { readIdentity, stripIdentity } = require('../adapters/mcp/identity-param');
const { FloodCounter } = require('./flood');
const { refreshUserCard, CARD_TOOLS } = require('../intake/user-card');
const turnDomain = require('../domain/turn');

// One of these per turn. The gateway spawns a fresh MCP shim for every agent
// turn and the shim holds ONE socket to brokerd for its whole life, so a
// connection IS a turn — no new protocol field, no clock heuristic. A shim
// that reconnects mid-turn (only after a socket error) starts a new one; the
// cost of that rare case is one extra counted message, against the current
// cost of a whole turn going uncounted.
//
// That mapping is true of the gateway TODAY, and bin/olma-mcp.js already
// refuses to bet on it staying true (its identity self-healing says so in
// as many words). So neither does this: `userId` below makes a connection
// that ever serves a second user start a fresh turn, and the recovery's
// count is consumed exactly once. Both mean that if the process model
// changes underneath us, the failure is "no recovery" — today's behaviour —
// rather than a message silently going uncounted for someone else.
const newTurn = () => ({ userId: null, opened: false, counted: false, quota: null });

function createBrokerServer({ pool, flood }) {
  flood = flood || new FloodCounter();

  async function handleToolCall(name, args, turn = newTurn()) {
    const tool = BY_NAME.get(name);
    if (!tool) return { ok: false, text: `ERROR not_found: unknown tool ${name}` };
    try {
      let actorId = null;
      const result = await withTx(pool, async (client) => {
        const auth = await usersDomain.resolveByToken(client, readIdentity(args));
        if (!auth.ok) {
          // Every auth failure is on the record: a bug or an attempt, and in
          // both cases something the dashboard should surface.
          await require('../domain/audit').record(client, null, 'auth.failed', {
            tool: name, reason: auth.error.message,
          });
          return auth;
        }
        actorId = auth.data.user.id;

        // The first tool of the turn decides whether the turn was opened
        // properly. `turn_start` opens it itself; anything else means the
        // model skipped the call, and the record has to be repaired by the
        // one layer that cannot forget (see domain/turn.js).
        //
        // The flag is read ONLY on that defect path — a healthy turn opens
        // with turn_start, marks itself opened, and never touches this
        // branch again, so nothing is added to the hot path.
        // A connection that ever serves a different user is not the same turn,
        // whatever the transport thinks.
        if (turn.userId !== actorId) {
          turn.userId = actorId;
          turn.opened = false; turn.counted = false; turn.quota = null;
        }

        if (!turn.opened) {
          turn.opened = true;
          if (name !== 'turn_start' && await turnDomain.isEnabledFor(client, auth.data.user)) {
            const recovered = await turnDomain.openTurnImplicitly(client, auth.data.user, { firstTool: name });
            turn.counted = recovered.counted;
            turn.quota = recovered.quota;
            // Only this path still saw a NULL last_inbound_at; it has just
            // overwritten it, so a turn_start later in the same turn can no
            // longer tell a first message from a thousandth one.
            turn.firstTurn = recovered.firstTurn;
          }
        }

        const out = await tool.handler(client, auth.data.user, stripIdentity(args), { flood, turn });
        // The recovery's count is worth exactly one `turn_start`. Clearing it
        // here means a connection that outlives its turn cannot make the NEXT
        // turn's turn_start believe its message was already counted — which
        // would be this fix causing the very thing it exists to prevent.
        // `firstTurn` is spent by the same rule and cleared in the same
        // breath: a connection that outlives its turn must not hand the NEXT
        // message a leftover "this person is brand new".
        if (name === 'turn_start') { turn.counted = false; turn.quota = null; turn.firstTurn = false; }
        return out;
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

  // `turn` is supplied by the connection handler below. It defaults to a fresh
  // one so a direct dispatch() — every test, and the ping path — behaves like
  // a turn of its own rather than depending on a caller it does not have.
  async function dispatch(msg, turn = newTurn()) {
    if (!msg || typeof msg !== 'object') return { ok: false, error: 'bad message' };
    switch (msg.method) {
      case 'ping':
        return { ok: true, pong: true, pid: process.pid };
      case 'tool_call': {
        const { name, args } = msg.params || {};
        return handleToolCall(name, args, turn);
      }
      default:
        return { ok: false, error: `unknown method ${msg.method}` };
    }
  }

  const server = net.createServer((socket) => {
    // One connection, one shim, one turn — see newTurn() above.
    const turn = newTurn();
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
        const res = await dispatch(msg, turn);
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
