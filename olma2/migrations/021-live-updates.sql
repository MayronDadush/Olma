-- Live updates ("עדכן אותי על..."): a user subscribes to a structured,
-- API-backed source of live information and gets a proactive message on a
-- cadence they chose. The design constraint, stated by the owner up front:
-- SMART sources, not web crawling — every source is a deterministic fetch of
-- a structured feed (a catalog API, a weather API), diffed/shaped in code,
-- with one cheap background-model call to write the human summary ONLY when
-- there is something new to say. Detection costs zero tokens by construction.
--
-- The source registry lives in code (domain/live-updates.js KNOWN sources —
-- same reasoning as KNOWN_CONNECTION_FEATURES: adding a source is a code
-- change, not a migration), so `source` carries no CHECK.
--
-- last_state is the per-subscription watermark (e.g. the set of OpenRouter
-- model ids already seen). The first run only establishes it — a brand-new
-- subscription must not open with "460 new models".
CREATE TABLE live_subscriptions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  params       JSONB NOT NULL DEFAULT '{}',
  cadence      TEXT NOT NULL DEFAULT 'daily' CHECK (cadence IN ('daily', 'weekly')),
  local_hour   INT NOT NULL DEFAULT 9 CHECK (local_hour BETWEEN 0 AND 23),
  next_run_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at  TIMESTAMPTZ,
  last_state   JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ
);
CREATE INDEX live_subscriptions_due ON live_subscriptions (next_run_at) WHERE cancelled_at IS NULL;
