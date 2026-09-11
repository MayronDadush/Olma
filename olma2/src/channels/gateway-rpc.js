'use strict';
// One long-lived WebSocket to the gateway, in place of a fresh `openclaw`
// process per sentence.
//
// Why this exists. Every proactive sentence Olma says — a reminder rung, a
// digest, every fixed line a group hears — went out as `spawn('openclaw',
// ['message','send',...])`. Measured on the box 2026-09-08: 8.8-12.7s idle,
// and 49-95s when the room was busy, because the cost is a cold Node process
// loading the whole CLI, not the send. The gateway answers the same work in
// milliseconds; what we were paying for was the queue at its door.
//
//   openclaw message send   8,810-12,670 ms   (three runs, idle box)
//   connect + handshake       120-190 ms      (this module, cold)
//   one RPC on an open socket   5-35 ms
//
// This is the documented Gateway WebSocket protocol
// (`docs/gateway/protocol.md` in the openclaw install), not the store and not
// a reverse-engineered frame: the gateway opens with a `connect.challenge`
// event, the client answers `connect` with the shared token, the gateway
// replies `hello-ok`. Device signatures are for device-auth clients; a
// shared-secret operator sends `auth: { token }` and nothing else. That
// distinction is the whole reason this is allowed here at all — the recurring
// mistake this project has paid for is being a second writer to somebody
// else's FILE, and going through the running service's own published API is
// the stated cure, not another instance of it.
//
// Two things this module refuses to do:
//
//   1. It never reports a send it cannot vouch for. A request that never left
//      (no config, no socket, handshake refused) throws with
//      `dispatched: false`, which is the caller's licence to retry on the CLI.
//      Once the frame is on the wire, a timeout or a dropped socket throws
//      with `dispatched: true` and the caller must NOT retry anywhere: the
//      gateway hands the message to WhatsApp and only then answers, so the
//      message has very likely already gone out. That is the same reading
//      `runOpenclaw` gives its own timeout, and for the same incident — a
//      group told the whole gate explanation while our books recorded nothing
//      sent (2026-09-06).
//
//   2. It never becomes the only pipe. Anything wrong here is a fallback to
//      the CLI, and a run of connect failures puts the module to sleep for a
//      minute so a dead gateway costs one failed connect per minute rather
//      than one per message.
const { randomUUID } = require('node:crypto');
const occ = require('../intake/openclaw-config');
const { inTestProcess } = require('../intake/production-guard');

const CONNECT_TIMEOUT_MS = 10_000;
// The gateway's own per-RPC deadline is 30s (protocol.md). Ours sits above it
// so a gateway that answers slowly answers at all, and below `runOpenclaw`'s
// 120s so a caller's overall budget is unchanged.
const REQUEST_TIMEOUT_MS = 45_000;
// A socket nobody has used for this long is closed, so a short-lived process
// (a script, a one-shot job) can exit without anyone remembering to call
// `shutdown`. brokerd pays one reconnect — ~130ms — per idle stretch.
const IDLE_CLOSE_MS = 120_000;
// After this many consecutive connect failures the module stops trying for
// COOLOFF_MS and everything goes out on the CLI.
const COLD_AFTER_FAILURES = 3;
const COOLOFF_MS = 60_000;

// The values the gateway's connect schema actually admits (GATEWAY_CLIENT_IDS
// / GATEWAY_CLIENT_MODES in the install). `cli` would be a lie — we are host
// tooling holding a client connection, which is what these two say.
const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const PROTOCOL = 4;

let conn = null;          // { ws, ready, pending, idleTimer }
let consecutiveFailures = 0;
let coldUntil = 0;

function failed(message, extra) {
  return Object.assign(new Error(message), extra);
}

