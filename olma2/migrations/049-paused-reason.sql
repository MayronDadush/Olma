-- Who paused this person: NULL for a pause THEY asked for (pause_olma, the
-- admin page, the personal dashboard), 'quiet_ladder' for the one the check-in
-- ladder made after three unanswered check-ins. The difference decides who
-- may end it: a manual pause is ended only by hand, a ladder pause ends by
-- itself on the first message they send. Written by domain/pause.js alone.
ALTER TABLE users ADD COLUMN IF NOT EXISTS paused_reason text;
