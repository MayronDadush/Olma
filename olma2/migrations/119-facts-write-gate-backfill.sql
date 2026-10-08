-- The write-time gate in domain/facts.js (2026-10-08) refuses three shapes that
-- are not biography, and gives a plan a shelf life. This applies the same
-- verdict ONCE to the rows written before it existed, so the cards are right
-- from the first turn after the deploy rather than after some later pass.
--
-- Soft and idempotent, like forgetFact: a row is switched off, never deleted,
-- and a second run finds nothing left to change. No scheduled job follows this;
-- the door now keeps new rows honest. The SQL mirrors facts.js
-- (EMAIL_RE, REMINDER_RE, CONNECTION_RE, PLAN_SHELF_LIFE_DAYS) and
-- tests/facts.test.js runs both over the same strings so they cannot drift.

UPDATE user_facts
   SET active = false, updated_at = now()
 WHERE active
   AND ( fact ~ '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+'
      OR fact ~ 'תזכורת|תזכורות'
      OR fact ~ '^\s*יש\s+(לו\s+|לה\s+)?קשר\s+עם\s' );

-- A plan with no end gets one 45 days after it was learned (a profile-page
-- answer is a standing answer, not a plan). One already past simply stops
-- being read: topFacts filters on expires_at.
UPDATE user_facts
   SET expires_at = learned_at + interval '45 days', updated_at = now()
 WHERE active
   AND category = 'plans'
   AND expires_at IS NULL
   AND prompt_key IS NULL;
