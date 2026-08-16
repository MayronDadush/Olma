-- Olma 2.0 — initial schema.
-- Every table born with its retention/cleanup story (see audit_log.retention_class,
-- outbox.expires_at, task_reminders.cancelled_at). Source of truth is this
-- directory of numbered migrations, applied by src/db/migrate.js — never edit
-- an applied migration, add a new one.

-- ============================================================ users & identity

CREATE TABLE users (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone                 TEXT NOT NULL UNIQUE,          -- E.164
  first_name            TEXT,
  last_name             TEXT,
  role                  TEXT NOT NULL DEFAULT 'user'   CHECK (role IN ('admin','user')),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','blocked')),
  agent_id              TEXT UNIQUE,                   -- OpenClaw agent (u-<id>)
  workspace_path        TEXT,
  timezone              TEXT,
  timezone_confirmed    BOOLEAN NOT NULL DEFAULT FALSE,
  name_confirmed        BOOLEAN NOT NULL DEFAULT FALSE,
  locale                TEXT NOT NULL DEFAULT 'he',
  identity_token        TEXT UNIQUE,                   -- olma_tok_<hex>, workspace-file root of trust
  onboarded_at          TIMESTAMPTZ,
  digest_times          TEXT,                          -- same format as v1 ("08:00,20:00")
  digest_scope          TEXT NOT NULL DEFAULT 'summary', -- summary | full | today
  checkin_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  last_checkin_at       TIMESTAMPTZ,
  checkin_misses        INTEGER NOT NULL DEFAULT 0,
  invited_by_connection_id BIGINT,                     -- FK added below (circular)
  quota_override_daily  INTEGER,                       -- admin per-user override, NULL = plan default
  quota_blocked_until   TIMESTAMPTZ,                   -- NULL = not blocked
  quota_notice_sent_at  TIMESTAMPTZ,                   -- one today-view notice per block window
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Channel identities. Today one whatsapp row per user; the schema is what lets
-- a future iMessage/Telegram identity join the same user_id without migration.
CREATE TABLE user_channels (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_type       TEXT NOT NULL DEFAULT 'whatsapp',
  channel_identifier TEXT NOT NULL,                    -- phone for whatsapp
  is_primary         BOOLEAN NOT NULL DEFAULT TRUE,    -- proactive sends go here
  linked_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_type, channel_identifier)
);
CREATE UNIQUE INDEX user_channels_one_primary ON user_channels (user_id) WHERE is_primary;

