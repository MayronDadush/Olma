-- The one-time offer to add Olma to more groups, made to somebody who has
-- just seen a coordination in a room work (owner, 2026-09-23: next check-in,
-- everybody who said yes to the time that was locked, once ever, group
-- coordinations only). Stamped on the PERSON, like timezone_asked_at (045)
-- and holiday_quiet_asked_at (062): a once-ever question lives on the person,
-- never on the route that asks it.
--
-- 086: SELECT max(version) FROM schema_migrations on the box was 85 on
-- 2026-09-23 (never `ls migrations/`).
ALTER TABLE users ADD COLUMN more_groups_offered_at TIMESTAMPTZ;
