'use strict';
// jobs/voice-calls.js: a finished phone call gets the identical facts/tasks
// treatment fact-extraction.js gives a finished WhatsApp chapter, plus a
// WhatsApp recap of the call itself — see the module header for why a call
// needs no idle-gap heuristic and why "processed" is a file move, not a row.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const voiceCalls = require('../src/jobs/voice-calls');

let db, dir;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-voice-')); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

function writeCall(name, { user, messages }) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ user, messages }));
}

function modelSays(json) {
  return {
    ok: true,
    text: JSON.stringify(json),
    model: 'deepseek/deepseek-v4-flash',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function recorder(answer) {
  const calls = [];
  return { calls, deps: { complete: (a) => { calls.push(a); return modelSays(answer); } } };
}

test('toChatMessages drops tool turns and keeps only what was said', () => {
  const chat = voiceCalls.toChatMessages([
    { role: 'system', content: 'you are Olma' },
    { role: 'user', content: 'מה השעה?' },
    { role: 'assistant', content: null, tool_calls: [{ name: 'get_my_digest' }] },
    { role: 'tool', content: '{"tasks":[]}' },
    { role: 'assistant', content: '  שלוש וחצי  ' },
  ]);
  assert.deepEqual(chat, [
    { role: 'user', text: 'מה השעה?' },
    { role: 'assistant', text: 'שלוש וחצי' },
  ]);
});

test('a call with no matching user is skipped, not failed, and moved out of the way', async () => {
  writeCall('a.json', { user: 999999, messages: [{ role: 'user', content: 'הלו' }] });
  await withClient(async (c) => {
    const res = await voiceCalls.sweepVoiceCalls(c, { transcriptsDir: dir });
    assert.equal(res.skipped, 1);
    assert.equal(res.failed.length, 0);
    assert.equal(res.processed.length, 0);
  });
  assert.equal(fs.existsSync(path.join(dir, 'a.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'processed', 'a.json')), true);
});

test('a call where nobody said a word is skipped — a missed call teaches nothing', async () => {
  const u = await makeUser(db.pool, '+972590002001', { firstName: 'דנה' });
  writeCall('b.json', { user: u.id, messages: [{ role: 'assistant', content: 'היי, מה קורה?' }] });
  await withClient(async (c) => {
    const rec = recorder({ facts: [], tasks: [], name: null, summary: null });
    const res = await voiceCalls.sweepVoiceCalls(c, { transcriptsDir: dir, ...rec.deps });
    assert.equal(res.skipped, 1);
    assert.equal(rec.calls.length, 0, 'no model turn spent on a call nobody spoke in');
  });
});

test('facts and tasks land through the exact same writes a WhatsApp chapter uses', async () => {
  const u = await makeUser(db.pool, '+972590002002', { firstName: 'עמית' });
  writeCall('c.json', {
    user: u.id,
    messages: [
      { role: 'assistant', content: 'היי עמית, מה קורה?' },
      { role: 'user', content: 'אני צריך לחדש את הדרכון השבוע' },
      { role: 'assistant', content: 'רשמתי' },
    ],
  });
  const rec = recorder({
    facts: [{ category: 'plans', fact: 'צריך לחדש דרכון', importance: 1, expires_at: null }],
    tasks: [{ title: 'לחדש דרכון', subtasks: [] }],
    name: null,
    summary: 'דיברנו על חידוש הדרכון שלך — רשמתי את זה למשימות.',
  });
  await withClient(async (c) => {
    const res = await voiceCalls.sweepVoiceCalls(c, { transcriptsDir: dir, ...rec.deps });
    assert.deepEqual(res.processed, [Number(u.id)]);

    const { rows: factRows } = await c.query(
      `SELECT fact FROM user_facts WHERE user_id = $1 AND active`, [u.id]);
    assert.equal(factRows.length, 1);
    assert.match(factRows[0].fact, /דרכון/);

    const { rows: taskRows } = await c.query(
      `SELECT title, source FROM tasks WHERE owner_id = $1`, [u.id]);
    assert.equal(taskRows.length, 1);
    assert.equal(taskRows[0].source, 'extracted');

    const { rows: outboxRows } = await c.query(
      `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'voice_call_summary'`, [u.id]);
    assert.equal(outboxRows.length, 1);
    assert.match(outboxRows[0].payload.instruction, /חידוש הדרכון/);
  });
  // buildInstruction was asked to include the summary field for this call.
  assert.match(rec.calls[0].user, /SUMMARY/);
  assert.equal(fs.existsSync(path.join(dir, 'processed', 'c.json')), true);
});

test('trivial small talk records nothing and sends no recap', async () => {
  const u = await makeUser(db.pool, '+972590002003', { firstName: 'גל' });
  writeCall('d.json', {
    user: u.id,
    messages: [
      { role: 'assistant', content: 'היי, מה קורה?' },
      { role: 'user', content: 'סתם התקשרתי לבדוק שזה עובד' },
    ],
  });
  const rec = recorder({ facts: [], tasks: [], name: null, summary: null });
  await withClient(async (c) => {
    const res = await voiceCalls.sweepVoiceCalls(c, { transcriptsDir: dir, ...rec.deps });
    assert.deepEqual(res.processed, [Number(u.id)]);
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'voice_call_summary'`, [u.id]);
    assert.equal(rows[0].n, 0);
  });
});

test('an unparseable model reply fails the file and leaves it in place for retry', async () => {
  const u = await makeUser(db.pool, '+972590002004', { firstName: 'רון' });
  writeCall('e.json', { user: u.id, messages: [{ role: 'user', content: 'שלום' }] });
  await withClient(async (c) => {
    const res = await voiceCalls.sweepVoiceCalls(c, {
      transcriptsDir: dir,
      complete: () => ({ ok: true, text: 'not json', model: 'x', usage: {} }),
    });
    assert.equal(res.failed.length, 1);
    assert.equal(res.processed.length, 0);
  });
  assert.equal(fs.existsSync(path.join(dir, 'e.json')), true, 'left in place, not silently dropped');
  assert.equal(fs.existsSync(path.join(dir, 'processed', 'e.json')), false);
});

test('re-running after a successful process is a no-op — the file already moved', async () => {
  const u = await makeUser(db.pool, '+972590002005', { firstName: 'נועה' });
  writeCall('f.json', {
    user: u.id,
    messages: [{ role: 'user', content: 'תזכירי לי מחר לקנות חלב' }],
  });
  const rec = recorder({ facts: [], tasks: [], name: null, summary: 'תזכורת לקנות חלב נרשמה.' });
  await withClient(async (c) => {
    await voiceCalls.sweepVoiceCalls(c, { transcriptsDir: dir, ...rec.deps });
    const again = await voiceCalls.sweepVoiceCalls(c, { transcriptsDir: dir, ...rec.deps });
    assert.equal(again.considered, 0, 'the moved file is not seen again');
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'voice_call_summary'`, [u.id]);
    assert.equal(rows[0].n, 1, 'exactly one summary, not one per tick');
  });
});

test('a missing transcripts directory is a quiet no-op, not an error', async () => {
  await withClient(async (c) => {
    const res = await voiceCalls.sweepVoiceCalls(c, { transcriptsDir: path.join(dir, 'nope') });
    assert.equal(res.considered, 0);
    assert.equal(res.failed.length, 0);
  });
});

test('MAX_PER_TICK caps how many calls one tick processes', async () => {
  const u = await makeUser(db.pool, '+972590002006', { firstName: 'תום' });
  for (let i = 0; i < voiceCalls.MAX_PER_TICK + 2; i++) {
    writeCall(`g${i}.json`, { user: u.id, messages: [{ role: 'user', content: `שיחה ${i}` }] });
  }
  const rec = recorder({ facts: [], tasks: [], name: null, summary: null });
  await withClient(async (c) => {
    const res = await voiceCalls.sweepVoiceCalls(c, { transcriptsDir: dir, ...rec.deps });
    assert.equal(res.considered, voiceCalls.MAX_PER_TICK);
  });
});
