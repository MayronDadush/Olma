-- The once-ever offer to go quiet on yom tov, stamped on the PERSON.
--
-- Two routes can ask it — the discovery ladder, and the turn hint on the erev
-- of a chag — and two routes each honouring "at most once" is twice. Same
-- doctrine and same shape as users.timezone_asked_at (migration 045), which
-- exists because "the city was asked four times" when the dedup lived on the
-- topic string instead of on the person.
--
-- No backfill: nobody has ever been asked, so NULL is the truth for everybody.
ALTER TABLE users ADD COLUMN IF NOT EXISTS holiday_quiet_asked_at timestamptz;
