-- When we last asked this person which CITY they are in.
--
-- The discovery ladder already offers each `topic` at most once ever, but the
-- key is the topic string — so an operator's one-off repair message carrying
-- topic 'timezone_repair' and the ladder's own 'timezone' were two different
-- asks as far as the dedup was concerned. Sarah (u-17) was asked for her city
-- on 2026-09-02 by the repair message and again on 2026-09-06 by the ladder,
-- four days apart, having answered neither. One column, checked by every path
-- that asks, is the thing a topic string cannot be.
--
-- Nullable and additive: NULL means "never asked", which is what everyone
-- except the backfill below starts as.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone_asked_at timestamptz;

-- Backfill from what actually went out, both spellings, so nobody who has
-- already been asked gets asked a second time the first tick after deploy.
UPDATE users u
   SET timezone_asked_at = ask.at
  FROM (
    SELECT o.user_id, max(o.sent_at) AS at
      FROM outbox o
     WHERE o.kind = 'checkin'
       AND o.sent_at IS NOT NULL
       AND o.hold_reason IS NULL
       AND o.payload->>'topic' LIKE 'timezone%'
     GROUP BY o.user_id
  ) ask
 WHERE u.id = ask.user_id
   AND u.timezone_asked_at IS NULL;
