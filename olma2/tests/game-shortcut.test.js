'use strict';
// Game nights from a private chat, answered by code (domain/game-shortcut.js,
// stage 4א): which messages are ours, what brokerd does with each — with
// gamesd and the gateway's config faked, because both defaults are live
// services — and what the gate does with the invite the host forwards.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { createBrokerServer } = require('../src/brokerd/server');
const { decide } = require('../src/outbox/gate');
const gs = require('../src/domain/game-shortcut');
const gameSummary = require('../src/domain/game-summary');
const proactiveText = require('../src/domain/proactive-text');
const templates = require('../src/domain/message-templates');
const replyLeak = require('../src/domain/reply-leak');

// ---- which messages ---------------------------------------------------------
test('the opening phrase matches whole, in both languages, and nothing longer does', () => {
  for (const p of gs.OPEN_PHRASES.he) assert.deepEqual(gs.matchOpenPhrase(p), { lang: 'he' }, p);
  for (const p of gs.OPEN_PHRASES.en) assert.deepEqual(gs.matchOpenPhrase(p), { lang: 'en' }, p);
  assert.deepEqual(gs.matchOpenPhrase('ערב משחק חדש!'), { lang: 'he' });
  assert.deepEqual(gs.matchOpenPhrase('New Game Night'), { lang: 'en' });
  for (const p of ['מתי ערב משחק חדש?', 'ערב משחק', 'היה ערב משחק חדש אתמול', '', null]) {
    assert.equal(gs.matchOpenPhrase(p), null, String(p));
  }
});

test('a code is ours when a game word vouches for it, or when it stands alone in capitals', () => {
  assert.deepEqual(gs.findCode('משחק K7M2Q'), { code: 'K7M2Q', withWord: true, lang: 'he' });
  assert.deepEqual(gs.findCode('משחק k7m2q'), { code: 'K7M2Q', withWord: true, lang: 'he' });
  assert.deepEqual(gs.findCode('game K7M2Q'), { code: 'K7M2Q', withWord: true, lang: 'en' });
  assert.deepEqual(gs.findCode('K7M2Q'), { code: 'K7M2Q', withWord: false, lang: 'he' });
  assert.deepEqual(gs.findCode('קוד: K7M2Q'), { code: 'K7M2Q', withWord: true, lang: 'he' });
  for (const p of [
    'hello',               // a word in lower case
    'HELLO',               // L is not in the alphabet
    'HAPPY birthday',      // the other word is not a game word
    'משחק K7M2Q ו־AB3CD',  // two codes
    'משחק K7M20',          // 0 is not in the alphabet
    'מה עם משחק K7M2Q מחר בערב?',
    '',
  ]) assert.equal(gs.findCode(p), null, p);
});

test('the price answer reads two numbers in the order she asked, or by their units', () => {
  const cases = {
    '50 1000': { price: 50, chips: 1000 },
    '50 ו־1000': { price: 50, chips: 1000 },
    'כניסה 50, 1000 זיטונים': { price: 50, chips: 1000 },
    '1000 ז׳יטונים 50 שקל': { price: 50, chips: 1000 },
    '50 ש"ח 1000': { price: 50, chips: 1000 },
    '50₪ ו1000 ז\'יטונים': { price: 50, chips: 1000 },
    '₪50 1000': { price: 50, chips: 1000 },
    '1,000 chips 50 nis': { price: 50, chips: 1000 },
    '37.5 500': { price: 37.5, chips: 500 },
  };
  for (const [text, want] of Object.entries(cases)) assert.deepEqual(gs.parseSetup(text), want, text);
  for (const p of ['50', '50 1000 20', '50 אבל תשאל את דני', '50 שקל 20 שקל', '0 1000', '50 10.5', 'כן', '']) {
    assert.equal(gs.parseSetup(p), null, p);
  }
});

test('a name is a short line of letters, and "לא" or a question is not one', () => {
  assert.equal(gs.parseName('דני'), 'דני');
  assert.equal(gs.parseName('  דני   לוי. '), 'דני לוי');
  assert.equal(gs.parseName("ג'ו"), "ג'ו");
  for (const p of ['לא', 'תודה', 'OK', 'מה?', 'דני 2', 'https://x.y', 'אחד שניים שלושה ארבעה', 'א'.repeat(30), '']) {
    assert.equal(gs.parseName(p), null, p);
  }
});