-- Learned preferences — structured, replaces the AGENTS.md markdown block.
-- Availability windows ("don't ping before 10") live here too; the delivery
-- gate reads them, global 9-20 is only the fallback.
CREATE TABLE user_preferences (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  learned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE entitlements (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan        TEXT NOT NULL DEFAULT 'free',
  status      TEXT NOT NULL DEFAULT 'active',
  valid_until TIMESTAMPTZ
);

-- ============================================================ tasks & reminders

CREATE TABLE tasks (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id         BIGINT REFERENCES tasks(id) ON DELETE CASCADE, -- one level only, enforced in code
  title             TEXT NOT NULL,
  category          TEXT,
  source            TEXT NOT NULL DEFAULT 'chat',
  due_at            TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  include_in_digest BOOLEAN NOT NULL DEFAULT TRUE,
  completed_at      TIMESTAMPTZ,
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tasks_owner_status ON tasks (owner_id, status) WHERE archived_at IS NULL;
CREATE INDEX tasks_parent ON tasks (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX tasks_due ON tasks (due_at) WHERE status = 'open' AND due_at IS NOT NULL;

-- A reminder always belongs to a task; several per task allowed.
-- Completing the task auto-cancels pending reminders (cancelled_at).
CREATE TABLE task_reminders (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id      BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  remind_at    TIMESTAMPTZ NOT NULL,
  repeat_rule  TEXT,
  sent_at      TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX task_reminders_due ON task_reminders (remind_at)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;

-- ============================================================ connections & grants

CREATE TABLE connections (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requester_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id       BIGINT REFERENCES users(id) ON DELETE CASCADE,  -- NULL until target joins
  target_phone    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('invited','pending_target','active','declined','revoked')),
  invite_reason   TEXT,       -- the concrete "why" shown in the stranger intro message
  invite_message  TEXT,
  requester_label TEXT,       -- private nicknames, one per side, independent
  target_label    TEXT,
  invited_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at    TIMESTAMPTZ
);
-- one live connection per (requester, phone); dead rows don't block a retry
CREATE UNIQUE INDEX connections_live_pair ON connections (requester_id, target_phone)
  WHERE status IN ('invited','pending_target','active');
CREATE INDEX connections_target ON connections (target_id) WHERE target_id IS NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_invited_by_fk
  FOREIGN KEY (invited_by_connection_id) REFERENCES connections(id) ON DELETE SET NULL;

-- Per-side, per-feature opt-in on top of a connection. Row present = granted.
-- Feature names validated in code (KNOWN_CONNECTION_FEATURES), not a CHECK —
-- adding a category must not need a migration.
CREATE TABLE connection_feature_grants (
  connection_id BIGINT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  grantor_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature       TEXT NOT NULL,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, grantor_id, feature)
);

-- ============================================================ shares (per-task only)

CREATE TABLE shares (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connection_id BIGINT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  owner_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewer_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id       BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer','editor')),
  status        TEXT NOT NULL CHECK (status IN ('pending_viewer','pending_owner','active','declined','revoked')),
  requested_by  BIGINT NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX shares_live_pair ON shares (task_id, viewer_id)
  WHERE status IN ('pending_viewer','pending_owner','active');
CREATE INDEX shares_viewer ON shares (viewer_id) WHERE status = 'active';

-- ============================================================ meetings

CREATE TABLE meetings (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  initiator_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT,
  status         TEXT NOT NULL DEFAULT 'negotiating'
                 CHECK (status IN ('negotiating','confirmed','no_match','cancelled')),
  proposed_slot  TEXT,   -- freeform: date+time+medium as one package
  confirmed_slot TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ
);

CREATE TABLE meeting_participants (
  meeting_id  BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'awaiting'
              CHECK (state IN ('awaiting','confirmed_current','declined_current','opted_out')),
  constraints JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (meeting_id, user_id)
);
CREATE INDEX meeting_participants_awaiting ON meeting_participants (user_id) WHERE state = 'awaiting';

-- ============================================================ issues (bugs/requests/friction)

CREATE TABLE issues (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category            TEXT NOT NULL CHECK (category IN ('bug','edge_case','feature_request','friction')),
  source              TEXT NOT NULL CHECK (source IN ('user_reported','agent_detected')),
  reporter_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  related_entity_type TEXT,
  related_entity_id   BIGINT,
  title               TEXT NOT NULL,
  detail              TEXT,
  status              TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','triaged','fixed','wontfix')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX issues_open ON issues (status, created_at) WHERE status IN ('new','triaged');

-- ============================================================ audit & analytics

-- General activity journal, not just cross-user privacy events.
-- retention_class: 'permanent' (consent/privacy: share.*, connection.*) kept forever;
-- 'routine' (task.created, meeting.slot_proposed...) cleaned after months.
CREATE TABLE audit_log (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id        BIGINT,
  event           TEXT NOT NULL,
  detail          JSONB,
  retention_class TEXT NOT NULL DEFAULT 'routine' CHECK (retention_class IN ('permanent','routine')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_actor ON audit_log (actor_id, created_at);
CREATE INDEX audit_log_event ON audit_log (event, created_at);
CREATE INDEX audit_log_retention ON audit_log (retention_class, created_at);

-- Nightly rollup from Anthropic usage report, keyed by the per-user agent_id.
CREATE TABLE usage_ledger (
  user_id            BIGINT REFERENCES users(id) ON DELETE CASCADE,
  date               DATE NOT NULL,
  model              TEXT NOT NULL DEFAULT '',
  input_tokens       BIGINT NOT NULL DEFAULT 0,
  output_tokens      BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(10,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date, model)
);

-- Nightly rollup from audit_log — product analytics, separate from cost.
CREATE TABLE product_metrics_daily (
  date   DATE NOT NULL,
  metric TEXT NOT NULL,
  value  NUMERIC NOT NULL,
  PRIMARY KEY (date, metric)
);

-- ============================================================ outbox (respectful delivery)

-- Every proactive message is a row here first; nothing sends directly.
-- The gate/worker drains it: personal availability window, block state,
-- soft daily budget (urgent bypasses), expiry ("עבר זמנה").
CREATE TABLE outbox (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,           -- meeting_update | connection_invite | digest | checkin | unblock_summary | reminder | ...
  payload         JSONB NOT NULL DEFAULT '{}',
  urgency         TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('urgent','normal')),
  hold_reason     TEXT,                    -- night | blocked | budget
  release_after   TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,             -- past this, delivered as stale note, not a live reminder
  idempotency_key TEXT UNIQUE,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox (user_id, created_at) WHERE sent_at IS NULL;
CREATE INDEX outbox_releasable ON outbox (release_after) WHERE sent_at IS NULL;

-- ============================================================ quota

-- Real-time message counting (the daily/hourly quota). Flood protection
-- (N per minute) lives in brokerd memory, deliberately NOT here.
CREATE TABLE quota_counters (
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  window_kind  TEXT NOT NULL CHECK (window_kind IN ('day','hour')),
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, window_kind, window_start)
);

-- ============================================================ platform

CREATE TABLE feature_flags (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO feature_flags (key, value) VALUES ('registration_open', 'true');

-- Strangers arriving while registration is closed. notified_at is set when the
-- reopen message actually went out (through the outbox, respectfully).
CREATE TABLE waitlist (
  phone       TEXT PRIMARY KEY,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ
);

CREATE TABLE job_heartbeats (
  job_name   TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ,
  last_ok_at  TIMESTAMPTZ,
  note        TEXT
);

CREATE TABLE integrations (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'connected',
  scopes     TEXT,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

-- ============================================================ user dashboard auth

-- Single-use, short-lived magic links; a used link opens a persistent session.
CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,             -- sha256 of the token, never the token itself
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

CREATE TABLE dashboard_sessions (
  id           TEXT PRIMARY KEY,           -- random 256-bit
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
