'use strict';
// Image and video generation through OpenRouter — access-limited by design.
//
// The owner's ask (2026-08-28): only admins and one named phone number may
// generate media, and the spend must land in its own visible column. So three
// rules live here and nowhere else:
//
//   * The SERVER is the gate. Every agent sees the tool schemas (tool listing
//     is global), so the refusal happens on the call, keyed to role + an
//     admin-editable phone allowlist — never to anything the model asserts.
//   * Cost is recorded from OpenRouter's own number. Unlike token arithmetic
//     (domain/model-pricing.js), every media response carries an authoritative
//     `usage.cost` in USD — verified live: image $0.01, 4s video $0.054. We
//     write that figure down, we never re-derive it.
//   * Files land in the requester's workspace (card-store), because the
//     workspace IS the outbound-media security boundary — same reasoning as
//     schedule cards: the gateway only attaches what the agent's own
//     allow-list can read, so a leaked path sends nothing.
//
// Images are synchronous (~7s measured, inside the 30s MCP call budget).
// Video takes 1-2 minutes, so generate_video SUBMITS and returns; the minute
// sweep polls, downloads, and enqueues the delivery. Both models are feature
// flags, so a better/cheaper model is a dashboard edit, not a deploy.
const { ok, err } = require('./results');
const flags = require('./flags');
const audit = require('./audit');
const cardStore = require('./card-store');
const { enqueue } = require('../outbox/enqueue');

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// Flags (all dashboard-editable). The phone list is comma-separated text —
// role='admin' users are allowed regardless of the list.
const IMAGE_MODEL_FLAG = 'media_image_model';
const VIDEO_MODEL_FLAG = 'media_video_model';
const ALLOWED_PHONES_FLAG = 'media_gen_phones';
const DEFAULT_IMAGE_MODEL = 'meta/muse-image';
const DEFAULT_VIDEO_MODEL = 'bytedance/seedance-2.0-mini';
const DEFAULT_ALLOWED_PHONES = '+972505404255';

const MAX_PROMPT_CHARS = 2000;
// The MCP shim aborts the whole tool call at 30s (bin/olma-mcp.js
// CALL_TIMEOUT_MS) — a ceiling this file cannot move without touching every
// tool. 25s was too tight a margin: מירון's first real request ("horse riding
// a horse", 2026-08-28) hit it and errored, while replaying the identical
// prompt moments later took 11.1s — real latency variance on the provider
// side, not a broken prompt. 27s leaves ~3s for the socket round-trip + two
// small DB writes, which measured well under 200ms; it narrows the window
// without touching the 30s ceiling itself.
const IMAGE_TIMEOUT_MS = 27_000;
const POLL_TIMEOUT_MS = 15_000;    // sweep-side fetches must not stall the minute tick
const JOB_MAX_AGE_MIN = 30;        // a job pending this long is declared lost
const PENDING_JOBS_PER_USER = 3;   // no fire-and-forget queue spam

// Validated against the live model listing 2026-08-28
// (GET /api/v1/videos/models → supported_durations / supported_resolutions).
const VIDEO_DURATIONS_S = { min: 4, max: 15, default: 5 };
const VIDEO_RESOLUTIONS = ['480p', '720p'];
const VIDEO_ASPECTS = ['1:1', '3:4', '9:16', '4:3', '16:9', '21:9', '9:21'];

function apiKey() {
  return process.env.OPENROUTER_API_KEY || null;
}

