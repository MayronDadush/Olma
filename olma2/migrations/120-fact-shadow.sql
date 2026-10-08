-- Jev in shadow over the two judgements about a fact that code cannot make
-- (rung 1 of the owner's ladder, as migration 091 did for duplicate tasks).
--
--   lifespan  Is this a ONE-OFF EVENT (stops being true once it has happened) or
--             a LASTING trait? The write gate (domain/facts.js) can only see a
--             date written in the text; "הולכת לניתוח" and "טסה לקפריסין" name
--             none, and sat on a card as importance 3 and without an end.
--   twin      Is it the SAME fact as another the person already has, said in
--             other words? task-similarity caught 1 of 4 real pairs.
--
-- One row per new fact, asked once, with what the CODE knew beside it. Nothing
-- reads this table to decide anything. Ids only, never the fact's words: they
-- are in `user_facts`, and a row here outliving its fact would be a second copy
-- of something personal. No foreign key on the ids that point at ANOTHER fact,
-- so a fact forgotten later does not take the record of what was said with it;
-- the fact itself and the owner cascade, so deleting a person deletes this too.
CREATE TABLE fact_shadow (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fact_id         BIGINT NOT NULL UNIQUE REFERENCES user_facts(id) ON DELETE CASCADE,
  owner_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- how many of their other facts it was compared against
  list_size       INT NOT NULL,
  -- what the code knew: did the fact carry an end when it was asked about
  code_dated      BOOLEAN NOT NULL,
  -- the code's twin answer (NULL = none), and the closest row by words
  code_twin_id    BIGINT,
  code_twin_score NUMERIC(5, 4),
  code_best_id    BIGINT,
  code_best_score NUMERIC(5, 4),
  -- Jev: 'event' | 'lasting' | 'other', and how sure
  jev_life        TEXT,
  jev_life_conf   NUMERIC(5, 4),
  -- Jev's pick from the other facts (NULL = none), and how sure
  jev_twin_id     BIGINT,
  jev_twin_conf   NUMERIC(5, 4),
  jev_model       TEXT,
  -- set instead of answers when the call failed; a row either way
  jev_error       TEXT,
  latency_ms      INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX fact_shadow_created ON fact_shadow (created_at);
