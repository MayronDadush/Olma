-- Images join videos on the submit-then-sweep path.
--
-- 017 assumed images were fast enough to stay synchronous inside the tool
-- call ("~7s, fits the 30s MCP budget"). Wrong, disproven live 2026-08-28:
-- מירון's first real prompt ("horse riding a horse") timed out at 25s, and
-- raising the margin to 27s just moved the failure — a direct, unbounded
-- call to OpenRouter for the SAME prompt took 29.4s. The model does not
-- render a fixed-size image; it decides how much detail to spend per
-- request (389 image_tokens for a plain triangle, 3052 for that prompt, at
-- a measured, consistent ~104 tokens/sec either way) — so no fetch timeout
-- under the 30s MCP ceiling can safely absorb every legitimate prompt.
--
-- OpenRouter's image endpoint has no job id or polling URL of its own (it is
-- one blocking HTTP call, unlike /videos), so provider_job_id/polling_url do
-- not apply to an image row — nullable, and NULL for kind='image'. The sweep
-- makes the actual (now unbounded) blocking call itself; sweeps already do
-- exactly this kind of slow network I/O for video polling and download, so
-- this is not a new category of risk, just the same one image now shares.
ALTER TABLE media_jobs DROP CONSTRAINT media_jobs_kind_check;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_kind_check CHECK (kind IN ('image','video'));
ALTER TABLE media_jobs ALTER COLUMN provider_job_id DROP NOT NULL;
ALTER TABLE media_jobs ALTER COLUMN polling_url DROP NOT NULL;
