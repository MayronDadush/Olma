-- The newest inbound message per GROUP session, as the gateway described it
-- to the model: subject, roster, sender, whether she was tagged, and the
-- message id a reply can quote.
--
-- Why a table at all: group mode (docs/group-mode.md) was designed to read
-- the roster off the gateway's own transcript store, and on OpenClaw
-- 2026.8.1 the transcript does not carry it. The `Conversation info` block
-- is built per turn and handed to the model; what is persisted is the bare
-- text (measured 2026-09-06 on the first live group message — zero real
-- transcripts on the box contain the block, only the suite's own probes).
-- The one place code can still see it is a gateway plugin on `llm_input`
-- (gateway-plugin/olma-turn), which forwards it to brokerd, which writes it
-- here. The sweep (jobs/groups.js) reads this row instead of the store.
--
-- One row per session, replaced on every message: the sweep wants the newest
-- tag, exactly as it wanted the newest transcript event before.
CREATE TABLE group_inbound_context (
  session_key   TEXT PRIMARY KEY,           -- agent:<agent>:whatsapp:group:<jid>
  agent_id      TEXT NOT NULL,              -- ggreet or g-<id>
  chat_id       TEXT,                       -- the gateway's chat_id (the jid, possibly channel-prefixed)
  subject       TEXT,
  members       TEXT,                       -- the gateway's group_members line, verbatim
  sender_e164   TEXT,
  sender_name   TEXT,
  was_mentioned BOOLEAN NOT NULL DEFAULT false,
  message_id    TEXT,
  at            TIMESTAMPTZ NOT NULL,       -- the message's own time, per the gateway
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
