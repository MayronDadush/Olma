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
const reactions = require('../domain/reactions');

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
const newTurn = () => ({
  userId: null, opened: false, counted: false, quota: null,
  // The inbound message id the acknowledgement marks attach to, and when it
  // arrived. Per-turn and never persisted: a mark belongs on the message being
  // handled right now, and a stale id would put one on the wrong message.
  messageId: null, lastInboundAt: null,
  // What has already been asked for on this turn, so a model that calls
  // `turn_start` twice does not buy a second identical reaction. Populated
  // lazily by markFor, which is the only thing that reads it.
  marked: null,
});

// A turn the gateway opened for a user BEFORE the model's first tool call
// (method `turn_open`, sent by gateway-hooks/olma-turn-open on every accepted
// inbound message). Held here until the shim connection for that user makes
// its first call and adopts it — no second count, and every mark lands on
// the real message id. Bounded by age: a pending open the model never
// followed (a message it answered with no tool at all) is dropped after
// PENDING_TTL_MS so it cannot be adopted by tomorrow's turn.
const PENDING_TTL_MS = 10 * 60_000;

function createBrokerServer({ pool, flood, placeMark, now }) {
  flood = flood || new FloodCounter();
  const clock = typeof now === 'function' ? now : Date.now;
  const pending = new Map(); // userId → { messageId, kind, lastInboundAt, counted, quota, firstTurn, openedAt }
  function takePending(userId) {
    const p = pending.get(userId);
    if (!p) return null;
    pending.delete(userId);
    return clock() - p.openedAt <= PENDING_TTL_MS ? p : null;
  }
  // Injectable for the same reason `send` is everywhere else here: the test
  // that matters for this feature is the one that watches a real turn place a
  // real mark, and it must do that without spawning anything.
  placeMark = placeMark || reactions.placeMark;

  // The gateway's opener. The agent id is the only identity the hook has, and
  // it is enough: one agent, one active user (config_guard keeps it so).
  async function handleTurnOpen(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (!/^u-\d+$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    const messageId = reactions.cleanMessageId(params.messageId);
    const kind = params.kind === 'voice' ? 'voice' : 'text';
    let out = null;
    let mark = null;
    await withTx(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT id, phone FROM users WHERE agent_id = $1 AND status = 'active'`, [agentId]);
      const user = rows[0];
      if (!user) { out = { ok: false, error: 'no active user for agent' }; return; }
      const rec = await turnDomain.openFromGateway(client, user, { messageId, kind });
      const state = kind === 'voice' ? 'listening' : 'working';
      const entry = {
        messageId, kind, lastInboundAt: clock(), openedAt: clock(),
        counted: rec.counted, quota: rec.quota, firstTurn: Boolean(rec.firstTurn),
        marked: new Set(),
      };
      if (!rec.skipped && messageId) {
        // The 👀 (or 👂) goes on now, from here, while the model is still reading
        // the prompt — the ack the feature promised, given before any model latency.
        const vocab = reactions.vocabulary(await require('../domain/flags').getFlag(client, reactions.VOCAB_FLAG));
        mark = { channel: 'whatsapp', target: user.phone, messageId, state, emoji: vocab[state] };
        entry.marked.add(`${messageId}:${state}`);
        entry.reactionVocab = vocab;
      }
      if (!rec.skipped) pending.set(Number(user.id), entry);
      out = { ok: true, opened: !rec.skipped, skipped: rec.skipped || null, userId: Number(user.id), counted: rec.counted };
    });
    if (mark) placeMark(mark);
    return out;
  }

  async function handleToolCall(name, args, turn = newTurn()) {
    const tool = BY_NAME.get(name);
    if (!tool) return { ok: false, text: `ERROR not_found: unknown tool ${name}` };
    try {
      let actorId = null;
      // Carried out of the transaction for the acknowledgement mark below: the
      // reaction target is read from OUR row, never from anything the model sent.
      let actorPhone = null;
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
        actorPhone = auth.data.user.phone;

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
          // Cleared with the rest, and this one is not bookkeeping: a message id
          // left over from the previous occupant of this connection would aim a
          // reaction at somebody else's message from inside this person's chat.
          turn.messageId = null; turn.lastInboundAt = null;
          turn.marked = null;
        }

        if (!turn.opened) {
          turn.opened = true;
          // Opened by the gateway already (turn_open): adopt it. The count,
          // the first-turn verdict and the message id are all in hand, and
          // the opening mark already went out — nothing here runs twice.
          const pre = takePending(actorId);
          if (pre) {
            turn.counted = pre.counted; turn.quota = pre.quota; turn.firstTurn = pre.firstTurn;
            turn.messageId = pre.messageId; turn.lastInboundAt = pre.lastInboundAt;
            turn.messageKind = pre.kind; turn.marked = pre.marked; turn.reactionVocab = pre.reactionVocab;
            turn.openedByGateway = true;
          } else if (name !== 'turn_start' && await turnDomain.isEnabledFor(client, auth.data.user)) {
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
      // The acknowledgement mark on the person's own message — 👀 as the turn
      // opens, ⏰ or ✅ as the work lands. Here, and not inside the handlers,
      // because every tool already passes through this one line: the table of
      // what earns which mark lives in domain/reactions.js and nothing else has
      // to know the feature exists.
      //
      // Outside the transaction and after the card refresh, for the same reason
      // that refresh is: this is decoration, and it may never fail a tool call
      // or hold one open. `placeMark` swallows its own failures and the target
      // is the user's OWN phone out of our database — never anything the model
      // supplied — so a wrong id can only mark a different message in the same
      // person's chat with Olma.
      const mark = reactions.markFor(name, result, turn);
      let placed = null;
      if (mark && actorPhone) {
        placed = placeMark({
          channel: 'whatsapp', // the one channel whose reactions we have verified
          target: actorPhone,
          messageId: turn.messageId,
          state: mark,
          // The operator's vocabulary, read once when the turn opened. Absent
          // (a direct dispatch, a turn that never called turn_start) means the
          // built-in table, which is the same thing this did before it was
          // configurable at all.
          emoji: turn.reactionVocab && turn.reactionVocab[mark],
        });
      }
      // Miron, 2026-09-05, having deleted a task by reply: he got the 👍 AND a
      // sentence saying it was deleted. The mark already says "done"; words
      // after it are a second notification for the same fact. So when — and
      // only when — a done-mark was asked for on this message, the result says
      // so, and the model is told the mark may be the whole answer. It rides
      // the RESULT rather than the doctrine: it costs tokens only on the turns
      // it applies to, and it arrives at the exact moment the model decides
      // what to write (the same budget rule as turn_start's hints).
      // `attempted`, never `sent` — placeMark makes no delivery claim, and
      // neither does this: the instruction is about not repeating the mark's
      // meaning, not about relying on the mark having landed.
      if (placed && placed.attempted && mark === 'done' && result && result.ok && result.data && typeof result.data === 'object') {
        result.data.hints = {
          ...(result.data.hints || {}),
          markPlaced: 'A 👍 has already been put on their message: it tells them this is done. '
            + 'If they gave a plain instruction and you have nothing to add — no question worth '
            + 'asking, no caveat, no error, no other hint here — reply with exactly NO_REPLY and '
            + 'nothing else. Write only when the words carry something the mark cannot.',
        };
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
      case 'turn_open':
        return handleTurnOpen(msg.params || {});
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

  return { server, listen, dispatch, flood, pendingCount: () => pending.size };
}

module.exports = { createBrokerServer };
