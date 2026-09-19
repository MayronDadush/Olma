-- The hand triage, made a feature. On 2026-09-19 the owner's own list was
-- sorted with him by hand — 38 open tasks down to 20 — and what made it work
-- was that every row arrived as ONE concrete proposal with its reason
-- attached, never as a report to read. So: one suggestion at a time, and
-- nothing at all when there is no honest one to make.
--
-- `dedup_key` is `<kind>:<the task ids, sorted>` and the unique index is what
-- makes "never ask the same thing twice" a property of the database rather
-- than of whichever query happens to generate next. A suggestion somebody
-- skipped is a decision, and re-asking would spend the one thing this feature
-- has (the assumption that it only speaks when it has something).
CREATE TABLE IF NOT EXISTS task_suggestions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT   NOT NULL,
  task_ids    BIGINT[] NOT NULL,
  dedup_key   TEXT   NOT NULL,
  detail      JSONB  NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ,
  decision    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS task_suggestions_once ON task_suggestions (user_id, dedup_key);
CREATE INDEX IF NOT EXISTS task_suggestions_live ON task_suggestions (user_id, id) WHERE decided_at IS NULL;

COMMENT ON COLUMN task_suggestions.kind IS 'stuck | overdue | duplicate';
COMMENT ON COLUMN task_suggestions.dedup_key IS 'kind + the task ids it is about; unique per person so nobody is asked the same thing twice';
COMMENT ON COLUMN task_suggestions.decision IS 'accepted | skipped | stale — stale means the tasks moved on before they answered';

-- When this person was last looked at. A row-less answer ("nothing to suggest
-- this week") has to be remembered too, or every page load re-runs the pass.
ALTER TABLE users ADD COLUMN IF NOT EXISTS suggested_at TIMESTAMPTZ;
COMMENT ON COLUMN users.suggested_at IS 'last time the suggestion pass ran for them, whether or not it found anything';
