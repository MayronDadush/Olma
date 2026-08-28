'use strict';
// Media generation (domain/media.js): the access gate, the synchronous image
// path, the submit-then-sweep video path, and the money — one row per user
// per day in media_usage_ledger, images and videos together, priced by
// OpenRouter's own usage.cost figure and never re-derived.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const media = require('../src/domain/media');
const flags = require('../src/domain/flags');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // enough to be bytes
const KEY = 'sk-or-test';

let db, admin, haim, stranger;
before(async () => {
  db = await freshDb();
  admin = await makeUser(db.pool, '+972526269826', { firstName: 'מירון' });
  haim = await makeUser(db.pool, '+972505404255', { firstName: 'חיים' });
  stranger = await makeUser(db.pool, '+972501111111', { firstName: 'זר' });
  const client = await db.pool.connect();
  try {
    await client.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
    admin.role = 'admin';
    // Give the two allowed users a real workspace to store files in.
    for (const u of [admin, haim]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-media-'));
      await client.query(`UPDATE users SET workspace_path = $2 WHERE id = $1`, [u.id, dir]);
      u.workspace_path = dir;
    }
  } finally { client.release(); }
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

// A fetch stub that answers by URL suffix and records every call it saw.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    for (const [suffix, answer] of routes) {
      if (String(url).includes(suffix)) {
        const a = typeof answer === 'function' ? answer(url, opts) : answer;
        return {
          ok: a.status ? a.status < 400 : true,
          status: a.status || 200,
          json: async () => a.json,
          arrayBuffer: async () => {
            const b = a.buf || PNG;
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          },
        };
      }
    }
    throw new Error('unexpected fetch: ' + url);
  };
  impl.calls = calls;
  return impl;
}

// ---- access ----------------------------------------------------------------

test('the gate: admin allowed, the allowlisted phone allowed, everyone else refused', async () => {
  await withClient(async (c) => {
    assert.equal((await media.requireMediaAccess(c, admin)).ok, true);
    assert.equal((await media.requireMediaAccess(c, haim)).ok, true);
    const no = await media.requireMediaAccess(c, stranger);
    assert.equal(no.ok, false);
    assert.equal(no.error.code, 'forbidden');
  });
});

test('the allowlist is a live flag, not a constant', async () => {
  await withClient(async (c) => {
    await flags.setFlag(c, media.ALLOWED_PHONES_FLAG, `${stranger.phone}, ${haim.phone}`);
    assert.equal((await media.requireMediaAccess(c, stranger)).ok, true);
    await flags.setFlag(c, media.ALLOWED_PHONES_FLAG, media.DEFAULT_ALLOWED_PHONES);
    assert.equal((await media.requireMediaAccess(c, stranger)).ok, false);
  });
});

test('a refused user spends nothing and no request leaves the box', async () => {
  await withClient(async (c) => {
    const fetchImpl = fakeFetch([]);
    const res = await media.generateImage(c, stranger, { prompt: 'a cat' }, { fetchImpl, apiKey: KEY });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'forbidden');
    assert.equal(fetchImpl.calls.length, 0);
  });
});

// ---- images ----------------------------------------------------------------

test('image: generated, stored in the workspace, and the cost is OpenRouter\'s own number', async () => {
  await withClient(async (c) => {
    const fetchImpl = fakeFetch([
      ['/images', { json: { data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.01 } } }],
    ]);
    const res = await media.generateImage(c, haim, { prompt: 'a blue triangle' }, { fetchImpl, apiKey: KEY });
    assert.equal(res.ok, true);
    assert.ok(res.data.path.startsWith(haim.workspace_path + '/cards/'));
    assert.ok(res.data.path.endsWith('.png'));
    assert.ok(fs.existsSync(res.data.path));
    assert.equal(res.data.cost_usd, 0.01);
    assert.ok(res.data.next_step.includes('MEDIA: ' + res.data.path));

    // The default model went out on the wire; the ledger got one image.
    const sent = JSON.parse(fetchImpl.calls[0].opts.body);
    assert.equal(sent.model, media.DEFAULT_IMAGE_MODEL);
    const { rows } = await c.query(
      `SELECT * FROM media_usage_ledger WHERE user_id = $1`, [haim.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].images, 1);
    assert.equal(rows[0].videos, 0);
    assert.equal(Number(rows[0].cost_usd), 0.01);

    // The audit row records money and model, never the prompt.
    const { rows: audit } = await c.query(
      `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'media.image_generated'`, [haim.id]);
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit[0].detail).includes('triangle'));
  });
});

