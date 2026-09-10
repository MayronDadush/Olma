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
const { BY_NAME, audienceOf } = require('../adapters/mcp/registry');
const { renderResult } = require('../adapters/mcp/render');
const { readIdentity, stripIdentity } = require('../adapters/mcp/identity-param');
const { FloodCounter } = require('./flood');
const { refreshUserCard, CARD_TOOLS } = require('../intake/user-card');
const turnDomain = require('../domain/turn');
const reactions = require('../domain/reactions');
const selfInitiated = require('../domain/self-initiated');
const { captureDisplayName } = require('../adapters/mcp/tools/_shared');
const groupContext = require('../domain/group-context');
const groupsDomain = require('../domain/groups');
const replyLeak = require('../domain/reply-leak');

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
  // Eleven of the first ~200 opens the gateway hook sent timed out on ITS side
  // (2s) and left nothing here — no audit row, no journal line, no crash — so
  // whether brokerd was slow, blocked or never reached could not be told
  // apart. `tool_call` above logs its failures; this path did not. Now it
  // does, and it logs where the time went whenever it takes longer than the
  // hook is willing to wait for half of it. A quiet failure is not a passing
  // one (CLAUDE.md, "a check that goes quiet").
  const TURN_OPEN_SLOW_MS = 1000;
  async function handleTurnOpen(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (!/^u-\d+$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    const started = Date.now();
    const steps = [];
    const lap = (name) => steps.push(`${name}=${Date.now() - started}`);
    try {
      const out = await openTurnFromGateway(agentId, params, lap);
      const ms = Date.now() - started;
      if (ms >= TURN_OPEN_SLOW_MS) console.error(`[brokerd] turn_open ${agentId} slow: ${ms}ms (${steps.join(' ')})`);
      return out;
    } catch (e) {
      console.error(`[brokerd] turn_open ${agentId} failed after ${Date.now() - started}ms (${steps.join(' ')}):`, e);
      return { ok: false, error: 'turn_open failed' };
    }
  }

  async function openTurnFromGateway(agentId, params, lap) {
    const messageId = reactions.cleanMessageId(params.messageId);
    const kind = params.kind === 'voice' ? 'voice' : 'text';
    let out = null;
    let mark = null;
    await withTx(pool, async (client) => {
      lap('tx');
      const { rows } = await client.query(
        `SELECT id, phone FROM users WHERE agent_id = $1 AND status = 'active'`, [agentId]);
      lap('user');
      const user = rows[0];
      if (!user) { out = { ok: false, error: 'no active user for agent' }; return; }
      const rec = await turnDomain.openFromGateway(client, user, { messageId, kind });
      lap('open');
      // The hook classified the text and sent us the verdict, never the words
      // (gateway-hooks/olma-turn-open). A message that is only thanks gets 🙏
      // instead of 👀: 👀 promises a reply and this one is not getting one.
      const thanksOnly = params.thanks === true;
      const state = thanksOnly ? 'thanks' : (kind === 'voice' ? 'listening' : 'working');
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
        thanksOnly,
        marked: new Set(), contextSent: false,
      };
      if (!rec.skipped && messageId) {
        // The 👀 (or 👂) goes on now, from here, while the model is still reading
        // the prompt — the ack the feature promised, given before any model latency.
        const vocab = reactions.vocabulary(await require('../domain/flags').getFlag(client, reactions.VOCAB_FLAG));
        lap('vocab');
        mark = { channel: 'whatsapp', target: user.phone, messageId, state, emoji: vocab[state] };
        entry.marked.add(`${messageId}:${state}`);
        entry.reactionVocab = vocab;
      }
      if (!rec.skipped) pushPending(Number(user.id), entry);
      out = { ok: true, opened: !rec.skipped, skipped: rec.skipped || null, userId: Number(user.id), counted: rec.counted };
    });
    lap('commit');
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
  // The gateway plugin's `llm_input` sighting of a GROUP turn: the
  // Conversation info block the gateway composed for the model, reduced to
  // the row the group sweep reads (domain/group-context.js — why this exists
  // is written there). Only the greeter and the group agents may file one,
  // only for a session of their own, and only for the group the block itself
  // names. Nothing here is user data and no turn is opened: a group turn is
  // not a person writing to her.
  async function handleGroupContext(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (!/^(ggreet|g-\d+)$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    const built = groupContext.fromConversationInfo(agentId, params.sessionKey, params.info, { at: params.at });
    if (!built.ok) return { ok: false, error: built.reason };
    let wrote = false;
    await withTx(pool, async (client) => {
      await groupContext.store(client, built.row);
      // Same transaction: the room's newest message and "this member spoke"
      // are one fact, and a stamp without the context row would be a window
      // opened by a message nothing else can account for.
      wrote = await groupContext.noteMemberWrote(client, built.row);
    });
    return {
      ok: true, stored: true, members: built.row.members ? true : false,
      wasMentioned: built.row.wasMentioned, memberWrote: wrote,
    };
  }

  // The reply gate's report. The plugin has already decided and already acted
  // — this is the only record that it happened, so it is written even when
  // nothing was dropped (an `identifier` the closed list has not heard of is
  // exactly the row somebody needs to see before it becomes the next leak).
  //
  // The TEXT never comes here and is never stored. What leaked is the point;
  // what was in the rest of the message is the person's business, and a frame
  // marker can BE a live credential (`domain/token-leak.js`) — the plugin
  // redacts one before it leaves the gateway and this refuses to widen that.
  async function handleReplyGate(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (!/^(?:u-\d+|g-\d+|ggreet)$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    const action = String(params.action || '').trim();
    if (!['pass', 'trim', 'cancel'].includes(action)) return { ok: false, error: 'bad action' };
    const leaks = (Array.isArray(params.leaks) ? params.leaks : []).slice(0, 12).map((l) => ({
      kind: String((l && l.kind) || '').slice(0, 20),
      at: replyLeak.redact(String((l && l.at) || '')).slice(0, 40),
      line: Number.isInteger(l && l.line) ? l.line : null,
    }));
    await withTx(pool, async (client) => {
      // A group agent has no user row behind it, and audit_log.actor_id is
      // nullable for exactly that: the event is still the whole record.
      const { rows } = /^u-\d+$/.test(agentId)
        ? await client.query('SELECT id FROM users WHERE agent_id = $1 AND status = \'active\'', [agentId])
        : { rows: [] };
      await require('../domain/audit').record(client, rows[0] ? Number(rows[0].id) : null, 'reply.gated', {
        agentId, action, leaks,
        kinds: [...new Set(leaks.map((l) => l.kind))],
        chars: Number.isFinite(params.chars) ? params.chars : null,
        kept: Number.isFinite(params.kept) ? params.kept : null,
        channel: params.channel ? String(params.channel).slice(0, 40) : null,
      });
    });
    return { ok: true, filed: true };
  }

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
        thanksOnly: Boolean(pre && pre.thanksOnly),
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
        // ── the group door ────────────────────────────────────────────────
        // Routed on the token's PREFIX, before the user door is even tried:
        // a group token must never be looked up among people, and a truncated
        // one must be refused as a group rather than come back "unknown
        // identity token" and send the model hunting for a person's file.
        //
        // Everything below this branch — the quota, the 👀 on somebody's
        // message, USER.md — is person-shaped and none of it applies to a
        // room. A group turn is short by construction: resolve, check the
        // audience, name the member who tagged her, run.
        if (groupsDomain.looksLikeGroupToken(readIdentity(args))) {
          const g = await groupsDomain.resolveByToken(client, readIdentity(args));
          if (!g.ok) {
            await require('../domain/audit').record(client, null, 'auth.failed', {
              tool: name, reason: g.error.message, caller: 'group',
            });
            return g;
          }
          const group = g.data.group;
          // A list is not a lock. The shim shows a group agent only its own
          // handful, but the refusal that matters is here: a group token
          // reaching a person's tool is the failure this whole design exists
          // to make impossible, so it is checked where the call actually runs.
          if (audienceOf(tool) !== 'group') {
            await require('../domain/audit').record(client, group.registered_by_user_id, 'group.tool_refused', {
              tool: name, groupId: group.id, reason: 'not a group tool',
            });
            return { ok: false, error: { code: 'forbidden', message: `${name} is not available in a group` } };
          }
          const actingUser = await groupsDomain.actingMember(client, group);
          // On the record every time, with the member it acted for: a room is
          // several people, and "who asked for this" is the first question
          // anybody will have about anything she did there.
          await require('../domain/audit').record(client, actingUser ? actingUser.id : null, 'group.tool', {
            tool: name, groupId: group.id, actingPhone: actingUser ? actingUser.phone : null,
          });
          return tool.handler(client, { group, actingUser }, stripIdentity(args), { flood, now: clock });
        }

        const auth = await usersDomain.resolveByToken(client, readIdentity(args));
        if (!auth.ok) {
          // Every auth failure is on the record: a bug or an attempt, and in
          // both cases something the dashboard should surface.
          await require('../domain/audit').record(client, null, 'auth.failed', {
            tool: name, reason: auth.error.message,
          });
          return auth;
        }
        // The mirror of the refusal above: these tools answer to a room, and
        // a person calling one would be asking about a group from inside a
        // private chat where nobody else can see what was asked.
        if (audienceOf(tool) === 'group') {
          return { ok: false, error: { code: 'forbidden', message: `${name} is only available to a group` } };
        }
        actorId = auth.data.user.id;
        actorPhone = auth.data.user.phone;

        // The first tool of the turn decides whether the turn was opened
        // properly. `turn_start` opens it itself; anything else means the
        // model skipped the call, and the record has to be repaired by the
        // one layer that cannot forget (see domain/turn.js).
        //
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

        // ── A pending open is adopted on ANY call, not the connection's first ─
        // This was `if (!turn.opened)` for two days, and `turn.opened` is a
        // latch that only ever clears on a change of user — which never
        // happens, one agent serving one person. But the shim caches ONE
        // socket for the life of the MCP process (`bin/olma-mcp.js`), and that
        // process outlives the turn by hours. So the FIRST message the process
        // ever saw froze itself into `turn.messageId`, and every turn after it
        // marked that message instead of its own: Miron got an ⏰ on a message
        // he had sent five minutes and forty seconds earlier, and once the
        // frozen id aged past the live window Yahav's evening earned no closing
        // mark at all for six hours (`incidents.md`, "The mark that never
        // moved"). Every 👀 anyone saw in between was the gateway's own
        // `ackReaction`, which is why the feature looked alive throughout.
        //
        // Adopting per call is safe against the double-count this latch was
        // guarding: `takePending` REMOVES the entry, so each opening — and each
        // count, quota and first-turn verdict on it — is consumed exactly once,
        // by whichever call gets there first. Later calls in the same turn find
        // nothing pending and keep what they hold.
        const pre = takePending(actorId);
        if (pre) {
          turn.opened = true;
          turn.counted = pre.counted; turn.quota = pre.quota; turn.firstTurn = pre.firstTurn;
          turn.messageId = pre.messageId; turn.lastInboundAt = pre.lastInboundAt;
          turn.messageKind = pre.kind; turn.marked = pre.marked; turn.reactionVocab = pre.reactionVocab;
          turn.thanksOnly = pre.thanksOnly;
          turn.openedByGateway = true;
        } else if (!turn.opened) {
          // No gateway open on file and this connection has not served a turn
          // yet: the model skipped `turn_start` and the record needs repairing.
          // Still latched, and deliberately — without an opening there is
          // nothing that can tell one turn from the next on this socket, so a
          // per-call recovery would count a single message once per tool.
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
        } else if (turn.messageId && !reactions.isLive(turn.lastInboundAt, clock())) {
          // Nothing to adopt, and the opening we are still holding is older
          // than the window a mark may be placed in — so it belongs to a turn
          // that has ended. `markFor` would refuse it anyway; dropping it here
          // says so once, where the id lives, instead of leaving a dead message
          // id on the turn for every later reader to have to distrust.
          turn.messageId = null; turn.lastInboundAt = null; turn.marked = null;
        }

        const out = await tool.handler(client, auth.data.user, stripIdentity(args), { flood, turn, now: clock });
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
      // The injected clock, not `Date.now()`: the turn's `lastInboundAt` was
      // written from it, and a liveness test where the two sides read different
      // clocks is one no test can pin.
      const mark = reactions.markFor(name, result, turn, clock());
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
        // What is now standing on their message, for the hint below. Recorded
        // where the attempt is made, so a mark nobody could spawn is never
        // claimed — `attempted`, never `sent`, exactly as the hint says.
        if (placed && placed.attempted) reactions.noteMarkAttempted(turn, mark);
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
      // The hint follows the MARK, not the spawn. `markFor` dedupes on message
      // AND state, so the SECOND done-tool of a turn gets null from it and
      // used to get no hint either — which is how Gali's `complete_task`, the
      // last thing the model read before writing, came back saying nothing at
      // all while a 👍 was already on her message (2026-09-10; see
      // reactions.doneMarkStands). One mark, and every result that earned it
      // says so.
      if (reactions.doneMarkStands(name, result, turn, clock()) && result.data && typeof result.data === 'object') {
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
      case 'group_context':
        return handleGroupContext(msg.params || {});
      case 'reply_gate':
        return handleReplyGate(msg.params || {});
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
