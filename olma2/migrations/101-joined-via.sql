-- Where each person came from, so growth can be read by channel (owner,
-- 2026-09-30: the goal is 100 weekly active users, and "which door works" is
-- the question every next step depends on).
--
-- `joined_via` is written once, at provisioning (jobs/intake.js):
--   'friend_link' their first message carried a friend's invite code
--                 (domain/referral.js) — `referred_by_user_id` says whose
--   'room'        they were on a WhatsApp room's roster before they wrote
--   'invite'      somebody asked to connect with them before they wrote
--   'direct'      none of the above
-- NULL means provisioned some other way (a script, the testbed) and is left
-- honest: unknown is not 'direct'.
--
-- The backfill below reads the same facts the sweep reads, for the people who
-- are already here. A room outranks an invite because a room creates the
-- connections itself (2026-09-09), so every room joiner also looks invited.
-- It also fills `invited_by_connection_id`, which provisioning never wrote
-- for anybody who already had a pending row — i.e. everybody it was for.
--
-- Additive: two nullable columns nothing before this reads.
ALTER TABLE users ADD COLUMN IF NOT EXISTS joined_via TEXT
  CHECK (joined_via IN ('friend_link', 'room', 'invite', 'direct'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_user_id BIGINT
  REFERENCES users(id) ON DELETE SET NULL;

UPDATE users u SET joined_via = CASE
    WHEN EXISTS (SELECT 1 FROM chat_group_members m
                  WHERE (m.user_id = u.id OR m.phone = u.phone)
                    AND m.first_seen_at <= COALESCE(u.onboarded_at, u.created_at) + interval '1 hour')
      THEN 'room'
    WHEN EXISTS (SELECT 1 FROM connections c
                  WHERE c.target_id = u.id AND c.invited_at < COALESCE(u.onboarded_at, u.created_at))
      THEN 'invite'
    ELSE 'direct' END
 WHERE u.joined_via IS NULL AND u.status = 'active' AND u.agent_id IS NOT NULL;

UPDATE users u SET invited_by_connection_id = (
    SELECT c.id FROM connections c
     WHERE c.target_id = u.id AND c.invited_at < COALESCE(u.onboarded_at, u.created_at)
     ORDER BY c.invited_at LIMIT 1)
 WHERE u.invited_by_connection_id IS NULL AND u.status = 'active' AND u.agent_id IS NOT NULL;
