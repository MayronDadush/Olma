-- The game-only track (owner, 2026-10-06). Somebody who reached Olma by
-- sending a game night's code came for the night, and on 2026-10-03 three of
-- them heard a check-in in the middle of the game, then the summary, the
-- welcome and a question about their country inside four minutes the next
-- morning. They have not written since.
--
-- So a person who came in through a game is on its track: the night's own
-- messages and the welcome reach them, nothing the check-in ladder decides
-- to say does (jobs/checkin.js). They leave it by USING her for something
-- else (domain/game-track.js decides, in code), and their day one starts at
-- that moment rather than at the night they joined.
--
-- game_track_at: when they joined through a game code. NULL = never on it.
-- game_track_left_at: when they left it. On the track = the first set and
-- this one NULL.
ALTER TABLE users ADD COLUMN IF NOT EXISTS game_track_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS game_track_left_at TIMESTAMPTZ;

-- The three who joined through the first real night (2026-10-03) and have
-- written nothing since that is not the game (owner, 2026-10-06: "גם אותם").
-- By what is on file rather than by id: a game claim on the record, and no
-- task, reminder or coordination of their own. Anybody who already used her
-- for something else is left off the track.
UPDATE users u SET game_track_at = (
    SELECT min(a.created_at) FROM audit_log a
     WHERE a.actor_id = u.id AND a.event = 'games.intake_claim')
 WHERE u.game_track_at IS NULL
   AND EXISTS (SELECT 1 FROM audit_log a WHERE a.actor_id = u.id AND a.event = 'games.intake_claim')
   AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.owner_id = u.id)
   AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.initiator_id = u.id);

COMMENT ON COLUMN users.game_track_at IS 'joined through a game night code; on the game-only track while game_track_left_at is NULL (jobs/checkin.js says nothing to them)';
COMMENT ON COLUMN users.game_track_left_at IS 'left the game-only track by using Olma for something else (domain/game-track.js); day one is counted from here';
