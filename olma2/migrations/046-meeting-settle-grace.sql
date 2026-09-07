-- Settling a meeting stopped being instantaneous (owner, 2026-09-06).
--
-- Two changes live here. A unanimous option no longer closes the meeting the
-- moment the last yes lands: it ARMS, and `minute_sweeps` closes it when the
-- grace has passed and the option is still unanimous — so somebody who marked
-- the wrong row has a minute to take it back before six people are told a
-- thing that is about to be untrue. And a meeting can now be settled by hand
-- on an option that is NOT unanimous, for the case the owner named: everyone
-- wants Tuesday, one person cannot make it, and the meeting happens anyway.
--
-- `settle_due_at` is the armed moment and NULL means nothing is armed;
-- `settling_option_id` is what it would settle on. `settled_by` records the
-- person who forced it, and stays NULL when nobody did — which is what makes
-- "everyone agreed" and "somebody decided" tellable apart afterwards.
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS settle_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS settling_option_id bigint REFERENCES meeting_options(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS settled_by bigint REFERENCES users(id) ON DELETE SET NULL;

-- The sweep asks one question a minute: is anything due. Partial, because all
-- but a handful of rows have NULL here at any moment.
CREATE INDEX IF NOT EXISTS meetings_settle_due_idx
  ON meetings (settle_due_at) WHERE settle_due_at IS NOT NULL;