test('the names offered are the first name, then with the surname\'s initial', () => {
  assert.deepEqual(gs.namesFor({ first_name: 'מירון', last_name: 'דדוש' }), ['מירון', 'מירון ד׳']);
  assert.deepEqual(gs.namesFor({ first_name: 'Miron', last_name: 'dadush' }), ['Miron', 'Miron D.']);
  assert.deepEqual(gs.namesFor({ first_name: 'דני בן', last_name: null }), ['דני']);
  assert.deepEqual(gs.namesFor({ first_name: null }), []);
});

test('buy-ins are said the way the table says them', () => {
  assert.equal(gs.buyinsText(0.5, 'he'), 'חצי כניסה');
  assert.equal(gs.buyinsText(1, 'he'), 'כניסה אחת');
  assert.equal(gs.buyinsText(1.5, 'he'), 'כניסה וחצי');
  assert.equal(gs.buyinsText(3, 'he'), '3 כניסות');
  assert.equal(gs.buyinsText(1, 'en'), '1 buy-in');
  assert.equal(gs.buyinsText(2.5, 'en'), '2.5 buy-ins');
});

test('every game sentence passes the reply gate, whoever is reading', () => {
  const vars = { night: 'ערב משחק', price: '50', chips: '1,000', code: 'K7M2Q', name: 'דני',
    count: 'כניסה אחת', url: 'https://allma.world/night/AbCdEfGhIjKlMnOpQrStUv', join: 'https://allma.world/g/K7M2Q' };
  for (const base of ['game_open', 'game_opened', 'game_invite', 'game_already_open', 'game_ask_name',
    'game_joined', 'game_name_taken', 'game_already', 'game_no_night', 'game_full', 'game_hello', 'game_privacy']) {
    for (const lang of ['he', 'en']) {
      const text = templates.render(templates.keyFor(base, lang, { fallback: 'he' }), vars, {});
      // An English sentence reaches only somebody on English, so it is judged
      // against that reader; Hebrew against all three.
      for (const readerWritesHebrew of lang === 'en' ? [false, null] : [true, false, null]) {
        const v = replyLeak.gateReply(text, { readerWritesHebrew });
        assert.equal(v.action, 'pass', `${base}/${lang} to readerWritesHebrew=${readerWritesHebrew}`);
      }
    }
  }
});

// ---- brokerd ----------------------------------------------------------------
let db, broker, now;
const marks = [];
const calls = [];
const policies = [];
const fake = { open: null, join: null };   // per test: body → answer

before(async () => {
  db = await freshDb();
  now = Date.parse('2026-09-30T18:00:00Z');
  broker = createBrokerServer({
    pool: db.pool, now: () => now,
    placeMark: (o) => { marks.push(o); return { attempted: true }; },
    games: {
      open: async (b) => { calls.push(['open', b]); return fake.open(b); },
      join: async (b) => { calls.push(['join', b]); return fake.join(b); },
      applyPolicy: (agentId, packs) => { policies.push([agentId, packs]); return { changed: true }; },
    },
  });
});
after(async () => { await db.teardown(); });

const ask = (params) => broker.dispatch({ id: 1, method: 'dashboard_link_shortcut', params });
let seq = 0;
async function person(extra = {}) {
  const u = await makeUser(db.pool, `+97250777${String(++seq).padStart(4, '0')}`, { firstName: 'מירון', lastName: 'דדוש', ...extra });
  await db.pool.query('UPDATE users SET agent_id = $2 WHERE id = $1', [u.id, `u-${u.id}`]);
  return { ...u, agent: `u-${u.id}` };
}
const packsOf = async (id) => (await db.pool.query('SELECT pack, via FROM user_packs WHERE user_id = $1', [id])).rows;
const NIGHT = { name: 'ערב משחק', price: 50, chips: 1000, code: 'K7M2Q' };
const URL = 'https://allma.world/night/AbCdEfGhIjKlMnOpQrStUv';
const reset = () => { calls.length = 0; policies.length = 0; fake.open = null; fake.join = null; };

