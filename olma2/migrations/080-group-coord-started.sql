-- The room hears once, when a coordination opens, that Olma has started asking
-- privately (owner, 2026-09-22). Its own column for the same reason every other
-- line in that family has one: "said" is per sentence, not a counter, so a line
-- held for the night goes out in the morning and never twice.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS group_started_at timestamptz;