test('image: the model flag overrides the default without a deploy', async () => {
  await withClient(async (c) => {
    await flags.setFlag(c, media.IMAGE_MODEL_FLAG, 'openai/gpt-5-image-mini');
    const fetchImpl = fakeFetch([
      ['/images', { json: { data: [{ b64_json: PNG.toString('base64') }], usage: { cost: 0.008 } } }],
    ]);
    const res = await media.generateImage(c, admin, { prompt: 'a dog' }, { fetchImpl, apiKey: KEY });
    assert.equal(res.ok, true);
    assert.equal(JSON.parse(fetchImpl.calls[0].opts.body).model, 'openai/gpt-5-image-mini');
    await flags.setFlag(c, media.IMAGE_MODEL_FLAG, media.DEFAULT_IMAGE_MODEL);
  });
});

test('image: a provider error is a clean refusal, and no money is recorded', async () => {
  await withClient(async (c) => {
    const fetchImpl = fakeFetch([
      ['/images', { status: 402, json: { error: { message: 'Insufficient credits' } } }],
    ]);
    const before_ = await c.query(`SELECT coalesce(sum(images),0)::int AS n FROM media_usage_ledger`);
    const res = await media.generateImage(c, admin, { prompt: 'a cat' }, { fetchImpl, apiKey: KEY });
    assert.equal(res.ok, false);
    assert.ok(res.error.message.includes('Insufficient credits'));
    const after_ = await c.query(`SELECT coalesce(sum(images),0)::int AS n FROM media_usage_ledger`);
    assert.equal(after_.rows[0].n, before_.rows[0].n);
  });
});