async function fetchWithTimeout(fetchImpl, url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- access -----------------------------------------------------------------
async function requireMediaAccess(client, user) {
  if (user.role === 'admin') return ok({ via: 'admin' });
  const raw = (await flags.getFlag(client, ALLOWED_PHONES_FLAG)) ?? DEFAULT_ALLOWED_PHONES;
  const allowed = String(raw).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (allowed.includes(user.phone)) return ok({ via: 'allowlist' });
  return err('forbidden',
    'media generation is not enabled for this user — do not offer it again, and do not suggest asking for access');
}

function badPrompt(prompt) {
  const p = String(prompt || '').trim();
  if (!p) return err('invalid', 'prompt is required');
  if (p.length > MAX_PROMPT_CHARS) {
    return err('invalid', `prompt too long (${p.length} > ${MAX_PROMPT_CHARS} chars)`);
  }
  return null;
}

// ---- the money --------------------------------------------------------------
// One row per user per day, images and videos together — the "separate
// column" the owner asked for. Cost is OpenRouter's own usage.cost, summed.
async function recordMediaUsage(client, userId, { images = 0, videos = 0, cost = 0 }) {
  await client.query(
    `INSERT INTO media_usage_ledger (user_id, date, images, videos, cost_usd)
     VALUES ($1, (now() at time zone 'utc')::date, $2, $3, $4)
     ON CONFLICT (user_id, date) DO UPDATE SET
       images = media_usage_ledger.images + $2,
       videos = media_usage_ledger.videos + $3,
       cost_usd = media_usage_ledger.cost_usd + $4`,
    [userId, images, videos, Number(cost || 0).toFixed(4)]
  );
}

// ---- images (synchronous) ---------------------------------------------------
async function generateImage(client, user, { prompt } = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const access = await requireMediaAccess(client, user);
  if (!access.ok) return access;
  const bad = badPrompt(prompt);
  if (bad) return bad;
  const key = deps.apiKey || apiKey();
  if (!key) return err('conflict', 'no OPENROUTER_API_KEY configured on the server');

  const model = String((await flags.getFlag(client, IMAGE_MODEL_FLAG)) || DEFAULT_IMAGE_MODEL);
  let res, body;
  try {
    res = await fetchWithTimeout(fetchImpl, `${OPENROUTER_BASE}/images`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: String(prompt).trim(), n: 1, output_format: 'png' }),
    }, deps.timeoutMs || IMAGE_TIMEOUT_MS);
    body = await res.json().catch(() => null);
  } catch (e) {
    return err('conflict', e.name === 'AbortError'
      ? 'image generation timed out — tell the user it did not work this time'
      : `image generation failed: ${String(e.message).slice(0, 120)}`);
  }
  const item = body && Array.isArray(body.data) && body.data[0];
  if (!res.ok || !item || !item.b64_json) {
    const msg = body && body.error && body.error.message ? body.error.message : `http ${res.status}`;
    return err('conflict', `image generation failed: ${String(msg).slice(0, 200)}`);
  }

  const png = Buffer.from(item.b64_json, 'base64');
  const saved = cardStore.saveMedia(user, png, 'png');
  if (!saved.ok) return saved;

  const cost = Number(body.usage && body.usage.cost) || 0;
  await recordMediaUsage(client, user.id, { images: 1, cost });
  // Model + cost, never the prompt — the ledger is about money, not content.
  await audit.record(client, user.id, 'media.image_generated', { model, costUsd: cost, bytes: png.length });

  return ok({
    path: saved.data.path,
    model,
    cost_usd: cost,
    next_step: 'Reply with one short sentence in the user\'s language, then "MEDIA: '
      + saved.data.path + '" on its own line. Do not describe the image at length — it speaks for itself.',
  });
}

