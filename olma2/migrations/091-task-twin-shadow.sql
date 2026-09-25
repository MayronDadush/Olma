-- Jev in shadow over the duplicate-task judgement (rung 1 of the ladder the
-- owner set on 2026-09-24: measure → shadow → refuse a write → say something).
--
-- One row per new top-level task: what the CODE said about it
-- (domain/task-similarity.compare against the list that was open when it was
-- written) beside what Jev said, asked once over the same list. Nothing reads
-- this table to decide anything. It exists so that, after a week, the two
-- answers can be read side by side on real tasks instead of on the eighty
-- labelled pairs (docs/model-experiments.md, run #91).
--
-- Ids only, never titles: the titles are in `tasks`, and a row here outliving
-- its task would be a second copy of somebody's words. `code_*` and `jev_pick_id`
-- carry no foreign key on purpose — a twin deleted later must not take the
-- record of what was said about it with it. The task and the owner cascade,
-- so deleting a person deletes this too.
CREATE TABLE task_twin_shadow (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id         BIGINT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  owner_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- how many open top-level tasks the new one was compared against
  list_size       INT NOT NULL,
  -- the code's merge answer (NULL = no twin), its reason and score
  code_twin_id    BIGINT,
  code_reason     TEXT,
  code_score      NUMERIC(5, 4),
  -- the closest row by words even when the code said "different", so the
  -- band just under the merge line can be read without recomputing it
  code_best_id    BIGINT,
  code_best_score NUMERIC(5, 4),
  -- Jev's pick from the same list (NULL = it said none), and how sure
  jev_pick_id     BIGINT,
  jev_confidence  NUMERIC(5, 4),
  jev_model       TEXT,
  -- set instead of a pick when the call failed; a row either way, so a task
  -- is asked about once and a failing endpoint shows up as a count
  jev_error       TEXT,
  latency_ms      INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX task_twin_shadow_created ON task_twin_shadow (created_at);
