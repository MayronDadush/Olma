'use strict';
// "שלח לי קישור" is answered by code, with no model turn (domain/link-request.js).
// Three layers, each held here: which messages match (and in which language),
// what brokerd does with one (mints, words, marks — or refuses and lets the
// model run), and what the plugin does with brokerd's answer (claims only an
// explicit claim with text; everything else fails open).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const flagsDomain = require('../src/domain/flags');
const linkRequest = require('../src/domain/link-request');
const templates = require('../src/domain/message-templates');
const onboarding = require('../src/domain/onboarding');
process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `link-shortcut-plugin-test-${process.pid}.log`);

let db, broker, plugin, now;
const marks = [];
before(async () => {
  db = await freshDb();
  now = Date.parse('2026-09-25T10:00:00Z');
  broker = createBrokerServer({
    pool: db.pool, now: () => now,
    placeMark: (o) => { marks.push(o); return { attempted: true }; },
  });
  plugin = await import('../gateway-plugin/olma-turn/index.js');
});
after(async () => { await db.teardown(); });

const ask = (params) => broker.dispatch({ id: 1, method: 'dashboard_link_shortcut', params });

// ---- which messages ---------------------------------------------------------
test('every phrase the owner listed matches, in Hebrew, and says so', () => {
  for (const p of ['שלח לי קישור לדאשבורד', 'שלח לי קישור', 'שלח קישור', 'קישור',
    'שלחי לי קישור לדאשבורד', 'שלחי לי קישור', 'שלחי קישור']) {
    assert.deepEqual(linkRequest.matchLinkRequest(p), { lang: 'he', kind: 'link' }, p);
  }
});

test('the English twins match, and answer in English', () => {
  for (const p of ['send me the dashboard link', 'Send me a link', 'send me the link', 'Send link', 'link', 'Dashboard link']) {
    assert.deepEqual(linkRequest.matchLinkRequest(p), { lang: 'en', kind: 'link' }, p);
  }
});

test('punctuation, emoji, spacing and niqqud are not part of the request', () => {
  for (const p of ['קישור?', '  שלחי   לי קישור 🙏 ', 'שְׁלַח קִישּׁוּר', 'Link!', 'send me the link please'.replace(' please', '.')]) {
    assert.ok(linkRequest.matchLinkRequest(p), p);
  }
});

test('anything MORE than the request goes to the model', () => {
  for (const p of ['שלח לי קישור לפגישה', 'מה הקישור?', 'קישור לזום', 'link to the meeting',
    'send me the link to the doc', 'תזכירי לי לשלוח קישור', 'היי', '', null, 'קישור '.repeat(40)]) {
    assert.equal(linkRequest.matchLinkRequest(p), null, String(p));
  }
});

test('a new language is one table entry, not a code change', () => {
  const table = { ...linkRequest.PHRASES, fr: ['envoie-moi le lien'] };
  assert.deepEqual(linkRequest.matchLinkRequest('Envoie moi le lien', table), { lang: 'fr', kind: 'link' });
  assert.deepEqual(linkRequest.matchLinkRequest('קישור', table), { lang: 'he', kind: 'link' }, 'the others unchanged');
});

test('keyFor picks a language\'s template and falls back where one is missing', () => {
  assert.equal(templates.keyFor('dashboard_link', 'he'), 'dashboard_link');
  assert.equal(templates.keyFor('dashboard_link', 'he-IL'), 'dashboard_link');
  assert.equal(templates.keyFor('dashboard_link', 'EN'), 'dashboard_link_en');
  assert.equal(templates.keyFor('dashboard_link', 'fr'), 'dashboard_link_en', 'no French yet → English');
  assert.equal(templates.keyFor('opening', 'he'), 'opening_he');
  assert.equal(templates.keyFor('opening', 'ru'), 'opening_en');
  assert.throws(() => templates.keyFor('no_such_family', 'he'));
  // The opening keeps its own rule for "nothing on file": Hebrew.
  assert.equal(onboarding.openingKey(''), 'opening_he');
  assert.equal(onboarding.openingKey(null), 'opening_he');
  assert.equal(onboarding.openingKey('he-il'), 'opening_he');
  assert.equal(onboarding.openingKey('ar'), 'opening_en');
});

