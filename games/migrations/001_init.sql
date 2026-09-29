-- Game nights: their own database (olma_games), their own numbering. Olma's
-- migrations never see these and these never see Olma's. Additive only, like
-- everything else on the box: a rollback reaches code, never a schema.

CREATE TABLE nights (
  id              bigserial PRIMARY KEY,
  -- The 22-character link. Knowing it is the permission to read and write
  -- the night, so it is random and never derived from anything.
  token           text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9]{22}$'),
  -- The short join code for WhatsApp (stage 3). Unique among OPEN nights
  -- only, so the alphabet of 31^5 is never used up.
  code            text NOT NULL CHECK (code ~ '^[2-9A-HJ-KM-NP-Z]{5}$'),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  price_ag        integer NOT NULL CHECK (price_ag > 0 AND price_ag <= 10000000),
  chips_per_buyin integer NOT NULL CHECK (chips_per_buyin > 0 AND chips_per_buyin <= 10000000),
  food_mode       text NOT NULL DEFAULT 'merge' CHECK (food_mode IN ('merge', 'split')),
  prev_id         bigint REFERENCES nights(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);
CREATE UNIQUE INDEX nights_open_code ON nights (code) WHERE closed_at IS NULL;

-- A player is a NAME at a table. user_id is set only when the person proved
-- who they are by writing to Olma (stage 3); nothing here ever holds a phone.
CREATE TABLE players (
  night_id   bigint NOT NULL REFERENCES nights(id),
  id         text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{2,32}$'),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 24),
  ord        double precision NOT NULL,
  user_id    bigint,
  linked_at  timestamptz,
  linked_via text CHECK (linked_via IN ('host', 'invite', 'group', 'page')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (night_id, id)
);

CREATE TABLE buyins (
  night_id  bigint NOT NULL REFERENCES nights(id),
  id        text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{2,32}$'),
  player_id text NOT NULL,
  n         numeric(2,1) NOT NULL CHECK (n IN (0.5, 1)),
  via       text NOT NULL DEFAULT 'tap',
  at        bigint NOT NULL,
  PRIMARY KEY (night_id, id),
  FOREIGN KEY (night_id, player_id) REFERENCES players(night_id, id)
);

CREATE TABLE cashouts (
  night_id  bigint NOT NULL REFERENCES nights(id),
  player_id text NOT NULL,
  chips     integer NOT NULL CHECK (chips >= 0 AND chips <= 1000000000),
  via       text NOT NULL DEFAULT 'tap',
  at        bigint NOT NULL,
  PRIMARY KEY (night_id, player_id),
  FOREIGN KEY (night_id, player_id) REFERENCES players(night_id, id)
);

-- An order's shape (payer, eaters, own dishes, several payers) is validated
-- in src/validate.js and kept whole; nothing outside the night reads inside it.
CREATE TABLE food (
  night_id bigint NOT NULL REFERENCES nights(id),
  id       text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{2,32}$'),
  data     jsonb NOT NULL,
  at       bigint NOT NULL,
  PRIMARY KEY (night_id, id)
);

CREATE TABLE log (
  night_id bigint NOT NULL REFERENCES nights(id),
  id       text NOT NULL,
  t        text NOT NULL CHECK (length(t) <= 200),
  via      text NOT NULL DEFAULT 'tap',
  at       bigint NOT NULL,
  PRIMARY KEY (night_id, id)
);

-- One row per player of a CLOSED night, for statistics later. No food.
-- Rewritten when a count is corrected after closing, removed if the night
-- stops adding up, never duplicated.
CREATE TABLE game_results (
  night_id        bigint NOT NULL REFERENCES nights(id),
  player_id       text NOT NULL,
  name            text NOT NULL,
  user_id         bigint,
  buyins          numeric(6,1) NOT NULL,
  chips           integer NOT NULL,
  net_ag          integer NOT NULL,
  price_ag        integer NOT NULL,
  chips_per_buyin integer NOT NULL,
  pot_ag          integer NOT NULL,
  closed_at       timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (night_id, player_id)
);
CREATE INDEX game_results_user ON game_results (user_id) WHERE user_id IS NOT NULL;
