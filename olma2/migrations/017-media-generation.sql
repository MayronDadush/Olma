-- Media generation (images + video) through OpenRouter, access-limited.
--
-- Two tables because the two facts have different lifetimes:
--
-- media_jobs is the async half. An image comes back in ~7s inside the tool
-- call; a video takes 1-2 minutes, far past the 30s MCP call timeout — so the
-- tool SUBMITS and returns, and the minute sweep polls OpenRouter, downloads
-- the file into the requester's workspace, and enqueues the delivery. The row
-- is the handoff between those two moments; without it a brokerd restart
-- mid-generation would orphan a video that was already paid for.
--
-- media_usage_ledger is the money. The owner asked for image+video spend in
-- its own column, visible, and it deliberately does NOT ride usage_ledger:
-- that table's rows are token arithmetic priced by our own table and
-- reconciled against Anthropic's bill, while media cost arrives as an
-- authoritative USD figure from OpenRouter itself (usage.cost on every
-- response — verified live 2026-08-28). Mixing the two would poison the
-- reconciliation line that exists to catch exactly this kind of confusion.
CREATE TABLE media_jobs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('video')),
  model           TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  provider_job_id TEXT NOT NULL,
  polling_url     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','completed','failed','expired','cancelled')),
  file_path       TEXT,
  cost_usd        NUMERIC(10,4),
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX media_jobs_pending ON media_jobs (created_at) WHERE status = 'pending';

CREATE TABLE media_usage_ledger (
  user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date     DATE NOT NULL,
  images   INT NOT NULL DEFAULT 0,
  videos   INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);