test('"ערב משחק חדש" turns the pack on, asks the price, and the answer opens the night and queues the invite', async () => {
  reset();
  const u = await person();
  fake.open = (b) => (b.probe ? { ok: true, none: true } : { ok: true, opened: true, night: NIGHT, url: `${URL}#me-p1` });

  const first = await ask({ agentId: u.agent, body: 'ערב משחק חדש', messageId: '3EB0GAME0001' });
  assert.equal(first.claim, true);
  assert.equal(first.text, "🃏 פותחים ערב משחק.\nכמה עולה כניסה, וכמה ז'יטונים לכל כניסה?");
  assert.deepEqual(calls, [['open', { userId: Number(u.id), probe: true }]], 'a probe, nothing opened yet');
  assert.deepEqual(await packsOf(u.id), [{ pack: 'games', via: 'phrase' }]);
  assert.deepEqual(policies, [[u.agent, ['games']]], 'the deny list follows the row at once');
  assert.equal(marks.filter((m) => m.messageId === '3EB0GAME0001' && m.state === 'done').length, 1);

  const second = await ask({ agentId: u.agent, body: '50 ו־1000', messageId: '3EB0GAME0002' });
  assert.equal(second.claim, true);
  assert.deepEqual(calls[1], ['open', { userId: Number(u.id), name: 'מירון', locale: 'he', price: 50, chips: 1000, nightName: 'ערב משחק' }]);
  assert.equal(second.text,
    `🃏 פתחתי את ערב משחק. כניסה 50 ₪, 1,000 ז'יטונים לכניסה.\nהדף של הערב:\n${URL}#me-p1\nאת ההודעה הבאה אפשר להעביר לקבוצת הוואטסאפ 👇`);

  const { rows: [inv] } = await db.pool.query(
    'SELECT kind, urgency, payload, idempotency_key FROM outbox WHERE user_id = $1', [u.id]);
  assert.equal(inv.kind, gameSummary.INVITE_KIND);
  assert.equal(inv.urgency, 'urgent');
  assert.equal(inv.idempotency_key, `game_invite:K7M2Q:${u.id}`);
  assert.equal(inv.payload.texts.he,
    `🃏 ערב משחק · כניסה 50 ₪\nנכנסים לקישור, בוחרים כיסא ורושמים כניסות:\n${URL}\n\nלרשום כניסות מהוואטסאפ: https://allma.world/g/K7M2Q`);
  assert.ok(!inv.payload.texts.he.includes('#me-'), 'the host\'s own seat never goes to the group');
  assert.match(inv.payload.texts.en, /Log buy-ins from WhatsApp: https:\/\/allma\.world\/g\/K7M2Q$/);
  // And the raw pipe says the Hebrew to a Hebrew host.
  assert.equal(proactiveText.rawPipeTextFor({ kind: inv.kind, payload: inv.payload, locale: 'he' }, {}), inv.payload.texts.he);
  assert.equal(proactiveText.rawPipeTextFor({ kind: inv.kind, payload: inv.payload, locale: 'en' }, {}), inv.payload.texts.en);

  const events = (await db.pool.query(
    "SELECT event, detail FROM audit_log WHERE actor_id = $1 AND event LIKE 'games.%' ORDER BY id", [u.id])).rows;
  assert.deepEqual(events, [
    { event: 'games.phrase_shortcut', detail: { outcome: 'asked_setup', lang: 'he' } },
    { event: 'games.phrase_shortcut', detail: { outcome: 'opened', lang: 'he' } },
  ]);
});

test('a night already open is handed back, and the phrase asks nothing', async () => {
  reset();
  const u = await person();
  fake.open = () => ({ ok: true, already: true, night: NIGHT, url: `${URL}#me-p1` });
  const out = await ask({ agentId: u.agent, body: 'ערב פוקר חדש' });
  assert.equal(out.text, `🃏 יש לך כבר ערב פתוח: ערב משחק, קוד K7M2Q.\nהדף של הערב:\n${URL}#me-p1`);
  // The next message is not read as a price.
  assert.deepEqual(await ask({ agentId: u.agent, body: '50 1000' }), { ok: true, claim: false });
});

