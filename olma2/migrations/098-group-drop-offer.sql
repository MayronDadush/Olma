-- When the room was offered to drop its coordination (owner, 2026-09-28: "מתי
-- פשוט להודיע להם אני רואה שאין כלכך היענות על התיאום הזה ולהציע לרדת ממנו").
-- `domain/coordination-policy` says it after twelve quiet hours past the chase,
-- and the coordination closes as `no_match` if nobody answers by the moment
-- the offer named.
--
--   group_drop_offer_at — the moment the offer went into the room's queue,
--                         on the clock the decision was made on (like every
--                         `group_*_at` stamp); NULL is "never offered". Once
--                         per coordination: an answer after it lapses the
--                         offer, and it is never said twice.
--   group_drop_close_at — the moment the offer SAID it would close ("אסגור
--                         אותו מחר ב-09:00", owner: name the hour). Stored,
--                         never recomputed, so the close keeps the promise the
--                         room read.
--
-- 098: SELECT max(version) FROM schema_migrations on the box was 97 on
-- 2026-09-28, and main holds 097; 096 belongs to a branch in flight.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS group_drop_offer_at TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS group_drop_close_at TIMESTAMPTZ;
