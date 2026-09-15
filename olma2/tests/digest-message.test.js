'use strict';
// The scheduled digest with no model in it (domain/digest-message.js). What is
// pinned: when it steps aside for the model, what the person reads — word for
// word, since nothing downstream rewrites it — and that a card which cannot go
// out is never a morning with nothing in it.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const flags = require('../src/domain/flags');
const digestMessage = require('../src/domain/digest-message');
const { sendDrawnDigest, sendRawMessage } = require('../src/channels/openclaw');

let db, user, workspace;
// Tuesday 2026-09-15, 09:00 in Jerusalem (UTC+3). Pinned: nothing here may
// depend on the hour the suite runs.
const NINE_AM = new Date('2026-09-15T06:00:00Z');
const noGoogle = async () => { throw new Error('not connected, must not be called'); };

before(async () => {
  db = await freshDb();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-digest-message-'));
  user = await makeUser(db.pool, '+972500000931', { firstName: 'מירון' });
  await db.pool.query(
    `UPDATE users SET timezone = 'Asia/Jerusalem', locale = 'he', agent_id = 'u-931',
       workspace_path = $2, name_confirmed = true, digest_scope = 'full' WHERE id = $1`,
    [user.id, workspace]);
});
after(async () => {
  fs.rmSync(workspace, { recursive: true, force: true });
  await db.teardown();
});
beforeEach(async () => {
  await db.pool.query(`DELETE FROM tasks WHERE owner_id = $1`, [user.id]);
  await db.pool.query(`DELETE FROM integrations WHERE user_id = $1`, [user.id]);
  await db.pool.query(`UPDATE users SET locale = 'he', name_confirmed = true WHERE id = $1`, [user.id]);
  await flags.setFlag(db.pool, 'digest_without_model_phones', 'all');
  await flags.setFlag(db.pool, 'digest_card_without_model_phones', '');
  await flags.setFlag(db.pool, 'digest_card_min_items', 3);
});

function row(payload = {}) {
  return { id: 1, kind: 'digest', user_id: user.id, payload: { scope: 'full', folded: [], mayAsk: false, ...payload } };
}

async function addTask(title, { dueAt = null, kind = null, category = null } = {}) {
  await db.pool.query(
    `INSERT INTO tasks (owner_id, title, due_at, kind, category) VALUES ($1, $2, $3, $4, $5)`,
    [user.id, title, dueAt, kind, category]);
}

async function compose(extra = {}, r = row()) {
  const client = await db.pool.connect();
  try {
    return await digestMessage.compose(client, r, {
      wording: {}, channelType: 'whatsapp', now: NINE_AM, listEvents: noGoogle, ...extra,
    });
  } finally { client.release(); }
}

// ── When the model still writes it ─────────────────────────────────────────

test('a morning carrying queued updates goes to the model, as before', async () => {
  await addTask('לקנות חלב');
  assert.equal(await compose({}, row({ folded: [{ kind: 'share', text: 'x' }] })), null);
  assert.equal(await digestMessage.forDelivery(db.pool, row({ folded: [{ kind: 'x' }] }), {}), null);
});

test('a digest merged or batched at delivery goes to the model', async () => {
  await addTask('לקנות חלב');
  assert.equal(await compose({}, row({ mergedParts: [{ kind: 'checkin' }] })), null);
  assert.equal(await compose({}, row({ items: ['a', 'b'] })), null);
  assert.equal(await compose({}, row({ instruction: 'say this' })), null);
});

test('a phone off the list goes to the model', async () => {
  await addTask('לקנות חלב');
  await flags.setFlag(db.pool, 'digest_without_model_phones', '+972500000000');
  assert.equal(await compose(), null);
  await flags.setFlag(db.pool, 'digest_without_model_phones', `+972500000000,${user.phone}`);
  assert.ok(await compose());
});

test('a card-sized morning stays with the model until the card list opens', async () => {
  for (const t of ['א', 'ב', 'ג', 'ד']) await addTask(t);
  assert.equal(await compose(), null, 'the model draws the card, exactly as before');
});

test('anything that throws is the model path, never a lost digest', async () => {
  const pool = { connect: async () => ({ query: async () => { throw new Error('boom'); }, release() {} }) };
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal(await digestMessage.forDelivery(pool, row(), { wording: {} }), null);
  } finally { console.error = origError; }
});

// ── What they read ─────────────────────────────────────────────────────────

test('the text morning, word for word', async () => {
  await addTask('רופא שיניים', { dueAt: '2026-09-15T13:00:00Z', kind: 'event' });
  await addTask('לשלם ארנונה', { dueAt: '2026-09-16T06:00:00Z' });
  const out = await compose();
  assert.equal(out.card, undefined);
  assert.equal(out.text, [
    'בוקר טוב מירון ☀️',
    'זה מה שעל הפרק:',
    '',
    '*ביומן*',
    '- 16:00 — רופא שיניים',
    '',
    '*על הרשימה*',
    '- מחר 09:00 — לשלם ארנונה',
  ].join('\n'));
  assert.doesNotMatch(out.text, /\?/, 'nothing drawn ever asks');
});

