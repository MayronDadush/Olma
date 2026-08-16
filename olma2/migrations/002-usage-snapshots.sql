-- Cost attribution pipeline. OpenClaw exposes cumulative token totals per
-- session (verified live: sessions list --json carries agentId/model/
-- totalTokens); we snapshot those and accumulate positive deltas into
-- usage_ledger. This is an attribution estimate per user — the org-level
-- Anthropic report remains the billing truth for the system total.

CREATE TABLE usage_session_snapshots (
  session_id   TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  model        TEXT NOT NULL DEFAULT '',
  total_tokens BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE usage_ledger ADD COLUMN total_tokens BIGINT NOT NULL DEFAULT 0;