test('an answer that is not a price goes to the model, and the question is not asked twice over', async () => {
  reset();
  const u = await person();
  fake.open = (b) => (b.probe ? { ok: true, none: true } : { ok: true, opened: true, night: NIGHT, url: URL });
  await ask({ agentId: u.agent, body: 'ערב משחק חדש' });
  assert.deepEqual(await ask({ agentId: u.agent, body: '50 אבל תשאל את דני' }), { ok: true, claim: false });
  assert.deepEqual(await ask({ agentId: u.agent, body: '50 1000' }), { ok: true, claim: false },
    'only the NEXT message answers her');
  assert.equal(calls.filter(([, b]) => !b.probe).length, 0);
});

test('the question lapses after a quarter of an hour', async () => {
  reset();
  const u = await person();
  fake.open = (b) => (b.probe ? { ok: true, none: true } : { ok: true, opened: true, night: NIGHT, url: URL });
  await ask({ agentId: u.agent, body: 'ערב משחק חדש' });
  now += 16 * 60_000;
  try {
    assert.deepEqual(await ask({ agentId: u.agent, body: '50 1000' }), { ok: true, claim: false });
  } finally { now -= 16 * 60_000; }
  // …and inside the quarter of an hour it IS the answer.
  await ask({ agentId: u.agent, body: 'ערב משחק חדש' });
  now += 14 * 60_000;
  try {
    assert.equal((await ask({ agentId: u.agent, body: '50 1000' })).claim, true);
  } finally { now -= 14 * 60_000; }
});

test('a code seats them under their first name, turns the pack on, and says what to write during the night', async () => {
  reset();
  const u = await person({ firstName: 'דני', lastName: 'לוי' });
  fake.join = (b) => ({ ok: true, joined: true, night: NIGHT, name: b.names[0], buyins: 0, url: `${URL}#me-p7` });
  const out = await ask({ agentId: u.agent, body: 'משחק K7M2Q', messageId: '3EB0GAME0100' });
  assert.deepEqual(calls, [['join', { userId: Number(u.id), code: 'K7M2Q', names: ['דני', 'דני ל׳'] }]]);
  assert.equal(out.text,
    `👍 דני, נכנסת לערב משחק.\nבמהלך הערב אפשר לכתוב לי:\n• עוד כניסה / חצי כניסה\n• מה המצב?\n• בסוף: נשארו לי 1,850\nהדף של הערב:\n${URL}#me-p7`);
  assert.deepEqual(await packsOf(u.id), [{ pack: 'games', via: 'code' }]);
  assert.deepEqual(policies, [[u.agent, ['games']]]);
});

test('sending the code again says where they stand', async () => {
  reset();
  const u = await person({ firstName: 'דני' });
  fake.join = () => ({ ok: true, already: true, night: NIGHT, name: 'דני', buyins: 1.5, url: `${URL}#me-p7` });
  const out = await ask({ agentId: u.agent, body: 'K7M2Q' });
  assert.equal(out.text, `יש לך כבר כניסה וחצי בערב משחק.\nהדף של הערב:\n${URL}#me-p7`);
  fake.join = () => ({ ok: true, already: true, night: NIGHT, name: 'דני', buyins: 0, url: `${URL}#me-p7` });
  assert.match((await ask({ agentId: u.agent, body: 'K7M2Q' })).text, /^👍 דני, נכנסת לערב משחק\./,
    'with nothing bought yet, the instructions again');
});

test('no name on file: she asks, and the answer seats them', async () => {
  reset();
  const u = await person({ firstName: null, lastName: null });
  fake.join = (b) => (b.names.length
    ? { ok: true, joined: true, night: NIGHT, name: b.names[0], buyins: 0, url: `${URL}#me-p9` }
    : { ok: false, error: 'need_name', night: NIGHT });
  const q = await ask({ agentId: u.agent, body: 'משחק K7M2Q' });
  assert.equal(q.text, '🃏 ערב משחק, כניסה 50 ₪.\nאיך קוראים לך? ככה החברים יראו אותך בערב.');
  assert.deepEqual(await packsOf(u.id), [], 'not seated, so no pack yet');
  const a = await ask({ agentId: u.agent, body: 'יוסי' });
  assert.deepEqual(calls[1], ['join', { userId: Number(u.id), code: 'K7M2Q', names: ['יוסי'] }]);
  assert.match(a.text, /^👍 יוסי, נכנסת לערב משחק\./);
});

