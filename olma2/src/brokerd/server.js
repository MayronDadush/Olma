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
const selfInitiated = require('../domain/self-initiated');
const { captureDisplayName } = require('../adapters/mcp/tools/_shared');

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
//
// A QUEUE per user, oldest first, since 2026-09-06 — it was one slot, and
// Miron's "בוצע" followed three seconds later by "עוד לא" showed what a slot
// does: the second open overwrote the first, so the first turn's tools would
// have adopted the second message's open (its marks on the wrong message,
// and under the gateway's follow-up queue mode the first message's open
// simply gone). Now each message keeps its own entry; which one a turn
// adopts is decided below (takePending / peekPending), and the queue is
// capped so a person who writes ten lines while the model thinks cannot
// grow it without bound.
const PENDING_TTL_MS = 10 * 60_000;
const PENDING_MAX_PER_USER = 8;

function createBrokerServer({ pool, flood, placeMark, now }) {
  flood = flood || new FloodCounter();
  const clock = typeof now === 'function' ? now : Date.now;
  // userId → [{ messageId, kind, senderName, replyToId, lastInboundAt, counted, quota, firstTurn, openedAt, contextSent }], oldest first
  const pending = new Map();
  function livePending(userId) {
    const list = (pending.get(userId) || []).filter((p) => clock() - p.openedAt <= PENDING_TTL_MS);
    if (list.length) pending.set(userId, list); else pending.delete(userId);
    return list;
  }
  function pushPending(userId, entry) {
    const list = livePending(userId);
    list.push(entry);
    while (list.length > PENDING_MAX_PER_USER) list.shift();
    pending.set(userId, list);
  }
  // The shim connection's first tool call adopts an open. Which one: the
  // oldest whose opening was already put in the prompt (`contextSent`) —
  // that is the turn now running, and a later message that arrived while it
  // ran must not be stolen from its own turn. With no such entry (the turn
  // opens with turn_start, or the plugin never asked) it is the newest, and
  // the older ones are dropped with it: they belong to turns that ended with
  // no tool call at all, and adopting one of those would put this turn's
  // marks on an earlier message — exactly the one-slot bug, one step behind.
  function takePending(userId) {
    const list = livePending(userId);
    if (!list.length) return null;
    const idx = list.findIndex((p) => p.contextSent);
    let taken;
    if (idx >= 0) { taken = list[idx]; list.splice(idx, 1); }
    else { taken = list[list.length - 1]; list.length = 0; }
    if (list.length) pending.set(userId, list); else pending.delete(userId);
    return taken;
  }
  // Read without adopting: `turn_context` needs the open but must leave it
  // for the shim connection, which is what puts the 👍 on the right message.
  // The oldest entry not yet put in a prompt is this prompt's message; every
  // entry older than it was already contexted for a turn that has since
  // ended (the gateway runs one turn per session at a time) and is dropped
  // here, so a turn that made no tool call leaves nothing behind for the
  // next one to adopt by mistake. A rebuilt prompt for the same message
  // (every entry already contexted) reads the newest again, and the
  // `contextSent` flag on it keeps the first-turn stamp from being spent
  // twice.
  function peekPending(userId) {
    const list = livePending(userId);
    if (!list.length) return null;
    const idx = list.findIndex((p) => !p.contextSent);
    if (idx < 0) return list[list.length - 1];
    if (idx > 0) { list.splice(0, idx); pending.set(userId, list); }
    return list[0];
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
        // The WhatsApp display name, kept for `turn_context` below: on the
        // turn_start path the model relays it as sender_name; here the hook
        // already saw it, so the person whose prompt opens the turn is named
        // by the same rule (a guess they still confirm, never an overwrite).
        senderName: typeof params.senderName === 'string' ? params.senderName.slice(0, 80) : null,
        // The message they replied to, when the hook saw a WhatsApp reply.
        // Only `turn_context` reads it (the plugin cannot see the reply from
        // where it stands — see the hook); on the turn_start path the model
        // relays `reply_to_id` itself, as before.
        replyToId: reactions.cleanMessageId(params.replyToId) || null,
        counted: rec.counted, quota: rec.quota, firstTurn: Boolean(rec.firstTurn),
        marked: new Set(), contextSent: false,
      };
      if (!rec.skipped && messageId) {
        // The 👀 (or 👂) goes on now, from here, while the model is still reading
        // the prompt — the ack the feature promised, given before any model latency.
        const vocab = reactions.vocabulary(await require('../domain/flags').getFlag(client, reactions.VOCAB_FLAG));
        mark = { channel: 'whatsapp', target: user.phone, messageId, state, emoji: vocab[state] };
        entry.marked.add(`${messageId}:${state}`);
        entry.reactionVocab = vocab;
      }
      if (!rec.skipped) pushPending(Number(user.id), entry);
      out = { ok: true, opened: !rec.skipped, skipped: rec.skipped || null, userId: Number(user.id), counted: rec.counted };
    });
    if (mark) placeMark(mark);
    return out;
  }

  // Phase B of the same feature: the gateway plugin (gateway-plugin/olma-turn,
  // `before_prompt_build`) asks for what turn_start would have RETURNED, and
  // prepends it to the prompt — so for the people turn_context_phones covers
  // the model reads its opening instead of calling for it, and a reply with no
  // tool call at all is still a counted, hinted, marked turn.
  //
  // Reads the pending open, never adopts it: the shim connection's first tool
  // call still does that, which is what keeps every mark on the real message.
  // With no open on file this answers `context: null` and records why — the
  // doctrine variant then falls back to calling turn_start, so a hook that
  // misfired costs a tool call, not a count. Never opens a turn itself: the
  // prompt build runs for cron lanes and deliveries too, and this cannot tell
  // a person writing from a job running on their agent; the hook can.
  async function handleTurnContext(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (!/^u-\d+$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    let out = null;
    let userId = null;
    let cardStale = false;
    await withTx(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT id, phone, first_name, locale, paused_at FROM users WHERE agent_id = $1 AND status = 'active'`, [agentId]);
      const user = rows[0];
      if (!user) { out = { ok: false, error: 'no active user for agent' }; return; }
      userId = Number(user.id);
      if (!await turnDomain.contextEnabledFor(client, user)) { out = { ok: true, enabled: false }; return; }
      const ourTurn = selfInitiated.isActive(user.id);
      // A turn Olma started reads no open: the person's own pending message,
      // if one is waiting, keeps its opening for its own prompt.
      const pre = ourTurn ? null : peekPending(userId);
      // The reply, from whichever side saw it: the hook (the WhatsApp quote,
      // parsed at preprocess time) or the plugin (a `reply_to_id` in the
      // prompt — which on OpenClaw 2026.8.1 it never sees, kept for a
      // gateway that changes that).
      const replyTarget = params.replyTarget === true || Boolean(pre && pre.replyToId);
      if (!pre && !ourTurn) {
        await require('../domain/audit').record(client, user.id, 'turn.context_without_open', {
          trigger: params.trigger || null, messageProvider: params.messageProvider || null,
        });
        out = { ok: true, enabled: true, context: null };
        return;
      }
      if (pre && !user.first_name && pre.senderName) {
        cardStale = (await captureDisplayName(client, user, pre.senderName)).ok;
      }
      const data = await turnDomain.advise(client, user, {
        counted: ourTurn || !pre ? { data: { blocked: false } } : pre.quota,
        // Spent on the first prompt build for this message: a rebuilt prompt
        // (model fallback) is the same message, and must not stamp twice.
        firstTurn: Boolean(pre && pre.firstTurn && !pre.contextSent),
        ourTurn, replyTarget, languageNudge: null,
      });
      if (pre) pre.contextSent = true;
      out = { ok: true, enabled: true, context: turnDomain.renderContext(data), directive: data.directive };
    });
    if (cardStale && userId) await refreshUserCard(pool, userId);
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
      case 'turn_context':
        return handleTurnContext(msg.params || {});
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

  return { server, listen, dispatch, flood, pendingCount: () => [...pending.values()].reduce((n, l) => n + l.length, 0) };
}

module.exports = { createBrokerServer };
