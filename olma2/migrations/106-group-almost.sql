-- The room's "one short" line (owner, 2026-10-02, the poker room): when the
-- leading time is a single yes away from the number the room said it needs,
-- the room hears it once — the base line waits for the number itself, so four
-- out of five had no line at all. Stamped like every other line in that family
-- (group-voice.decideGroupLine, jobs/groups.sweepGroupVoice), so a line held
-- for the room's night goes out in the morning and never twice.
--
-- Additive: one nullable column, read only by the sweep.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS group_almost_at TIMESTAMPTZ;

-- A room already told this by hand (the poker room, 2026-10-02, audited as
-- `manual_almost`) has heard it: without this the first pass after the deploy
-- would say it a second time.
UPDATE meetings m SET group_almost_at = a.created_at
  FROM audit_log a
 WHERE a.event = 'group.coordination_said'
   AND a.detail->>'kind' = 'manual_almost'
   AND (a.detail->>'meetingId')::bigint = m.id
   AND m.group_almost_at IS NULL;
