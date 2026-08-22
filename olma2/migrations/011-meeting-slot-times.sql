-- A proposed slot had no machine-readable time — only freeform text like
-- "יום שישי בשעה 20:00". Nothing in the system could therefore answer "has
-- this already happened?", which is how a user was nudged on Saturday about
-- Friday's poker game: the check-in ladder's top rung quoted a dead slot,
-- and nothing had ever closed the negotiation.
--
-- The slot text stays exactly as it was (it carries the place and the medium,
-- and it is what people actually read). This adds the machine half beside it.
ALTER TABLE meetings ADD COLUMN proposed_start_at  TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN confirmed_start_at TIMESTAMPTZ;

-- 'expired' is a distinct ending from 'no_match': nobody disagreed, the
-- moment simply passed while the negotiation was still open.
ALTER TABLE meetings DROP CONSTRAINT meetings_status_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_status_check
  CHECK (status IN ('negotiating','confirmed','no_match','cancelled','expired'));

-- The sweep's lookup: open negotiations only.
CREATE INDEX meetings_negotiating_start ON meetings (proposed_start_at)
  WHERE status = 'negotiating';
