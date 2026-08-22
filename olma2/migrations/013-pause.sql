-- Reversible opt-out. A user asked Olma to stop and there was nowhere to
-- record it: the agent said goodbye, called nothing, and the check-in ladder
-- reached him again the next morning. checkin_enabled already existed but was
-- a dead switch — read by one query, written by nothing — and it only ever
-- covered check-ins, not reminders, digests or another user's fan-out.
--
-- paused_at is the one flag every outbound path consults. NULL = running.
-- Nothing here deletes anything: pausing is meant to be undone.
ALTER TABLE users ADD COLUMN IF NOT EXISTS paused_at timestamptz;