test('a name already at the table asks for another', async () => {
  reset();
  const u = await person({ firstName: 'דני', lastName: null });
  fake.join = (b) => (b.names[0] === 'דני'
    ? { ok: false, error: 'name_taken', name: 'דני', night: NIGHT }
    : { ok: true, joined: true, night: NIGHT, name: b.names[0], buyins: 0, url: `${URL}#me-p9` });
  assert.equal((await ask({ agentId: u.agent, body: 'משחק K7M2Q' })).text, 'כבר יש דני בערב. איזה שם לכתוב לך?');
  assert.match((await ask({ agentId: u.agent, body: 'דני הגדול' })).text, /^👍 דני הגדול, נכנסת/);
});

test('an unknown code is answered only when a game word came with it', async () => {
  reset();
  const u = await person();
  fake.join = () => ({ ok: false, error: 'no_night' });
  assert.equal((await ask({ agentId: u.agent, body: 'משחק ABCDE' })).text,
    'לא מצאתי ערב פתוח עם הקוד ABCDE. אולי הוא כבר נסגר? אפשר לבקש קוד חדש ממי שפתח את הערב.');
  assert.deepEqual(await ask({ agentId: u.agent, body: 'HAPPY' }), { ok: true, claim: false },
    'a bare word in capitals that is no night is not ours');
  assert.deepEqual(await packsOf(u.id), []);
});

test('a full table says so', async () => {
  reset();
  const u = await person();
  fake.join = () => ({ ok: false, error: 'full', night: NIGHT });
  assert.equal((await ask({ agentId: u.agent, body: 'משחק K7M2Q' })).text,
    'בערב משחק כבר יושבים 30 שחקנים, וזה המקסימום לערב אחד.');
});

test('English on file is answered in English', async () => {
  reset();
  const u = await person({ firstName: 'Dan', lastName: null, locale: 'en' });
  fake.open = (b) => (b.probe ? { ok: true, none: true }
    : { ok: true, opened: true, night: { ...NIGHT, name: b.nightName }, url: `${URL}#me-p1` });
  assert.match((await ask({ agentId: u.agent, body: 'new game night' })).text, /^🃏 /);
  const out = await ask({ agentId: u.agent, body: '50 1000' });
  assert.equal(calls[1][1].nightName, 'Game night');
  assert.doesNotMatch(out.text, /[֐-׿]/, 'no Hebrew to somebody on English');
});

test('gamesd down, slow or refusing: no claim, nothing written, and the model runs', async () => {
  reset();
  const u = await person();
  fake.open = () => { throw new Error('The operation was aborted due to timeout'); };
  fake.join = () => { throw new Error('ECONNREFUSED'); };
  const err = console.error; console.error = () => {};
  try {
    assert.deepEqual(await ask({ agentId: u.agent, body: 'ערב משחק חדש' }), { ok: true, claim: false });
    assert.deepEqual(await ask({ agentId: u.agent, body: 'משחק K7M2Q' }), { ok: true, claim: false });
  } finally { console.error = err; }
  fake.open = (b) => (b.probe ? { ok: true, none: true } : { ok: false, error: 'bad_number' });
  await ask({ agentId: u.agent, body: 'ערב משחק חדש' });
  assert.deepEqual(await ask({ agentId: u.agent, body: '50 1000' }), { ok: true, claim: false });
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM outbox WHERE user_id = $1', [u.id])).rows[0].n, 0);
});

