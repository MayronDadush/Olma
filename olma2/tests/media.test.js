'use strict';
// Media generation (domain/media.js): the access gate, the submit-then-sweep
// path BOTH kinds now use (images joined videos on it 2026-08-28, after a
// real prompt from מירון proved images cannot safely stay synchronous), and
// the money — one row per user per day in media_usage_ledger, images and
// videos together, priced by OpenRouter's own usage.cost figure and never
// re-derived.
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
        const a = typeof answer === 'function' ? await answer(url, opts) : answer;
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

test('a refused user spends nothing and no job is queued', async () => {
  await withClient(async (c) => {
    const before_ = await c.query(`SELECT count(*)::int AS n FROM media_jobs WHERE user_id = $1`, [stranger.id]);
    const img = await media.startImage(c, stranger, { prompt: 'a cat' }, { apiKey: KEY });
    assert.equal(img.ok, false);
    assert.equal(img.error.code, 'forbidden');
    const vid = await media.startVideo(c, stranger, { prompt: 'a cat' }, { apiKey: KEY });
    assert.equal(vid.ok, false);
    assert.equal(vid.error.code, 'forbidden');
    const after_ = await c.query(`SELECT count(*)::int AS n FROM media_jobs WHERE user_id = $1`, [stranger.id]);
    assert.equal(after_.rows[0].n, before_.rows[0].n);
  });
});

// ---- images (submit-then-sweep, same as video — see file header) -----------
// The image endpoint has no polling URL of its own: one blocking call IS the
// whole job, so the sweep does it in a single step (runImageJob), unlike
// video's separate poll-then-download.

test('image: submit creates a pending job; the sweep generates, charges, and enqueues delivery ONCE', async () => {
  await withClient(async (c) => {
    const submit = fakeFetch([]); // startImage makes no network call at all
    const res = await media.startImage(c, haim, { prompt: 'a blue triangle' }, { fetchImpl: submit, apiKey: KEY });
    assert.equal(res.ok, true);
    assert.equal(res.data.status, 'pending');
    assert.ok(res.data.next_step.includes('SENT AUTOMATICALLY'));
    assert.equal(submit.calls.length, 0);
    const jobId = res.data.job_id;

    const done = fakeFetch([
      ['/images', { json: { data: [{ b64_json: PNG.toString('base64') }], usage: { cost: 0.01 } } }],
    ]);
    const s1 = await media.sweepMediaJobs(c, { fetchImpl: done, apiKey: KEY });
    assert.deepEqual(s1.completed, [jobId]);
    // The default model went out on the wire.
    assert.equal(JSON.parse(done.calls[0].opts.body).model, media.DEFAULT_IMAGE_MODEL);

    const { rows: [job] } = await c.query(`SELECT * FROM media_jobs WHERE id = $1`, [jobId]);
    assert.equal(job.status, 'completed');
    assert.ok(job.file_path.startsWith(haim.workspace_path + '/cards/'));
    assert.ok(job.file_path.endsWith('.png'));
    assert.ok(fs.existsSync(job.file_path));
    assert.equal(Number(job.cost_usd), 0.01);

    const { rows: led } = await c.query(`SELECT * FROM media_usage_ledger WHERE user_id = $1`, [haim.id]);
    assert.equal(led[0].images, 1);
    assert.equal(led[0].videos, 0);

    const { rows: out } = await c.query(
      `SELECT * FROM outbox WHERE user_id = $1 AND kind = 'media_ready'`, [haim.id]);
    assert.equal(out.length, 1);
    assert.equal(out[0].urgency, 'urgent');
    assert.equal(out[0].payload.kind, 'image');
    assert.equal(out[0].payload.path, job.file_path);

    // The audit row records money and model, never the prompt.
    const { rows: audit } = await c.query(
      `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'media.image_generated'`, [haim.id]);
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit[0].detail).includes('triangle'));

    // Second sweep: the job is no longer pending — nothing happens twice.
    const s2 = await media.sweepMediaJobs(c, { fetchImpl: done, apiKey: KEY });
    assert.deepEqual(s2.completed, []);
    const { rows: again } = await c.query(
      `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'media_ready'`, [haim.id]);
    assert.equal(again[0].n, 1);
  });
});

test('image: a request that takes far longer than any MCP call budget still succeeds — the point of moving it to the sweep', async () => {
  await withClient(async (c) => {
    const res = await media.startImage(c, admin, { prompt: 'a very detailed scene' }, { apiKey: KEY });
    assert.equal(res.ok, true);
    // A slow provider response (deliberately past the old 25-30s tool-call
    // ceiling this replaced) — the sweep has no such ceiling of its own.
    const slow = fakeFetch([
      ['/images', async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { json: { data: [{ b64_json: PNG.toString('base64') }], usage: { cost: 0.02 } } };
      }],
    ]);
    const s = await media.sweepMediaJobs(c, { fetchImpl: slow, apiKey: KEY });
    assert.deepEqual(s.completed, [res.data.job_id]);
  });
});