test('an unconfirmed name is left out, and so is the space before it', async () => {
  await db.pool.query(`UPDATE users SET name_confirmed = false WHERE id = $1`, [user.id]);
  await addTask('לקנות חלב');
  const out = await compose();
  assert.match(out.text, /^בוקר טוב ☀️\n/);
  assert.doesNotMatch(out.text, /מירון/);
});

test('the greeting follows the hour where they are', async () => {
  await addTask('לקנות חלב');
  const evening = await compose({ now: new Date('2026-09-15T15:30:00Z') }); // 18:30 Jerusalem
  assert.match(evening.text, /^ערב טוב מירון/);
  assert.equal(digestMessage.greetingFor('he', 13), 'צהריים טובים');
  assert.equal(digestMessage.greetingFor('he', 2), 'ערב טוב', 'never "לילה טוב", which is goodbye');
  assert.equal(digestMessage.greetingFor('en', 8), 'Good morning');
});

test('nothing due is its own sentence, not an empty heading', async () => {
  const out = await compose();
  assert.equal(out.text, 'בוקר טוב מירון ☀️\nאין כרגע כלום ביומן או ברשימה — יום פנוי 🌿');
});

test('an English speaker reads English', async () => {
  await db.pool.query(`UPDATE users SET locale = 'en' WHERE id = $1`, [user.id]);
  await addTask('Pay the rent', { dueAt: '2026-09-16T06:00:00Z' });
  const out = await compose();
  assert.equal(out.text, "Good morning מירון ☀️\nHere's what's on:\n\n*On your list*\n- Tomorrow 09:00 — Pay the rent");
});

test('the owner rewording from the admin page is what goes out', async () => {
  await addTask('לקנות חלב');
  const out = await compose({ wording: { digest_intro: '{{greeting}}! הנה היום:' } });
  assert.match(out.text, /^בוקר טוב! הנה היום:\n\n/);
});

test('Google events join the calendar in time order, and a mirrored task is not listed twice', async () => {
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status) VALUES ($1, 'google_calendar', 'connected')`, [user.id]);
  await flags.setFlag(db.pool, 'digest_card_min_items', 10);
  await addTask('רופא שיניים', { dueAt: '2026-09-15T13:00:00Z', kind: 'event' });
  await db.pool.query(`UPDATE tasks SET calendar_event_id = 'mirrored-1' WHERE owner_id = $1`, [user.id]);
  const listEvents = async () => ({
    ok: true,
    data: {
      events: [
        { id: 'g-1', title: 'ישיבת צוות', start: '2026-09-15T08:00:00Z', end: '2026-09-15T09:00:00Z', allDay: false },
        { id: 'mirrored-1', title: 'רופא שיניים', start: '2026-09-15T13:00:00Z', end: '2026-09-15T14:00:00Z', allDay: false },
        { id: 'g-2', title: 'יום הולדת לדנה', start: '2026-09-16', end: '2026-09-17', allDay: true },
        { id: 'g-3', title: 'מחרתיים', start: '2026-09-17T08:00:00Z', end: '2026-09-17T09:00:00Z', allDay: false },
      ],
    },
  });
  const out = await compose({ listEvents });
  assert.match(out.text, /\*ביומן\*\n- 11:00-12:00 — ישיבת צוות\n- 16:00 — רופא שיניים\n- מחר — יום הולדת לדנה$/);
  assert.equal((out.text.match(/רופא שיניים/g) || []).length, 1);
  assert.doesNotMatch(out.text, /מחרתיים/, 'past tomorrow is not this digest');
});

test('a Google read that fails is left out, and the morning still goes', async () => {
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status) VALUES ($1, 'google_calendar', 'connected')`, [user.id]);
  await addTask('לקנות חלב');
  const out = await compose({ listEvents: async () => ({ ok: false, error: { code: 'conflict' } }) });
  assert.match(out.text, /לקנות חלב/);
});

test('waiting on others, and owing an answer, are statements under the list', () => {
  const lines = digestMessage.crossUserLines({
    awaitingOthers: [{ title: 'ארוחת צהריים', waiting_on: ['דנה', 'יהב'] }],
    pendingMeetings: [{ title: 'קפה', initiator_name: 'גיא' }],
  }, 'he', {});
  assert.deepEqual(lines, ['⏳ עוד מחכים לתשובה: ארוחת צהריים (דנה, יהב)', '📩 מחכה לתשובה ממך: קפה (גיא)']);
});

// ── The card ───────────────────────────────────────────────────────────────

