-- Behavioral evals: nightly scripted conversations against a dedicated eval
-- user, judged in two layers (hard checks in code, text quality by a second
-- model). See src/evals/ for the harness and jobs/evals.js for the schedule.
--
-- users.is_eval marks the ONE synthetic user the harness talks to. Every
-- proactive sweep excludes it and the outbox gate drops its rows outright —
-- its phone number is fake, so a delivery attempt could only ever fail,
-- climb the retry counter, and trip the stuck-outbox alarm with noise.

ALTER TABLE users ADD COLUMN is_eval BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE eval_runs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger       TEXT NOT NULL DEFAULT 'nightly' CHECK (trigger IN ('nightly', 'manual')),
  agent_model   TEXT,          -- what the agent turns actually ran on
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  scenarios     INT NOT NULL DEFAULT 0,
  greens        INT NOT NULL DEFAULT 0,
  yellows       INT NOT NULL DEFAULT 0,
  reds          INT NOT NULL DEFAULT 0,
  errors        INT NOT NULL DEFAULT 0,
  note          TEXT
);

CREATE TABLE eval_results (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id        BIGINT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  scenario      TEXT NOT NULL,
  -- red    = a hard (deterministic) check failed: wrong tool calls, wrong DB state
  -- yellow = hard checks passed, the judge model flagged the text
  -- error  = the harness itself failed (turn died, judge unparseable) — never
  --          silently green: a broken checker that looks healthy is the
  --          /health-was-red-for-13-hours failure all over again
  status        TEXT NOT NULL CHECK (status IN ('green', 'yellow', 'red', 'error')),
  hard_failures JSONB NOT NULL DEFAULT '[]',
  judge         JSONB,         -- {verdict, problems:[{rule, quote}]} from the judge model
  reply         TEXT,          -- the agent's final reply text (last turn)
  duration_ms   INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The yellow-two-nights alert rule reads "this scenario's previous result".
CREATE INDEX eval_results_by_scenario ON eval_results (scenario, id DESC);
