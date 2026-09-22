-- One sentence a member asked the ROOM to hear (owner, 2026-09-22). Sharon
-- wrote privately that four o'clock was a bit hot and asked that everybody be
-- told; nothing could carry a word from a private chat into the room. Kept per
-- (meeting, member) because the budget is per person per coordination: a row
-- with `relay_text` set has spent it, `relay_said_at` is when the room heard it.
ALTER TABLE meeting_participants
  ADD COLUMN IF NOT EXISTS relay_text text,
  ADD COLUMN IF NOT EXISTS relay_said_at timestamptz;
