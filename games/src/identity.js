'use strict';
// Who is calling: brokerd's `identity_resolve` over its unix socket. gamesd
// holds no copy of Olma's users and never reads its database; the token the
// model passed is the only claim, and brokerd is the only thing that can
// honour it. The answer is the person's id, first name, timezone, locale and
// the packs they hold — never a phone, never the token back.
//
// One connection per call: a tool call is a few a minute at most, and a
// long-lived socket is the thing olma-mcp.js had to learn to drop correctly
// when brokerd restarts (`incidents.md`, "The socket that was never closed").
const net = require('net');

const SOCK = () => process.env.OLMA_SOCK || '/opt/olma2/run/brokerd.sock';
const TIMEOUT_MS = 5000;

function resolveIdentity(token, { sock = SOCK(), timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf = '', done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); c.destroy(); fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('brokerd timeout')), timeoutMs);
    c.on('connect', () => c.write(JSON.stringify({ id: 1, method: 'identity_resolve', params: { token, caller: 'games' } }) + '\n'));
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

module.exports = { resolveIdentity };
