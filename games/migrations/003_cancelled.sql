-- A night closed by the people at the table WITHOUT a settlement: they
-- changed their minds, or never reported the chips (owner, 2026-10-03). Until
-- now closed_at was set only by the count adding up, so a night nobody
-- finished stayed open and blocked the next one.
--
-- A cancelled night has BOTH columns set: closed_at frees its join code and
-- takes it out of every "open night" reader, and cancelled_at says no
-- settlement happened, so game_results stays empty and no write reopens it.
ALTER TABLE nights ADD COLUMN cancelled_at timestamptz;
