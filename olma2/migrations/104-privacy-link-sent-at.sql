-- When the privacy link (https://allma.world/privacy) first reached this
-- PERSON, whichever voice said it.
--
-- The owner's rule (2026-10-01) is that the link reaches each person once,
-- ever. It rides four things: the owner's opening copy (said by the intake
-- greeter or by their own agent's first turn), a room's short opening, a game
-- night's first answer, and the policy update. `opening_sent_at` cannot stand
-- in for it, because it answers a different question — whether the owner's
-- words were recognised — and a greeter that paraphrased the copy while
-- keeping the link leaves it NULL, so their own agent then opens with the whole
-- copy, link and all, a second time. Same shape as `timezone_asked_at` and
-- `holiday_quiet_asked_at`: a once-ever thing is stamped on the person, never
-- deduped on the route that says it.
--
-- Additive: a nullable column. NULL means "no voice we can see has said it",
-- which is the behaviour before this migration.
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_link_sent_at TIMESTAMPTZ;

-- Everyone who has already read it. The link joined the opening copy at the
-- compliance revision, 2026-09-28T17:12:17Z (domain/policy-notice.js), so an
-- introduction after that carried it — the greeter's or a room's
-- (`opening_sent_at`), or their own agent's first turn when nobody greeted
-- them (`first_turn_at`). And a policy update that really went out
-- (`sent_at` with no `hold_reason`) carried it by definition.
UPDATE users SET privacy_link_sent_at = opening_sent_at
 WHERE privacy_link_sent_at IS NULL AND opening_sent_at >= '2026-09-28T17:12:17Z';

UPDATE users SET privacy_link_sent_at = first_turn_at
 WHERE privacy_link_sent_at IS NULL AND opening_sent_at IS NULL
   AND first_turn_at >= '2026-09-28T17:12:17Z';

UPDATE users u SET privacy_link_sent_at = o.first_sent
  FROM (SELECT user_id, min(sent_at) AS first_sent FROM outbox
         WHERE kind = 'policy_update' AND sent_at IS NOT NULL AND hold_reason IS NULL
         GROUP BY user_id) o
 WHERE u.id = o.user_id AND u.privacy_link_sent_at IS NULL;
