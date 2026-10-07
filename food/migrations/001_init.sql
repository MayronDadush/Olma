-- olma_food: what one person ate, beside Olma and never inside it.
--
-- Everything is keyed by Olma's user id, which brokerd's identity_resolve hands
-- us for the token the model passed (src/identity.js). There is no copy of
-- Olma's users here: `people` holds only what this service needs to act for
-- them (their clock, their language, their goal) and the page's link.

CREATE TABLE people (
  user_id      bigint PRIMARY KEY,
  token        text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9]{22}$'),
  name         text,
  timezone     text NOT NULL DEFAULT 'Asia/Jerusalem',
  locale       text NOT NULL DEFAULT 'he',
  -- false: no calories or grams anywhere, only what was on the plate.
  numbers      boolean NOT NULL DEFAULT true,
  -- A goal nobody set is a default the page says is a default (goal_set).
  goal_kcal    integer NOT NULL DEFAULT 2000 CHECK (goal_kcal BETWEEN 800 AND 6000),
  goal_protein integer NOT NULL DEFAULT 100 CHECK (goal_protein BETWEEN 10 AND 400),
  goal_carbs   integer NOT NULL DEFAULT 250 CHECK (goal_carbs BETWEEN 0 AND 800),
  goal_fat     integer NOT NULL DEFAULT 70 CHECK (goal_fat BETWEEN 10 AND 300),
  goal_set     boolean NOT NULL DEFAULT false,
  water_goal   integer NOT NULL DEFAULT 8 CHECK (water_goal BETWEEN 1 AND 20),
  challenge    text CHECK (challenge IN ('veg_dinner', 'protein_breakfast', 'water6')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A meal is on a person's LOCAL day, written when it was eaten, not when it
-- was logged: "yesterday evening I had pizza" lands on yesterday.
CREATE TABLE meals (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES people(user_id) ON DELETE CASCADE,
  day        date NOT NULL,
  slot       text NOT NULL CHECK (slot IN ('breakfast', 'lunch', 'dinner', 'snack')),
  at         timestamptz NOT NULL DEFAULT now(),
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  source     text NOT NULL CHECK (source IN ('photo', 'text', 'voice', 'label', 'repeat', 'usual', 'auto', 'page')),
  -- A meal logged roughly on purpose (Friday dinner): it counts as a meal and
  -- nothing else, no totals, no challenge, no "over the goal".
  rough      boolean NOT NULL DEFAULT false,
  -- The part of a shared dish that was theirs, in their words ("2 of 8").
  shared_part text,
  via        text NOT NULL CHECK (via IN ('olma', 'page', 'auto')),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meals_user_day ON meals (user_id, day) WHERE deleted_at IS NULL;

CREATE TABLE items (
  id         bigserial PRIMARY KEY,
  meal_id    bigint NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  ord        smallint NOT NULL,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  grams      numeric NOT NULL CHECK (grams >= 0 AND grams <= 3000),
  kcal100    numeric NOT NULL CHECK (kcal100 >= 0 AND kcal100 <= 950),
  protein100 numeric NOT NULL CHECK (protein100 >= 0 AND protein100 <= 100),
  carbs100   numeric NOT NULL CHECK (carbs100 >= 0 AND carbs100 <= 100),
  fat100     numeric NOT NULL CHECK (fat100 >= 0 AND fat100 <= 100),
  grp        text NOT NULL CHECK (grp IN ('protein', 'veg', 'fruit', 'grain', 'fat', 'sweet', 'drink')),
  -- label: read off a nutrition label, not estimated. portion: the person's
  -- own amount, learned from a correction (portions below).
  confidence text NOT NULL CHECK (confidence IN ('high', 'mid', 'low', 'label', 'said', 'portion'))
);
CREATE INDEX items_meal ON items (meal_id);

CREATE TABLE water (
  user_id bigint NOT NULL REFERENCES people(user_id) ON DELETE CASCADE,
  day     date NOT NULL,
  cups    smallint NOT NULL CHECK (cups BETWEEN 0 AND 30),
  PRIMARY KEY (user_id, day)
);

-- A correction is a lesson: the next plate with the same thing starts from
-- their amount. Keyed by the item's base name (before " · ").
CREATE TABLE portions (
  user_id    bigint NOT NULL REFERENCES people(user_id) ON DELETE CASCADE,
  name       text NOT NULL,
  grams      numeric NOT NULL CHECK (grams > 0 AND grams <= 3000),
  from_grams numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name)
);

-- A meal that logs itself every day at an hour they chose ("the morning
-- latte"). `last_day` is the last local day it was written, so a restart
-- never writes it twice.
CREATE TABLE auto_meals (
  user_id  bigint NOT NULL REFERENCES people(user_id) ON DELETE CASCADE,
  title    text NOT NULL,
  slot     text NOT NULL CHECK (slot IN ('breakfast', 'lunch', 'dinner', 'snack')),
  hour     smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  items    jsonb NOT NULL,
  last_day date,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, title)
);
