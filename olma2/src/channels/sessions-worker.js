'use strict';
// The other side of sessions-async.js: a worker thread that owns the
// synchronous reads in channels/sessions.js so the main thread never does.
//
// One message in, one message out. `home` rides on every request because
// sessions.js resolves OLMA_OPENCLAW_HOME at call time and a worker's env is a
// copy taken at spawn — a test that points HOME at a fixture directory after
// the worker exists would otherwise be reading the wrong tree.
//
// Errors go back as data, not as a thrown Error: the failure text is what
// the caller needs (a malformed store must fail its sweep by name), and a
// plain object survives structured clone on every Node this runs on.
const { parentPort } = require('node:worker_threads');
const sessions = require('./sessions');

// A stall the suite can ask for, and nothing else can: the facade's deadline
// is a guard that only ever fires when a read has already hung, which makes
// it the first thing to rot into decoration. With this hook a test can show
// it fire. Bounded (the wait ends on its own), and only when the process was
// started with the hook switched on — never on the box.
const TEST_HOOKS = process.env.OLMA_SESSIONS_WORKER_TEST_HOOKS === '1';
function stall(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(Number(ms) || 0, 5_000));
  return 'stalled';
}

parentPort.on('message', ({ id, fn, args, home }) => {
  if (home === undefined || home === null) delete process.env.OLMA_OPENCLAW_HOME;
  else process.env.OLMA_OPENCLAW_HOME = home;
  try {
    if (fn === '__stall' && TEST_HOOKS) {
      parentPort.postMessage({ id, ok: true, result: stall(args[0]) });
      return;
    }
    if (typeof sessions[fn] !== 'function') throw new Error(`sessions.${fn} is not a function`);
    const result = sessions[fn](...args);
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: { name: e && e.name, message: String((e && e.message) || e) } });
  }
});