test('both default sentences pass the reply gate, whoever is reading', () => {
  // The gateway sends a claimed reply through reply_payload_sending like any
  // other, and the gate drops English to somebody who writes Hebrew — so the
  // English sentence has to stay short enough that it cannot be a leak, and
  // the link has to be one the gate knows we serve.
  const replyLeak = require('../src/domain/reply-leak');
  const url = 'https://allma.world/d/AbCdEfGhIjKlMnOpQrStUv';
  for (const key of ['dashboard_link', 'dashboard_link_en']) {
    const text = templates.render(key, { url }, {});
    for (const readerWritesHebrew of [true, false, null]) {
      const v = replyLeak.gateReply(text, { readerWritesHebrew });
      assert.equal(v.action, 'pass', `${key} to readerWritesHebrew=${readerWritesHebrew}`);
      assert.equal(v.text, text);
    }
  }
});

// ---- the code kind ("קוד כניסה") --------------------------------------------
test('the code phrases match as a CODE, in both languages, and never as a link', () => {
  for (const p of linkRequest.CODE_PHRASES.he) assert.deepEqual(linkRequest.matchLinkRequest(p), { lang: 'he', kind: 'code' }, p);
  for (const p of linkRequest.CODE_PHRASES.en) assert.deepEqual(linkRequest.matchLinkRequest(p), { lang: 'en', kind: 'code' }, p);
  // What the app's button types into WhatsApp, exactly as the page encodes it.
  assert.deepEqual(linkRequest.matchLinkRequest('קוד כניסה לאפליקציה'), { lang: 'he', kind: 'code' });
  assert.deepEqual(linkRequest.matchLinkRequest('App sign-in code'), { lang: 'en', kind: 'code' });
  for (const p of ['קוד', 'מה הקוד של הזום?', 'קוד כניסה לבניין', 'code']) {
    assert.equal(linkRequest.matchLinkRequest(p), null, p);
  }
  for (const p of Object.values(linkRequest.CODE_PHRASES).flat()) {
    assert.ok(p.length <= linkRequest.MAX_LENGTH, `${p} is longer than the plugin forwards`);
  }
});

test('both code sentences pass the reply gate, whoever is reading', () => {
  const replyLeak = require('../src/domain/reply-leak');
  for (const key of ['dashboard_code', 'dashboard_code_en']) {
    const text = templates.render(key, { code: '4821 0937' }, {});
    for (const readerWritesHebrew of [true, false, null]) {
      const v = replyLeak.gateReply(text, { readerWritesHebrew });
      assert.equal(v.action, 'pass', `${key} to readerWritesHebrew=${readerWritesHebrew}`);
    }
  }
});

// ---- brokerd ----------------------------------------------------------------
async function person(n, extra = {}) {
  const u = await makeUser(db.pool, `+97250555${String(n).padStart(4, '0')}`, extra);
  await db.pool.query(`UPDATE users SET agent_id = $2 WHERE id = $1`, [u.id, `u-${u.id}`]);
  return u;
}

test('a match mints a link and hands back the sentence in the language they wrote', async () => {
  const u = await person(1);
  const he = await ask({ agentId: `u-${u.id}`, body: 'שלחי לי קישור', messageId: '3EB0AAAA1111' });
  assert.equal(he.ok, true);
  assert.equal(he.claim, true);
  assert.equal(he.lang, 'he');
  assert.match(he.text, /^הקישור לדף שלך 👇\nhttps:\/\/\S+\/d\/[A-Za-z0-9]{22}$/);
  const en = await ask({ agentId: `u-${u.id}`, body: 'send me the link', messageId: '3EB0AAAA2222' });
  assert.match(en.text, /^Here’s your page 👇\nhttps:\/\/\S+\/d\/[A-Za-z0-9]{22}$/);
  assert.notEqual(he.text, en.text, 'a fresh link each time');

  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM magic_links WHERE user_id = $1`, [u.id]);
  assert.equal(rows[0].n, 2);
  const audit = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'dashboard.link_shortcut' ORDER BY id`, [u.id]);
  assert.deepEqual(audit.rows.map((r) => r.detail), [{ lang: 'he' }, { lang: 'en' }]);
  assert.ok(!JSON.stringify(audit.rows).includes('קישור'), 'the words are matched and dropped');

  const mine = marks.filter((m) => m.messageId === '3EB0AAAA1111');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].state, 'done', 'answered, so the 👀 becomes a 👍');
});

