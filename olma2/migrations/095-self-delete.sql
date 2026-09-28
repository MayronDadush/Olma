-- A person deleting everything Olma holds about them, from the chat or from
-- their own page (owner, 2026-09-28: "כלי שמוחק את כל המידע שנשמר דרך עולמה
-- או דרך הדאשבורד"). Only on their explicit request, never after any amount of
-- silence or pause.
--
--   deletion_previewed_at  — the chat tool showed them what would go. A
--                            confirmation is accepted only within minutes of
--                            this, so a model cannot confirm what nobody saw.
--   deletion_requested_at  — they confirmed. The `self_delete` job carries it
--                            out a minute later, outside the turn that asked
--                            (the agent answering them is one of the things
--                            it deletes).
--
-- 095: SELECT max(version) FROM schema_migrations on the box was 94 on
-- 2026-09-28 (never `ls migrations/`).
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_previewed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_deletion_requested ON users (deletion_requested_at)
  WHERE deletion_requested_at IS NOT NULL;
