-- Packs: a whole set of tools a person turns on, served by an MCP server that
-- is not ours. Game nights is the first (games/, its own DB and service).
--
-- Every agent on the gateway is denied a pack's tools (`games__*`) unless its
-- person has a row here — intake/agent-tool-policy.js reads this table, the
-- deploy's sync writes it into each agent's `tools.deny`, and config_guard
-- names any agent that differs. So this table IS who sees the game tools, and
-- brokerd's `identity_resolve` hands the same list to gamesd, which refuses a
-- call from anybody without it — the deny decides what the model reads, this
-- row decides what the server will do.
--
-- `via` is how it was turned on: by the owner by hand, by the phrase that
-- opens a game night, or by a join code. Empty when it is created; nobody
-- sees anything until a row is written.
--
-- Additive: a new table nothing before this reads.
CREATE TABLE IF NOT EXISTS user_packs (
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack       TEXT        NOT NULL CHECK (pack IN ('games')),
  via        TEXT        NOT NULL CHECK (via IN ('owner', 'phrase', 'code')),
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pack)
);
