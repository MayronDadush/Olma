-- The picture of a person's day (or week) that Olma sends in the evening:
-- one row per person, kind and day, claimed BEFORE anything is spent, so a
-- second ask for the same day is refused rather than paid for twice
-- (src/picture.js). `model` is the image model that drew it, or NULL for the
-- card drawn by code (no key, over the month's cap, or the model failed),
-- which is also what the two models' comparison is read from.
CREATE TABLE IF NOT EXISTS pictures (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES people(user_id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('day', 'week')),
  day        date NOT NULL,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'generated', 'drawn')),
  model      text,
  theme      text,
  cost_usd   numeric(10,6),
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, day)
);

-- Two more purposes: the picture itself, and the short call that turns the
-- titles they wrote into plain English food names for it.
ALTER TABLE model_calls DROP CONSTRAINT IF EXISTS model_calls_purpose_check;
ALTER TABLE model_calls ADD CONSTRAINT model_calls_purpose_check CHECK (purpose IN ('see', 'match', 'say', 'scene', 'picture'));
