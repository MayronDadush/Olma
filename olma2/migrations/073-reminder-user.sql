-- A reminder is one PERSON's, not the task's. Until now the row hung off the
-- task alone and every reader took the recipient to be tasks.owner_id — which
-- was the same person for as long as only the owner could write. With
-- everyone on a shared task equal (2026-09-19, incidents.md "The list he
-- could not put his own task into"), two people on one list each want their
-- own nudge about it, and a reminder that followed the task's owner would
-- reach the wrong one the moment the task changed hands.
--
-- Nullable on purpose: code that predates this column keeps inserting rows
-- without it, and every reader resolves COALESCE(r.user_id, t.owner_id) —
-- which is exactly the answer those rows always had. The backfill makes the
-- COALESCE moot for everything already written.
ALTER TABLE task_reminders ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;

UPDATE task_reminders r SET user_id = t.owner_id
  FROM tasks t WHERE t.id = r.task_id AND r.user_id IS NULL;

CREATE INDEX IF NOT EXISTS task_reminders_user ON task_reminders (user_id)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;

COMMENT ON COLUMN task_reminders.user_id IS 'who this reminder reaches; NULL on rows written before 073 means the task''s owner (readers COALESCE)';