test('"קוד כניסה" mints eight digits, answers with them, and makes no link', async () => {
  const u = await person(7);
  const out = await ask({ agentId: `u-${u.id}`, body: 'קוד כניסה לאפליקציה', messageId: '3EB0CCCC0001' });
  assert.equal(out.claim, true);
  assert.equal(out.kind, 'code');
  const m = out.text.match(/^הקוד לכניסה לאפליקציה 👇\n\*(\d{4}) (\d{4})\*\nתקף ל־10 דקות\.$/);
  assert.ok(m, out.text);
  const { rows } = await db.pool.query(
    `SELECT target, expires_at - created_at AS ttl FROM magic_links WHERE user_id = $1`, [u.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, 'code');
  // And the code it said is the one that opens a session.
  const auth = require('../src/domain/dashboard-auth');
  const opened = await withTx(db.pool, (c) => auth.redeemCode(c, m[1] + ' ' + m[2]));
  assert.equal(opened.ok, true);
  assert.equal(opened.data.userId, Number(u.id));
  const audit = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'dashboard.code_shortcut'`, [u.id]);
  assert.deepEqual(audit.rows.map((r) => r.detail), [{ lang: 'he' }]);
  assert.ok(!JSON.stringify(audit.rows).includes(m[1]), 'the code is never written anywhere readable');
  // A button typed it in English; they are Hebrew on file, so Hebrew it is.
  const typed = await ask({ agentId: `u-${u.id}`, body: 'app sign-in code' });
  assert.match(typed.text, /^הקוד לכניסה לאפליקציה 👇\n\*\d{4} \d{4}\*\n/);
  await db.pool.query(`UPDATE users SET locale = 'en' WHERE id = $1`, [u.id]);
  const en = await ask({ agentId: `u-${u.id}`, body: 'קוד כניסה' });
  assert.match(en.text, /^Your app code 👇\n\*\d{4} \d{4}\*\nValid 10 minutes\.$/, 'and English on file is English');
});

test('the owner rewords it from the admin page like every other fixed sentence', async () => {
  const u = await person(2);
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, templates.FLAG, { dashboard_link: 'הנה 👉 {{url}}' }));
  try {
    const out = await ask({ agentId: `u-${u.id}`, body: 'קישור' });
    assert.match(out.text, /^הנה 👉 https:\/\/\S+\/d\/[A-Za-z0-9]{22}$/);
  } finally {
    await withTx(db.pool, (c) => flagsDomain.setFlag(c, templates.FLAG, {}));
  }
});

test('no match, nobody behind the agent, or the eval user: no claim, and the model runs', async () => {
  const u = await person(3);
  assert.deepEqual(await ask({ agentId: `u-${u.id}`, body: 'שלח לי קישור לפגישה' }), { ok: true, claim: false });
  assert.deepEqual(await ask({ agentId: 'u-999999', body: 'קישור' }), { ok: true, claim: false });
  const ev = await person(4);
  await db.pool.query(`UPDATE users SET is_eval = true WHERE id = $1`, [ev.id]);
  assert.deepEqual(await ask({ agentId: `u-${ev.id}`, body: 'קישור' }), { ok: true, claim: false });
  const paused = await person(5);
  await db.pool.query(`UPDATE users SET status = 'pending' WHERE id = $1`, [paused.id]);
  assert.deepEqual(await ask({ agentId: `u-${paused.id}`, body: 'קישור' }), { ok: true, claim: false });
  // The greeter goes to the game path (stage 4ב), which claims nothing it cannot place.
  assert.deepEqual(await ask({ agentId: 'intake', body: 'קישור' }), { ok: true, claim: false });
  assert.deepEqual(await ask({ agentId: 'g-7', body: 'קישור' }), { ok: false, error: 'bad agentId' });
});

test('the turn the hook opened for the same message is not left waiting, whichever lands first', async () => {
  const u = await person(6);
  const agentId = `u-${u.id}`;
  // Hook first: its open is queued with a 👀, then the shortcut answers.
  await broker.dispatch({ id: 1, method: 'turn_open', params: { agentId, messageId: '3EB0BBBB0001' } });
  assert.equal(broker.pendingCount(), 1);
  await ask({ agentId, body: 'קישור', messageId: '3EB0BBBB0001' });
  assert.equal(broker.pendingCount(), 0, 'no turn is coming to adopt it');
  // Shortcut first: the late open marks 👍 and queues nothing.
  await ask({ agentId, body: 'קישור', messageId: '3EB0BBBB0002' });
  await broker.dispatch({ id: 1, method: 'turn_open', params: { agentId, messageId: '3EB0BBBB0002' } });
  assert.equal(broker.pendingCount(), 0);
  const late = marks.filter((m) => m.messageId === '3EB0BBBB0002').map((m) => m.state);
  assert.deepEqual(late, ['done', 'done'], 'never a 👀 on a message that was already answered');
});

// ---- the plugin -------------------------------------------------------------
function fakeConnect(reply) {
  const sent = [];
  const connect = () => {
    const h = {};
    const s = {
      on(ev, fn) { h[ev] = fn; return s; },
      write(x) { sent.push(JSON.parse(x)); setTimeout(() => h.data && h.data(JSON.stringify(reply) + '\n'), 0); },
      end() { h.close && h.close(); }, destroy() {},
    };
    setTimeout(() => h.connect && h.connect(), 0);
    return s;
  };
  return { connect, sent };
}
const DM = 'agent:u-3:whatsapp:direct:+972526269826';

test('the plugin claims an explicit claim and hands the gateway the text to send', async () => {
  const log = [];
  const { connect, sent } = fakeConnect({ id: 1, ok: true, claim: true, text: 'הקישור לדף שלך 👇\nhttps://allma.world/d/x', lang: 'he' });
  const h = plugin.buildLinkShortcutHandler({ connect, log: (o) => log.push(o) });
  const out = await h({ sessionKey: DM, body: 'קישור', messageId: '3EB0CCCC' }, {});
  assert.deepEqual(out, { handled: true, text: 'הקישור לדף שלך 👇\nhttps://allma.world/d/x' });
  assert.equal(sent[0].method, 'dashboard_link_shortcut');
  assert.deepEqual(sent[0].params, { agentId: 'u-3', body: 'קישור', messageId: '3EB0CCCC' });
  assert.deepEqual(log.at(-1).claim, true);
  assert.ok(!JSON.stringify(log).includes('קישור'), 'the trace never carries the words');
});

test('the plugin fails open, and a long message or a room never leaves the gateway', async () => {
  const ev = { sessionKey: DM, body: 'קישור' };
  const mk = (reply) => plugin.buildLinkShortcutHandler({ connect: fakeConnect(reply).connect, log: () => {} });
  assert.equal(await mk({ id: 1, ok: true, claim: false })(ev, {}), undefined);
  assert.equal(await mk({ id: 1, ok: true, claim: true })(ev, {}), undefined, 'a claim with no text is not a claim');
  assert.equal(await mk({ id: 1, ok: true, claim: true, text: '  ' })(ev, {}), undefined);
  assert.equal(await mk({ id: 1, ok: false, error: 'x' })(ev, {}), undefined);
  const dead = () => {
    const hs = {};
    const s = { on(e, fn) { hs[e] = fn; return s; }, write() {}, end() {}, destroy() {} };
    setTimeout(() => hs.error && hs.error(new Error('ECONNREFUSED')), 0);
    return s;
  };
  assert.equal(await plugin.buildLinkShortcutHandler({ connect: dead, log: () => {} })(ev, {}), undefined);

  const { connect, sent } = fakeConnect({ id: 1, ok: true, claim: true, text: 'x' });
  const h = plugin.buildLinkShortcutHandler({ connect, log: () => {} });
  assert.equal(await h({ sessionKey: DM, body: 'א'.repeat(81) }, {}), undefined);
  assert.equal(await h({ sessionKey: DM, body: '   ' }, {}), undefined);
  assert.equal(await h({ sessionKey: 'agent:g-7:whatsapp:group:1203634@g.us', body: 'קישור' }, {}), undefined);
  assert.equal(await h({ sessionKey: 'agent:intake:whatsapp:direct:+97252', body: 'קישור' }, {}), undefined,
    'a greeter key with no whole number on it');
  assert.equal(await h({ sessionKey: 'agent:ggreet:whatsapp:direct:+972526269826', body: 'קישור' }, {}), undefined);
  assert.equal(await h({ sessionKey: DM, body: 'קישור', isGroup: true }, {}), undefined);
  assert.equal(sent.length, 0, 'none of them asked brokerd anything');
});

test('the DM greeter\'s session goes to brokerd as "intake" with its key, and its claim is the reply', async () => {
  const key = 'agent:intake:whatsapp:direct:+972526269826';
  const { connect, sent } = fakeConnect({ id: 1, ok: true, claim: true, text: 'היי, אני עולמה', kind: 'game' });
  const h = plugin.buildLinkShortcutHandler({ connect, log: () => {} });
  assert.deepEqual(await h({ sessionKey: key, body: 'משחק K7M2Q', messageId: '3EB0X' }, {}),
    { handled: true, text: 'היי, אני עולמה' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'dashboard_link_shortcut');
  assert.deepEqual(sent[0].params, { agentId: 'intake', body: 'משחק K7M2Q', sessionKey: key, messageId: '3EB0X' });
});