test('a config write that fails costs nothing but the tools arriving later', async () => {
  const u = await person({ firstName: 'דני' });
  const b = createBrokerServer({
    pool: db.pool, now: () => now, placeMark: () => ({ attempted: true }),
    games: {
      join: async () => ({ ok: true, joined: true, night: NIGHT, name: 'דני', buyins: 0, url: URL }),
      applyPolicy: () => { throw new Error('EACCES'); },
    },
  });
  const err = console.error; console.error = () => {};
  try {
    const out = await b.dispatch({ id: 1, method: 'dashboard_link_shortcut', params: { agentId: u.agent, body: 'משחק K7M2Q' } });
    assert.equal(out.claim, true);
  } finally { console.error = err; }
  assert.deepEqual(await packsOf(u.id), [{ pack: 'games', via: 'code' }], 'the row is the permission, and it is there');
});

test('the link shortcut still works behind it', async () => {
  reset();
  const u = await person();
  const out = await ask({ agentId: u.agent, body: 'שלח לי קישור' });
  assert.equal(out.claim, true);
  assert.equal(out.kind, 'link');
  assert.deepEqual(calls, [], 'gamesd is not asked about a message that is not a game one');
});

test('the eval user and a stranger are not answered', async () => {
  reset();
  fake.open = () => ({ ok: true, none: true });
  const ev = await person();
  await db.pool.query('UPDATE users SET is_eval = true WHERE id = $1', [ev.id]);
  assert.deepEqual(await ask({ agentId: ev.agent, body: 'ערב משחק חדש' }), { ok: true, claim: false });
  assert.deepEqual(await ask({ agentId: 'u-999999', body: 'ערב משחק חדש' }), { ok: true, claim: false });
  assert.deepEqual(calls, []);
});

// ---- a new number (stage 4ב) ------------------------------------------------
// Somebody Olma has never heard of taps the invite's short link and sends
// "משחק K7M2Q". The greeter's session key reaches brokerd as agentId 'intake';
// brokerd makes the pending row, seats them, and the intake sweep gives them an
// agent (jobs/intake.js, `gameClaimed`).
const flags = require('../src/domain/flags');
const intakeKey = (phone) => `agent:intake:whatsapp:direct:${phone}`;
const HELLO = 'היי, אני עולמה 👋 עוזרת AI';
const PRIVACY = 'מה אני שומרת ואיך מוחקים: https://allma.world/privacy';
let tel = 0;
const newPhone = () => `+97252888${String(++tel).padStart(4, '0')}`;
const rowOf = async (phone) => (await db.pool.query('SELECT * FROM users WHERE phone = $1', [phone])).rows[0];
const claimsOf = async (id) => (await db.pool.query(
  "SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'games.intake_claim' ORDER BY id", [id])).rows.map((r) => r.detail);
const seatByName = (b) => (b.names.length
  ? { ok: true, joined: true, night: NIGHT, name: b.names[0], buyins: 0, url: `${URL}#me-p4` }
  : { ok: false, error: 'need_name', night: NIGHT });
async function withFlag(key, value, fn) {
  const before = await flags.getFlag(db.pool, key);
  await flags.setFlag(db.pool, key, value);
  try { return await fn(); } finally { await flags.setFlag(db.pool, key, before ?? null); }
}
const open = (fn) => withFlag('registration_open', true, fn);

