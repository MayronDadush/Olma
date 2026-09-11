#!/usr/bin/env node
// The thin MCP shim. OpenClaw spawns this fresh on every agent turn — so it
// must do almost nothing: speak MCP (line-delimited JSON-RPC) on stdio,
// forward tool calls to brokerd over the unix socket, return text. Tool
// definitions come from the shared registry module, no socket round-trip.
'use strict';
const net = require('node:net');
const readline = require('node:readline');
const { toolDefinitions } = require('../src/adapters/mcp/registry');
const { IDENTITY_PARAM, LEGACY_IDENTITY_PARAM, readIdentity } = require('../src/adapters/mcp/identity-param');

const SOCK = process.env.OLMA_SOCK || '/opt/olma2/run/brokerd.sock';
const CALL_TIMEOUT_MS = 30_000;

// ---- identity self-healing --------------------------------------------------
// Recurring "unknown identity token" failures are the model typing a guessed
// or truncated token instead of the file contents — observed three times in
// one live conversation despite explicit doctrine against it. Doctrine failed;
// per the design rule (D-007), correctness must not depend on model
// discipline, so the shim repairs what it can mechanically.
//
// The repair is deliberately narrow: a MALFORMED token (truncated, empty, a
// placeholder — anything that is not olma_tok_ + 32 hex) is replaced with the
// token that already succeeded on this stdio connection. A malformed string
// carries no identity claim, so the swap can only restore access this
// connection has already proven. A WELL-FORMED but unknown token is passed
// through and allowed to fail: the gateway runs one shim per session today,
// but nothing here may bet on that staying true — auto-"correcting" a
// well-formed token would turn one user's typo into another user's identity
// the day shims are ever shared. The failure text itself now tells the model
// the one recovery that works (re-read the file), which covers that rare case.
//
// A repair writes the CURRENT parameter name and clears the legacy one, so a
// model still copying the old name from earlier in its session is nudged
// forward rather than kept there (brokerd accepts both regardless).
//
// Since group mode there are TWO kinds of identity — a person's `olma_tok_`
// and a group's `olma_grp_` — and the repair must never cross between them.
// The comment above already named the hazard ("nothing here may bet on" one
// shim per session); with a group token in play it stops being theoretical,
// because the mistake would no longer be one person acting as another but a
// whole ROOM acting as one of the people in it. So: a proven token of a
// second kind on the same connection disables the repair for that connection
// entirely. Nothing is lost — the repair exists for a model that mistypes,
// and a connection serving two kinds has bigger problems than a typo.
const USER_TOKEN_RE = /^olma_tok_[0-9a-f]{32}$/;
const GROUP_TOKEN_RE = /^olma_grp_[0-9a-f]{32}$/;
const wellFormed = (t) => USER_TOKEN_RE.test(t) || GROUP_TOKEN_RE.test(t);
const kindOf = (t) => (GROUP_TOKEN_RE.test(t) ? 'group' : 'user');
let knownGoodToken = null;
let knownGoodKind = null;
let mixedKinds = false;

// ---- brokerd client (single socket, sequential-friendly, id-mapped) --------
let sockConn = null;
let nextId = 1;
const pending = new Map();

// Drops the socket so the NEXT call dials a fresh one, and fails everything
// still waiting on this one. Guarded by identity: a dying socket must never
// clear a replacement that a later call has already opened.
function dropSocket(sock, err) {
  if (sockConn === sock) sockConn = null;
  for (const [, p] of pending) p.reject(err);
  pending.clear();
}

function connectBroker() {
  if (sockConn) return sockConn;
  sockConn = net.connect(SOCK);
  const sock = sockConn;
  let buf = '';
  sockConn.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    if (buf.length > 8 * 1024 * 1024) { // a broker that never sends \n must not eat memory
      buf = '';
      sock.destroy(new Error('oversized broker response'));
      return;
    }
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.resolve(msg); }
      } catch { /* ignore unparseable broker line */ }
    }
  });
  sockConn.on('error', (e) => dropSocket(sock, e));
  // A brokerd that goes away CLEANLY — systemd stopping it for a deploy, the
  // process exiting — never produces an 'error'. The peer sends FIN, node
  // ends this side too, 'end' and 'close' fire, and that was the whole of
  // what the shim used to hear: nothing. `sockConn` stayed set and pointed at
  // a destroyed socket, and `write()` on one of those neither throws nor
  // emits — it returns true and the bytes go nowhere. So every later call sat
  // out the full CALL_TIMEOUT_MS and answered "assistant backend not
  // reachable (brokerd timeout)", for the life of the shim process rather
  // than once. On 2026-09-11 a deploy restarted brokerd mid-conversation and
  // Yehav's eleven snooze_task calls failed 30 seconds apart, five and a half
  // minutes, while brokerd had been answering again one second after it
  // stopped (`incidents.md`, "The socket that was never closed").
  //
  // Both events, because half-open is reachable: 'end' is the peer's FIN, and
  // with allowHalfOpen false (the default) 'close' follows — but a socket
  // destroyed from this side emits only 'close'. Dropping twice is harmless;
  // the second call finds `pending` empty and `sockConn` already replaced.
  sockConn.on('end', () => dropSocket(sock, new Error('brokerd closed the connection')));
  sockConn.on('close', () => dropSocket(sock, new Error('brokerd connection closed')));
  return sockConn;
}

function brokerCall(name, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('brokerd timeout'));
    }, CALL_TIMEOUT_MS);
    pending.set(id, {
      resolve: (m) => { clearTimeout(timer); resolve(m); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      connectBroker().write(JSON.stringify({ id, method: 'tool_call', params: { name, args } }) + '\n');
    } catch (e) {
      clearTimeout(timer); pending.delete(id); reject(e);
    }
  });
}

// ---- MCP over stdio ---------------------------------------------------------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'olma', version: '2.0.0' },
      });
    } else if (method === 'notifications/initialized') {
      // notification, no response
    } else if (method === 'tools/list') {
      reply(id, { tools: toolDefinitions() });
    } else if (method === 'tools/call') {
      const { name, arguments: rawArgs } = params || {};
      const args = { ...(rawArgs || {}) };
      // Malformed identity + a proven one on hand → repair before the round trip.
      if (knownGoodToken && !mixedKinds && !wellFormed(String(readIdentity(args) || ''))) {
        args[IDENTITY_PARAM] = knownGoodToken;
        delete args[LEGACY_IDENTITY_PARAM];
      }
      let text;
      try {
        const res = await brokerCall(name, args);
        text = res.text || (res.ok ? 'OK' : 'ERROR internal: empty broker reply');
        const used = String(readIdentity(args) || '');
        if (text.startsWith('OK') && wellFormed(used)) {
          if (knownGoodKind && kindOf(used) !== knownGoodKind) mixedKinds = true;
          knownGoodToken = used;
          knownGoodKind = kindOf(used);
        }
      } catch (e) {
        text = `ERROR unavailable: assistant backend not reachable (${e.message})`;
      }
      reply(id, { content: [{ type: 'text', text }], isError: text.startsWith('ERROR') });
    } else if (id !== undefined) {
      replyError(id, -32601, `unknown method ${method}`);
    }
  } catch (e) {
    if (id !== undefined) replyError(id, -32603, e.message);
  }
});
rl.on('close', () => process.exit(0));
