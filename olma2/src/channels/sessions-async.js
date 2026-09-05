'use strict';
// channels/sessions.js, off the main thread.
//
// Every export of sessions.js is synchronous — readFileSync, readdirSync, a
// read-only node:sqlite handle — and brokerd runs them inside sweeps on the
// same event loop that answers turn_start for live users, on a box with one
// core. A sweep walking every user's store therefore deafens the daemon for
// the whole walk. jobs/usage.js met this on 2026-08-25 (a cold transcript
// scan, a user's turn timing out twice against a healthy process) and yields
// between files; config_guard yields between users. This is the general fix:
// the same functions, the same return values, run in a worker thread, so the
// main thread only ever waits on a promise.
//
// What it is NOT: a change to sessions.js. That module keeps its sync API
// (the dashboard and the eval harness call it directly, and every fixture in
// the suite is built against it); this file forwards to it in a worker and
// nothing else. A caller switches by `await`ing the same call it made before.
//
// Guarantees, each because of something that already went wrong elsewhere:
//   * the worker never outlives its usefulness. A test child that cannot exit
//     is invisible to `node --test` (tests/helpers.js), and a background
//     thread is exactly the kind of handle that does it. Measured on Node 26:
//     `worker.unref()` alone does NOT let the parent exit (the MessagePort
//     keeps the loop alive, with or without stdio), only terminate() does. So
//     the worker is terminated after IDLE_MS without a call and respawned on
//     the next one — brokerd's 5s intake tick keeps it warm for good, a
//     one-off script or a test process sheds it — and tests/helpers.js closes
//     it outright in every teardown;
//   * every call has a deadline. A read that never returns would otherwise
//     hold its sweep open for ever, which the job heartbeat would report as
//     "running" rather than "stuck". On deadline the worker is killed and
//     replaced, and the caller gets a named rejection;
//   * a crashed worker rejects every call in flight and the next call spawns
//     a fresh one — nothing is retried silently, nothing is dropped silently;
//   * OLMA_OPENCLAW_HOME is sent with every call, read at call time, so a
//     test that redirects it after the worker exists still reads its own tree.
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER_PATH = path.join(__dirname, 'sessions-worker.js');
const CALL_TIMEOUT_MS = Number(process.env.OLMA_SESSIONS_READ_TIMEOUT_MS || 60_000);
const IDLE_MS = Number(process.env.OLMA_SESSIONS_WORKER_IDLE_MS || 30_000);

let worker = null;
let nextId = 1;
let idleTimer = null;

// Re-armed after every completed call; fires only when nothing is in flight.
function armIdle(w) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (worker !== w || w.pending.size) return;
    worker = null;
    w.terminate().catch(() => {});
  }, IDLE_MS);
  idleTimer.unref();
}

// The in-flight map belongs to ONE worker, never to the module. A replaced
// worker's exit event arrives after its successor may already be answering
// calls; a shared map let the dead worker's exit reject the live worker's
// first call as "in flight" — found by the deadline test, not by reasoning.
function failAll(w, err) {
  for (const [, p] of w.pending) { clearTimeout(p.timer); p.reject(err); }
  w.pending.clear();
}

function spawnWorker() {
  const w = new Worker(WORKER_PATH);
  w.pending = new Map(); // id -> { resolve, reject, timer }
  w.unref();
  w.on('message', (msg) => {
    const p = w.pending.get(msg.id);
    if (!p) return;
    w.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (!w.pending.size) armIdle(w);
    if (msg.ok) p.resolve(msg.result);
    else {
      const e = new Error(msg.error && msg.error.message ? msg.error.message : 'sessions read failed');
      if (msg.error && msg.error.name) e.name = msg.error.name;
      p.reject(e);
    }
  });
  w.on('error', (e) => {
    if (worker === w) worker = null;
    failAll(w, new Error(`sessions worker crashed: ${e && e.message}`));
  });
  w.on('exit', (code) => {
    if (worker === w) worker = null;
    if (w.pending.size) failAll(w, new Error(`sessions worker exited (${code}) with calls in flight`));
  });
  return w;
}

function call(fn, args) {
  if (!worker) worker = spawnWorker();
  const w = worker;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      w.pending.delete(id);
      reject(new Error(`sessions.${fn} did not return within ${CALL_TIMEOUT_MS}ms; worker replaced`));
      // Kill THIS worker only if it is still the live one; a later call may
      // already have spawned its successor.
      if (worker === w) worker = null;
      w.terminate().catch(() => {});
    }, CALL_TIMEOUT_MS);
    timer.unref();
    w.pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, fn, args, home: process.env.OLMA_OPENCLAW_HOME });
  });
}

// Stops the worker. For tests and for brokerd's shutdown; a subsequent call
// simply starts a new one.
async function close() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const w = worker;
  worker = null;
  if (!w) return;
  failAll(w, new Error('sessions worker closed'));
  await w.terminate().catch(() => {});
}

// The subset the daemon's sweeps use. Each is `sessions.<name>` with the same
// arguments and the same result, one promise later.
const FORWARDED = [
  'listSessions', 'listSessionsForAgent', 'readRecentMessages', 'readPeerUserText',
  'readPeerDisplayName', 'listTranscripts', 'readTranscriptUsage',
  'readSessionEventsSlice', 'hasInboundUserTurn', 'scanAssistantTextSince',
];
// `_call` is for the suite only — it is how the deadline test reaches the
// worker's guarded stall hook. Nothing in src/ calls it.
const api = { close, CALL_TIMEOUT_MS, IDLE_MS, _call: call };
for (const name of FORWARDED) api[name] = (...args) => call(name, args);

module.exports = api;
