-- The slot text the room's "יש כיוון" line actually named. `group_base_at`
-- says the line was said; it cannot say WHICH time it said, so when the
-- leading option was deleted the room went on holding a time that no longer
-- existed (Padel Gang, meeting 40: told שבת 16:00, which Sharon then removed).
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS group_base_slot text;
