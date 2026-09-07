-- Every sentence Olma says to a ROOM becomes a row here first.
--
-- It was a bare spawn until now: the sweep decided, called the CLI, and
-- stamped the column when the CLI came back. That leaves a gap of the CLI's
-- whole start-up — measured at 16 seconds on the box — in which the process
-- can die with the message already delivered and nothing written down. On
-- 2026-09-07 a deploy restarted brokerd inside exactly that gap and a room
-- was told "יש! כולם כאן" twice, 28 seconds apart (incidents.md, "The room
-- was told twice").
--
-- The stamp now happens in the SAME transaction as the row, so a rollback
-- takes both or neither, and `idempotency_key` is UNIQUE so that even a lost
-- stamp cannot produce the sentence a second time. That key is the actual
-- promise here; the rest is bookkeeping.
--
-- Deliberately NOT the `outbox` table. That one is addressed to a PERSON —
-- every reader of it joins `users` and asks about quiet hours, a pause, the
-- daily budget, the quiet ladder — and a room is none of those things. One
-- queue per audience, each with exactly one sender, is what keeps "there is no
-- second way to reach a person" true: nothing in this table can name a user.
CREATE TABLE IF NOT EXISTS group_outbox (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id        BIGINT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  -- What kind of sentence, so the worker can render it from the owner's
  -- current wording rather than from the wording that happened to be loaded
  -- when the sweep decided. Same rule as the reminder rungs.
  kind            TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The message id this line answers, when it answers one. A bare notice
  -- floats in a room where three people are talking.
  reply_to        TEXT,
  idempotency_key TEXT UNIQUE,
  -- How many times a sender has picked this row up. It only ever goes up —
  -- a refusal does not put it back to zero — so two refusals are two, and the
  -- second one ends the row.
  attempts        INTEGER NOT NULL DEFAULT 0,
  -- The in-flight marker, and the claim: NULL means nobody holds it, and
  -- taking it is one UPDATE with `claimed_at IS NULL` in the WHERE. A sender
  -- that dies mid-send leaves it SET, and nothing will ever pick that row up
  -- again — a room that misses one sentence is better off than a room told
  -- the same thing twice, which is the whole reason this table exists. A
  -- definite refusal is the other case: nothing was delivered, so the claim is
  -- handed back (NULL again) while the attempt stays counted.
  claimed_at      TIMESTAMPTZ,
  last_error      TEXT,
  -- Set together with sent_at: 'unconfirmed' is a send we cannot swear to,
  -- 'abandoned' is one we stopped retrying. Both are terminal, both mean
  -- nothing further will be attempted for this row.
  hold_reason     TEXT,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS group_outbox_pending
  ON group_outbox (created_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS group_outbox_by_group
  ON group_outbox (group_id, created_at);