// Read per call, never captured at module load — the same rule
// intake/openclaw-config.js states for its own path, and for the same reason:
// a test process points OLMA_OPENCLAW_CONFIG at a temp dir, and whether that
// happens before or after this module is first required depends on require
// order. In a test process `loadConfig` throws on the production path, which
// lands here as "no gateway available" and sends everything down the CLI.
function readTarget() {
  let cfg;
  try { cfg = occ.loadConfig(); }
  catch (e) { throw failed(`gateway config unreadable: ${e.message}`, { dispatched: false }); }
  const gw = cfg.gateway || {};
  const auth = gw.auth || {};
  const token = auth.token || auth.password || '';
  const mode = auth.mode || 'token';
  // `trusted-proxy` and `none` are real modes this module has never been
  // tested against; the honest answer is to decline and let the CLI, which
  // knows all of them, do it.
  if (mode !== 'token' && mode !== 'password') {
    throw failed(`gateway auth mode ${mode} is not handled here`, { dispatched: false });
  }
  if (!token) throw failed('gateway has no shared secret configured', { dispatched: false });
  // On a multi-agent roster an agent-less send is REFUSED — "session key
  // \"main\" has no explicit owner" — and this is the same
  // `agents.defaults.systemAgent.agentId` the CLI resolves for us today
  // (CLAUDE.md, "the raw pipe needs systemAgent.agentId"). The CLI reads it
  // from the config and passes it; so do we, from the same key, rather than
  // naming an agent here. Measured against the live gateway 2026-09-09: the
  // send is refused without it.
  const defaults = (cfg.agents && cfg.agents.defaults) || {};
  const systemAgentId = (defaults.systemAgent && defaults.systemAgent.agentId) || '';
  return { url: `ws://127.0.0.1:${gw.port || 18789}`, token, systemAgentId };
}

function available() {
  // Fail closed in the suite, ahead of any config read. `deploy.sh --restart`
  // runs these tests ON THE BOX, where 127.0.0.1:18789 is the gateway serving
  // real people — and unlike the config path, a socket has no temp-directory
  // equivalent to point somewhere harmless. The CLI path a test takes instead
  // is the one it already took before this module existed.
  if (inTestProcess()) return false;
  if (process.env.OLMA_GATEWAY_RPC_SEND === 'off') return false;
  // Node <22 has no global WebSocket. Nothing to install and nothing to
  // apologise for: the CLI path is still there.
  return typeof globalThis.WebSocket === 'function';
}

function armIdleClose() {
  if (!conn) return;
  clearTimeout(conn.idleTimer);
  conn.idleTimer = setTimeout(() => { shutdown(); }, IDLE_CLOSE_MS);
  // An unref'd timer cannot hold the loop open; the SOCKET can, which is what
  // the idle close is for.
  if (conn.idleTimer.unref) conn.idleTimer.unref();
}

function dropConnection(err) {
  const dying = conn;
  conn = null;
  if (!dying) return;
  clearTimeout(dying.idleTimer);
  for (const [, p] of dying.pending) p.reject(err);
  dying.pending.clear();
  try { dying.ws.close(); } catch { /* already gone */ }
}

function connect() {
  if (conn) return conn.ready;
  if (Date.now() < coldUntil) {
    return Promise.reject(failed('gateway rpc is cooling off after repeated failures', { dispatched: false }));
  }
  let target;
  try { target = readTarget(); } catch (e) { return Promise.reject(e); }

  const pending = new Map();
  const ws = new WebSocket(target.url);
  const state = { ws, pending, idleTimer: null, ready: null, systemAgentId: target.systemAgentId };
  conn = state;

  state.ready = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= COLD_AFTER_FAILURES) coldUntil = Date.now() + COOLOFF_MS;
        dropConnection(err);
        reject(err);
      } else {
        consecutiveFailures = 0;
        coldUntil = 0;
        armIdleClose();
        resolve(state);
      }
    };

    const timer = setTimeout(
      () => finish(failed('gateway handshake timed out', { dispatched: false })),
      CONNECT_TIMEOUT_MS,
    );
    if (timer.unref) timer.unref();

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      finish(failed('gateway socket error', { dispatched: false }));
    });
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      // Before hello-ok this is a refused connection; after it, the pending
      // requests are told the socket went away — dispatched, so uncertain.
      if (!settled) finish(failed('gateway closed the socket during the handshake', { dispatched: false }));
      else if (conn === state) dropConnection(failed('gateway socket closed', { dispatched: true }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); }
      catch { return; }
      // The pre-connect challenge. `ts` matters only to device-auth clients;
      // a shared-secret operator answers with the token.
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        send(state, 'connect', {
          minProtocol: PROTOCOL,
          maxProtocol: PROTOCOL,
          client: { id: CLIENT_ID, version: '1', platform: process.platform, mode: CLIENT_MODE },
          role: 'operator',
          scopes: ['operator.read', 'operator.write'],
          caps: [], commands: [], permissions: {},
          auth: { token: target.token },
          locale: 'en-US',
          userAgent: 'olma2-brokerd',
        }, CONNECT_TIMEOUT_MS).then(
          () => { clearTimeout(timer); finish(null); },
          (e) => { clearTimeout(timer); finish(failed(`gateway refused the connection: ${e.message}`, { dispatched: false })); },
        );
        return;
      }
      // `tick` and every other event: nothing here subscribes to anything, so
      // they are noise. Answers carry the id we sent.
      if (msg.id == null) return;
      const p = pending.get(String(msg.id));
      if (!p) return;
      pending.delete(String(msg.id));
      clearTimeout(p.timer);
      if (msg.ok === false || msg.error) {
        const detail = msg.error && (msg.error.message || msg.error.code) ? `${msg.error.code || 'error'}: ${msg.error.message || ''}` : 'gateway error';
        // The gateway ANSWERED and the answer is no. Nothing was delivered,
        // and the CLI would reach the same handler and be told the same
        // thing, so this is a plain failure and never a reason to retry.
        p.reject(failed(detail.trim(), { dispatched: true, refused: true }));
      } else {
        p.resolve(msg.payload === undefined ? {} : msg.payload);
      }
    });
  });

  return state.ready;
}

