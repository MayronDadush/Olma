-- When she last told a room that somebody in it had not written to her.
--
-- The opening line ("יש! כולם כאן ואפשר להתחיל") is an ANSWER: it closes a
-- wait the room was told about. The first real group was never waiting on
-- anyone — both members were already users when she was added — so the line
-- announced the end of something that had never started (owner, 2026-09-06).
--
-- `notices_sent` cannot carry this: it also counts the `too_large` notice,
-- which is not about anybody being missing, and a room told it was too big
-- and then trimmed has nothing to celebrate either.
ALTER TABLE chat_groups ADD COLUMN IF NOT EXISTS gate_notice_at TIMESTAMPTZ;

-- Backfill: a group that has sent notices while locked was told about a wait.
-- On the box today that is no group at all — the one live row has
-- notices_sent = 0 — so this is for any other install and for readability.
UPDATE chat_groups SET gate_notice_at = last_notice_at
 WHERE last_notice_at IS NOT NULL AND notices_sent > 0 AND state <> 'too_large';
