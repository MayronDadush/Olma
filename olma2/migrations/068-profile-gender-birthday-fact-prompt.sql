-- The profile page had three fields that saved nowhere (owner, 2026-09-14).
--
-- The personal dashboard drew a birthday, a form of address and a name, and
-- none of them reached the server: every real person saw the design fixture's
-- birthday, 16 March 1994, and a gender switch that changed the avatar and
-- nothing else. The name already had a column; these two did not.
--
--   gender       how Olma addresses THEM — masculine or feminine Hebrew. Not
--                the assistant's own gender, which is `assistant_gender`.
--                NULL is "they have not said", and the card says nothing then.
--   birth_date   a date, not an instant: a birthday has no zone.
--
-- `user_facts.prompt_key` is which question on the profile page a fact
-- answers ("work_hours"). It is what lets the page stop asking a question
-- somebody has already answered, and ask it again once they delete the fact —
-- the fact row is the answer, so there is no second record to fall out of step.
--
-- Additive: NULL for everyone, and nothing reads them until this ships.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS gender TEXT CHECK (gender IN ('male', 'female')),
  ADD COLUMN IF NOT EXISTS birth_date DATE;

ALTER TABLE user_facts
  ADD COLUMN IF NOT EXISTS prompt_key TEXT;

CREATE INDEX IF NOT EXISTS user_facts_prompt_key_idx
  ON user_facts (user_id, prompt_key) WHERE prompt_key IS NOT NULL AND active = true;