test('a new number\'s code: she says she is an AI, asks the name, and the page on privacy — once', () => open(async () => {
  reset();
  const phone = newPhone();
  fake.join = seatByName;
  const q = await ask({ agentId: 'intake', sessionKey: intakeKey(phone), body: 'משחק K7M2Q', messageId: '3EB0NEW00001' });
  assert.equal(q.claim, true);
  assert.equal(q.text, `${HELLO}\n🃏 ערב משחק, כניסה 50 ₪.\nאיך קוראים לך? ככה החברים יראו אותך בערב.\n${PRIVACY}`);
  const u = await rowOf(phone);
  assert.equal(u.status, 'pending');
  assert.equal(u.agent_id, null, 'the sweep gives the agent, never brokerd');
  assert.equal(u.locale, 'he');
  assert.equal(u.timezone, 'Asia/Jerusalem', 'never NULL — the dialling code, as for anybody');
  assert.ok(u.opening_sent_at, 'the introduction is said, so nobody says it again');
  assert.deepEqual(calls, [['join', { userId: Number(u.id), code: 'K7M2Q', names: [] }]]);
  assert.deepEqual(await packsOf(u.id), [], 'not seated yet');
  assert.deepEqual(await claimsOf(u.id), [{ outcome: 'need_name', lang: 'he', introduced: true }]);
  assert.ok(marks.some((m) => m.target === phone && m.messageId === '3EB0NEW00001' && m.state === 'done'));

  const a = await ask({ agentId: 'intake', sessionKey: intakeKey(phone), body: 'יוסי כהן' });
  assert.deepEqual(calls[1], ['join', { userId: Number(u.id), code: 'K7M2Q', names: ['יוסי כהן'] }]);
  assert.match(a.text, /^👍 יוסי כהן, נכנסת לערב משחק\./, 'no second hello, no second privacy line');
  assert.doesNotMatch(a.text, /privacy|עולמה/);
  const after = await rowOf(phone);
  assert.deepEqual([after.first_name, after.last_name, after.name_confirmed], ['יוסי', 'כהן', true]);
  assert.deepEqual(await packsOf(u.id), [{ pack: 'games', via: 'code' }]);
  assert.deepEqual(policies, [], 'no agent yet: the pack rides the first config write instead');
  assert.equal((await claimsOf(u.id))[1].outcome, 'joined');
}));

test('a new number in English is answered in English, and its row says so', () => open(async () => {
  reset();
  const phone = '+14155550142';
  fake.join = seatByName;
  const q = await ask({ agentId: 'intake', sessionKey: intakeKey(phone), body: 'game K7M2Q' });
  assert.match(q.text, /^Hey, I’m Allma 👋 an AI assistant\n/);
  assert.match(q.text, /\nWhat I keep and how to delete it: https:\/\/allma\.world\/privacy$/);
  assert.doesNotMatch(q.text.replace(NIGHT.name, ''), /[֐-׿]/, 'only the host\'s own name for the night');
  const u = await rowOf(phone);
  assert.equal(u.locale, 'en');
  assert.ok(u.timezone);
}));

test('a wrong code from a new number is answered; a bare five letters is not ours', () => open(async () => {
  reset();
  fake.join = () => ({ ok: false, error: 'no_night' });
  const phone = newPhone();
  const out = await ask({ agentId: 'intake', sessionKey: intakeKey(phone), body: 'משחק ABCDE' });
  assert.equal(out.text, `${HELLO}\nלא מצאתי ערב פתוח עם הקוד ABCDE. אולי הוא כבר נסגר? אפשר לבקש קוד חדש ממי שפתח את הערב.\n${PRIVACY}`);
  const bare = newPhone();
  assert.deepEqual(await ask({ agentId: 'intake', sessionKey: intakeKey(bare), body: 'HAPPY' }), { ok: true, claim: false });
  assert.equal(await rowOf(bare), undefined, 'rolled back: the greeter meets them as before');
}));

test('closed registration, the hourly cap, a blocked number and any other message all go to the greeter', async () => {
  reset();
  fake.join = seatByName;
  const closed = newPhone();
  await withFlag('registration_open', false, async () => {
    assert.deepEqual(await ask({ agentId: 'intake', sessionKey: intakeKey(closed), body: 'משחק K7M2Q' }), { ok: true, claim: false });
  });
  assert.equal(await rowOf(closed), undefined);

  await open(async () => {
    const capped = newPhone();
    await withFlag('intake_hourly_cap', 0, async () => {
      assert.deepEqual(await ask({ agentId: 'intake', sessionKey: intakeKey(capped), body: 'משחק K7M2Q' }), { ok: true, claim: false });
    });
    assert.equal(await rowOf(capped), undefined);

    const blocked = newPhone();
    const b = await makeUser(db.pool, blocked);
    await db.pool.query("UPDATE users SET status = 'blocked' WHERE id = $1", [b.id]);
    assert.deepEqual(await ask({ agentId: 'intake', sessionKey: intakeKey(blocked), body: 'משחק K7M2Q' }), { ok: true, claim: false });

    const chat = newPhone();
    assert.deepEqual(await ask({ agentId: 'intake', sessionKey: intakeKey(chat), body: 'היי, מה את?' }), { ok: true, claim: false });
    assert.deepEqual(await ask({ agentId: 'intake', sessionKey: 'agent:intake:whatsapp:group:1203@g.us', body: 'משחק K7M2Q' }),
      { ok: true, claim: false });
    assert.equal(await rowOf(chat), undefined);
  });
  assert.deepEqual(calls, [], 'gamesd was never asked');
});

