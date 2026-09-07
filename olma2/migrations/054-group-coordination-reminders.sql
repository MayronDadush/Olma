-- The two reminders a room gets about a coordination that is already set.
--
-- The owner's fifth moment (2026-09-07): "תזכורת ביום שמתקיים התיאום / שעה
-- לפני". Two more stamps beside the three in 053, for the same reason — said
-- once each, per coordination, and a room that plays every week gets them
-- again next week about the new one.
--
-- Both are only ever possible for a meeting with a real `confirmed_start_at`.
-- A slot that never carried a moment ("some time next week") cannot be
-- reminded about, and inventing one would be worse than saying nothing.
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS group_dayof_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS group_hour_at TIMESTAMPTZ;
