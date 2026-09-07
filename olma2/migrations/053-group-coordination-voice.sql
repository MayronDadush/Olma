-- What the ROOM has already been told about its own coordination.
--
-- The owner named five moments a group hears from her (2026-09-07): when she
-- starts, when she has a base, mid-way when she wants to speed it up, when it
-- succeeds, and the reminders on the day. The first is said in her own turn —
-- somebody just tagged her — and these three are proactive, so each one needs
-- a place to record that it has been said. Once per coordination, never once
-- per room: a group that arranges padel every week hears the same three
-- sentences again next week, about the new one.
--
-- NULL means "not said yet", which is exactly what the sweep asks.
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS group_base_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS group_chase_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS group_done_at TIMESTAMPTZ;