test('image: empty and oversized prompts are refused before any request', async () => {
  await withClient(async (c) => {
    const fetchImpl = fakeFetch([]);
    assert.equal((await media.generateImage(c, admin, { prompt: '  ' }, { fetchImpl, apiKey: KEY })).ok, false);
    assert.equal((await media.generateImage(c, admin, { prompt: 'x'.repeat(2001) }, { fetchImpl, apiKey: KEY })).ok, false);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

// ---- video ------------------------------------------------------------------

test('video: submit creates a pending job; the sweep downloads, charges, and enqueues delivery ONCE', async () => {
  await withClient(async (c) => {
    const fetchImpl = fakeFetch([
      ['/videos', { status: 202, json: { id: 'job-abc', polling_url: 'https://openrouter.ai/api/v1/videos/job-abc', status: 'pending' } }],
    ]);
    const res = await media.startVideo(c, haim, { prompt: 'a red ball bouncing', duration_seconds: 4 }, { fetchImpl, apiKey: KEY });
    assert.equal(res.ok, true);
    assert.equal(res.data.status, 'pending');
    assert.ok(res.data.next_step.includes('SENT AUTOMATICALLY'));
    const jobId = res.data.job_id;

    // First sweep: still rendering — nothing changes.
    const still = fakeFetch([
      ['/videos/job-abc', { json: { status: 'pending' } }],
    ]);
    const s1 = await media.sweepMediaJobs(c, { fetchImpl: still, apiKey: KEY });
    assert.deepEqual(s1.completed, []);

    // Second sweep: completed — file lands in the workspace, the ledger gets
    // OpenRouter's cost, and exactly one media_ready row exists.
    const mp4 = Buffer.from('0000001c66747970', 'hex');
    const done = fakeFetch([
      ['/content', { buf: mp4, json: {} }],
      ['/videos/job-abc', { json: { status: 'completed', unsigned_urls: ['https://openrouter.ai/api/v1/videos/job-abc/content?index=0'], usage: { cost: 0.054 } } }],
    ]);
    const s2 = await media.sweepMediaJobs(c, { fetchImpl: done, apiKey: KEY });
    assert.deepEqual(s2.completed, [jobId]);

    const { rows: [job] } = await c.query(`SELECT * FROM media_jobs WHERE id = $1`, [jobId]);
    assert.equal(job.status, 'completed');
    assert.ok(job.file_path.endsWith('.mp4'));
    assert.ok(fs.existsSync(job.file_path));
    assert.equal(Number(job.cost_usd), 0.054);

    const { rows: led } = await c.query(`SELECT * FROM media_usage_ledger WHERE user_id = $1`, [haim.id]);
    assert.equal(led[0].videos, 1);

    const { rows: out } = await c.query(
      `SELECT * FROM outbox WHERE user_id = $1 AND kind = 'media_ready'`, [haim.id]);
    assert.equal(out.length, 1);
    assert.equal(out[0].urgency, 'urgent');
    assert.equal(out[0].payload.path, job.file_path);

    // Third sweep: the job is no longer pending — nothing happens twice.
    const s3 = await media.sweepMediaJobs(c, { fetchImpl: done, apiKey: KEY });
    assert.deepEqual(s3.completed, []);
    const { rows: again } = await c.query(
      `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'media_ready'`, [haim.id]);
    assert.equal(again[0].n, 1);
  });
});

test('video: a failed generation tells the user once, and is never charged', async () => {
  await withClient(async (c) => {
    const submit = fakeFetch([
      ['/videos', { status: 202, json: { id: 'job-bad', polling_url: 'https://openrouter.ai/api/v1/videos/job-bad', status: 'pending' } }],
    ]);
    const res = await media.startVideo(c, admin, { prompt: 'impossible scene' }, { fetchImpl: submit, apiKey: KEY });
    assert.equal(res.ok, true);

    const fail = fakeFetch([
      ['/videos/job-bad', { json: { status: 'failed' } }],
    ]);
    const s = await media.sweepMediaJobs(c, { fetchImpl: fail, apiKey: KEY });
    assert.deepEqual(s.failed, [res.data.job_id]);

    const { rows: [job] } = await c.query(`SELECT * FROM media_jobs WHERE id = $1`, [res.data.job_id]);
    assert.equal(job.status, 'failed');
    const { rows: out } = await c.query(
      `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'media_failed'`, [admin.id]);
    assert.equal(out[0].n, 1);
    const { rows: led } = await c.query(
      `SELECT coalesce(sum(videos),0)::int AS n FROM media_usage_ledger WHERE user_id = $1`, [admin.id]);
    assert.equal(led[0].n, 0);
  });
});

test('video: a job pending past the age cap is declared lost, not polled forever', async () => {
  await withClient(async (c) => {
    const submit = fakeFetch([
      ['/videos', { status: 202, json: { id: 'job-old', polling_url: 'https://openrouter.ai/api/v1/videos/job-old', status: 'pending' } }],
    ]);
    const res = await media.startVideo(c, admin, { prompt: 'slow scene' }, { fetchImpl: submit, apiKey: KEY });
    await c.query(`UPDATE media_jobs SET created_at = now() - interval '31 minutes' WHERE id = $1`, [res.data.job_id]);
    const s = await media.sweepMediaJobs(c, { fetchImpl: fakeFetch([]), apiKey: KEY });
    assert.deepEqual(s.failed, [res.data.job_id]);
  });
});

test('video: parameters are validated before money moves', async () => {
  await withClient(async (c) => {
    const fetchImpl = fakeFetch([]);
    const deps = { fetchImpl, apiKey: KEY };
    assert.equal((await media.startVideo(c, admin, { prompt: 'x', duration_seconds: 3 }, deps)).ok, false);
    assert.equal((await media.startVideo(c, admin, { prompt: 'x', duration_seconds: 16 }, deps)).ok, false);
    assert.equal((await media.startVideo(c, admin, { prompt: 'x', duration_seconds: 4.5 }, deps)).ok, false);
    assert.equal((await media.startVideo(c, admin, { prompt: 'x', aspect_ratio: '2:1' }, deps)).ok, false);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('the ledger accumulates images and videos into ONE row per user per day', async () => {
  await withClient(async (c) => {
    await c.query(`DELETE FROM media_usage_ledger WHERE user_id = $1`, [stranger.id]);
    await media.recordMediaUsage(c, stranger.id, { images: 1, cost: 0.01 });
    await media.recordMediaUsage(c, stranger.id, { videos: 1, cost: 0.054 });
    await media.recordMediaUsage(c, stranger.id, { images: 1, cost: 0.01 });
    const { rows } = await c.query(`SELECT * FROM media_usage_ledger WHERE user_id = $1`, [stranger.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].images, 2);
    assert.equal(rows[0].videos, 1);
    assert.equal(Number(rows[0].cost_usd), 0.074);
  });
});
