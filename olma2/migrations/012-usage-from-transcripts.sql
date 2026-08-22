-- Cost accounting, rebuilt on the transcripts instead of the session index.
--
-- Migration 002 read `totalTokens` out of the gateway's sessions.json and
-- accumulated positive deltas, on the stated belief that the field is a
-- cumulative counter. It is not. Verified live 2026-08-20 against Anthropic's
-- own Cost page, which billed $4.57 for that day on the `openclaw` key while
-- our ledger reported cents:
--
--   * `totalTokens` is a GAUGE — the size of the current context, not a
--     lifetime total. Every session in the index sits at 26k-38k regardless of
--     how long the conversation ran. One real session (u-3, 9b199906) held 138
--     model calls and 5,690,328 billable tokens; its gauge read 58,892.
--   * `estimatedCostUsd` is derived from that same gauge, and each call's own
--     `usage.cost` block comes back all-zero from the gateway, so the number is
--     not a price at all.
--   * Sessions ROTATE. That $2.18 session no longer appears in sessions.json —
--     the WhatsApp session key now points at a newer sessionId. Its usage did
--     not just go unpriced, it became invisible, and the delta arithmetic saw
--     a shrink and re-baselined to zero.
--
-- The transcripts do carry the truth: every assistant message has a `usage`
-- block with input/output/cacheRead/cacheWrite. Summing those against the
-- published per-model rates reproduced Anthropic's $4.57 to within 2.4%.
--
-- So the snapshot table stops tracking a token total and starts tracking a
-- read position in the transcript file, which is a real high-water mark: the
-- file is append-only, so a byte offset can only move forward, and a re-run
-- attributes nothing twice.
ALTER TABLE usage_session_snapshots ADD COLUMN byte_offset BIGINT NOT NULL DEFAULT 0;
ALTER TABLE usage_session_snapshots ADD COLUMN transcript_path TEXT;

-- The rows written under the old, broken assumption are not worth keeping:
-- they are a gauge misread as a counter, and leaving them in place would mean
-- the corrected backfill adds real numbers on top of meaningless ones. The
-- offsets reset with them, so the next sweep re-reads every transcript from
-- the beginning and rebuilds the ledger from the source of truth.
DELETE FROM usage_session_snapshots;
DELETE FROM usage_ledger;

-- Agents `main` and `intake` are real cost with no user to attribute it to —
-- background sweeps, the intake greeter, the weekly cost report itself. They
-- were silently dropped before (the sweep skipped any agent id not starting
-- `u-`), which is part of why the total read low. usage_ledger cannot hold
-- them: user_id is in its primary key, and Postgres will not accept NULL there.
CREATE TABLE usage_system_ledger (
  agent_id           TEXT NOT NULL,
  date               DATE NOT NULL,
  model              TEXT NOT NULL DEFAULT '',
  input_tokens       BIGINT NOT NULL DEFAULT 0,
  output_tokens      BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(10,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, date, model)
);

-- Set when a model id has no entry in domain/model-pricing.js and the blended
-- fallback rate had to be used. A dashboard that cannot tell a real price from
-- a guess is how the last wrong number went unnoticed for a month.
ALTER TABLE usage_ledger ADD COLUMN estimated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE usage_system_ledger ADD COLUMN estimated BOOLEAN NOT NULL DEFAULT false;
