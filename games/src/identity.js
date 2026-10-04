'use strict';
// gamesd's one line to brokerd, over its unix socket. Two questions go down
// it: who is calling (`identity_resolve`, below), "this night just closed"
// (`game_summary`) and "the model just opened one" (`game_invite`).
//
// Who is calling: brokerd's `identity_resolve`. gamesd
// holds no copy of Olma's users and never reads its database; the token the
// model passed is the only claim, and brokerd is the only thing that can
// honour it. The answer is the person's id, first name, timezone, locale and
// the packs they hold — never a phone, never the token back.
//
// One connection per call: a tool call is a few a minute at most, and a
// long-lived socket is the thing olma-mcp.js had to learn to drop correctly
// when brokerd restarts (`incidents.md`, "The socket that was never closed").
const net = require('net');

const LIVE_SOCK = '/opt/olma2/run/brokerd.sock';
const SOCK = () => process.env.OLMA_SOCK || LIVE_SOCK;
const TIMEOUT_MS = 5000;

function call(method, params, { sock = SOCK(), timeoutMs = TIMEOUT_MS } = {}) {
  // A test must never reach the live brokerd: on the box that socket is real,
  // and `game_summary` down it is a WhatsApp message to a real person. Same
  // guard as olma2's intake/production-guard.js, for the same reason
  // (`incidents.md`, "The test suite provisioned into production").
  if (process.env.NODE_TEST_CONTEXT && sock === LIVE_SOCK) {
    return Promise.reject(new Error('refused: a test reached the live brokerd socket'));
  }
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf = '', done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); c.destroy(); fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('brokerd timeout')), timeoutMs);
    c.on('connect', () => c.write(JSON.stringify({ id: 1, method, params }) + '\n'));
    c.on('data', ch => {
      buf += ch.toString('utf8');
      if (buf.length > 64 * 1024) return finish(reject, new Error('oversized brokerd reply'));
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try { finish(resolve, JSON.parse(buf.slice(0, i))); } catch { finish(reject, new Error('unreadable brokerd reply')); }
    });
    c.on('error', e => finish(reject, e));
    c.on('close', () => finish(reject, new Error('brokerd closed the connection')));
  });
}

const resolveIdentity = (token, opts) => call('identity_resolve', { token, caller: 'games' }, opts);

// A night's count just closed: the settlement as drawn, in both languages, and
// the users linked to it. brokerd queues it for whoever of them holds the pack
// and it goes out on the raw pipe, word for word (olma2
// domain/game-summary.js). The answer names who was queued.
const sendSummary = ({ nightId, userIds, texts }, opts) =>
  call('game_summary', { caller: 'games', nightId, userIds, texts }, opts);

// The model just opened a night for this person (tools.start_game_night):
// brokerd sends them the same two messages as the shortcut, by code — their
// personal link, then the invite they forward to the others (olma2
// domain/game-shortcut.js hostMessages).
const sendInvite = ({ userId, night, url }, opts) =>
  call('game_invite', { caller: 'games', userId, night, url }, opts);

module.exports = { resolveIdentity, sendSummary, sendInvite };
