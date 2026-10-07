-- Values per 100 g come from a table, never from a model.
--
-- The vision bench (food/bench) showed the model's own per-100 g values were
-- the largest error on a plate: a chicken-apple sausage valued as a pork one
-- moved the total by 40-90%. So a model now names what it sees and how much,
-- and the values come from `foods`: one row per food, from a public table
-- (USDA SR Legacy today; the Health Ministry's Tzameret when it is loaded).
--
-- `food_names` is the bridge, and it is shared by everyone: once "chicken
-- breast, roasted" is matched to a row, every person and every model that says
-- it gets that row. A name is matched once (by hand, or by a cheap model
-- choosing among table rows) and then never again.

CREATE TABLE foods (
  id          serial PRIMARY KEY,
  source      text NOT NULL CHECK (source IN ('usda', 'tzameret', 'manual')),
  source_id   text NOT NULL,
  name_en     text,
  name_he     text,
  category    text,
  kcal100     numeric(6,1) NOT NULL CHECK (kcal100 BETWEEN 0 AND 950),
  protein100  numeric(5,1) NOT NULL CHECK (protein100 BETWEEN 0 AND 100),
  carbs100    numeric(5,1) NOT NULL CHECK (carbs100 BETWEEN 0 AND 100),
  fat100      numeric(5,1) NOT NULL CHECK (fat100 BETWEEN 0 AND 100),
  UNIQUE (source, source_id)
);

CREATE TABLE food_names (
  name        text PRIMARY KEY,                     -- normalized: lower case, single spaces
  food_id     int NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  via         text NOT NULL CHECK (via IN ('manual', 'model', 'seed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Where an item's values came from, so a wrong row can be found and fixed
-- for every meal that used it.
ALTER TABLE items ADD COLUMN food_id int REFERENCES foods(id) ON DELETE SET NULL;
ALTER TABLE items ADD COLUMN value_src text CHECK (value_src IN ('table', 'label', 'model', 'group'));

-- Every call foodd makes to a model, for the bill and for "is it slow".
-- No picture and no words: only who, what for, how long and what it cost.
CREATE TABLE model_calls (
  id          bigserial PRIMARY KEY,
  user_id     bigint,
  at          timestamptz NOT NULL DEFAULT now(),
  purpose     text NOT NULL CHECK (purpose IN ('see', 'match')),
  model       text NOT NULL,
  ok          boolean NOT NULL,
  ms          int,
  cost_usd    numeric(10,6),
  error       text
);
CREATE INDEX model_calls_at ON model_calls (at);