test('an open card list draws the card, with the list in the picture and not beside it', async () => {
  await flags.setFlag(db.pool, 'digest_card_without_model_phones', 'all');
  await addTask('רופא שיניים', { dueAt: '2026-09-15T13:00:00Z', kind: 'event' });
  await addTask('לשלם ארנונה', { dueAt: '2026-09-16T06:00:00Z', category: 'money' });
  for (let i = 0; i < 20; i++) await addTask(`משימה ${i}`, { category: i % 2 ? 'home' : 'work' });
  let spec;
  const out = await compose({
    renderPng: (s) => { spec = s; return { ok: true, data: { png: Buffer.from('png') } }; },
    saveCard: () => ({ ok: true, data: { path: `${workspace}/cards/x.png` } }),
  });
  assert.equal(out.card.path, `${workspace}/cards/x.png`);
  assert.equal(out.caption, 'בוקר טוב מירון ☀️\nזה מה שעל הפרק:');
  assert.match(out.text, /משימה 19/, 'the words are always the whole message, for a card that cannot go');
  assert.equal(spec.subtitle, 'יום שלישי 15.9');
  assert.ok(spec.sections.every((s) => s.items.length <= 15));
  assert.deepEqual(spec.sections.map((s) => s.title), ['ביומן', 'על הרשימה', 'על הרשימה']);
  assert.deepEqual(spec.sections[0].items, [{ date: '16:00', text: 'רופא שיניים', icon: 'calendar' }]);
  assert.deepEqual(spec.sections[1].items[0], { date: 'מחר 09:00', text: 'לשלם ארנונה', icon: 'money' });
  // The real renderer accepts what this builds.
  const real = require('../src/domain/schedule-card').renderPng(spec);
  assert.equal(real.ok, true, real.error && real.error.message);
});

test('a card the renderer refuses leaves the words to go out', async () => {
  await flags.setFlag(db.pool, 'digest_card_without_model_phones', 'all');
  for (const t of ['א', 'ב', 'ג', 'ד']) await addTask(t);
  const out = await compose({ renderPng: () => ({ ok: false, error: { message: 'too tall' } }) });
  assert.equal(out.card, undefined);
  assert.match(out.text, /- א/);
});

// ── Onto the pipe ──────────────────────────────────────────────────────────

const channel = { channel_type: 'whatsapp', channel_identifier: '+972500000931' };
const drawnCard = { text: 'WORDS', caption: 'CAPTION', card: { path: '/w/cards/x.png' }, user: { id: 9, agent_id: 'u-9' } };

function sender(answers) {
  const calls = [];
  return { calls, send: async (a) => { calls.push(a); return answers.shift(); } };
}

test('the card goes as their own agent, and the words are not sent after it', async () => {
  const s = sender([{ ok: true, via: 'gateway' }]);
  const r = await sendDrawnDigest(drawnCard, channel, { sendRawMessage: s.send });
  assert.equal(r.ok, true);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0], {
    channel: 'whatsapp', target: '+972500000931', message: 'CAPTION', media: '/w/cards/x.png', agentId: 'u-9',
  });
});

test('a card that timed out is not followed by the words — that is the morning twice', async () => {
  const s = sender([{ ok: false, timedOut: true, via: 'gateway' }]);
  const r = await sendDrawnDigest(drawnCard, channel, { sendRawMessage: s.send });
  assert.equal(r.timedOut, true);
  assert.equal(s.calls.length, 1);
});

test('a refused card is followed by the words', async () => {
  const s = sender([{ ok: false, error: 'path-not-allowed', via: 'gateway' }, { ok: true, via: 'gateway' }]);
  const origError = console.error;
  console.error = () => {};
  try {
    const r = await sendDrawnDigest(drawnCard, channel, { sendRawMessage: s.send });
    assert.equal(r.ok, true);
    assert.equal(r.drawn, 'text');
  } finally { console.error = origError; }
  assert.deepEqual(s.calls[1], { channel: 'whatsapp', target: '+972500000931', message: 'WORDS', agentId: 'u-9' });
});

test('words refused as their agent are sent once more as main', async () => {
  const s = sender([{ ok: false, error: 'scope', via: 'gateway' }, { ok: true, via: 'gateway' }]);
  const r = await sendDrawnDigest({ ...drawnCard, card: undefined }, channel, { sendRawMessage: s.send });
  assert.equal(r.ok, true);
  assert.equal(r.asMain, true);
  assert.equal(s.calls[1].agentId, undefined);
});

test('media never falls back to the CLI, which cannot send as their agent', async () => {
  const cli = [];
  const r = await sendRawMessage(
    { channel: 'whatsapp', target: '+972500000931', message: 'c', media: '/w/x.png', agentId: 'u-9' },
    {
      gatewaySend: async () => { throw Object.assign(new Error('no socket'), { dispatched: false }); },
      runOpenclaw: async (a) => { cli.push(a); return { ok: true }; },
    });
  assert.equal(r.ok, false);
  assert.equal(cli.length, 0);
});

test('the agent and the media reach the gateway request', async () => {
  const seen = [];
  await sendRawMessage(
    { channel: 'whatsapp', target: '+972500000931', message: 'c', media: '/w/x.png', agentId: 'u-9' },
    { gatewaySend: async (p) => { seen.push(p); return {}; }, runOpenclaw: async () => ({ ok: true }) });
  assert.deepEqual(seen, [{ channel: 'whatsapp', to: '+972500000931', message: 'c', mediaUrl: '/w/x.png', agentId: 'u-9' }]);
});