test('somebody the greeter already greeted is not introduced a second time', () => open(async () => {
  reset();
  const phone = newPhone();
  const p = await makeUser(db.pool, phone, { status: 'pending' });
  await db.pool.query('UPDATE users SET opening_sent_at = now() WHERE id = $1', [p.id]);
  fake.join = seatByName;
  const q = await ask({ agentId: 'intake', sessionKey: intakeKey(phone), body: 'משחק K7M2Q' });
  assert.equal(q.text, '🃏 ערב משחק, כניסה 50 ₪.\nאיך קוראים לך? ככה החברים יראו אותך בערב.');
  assert.deepEqual(await claimsOf(p.id), [{ outcome: 'need_name', lang: 'he', introduced: false }]);
}));

test('given an agent between the question and the answer, the answer still seats them — by either door', () => open(async () => {
  reset();
  fake.join = seatByName;
  const provisioned = async (phone) => {
    const u = await rowOf(phone);
    await db.pool.query("UPDATE users SET status = 'active', agent_id = $2 WHERE id = $1", [u.id, `u-${u.id}`]);
    return { ...u, agent: `u-${u.id}` };
  };
  // Their own agent's door: the binding went live before they answered.
  const one = newPhone();
  await ask({ agentId: 'intake', sessionKey: intakeKey(one), body: 'משחק K7M2Q' });
  const u1 = await provisioned(one);
  const a1 = await ask({ agentId: u1.agent, body: 'דנה' });
  assert.match(a1.text, /^👍 דנה, נכנסת לערב משחק\./);
  assert.deepEqual(await packsOf(u1.id), [{ pack: 'games', via: 'code' }]);
  assert.deepEqual(policies, [[u1.agent, ['games']]], 'an agent exists now, so the deny list follows at once');

  // The greeter's door: the binding was not live yet.
  const two = newPhone();
  await ask({ agentId: 'intake', sessionKey: intakeKey(two), body: 'משחק K7M2Q' });
  const u2 = await provisioned(two);
  const a2 = await ask({ agentId: 'intake', sessionKey: intakeKey(two), body: 'רוני' });
  assert.match(a2.text, /^👍 רוני, נכנסת לערב משחק\./);
  assert.equal((await rowOf(two)).first_name, 'רוני');
  assert.deepEqual(await packsOf(u2.id), [{ pack: 'games', via: 'code' }]);
}));

// ---- the gate ---------------------------------------------------------------
const WED_NIGHT = new Date('2026-08-12T23:40:00Z');
test('the gate: the invite goes out at once for a quarter of an hour after it was made, then waits like anything else', () => {
  const row = (ageMs) => ({ kind: gameSummary.INVITE_KIND, urgency: 'urgent',
    created_at: new Date(WED_NIGHT.getTime() - ageMs), payload: { code: 'K7M2Q', texts: { he: 'א', en: 'a' } } });
  const base = { plan: 'free', window: { start: '09:00', end: '21:00' }, tz: 'UTC', sentToday: 0, budget: 4, now: WED_NIGHT, quietDays: [] };
  assert.equal(decide({ ...base, row: row(10_000) }).action, 'deliver', 'the host is right there, at 23:40');
  assert.equal(decide({ ...base, row: row(10_000), checkinMisses: 3 }).action, 'deliver');
  assert.equal(decide({ ...base, row: row(20 * 60_000) }).holdReason, 'night');
  assert.equal(decide({ ...base, row: row(10_000), paused: true }).action, 'drop', 'a pause has no exceptions');
  const sat = new Date('2026-08-15T12:00:00Z');
  assert.equal(decide({ ...base, now: sat, quietDays: [sat.getUTCDay()],
    row: { ...row(0), created_at: new Date(sat.getTime() - 5_000) } }).action, 'deliver');
});
