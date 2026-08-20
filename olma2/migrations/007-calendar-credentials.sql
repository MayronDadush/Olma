-- Google Calendar, restored. The v1→v2 cutover left the integrations behind:
-- v2 shipped an `integrations` table with no credential columns and no
-- `oauth_states` at all, so the redirect URI Google is configured to send
-- users to had nowhere to land.
--
-- Secrets are AES-256-GCM blobs, never plaintext: possessing a database dump
-- (one lands in /root/backups nightly) must not be enough to read anyone's
-- Google tokens. The key lives outside the DB in a root-only file.

-- access_level is deliberately SEPARATE from `scopes`. We need both halves:
-- what the user asked for, and the raw scope string Google actually granted.
-- They diverge whenever someone narrows the grant on the consent screen, and
-- collapsing them into one column makes that case unrepresentable — which is
-- precisely the case where getting it wrong means writing to a calendar
-- somebody only agreed to let us read.
ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS credential_enc  TEXT,
  ADD COLUMN IF NOT EXISTS refresh_enc     TEXT,
  ADD COLUMN IF NOT EXISTS expires_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS account_label   TEXT,
  ADD COLUMN IF NOT EXISTS connected_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_refresh_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error      TEXT,
  ADD COLUMN IF NOT EXISTS access_level    TEXT;

-- `status` shipped as a bare TEXT DEFAULT 'connected' with no constraint. The
-- table has no rows yet, so pinning the vocabulary costs nothing today and
-- would cost a data migration later. 'needs_reauth' is the state a revoked or
-- expired grant lands in — without a name for it, a dead connection is
-- indistinguishable from a working one until a tool call fails.
ALTER TABLE integrations
  DROP CONSTRAINT IF EXISTS integrations_status_check;
ALTER TABLE integrations
  ADD CONSTRAINT integrations_status_check
  CHECK (status IN ('connected', 'needs_reauth', 'disconnected'));

ALTER TABLE integrations
  DROP CONSTRAINT IF EXISTS integrations_access_level_check;
ALTER TABLE integrations
  ADD CONSTRAINT integrations_access_level_check
  CHECK (access_level IS NULL OR access_level IN ('read_only', 'read_write'));

-- One row per consent attempt. The state is the only thing standing between
-- this and an open, unauthenticated endpoint that makes outbound calls to
-- Google on request: random, single-use, 15-minute TTL, bound to one user and
-- one requested access level.
--
-- ON DELETE CASCADE is not decoration. Without it an abandoned consent flow
-- pins a foreign key that makes deleting that user from the dashboard fail.
CREATE TABLE IF NOT EXISTS oauth_states (
  state            TEXT PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  requested_access TEXT NOT NULL CHECK (requested_access IN ('read_only', 'read_write')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  used_at          TIMESTAMPTZ
);

-- No index on expires_at: `state` is the primary key and the only lookup path.
-- The retention sweep's daily scan of a table this small does not need one.
