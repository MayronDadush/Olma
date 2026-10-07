'use strict';
// foodd's one line to brokerd, over its unix socket. Three questions go down it:
// who is calling (`identity_resolve`), "draw this card into their
// workspace" (`pack_card`) and "the photo they just sent" (`pack_media`). foodd holds no copy of Olma's users and never
// reads its database; the token the model passed is the only claim, and
// brokerd is the only thing that can honour it. The answer is the person's id,
// first name, timezone, locale and the packs they hold — never a phone.
//
// One connection per call, as in games/src/identity.js, for the same reason.
const net = require('net');

const LIVE_SOCK = '/opt/olma2/run/brokerd.sock';
const SOCK = () => process.env.OLMA_SOCK || LIVE_SOCK;
const TIMEOUT_MS = 5000;

function call(method, params, { sock = SOCK(), timeoutMs = TIMEOUT_MS, maxBytes = 64 * 1024 } = {}) {
  // A test must never reach the live brokerd (games/src/identity.js, and
  // olma2's incidents.md, "The test suite provisioned into production").
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
      if (buf.length > maxBytes) return finish(reject, new Error('oversized brokerd reply'));
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try { finish(resolve, JSON.parse(buf.slice(0, i))); } catch { finish(reject, new Error('unreadable brokerd reply')); }
    });
    c.on('error', e => finish(reject, e));
    c.on('close', () => finish(reject, new Error('brokerd closed the connection')));
  });
}

const resolveIdentity = (token, opts) => call('identity_resolve', { token, caller: 'food' }, opts);

// The day card: brokerd renders the SVG with Olma's own fonts into the
// person's workspace (the only place the gateway attaches media from) and
// answers with the file's path and their invite link.
const makeCard = ({ userId, svg }, opts) => call('pack_card', { caller: 'food', userId, svg }, opts);

// The photo they just sent, for the vision step. brokerd reads it from the
// gateway's inbound directory (we cannot), checks it is theirs to ask for and
// a picture, and answers with its bytes. A picture is up to 5 MB, so this one
// reply may be large.
const readMedia = ({ userId, path }, opts) => call('pack_media', { caller: 'food', userId, path }, { maxBytes: 8 * 1024 * 1024, ...opts });

module.exports = { resolveIdentity, makeCard, readMedia };
