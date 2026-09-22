-- A nudge whose hour is the hour they already hear from Olma in the morning
-- does not become a second message: the digest draws it (domain/digest-block.js)
-- and these two columns are how the sweep that hands it over and the tool that
-- draws it agree about that, since `sent_at` alone cannot tell "delivered as
-- its own message" from "handed to the morning picture".
--
-- `carried_outbox_id` names the DIGEST ROW, not a moment, and that is the whole
-- design: the nudge is drawn for exactly as long as that row is still waiting
-- to go out, and stops being drawn the instant it is delivered. A time window
-- would have been a second clock to get wrong — and one a test cannot pin,
-- since the model composes the turn some seconds after the sweep.
--
-- `carried_at` is the human-readable half: which occurrence, and when.
ALTER TABLE task_reminders ADD COLUMN IF NOT EXISTS carried_at timestamptz;
ALTER TABLE task_reminders ADD COLUMN IF NOT EXISTS carried_outbox_id bigint
  REFERENCES outbox(id) ON DELETE SET NULL;

-- The digest's lookup is "this person, carried onto a row still unsent".
CREATE INDEX IF NOT EXISTS task_reminders_carried_outbox_idx
  ON task_reminders (carried_outbox_id) WHERE carried_outbox_id IS NOT NULL;
