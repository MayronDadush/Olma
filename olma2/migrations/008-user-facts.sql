-- Deep memory: what Olma knows about a person, as rows.
--
-- The file-based memory layer it replaces was dead on arrival. Provisioning
-- seeded every workspace with MEMORY.md and a memory/ directory, and the
-- gateway faithfully injected the last two days of memory/YYYY-MM-DD.md on
-- session start — but no code ever WROTE a daily note. So the weekly fold had
-- nothing to fold and skipped forever, MEMORY.md stayed exactly as
-- provisioning wrote it, and everything the person actually told Olma lived
-- only in gateway session transcripts that eventually roll away.
--
-- The fix is the rule USER.md already proved: the system writes what it
-- learned as a side effect of the call that learned it, instead of trusting an
-- agent to remember to write a file. A fact is a row, extracted by a job, and
-- rendered into the card the agent reads every turn.
--
-- No embeddings, deliberately. Retrieval is a fixed Top-K in the card plus
-- ILIKE on demand, which costs nothing in steady state; a vector store would
-- add an always-on dependency to serve four users and 9MB of data.
CREATE TABLE user_facts (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Validated in code (KNOWN_FACT_CATEGORIES), not by a CHECK constraint —
  -- the same call the connection features made, for the same reason: adding a
  -- category should be a one-line change, not a migration.
  category    TEXT NOT NULL,
  fact        TEXT NOT NULL,
  -- 1 ordinary / 2 important / 3 core. Decides what survives the Top-K cut
  -- into USER.md, which is the only retrieval most turns ever get.
  importance  SMALLINT NOT NULL DEFAULT 1,
  -- conversation = a job read it out of a transcript; user_stated = the person
  -- said it to Olma's face and she stored it during the turn.
  source      TEXT NOT NULL DEFAULT 'conversation',
  -- Soft delete. "Forget that" must stop a fact being used without destroying
  -- the record that it was once true — a person correcting Olma is itself
  -- information, and a hard DELETE makes that unrecoverable.
  active      BOOLEAN NOT NULL DEFAULT true,
  -- Facts with a shelf life ("flying to Eilat in September"). Past this, the
  -- row stays for history but stops being retrieved.
  expires_at  TIMESTAMPTZ,
  learned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ordered exactly as topFacts() reads: one index serves both the card render
-- and the list tool.
CREATE INDEX user_facts_user_active ON user_facts (user_id, active, importance DESC, learned_at DESC);

-- Watermark for the extraction job: everything the person said after this has
-- not been looked at yet. NULL means "never extracted", which reads as epoch.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_fact_extraction_at TIMESTAMPTZ;

-- 0 = no floor between extractions, which is the chosen starting point: with a
-- handful of users the cost is noise and the feedback is worth more than the
-- saving. Raising it later throttles the job without touching code.
INSERT INTO feature_flags (key, value) VALUES ('fact_extraction_min_gap_hours', '0')
  ON CONFLICT (key) DO NOTHING;
