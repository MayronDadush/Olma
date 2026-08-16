-- The delivery gate counts today's SENT proactive messages per user (the soft
-- daily budget); the existing partial index covers only pending rows
-- (sent_at IS NULL) — exactly the wrong half for that query.
CREATE INDEX outbox_sent_by_user ON outbox (user_id, sent_at) WHERE sent_at IS NOT NULL;