function send(state, method, params, timeoutMs) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      // On the wire and unanswered. The gateway hands a message to WhatsApp
      // before it answers, so this is "very likely sent", not "not sent".
      reject(failed(`${method} timed out after ${timeoutMs}ms`, { dispatched: true }));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    state.pending.set(id, { resolve, reject, timer });
    try {
      state.ws.send(JSON.stringify({ type: 'req', id, method, params: params || {} }));
    } catch (e) {
      clearTimeout(timer);
      state.pending.delete(id);
      // The frame never left the process.
      reject(failed(`could not write to the gateway: ${e.message}`, { dispatched: false }));
    }
  });
}

// The raw pipe, one sentence. Resolves only on the gateway's own `ok: true`.
// `idempotencyKey` is REQUIRED by the send schema and is fresh per attempt on
// purpose: every `openclaw message send` process minted its own, so a retry
// behaves exactly as it does today. Deriving it from the outbox row would
// hand the gateway a veto over our own redelivery, which is a different
// feature and not this one.
async function sendMessage({ channel, to, message, replyToId }) {
  if (!available()) throw failed('gateway rpc is switched off', { dispatched: false });
  const state = await connect();
  armIdleClose();
  const params = {
    channel,
    to,
    message,
    idempotencyKey: randomUUID(),
    ...(state.systemAgentId ? { agentId: state.systemAgentId } : {}),
    ...(replyToId ? { replyToId: String(replyToId) } : {}),
  };
  const payload = await send(state, 'send', params, REQUEST_TIMEOUT_MS);
  armIdleClose();
  return payload;
}

// What the gateway thinks of its own channels — `linked`, `running`,
// `connected`, `reconnectAttempts` per channel. Read by the liveness probe,
// which is the only reason this is here.
//
// It MUST be this transport and not the CLI. `openclaw channels status --json`
// costs 4.1s of CPU per call, measured three times on the box 2026-09-11 —
// more than the `openclaw sessions list` that the never-poll-on-a-timer rule
// was written for. On an open socket the same question is one frame.
//
// Its own deadline, well under the five-minute tick: a probe is worth nothing
// if it can hold the sweep open, and a gateway too busy to answer in ten
// seconds is answered as `unknown` by the caller rather than waited for.
const STATUS_TIMEOUT_MS = 10_000;

async function channelsStatus() {
  if (!available()) throw failed('gateway rpc is switched off', { dispatched: false });
  const state = await connect();
  armIdleClose();
  const payload = await send(state, 'channels.status', {}, STATUS_TIMEOUT_MS);
  armIdleClose();
  return payload;
}

function shutdown() {
  dropConnection(failed('gateway rpc shutting down', { dispatched: true }));
}

module.exports = { sendMessage, channelsStatus, available, shutdown, CLIENT_ID, CLIENT_MODE };