// ---- video (submit now, deliver from the sweep) -----------------------------
async function startVideo(client, user, { prompt, duration_seconds, resolution, aspect_ratio } = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const access = await requireMediaAccess(client, user);
  if (!access.ok) return access;
  const bad = badPrompt(prompt);
  if (bad) return bad;
  const key = deps.apiKey || apiKey();
  if (!key) return err('conflict', 'no OPENROUTER_API_KEY configured on the server');

  const duration = duration_seconds == null ? VIDEO_DURATIONS_S.default : Number(duration_seconds);
  if (!Number.isInteger(duration) || duration < VIDEO_DURATIONS_S.min || duration > VIDEO_DURATIONS_S.max) {
    return err('invalid', `duration_seconds must be an integer ${VIDEO_DURATIONS_S.min}-${VIDEO_DURATIONS_S.max}`);
  }
  const reso = resolution || '720p';
  if (!VIDEO_RESOLUTIONS.includes(reso)) {
    return err('invalid', `resolution must be one of: ${VIDEO_RESOLUTIONS.join(', ')}`);
  }
  const aspect = aspect_ratio || '16:9';
  if (!VIDEO_ASPECTS.includes(aspect)) {
    return err('invalid', `aspect_ratio must be one of: ${VIDEO_ASPECTS.join(', ')}`);
  }

  // A user with several videos already cooking is either confused or looping —
  // refuse rather than queue money.
  const { rows: pend } = await client.query(
    `SELECT count(*)::int AS n FROM media_jobs WHERE user_id = $1 AND status = 'pending'`, [user.id]);
  if (pend[0].n >= PENDING_JOBS_PER_USER) {
    return err('conflict', 'several videos are already being generated for this user — wait for them to arrive first');
  }

  const model = String((await flags.getFlag(client, VIDEO_MODEL_FLAG)) || DEFAULT_VIDEO_MODEL);
  let res, body;
  try {
    res = await fetchWithTimeout(fetchImpl, `${OPENROUTER_BASE}/videos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model, prompt: String(prompt).trim(),
        duration, resolution: reso, aspect_ratio: aspect,
      }),
    }, deps.timeoutMs || POLL_TIMEOUT_MS);
    body = await res.json().catch(() => null);
  } catch (e) {
    return err('conflict', `video submission failed: ${String(e.message).slice(0, 120)}`);
  }
  if (!res.ok || !body || !body.id) {
    const msg = body && body.error && body.error.message ? body.error.message : `http ${res.status}`;
    return err('conflict', `video submission failed: ${String(msg).slice(0, 200)}`);
  }

  const { rows } = await client.query(
    `INSERT INTO media_jobs (user_id, kind, model, prompt, provider_job_id, polling_url)
     VALUES ($1, 'video', $2, $3, $4, $5) RETURNING id`,
    [user.id, model, String(prompt).trim().slice(0, 500), String(body.id),
      body.polling_url || `${OPENROUTER_BASE}/videos/${body.id}`]
  );
  await audit.record(client, user.id, 'media.video_started', { model, jobId: rows[0].id });

  return ok({
    job_id: Number(rows[0].id),
    status: 'pending',
    next_step: 'The video is being generated (usually 1-2 minutes) and will be SENT AUTOMATICALLY '
      + 'as a separate message when ready — tell the user it is on its way, and do NOT wait, '
      + 'poll, or call this tool again for the same request.',
  });
}

// ---- the sweep half ---------------------------------------------------------
// Rides the existing minute tick (no new sweeper — house rule). Each job is
// handled in its own try/catch: one poisoned row must never silence the rest
// (the outbox backoff outage, 2026-08-24, is the scar this line comes from).
async function sweepMediaJobs(client, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const key = deps.apiKey || apiKey();
  const out = { completed: [], failed: [], errored: [] };
  const { rows: jobs } = await client.query(
    `SELECT j.*, u.workspace_path FROM media_jobs j JOIN users u ON u.id = j.user_id
     WHERE j.status = 'pending' ORDER BY j.created_at LIMIT 10`);
  if (!jobs.length) return out;
  if (!key) { out.errored.push('no OPENROUTER_API_KEY'); return out; }

  for (const job of jobs) {
    try {
      const ageMin = (Date.now() - new Date(job.created_at).getTime()) / 60_000;
      if (ageMin > JOB_MAX_AGE_MIN) {
        await failJob(client, job, 'timed out after 30 minutes', out);
        continue;
      }
      const res = await fetchWithTimeout(fetchImpl, job.polling_url,
        { headers: { authorization: `Bearer ${key}` } }, POLL_TIMEOUT_MS);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) continue; // transient — next tick retries
      if (body.status === 'pending' || body.status === 'processing') continue;
      if (body.status !== 'completed') {
        await failJob(client, job, `provider status: ${body.status}`, out);
        continue;
      }

      const url = Array.isArray(body.unsigned_urls) && body.unsigned_urls[0];
      if (!url) { await failJob(client, job, 'completed but no download url', out); continue; }
      const dl = await fetchWithTimeout(fetchImpl, url,
        { headers: { authorization: `Bearer ${key}` } }, 60_000);
      if (!dl.ok) continue; // transient — retry next tick
      const buf = Buffer.from(await dl.arrayBuffer());

      const saved = cardStore.saveMedia({ workspace_path: job.workspace_path }, buf, 'mp4');
      if (!saved.ok) { await failJob(client, job, saved.error.message, out); continue; }

      const cost = Number(body.usage && body.usage.cost) || 0;
      // The status guard makes double-processing impossible even if two ticks
      // ever raced: only one UPDATE can move a row out of 'pending'.
      const { rowCount } = await client.query(
        `UPDATE media_jobs SET status = 'completed', file_path = $2, cost_usd = $3, updated_at = now()
         WHERE id = $1 AND status = 'pending'`, [job.id, saved.data.path, cost.toFixed(4)]);
      if (!rowCount) continue;
      await recordMediaUsage(client, job.user_id, { videos: 1, cost });
      await audit.record(client, job.user_id, 'media.video_generated',
        { model: job.model, costUsd: cost, bytes: buf.length, jobId: Number(job.id) });
      await enqueue(client, {
        userId: job.user_id, kind: 'media_ready', urgency: 'urgent',
        payload: { kind: 'video', path: saved.data.path, prompt: String(job.prompt).slice(0, 200) },
        idempotencyKey: `mediajob:${job.id}`,
      });
      out.completed.push(Number(job.id));
    } catch (e) {
      out.errored.push(`${job.id}: ${String(e.message).slice(0, 80)}`);
    }
  }
  return out;
}

async function failJob(client, job, reason, out) {
  const { rowCount } = await client.query(
    `UPDATE media_jobs SET status = 'failed', error = $2, updated_at = now()
     WHERE id = $1 AND status = 'pending'`, [job.id, String(reason).slice(0, 300)]);
  if (!rowCount) return;
  await enqueue(client, {
    userId: job.user_id, kind: 'media_failed', urgency: 'normal',
    payload: { kind: 'video', prompt: String(job.prompt).slice(0, 200) },
    idempotencyKey: `mediajob:${job.id}`,
  });
  out.failed.push(Number(job.id));
}

module.exports = {
  requireMediaAccess, generateImage, startVideo, sweepMediaJobs, recordMediaUsage,
  IMAGE_MODEL_FLAG, VIDEO_MODEL_FLAG, ALLOWED_PHONES_FLAG,
  DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, DEFAULT_ALLOWED_PHONES,
  VIDEO_DURATIONS_S, VIDEO_RESOLUTIONS, VIDEO_ASPECTS, JOB_MAX_AGE_MIN,
};