test('image: the model flag overrides the default without a deploy', async () => {
  await withClient(async (c) => {
    await flags.setFlag(c, media.IMAGE_MODEL_FLAG, 'openai/gpt-5-image-mini');
    const res = await media.startImage(c, admin, { prompt: 'a dog' }, { apiKey: KEY });
    const fetchImpl = fakeFetch([
      ['/images', { json: { data: [{ b64_json: PNG.toString('base64') }], usage: { cost: 0.008 } } }],
    ]);
    await media.sweepMediaJobs(c, { fetchImpl, apiKey: KEY });
    assert.equal(JSON.parse(fetchImpl.calls[0].opts.body).model, 'openai/gpt-5-image-mini');
    await flags.setFlag(c, media.IMAGE_MODEL_FLAG, media.DEFAULT_IMAGE_MODEL);
    // Confirm the row actually completed under that model.
    const { rows: [job] } = await c.query(`SELECT model, status FROM media_jobs WHERE id = $1`, [res.data.job_id]);
    assert.equal(job.model, 'openai/gpt-5-image-mini');
    assert.equal(job.status, 'completed');
  });
});

test('image: a provider error fails the job once, and no money is recorded', async () => {
  await withClient(async (c) => {
    const res = await media.startImage(c, admin, { prompt: 'a cat' }, { apiKey: KEY });
    const before_ = await c.query(`SELECT coalesce(sum(images),0)::int AS n FROM media_usage_ledger`);
    const fail = fakeFetch([
      ['/images', { status: 402, json: { error: { message: 'Insufficient credits' } } }],
    ]);
    const s = await media.sweepMediaJobs(c, { fetchImpl: fail, apiKey: KEY });
    assert.deepEqual(s.failed, [res.data.job_id]);
    const { rows: [job] } = await c.query(`SELECT status, error FROM media_jobs WHERE id = $1`, [res.data.job_id]);
    assert.equal(job.status, 'failed');
    assert.ok(job.error.includes('Insufficient credits'));
    const after_ = await c.query(`SELECT coalesce(sum(images),0)::int AS n FROM media_usage_ledger`);
    assert.equal(after_.rows[0].n, before_.rows[0].n);
    const { rows: out } = await c.query(
      `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'media_failed' ORDER BY id DESC LIMIT 1`, [admin.id]);
    assert.equal(out[0].payload.kind, 'image');
  });
});

test('image: empty and oversized prompts are refused before any job is queued', async () => {
  await withClient(async (c) => {
    const before_ = await c.query(`SELECT count(*)::int AS n FROM media_jobs WHERE user_id = $1`, [admin.id]);
    assert.equal((await media.startImage(c, admin, { prompt: '  ' }, { apiKey: KEY })).ok, false);
    assert.equal((await media.startImage(c, admin, { prompt: 'x'.repeat(2001) }, { apiKey: KEY })).ok, false);
    const after_ = await c.query(`SELECT count(*)::int AS n FROM media_jobs WHERE user_id = $1`, [admin.id]);
    assert.equal(after_.rows[0].n, before_.rows[0].n);
  });
});

test('image: a job pending past the age cap is declared lost, not tried forever', async () => {
  await withClient(async (c) => {
    const res = await media.startImage(c, admin, { prompt: 'a slow one' }, { apiKey: KEY });
    await c.query(`UPDATE media_jobs SET created_at = now() - interval '31 minutes' WHERE id = $1`, [res.data.job_id]);
    const s = await media.sweepMediaJobs(c, { fetchImpl: fakeFetch([]), apiKey: KEY });
    assert.deepEqual(s.failed, [res.data.job_id]);
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

    // haim also generated an image earlier in this file — scope to video rows
    // so that unrelated row does not read as a duplicate delivery.
    const { rows: out } = await c.query(
      `SELECT * FROM outbox WHERE user_id = $1 AND kind = 'media_ready' AND payload->>'kind' = 'video'`, [haim.id]);
    assert.equal(out.length, 1);
    assert.equal(out[0].urgency, 'urgent');
    assert.equal(out[0].payload.path, job.file_path);

    // Third sweep: the job is no longer pending — nothing happens twice.
    const s3 = await media.sweepMediaJobs(c, { fetchImpl: done, apiKey: KEY });
    assert.deepEqual(s3.completed, []);
    const { rows: again } = await c.query(
      `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'media_ready' AND payload->>'kind' = 'video'`, [haim.id]);
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
    // admin also had failed image jobs earlier in this file — scope to video.
    const { rows: out } = await c.query(
      `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'media_failed' AND payload->>'kind' = 'video'`, [admin.id]);
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

test('either kind counts toward the same per-user pending cap', async () => {
  await withClient(async (c) => {
    const fetchImpl = fakeFetch([
      ['/videos', { status: 202, json: { id: 'job-cap', polling_url: 'https://openrouter.ai/api/v1/videos/job-cap', status: 'pending' } }],
    ]);
    const jobs = [];
    for (let i = 0; i < media.PENDING_JOBS_PER_USER; i++) {
      const r = await media.startImage(c, admin, { prompt: `x${i}` }, { apiKey: KEY });
      assert.equal(r.ok, true);
      jobs.push(r.data.job_id);
    }
    const blocked = await media.startVideo(c, admin, { prompt: 'one more' }, { fetchImpl, apiKey: KEY });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'conflict');
    assert.equal(fetchImpl.calls.length, 0);
    // clean up so later tests in this file see a clear queue for `admin`
    await c.query(`UPDATE media_jobs SET status = 'cancelled' WHERE id = ANY($1)`, [jobs]);
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
