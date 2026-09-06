-- The onboarding review (src/domain/onboarding-review.js, src/jobs/onboarding-review.js).
-- A new person's first hours are read back by the checks and the answer is
-- kept here — for ever, clean ones included, because a review that only
-- appears when something is wrong cannot tell you the rate.
--
-- One row per person PER STAGE. There are two, and the second is not a
-- refinement of the first: measured against Yahav's real first day, five of
-- the faults found by hand — a "מחר" about that same morning, two check-in
-- rungs fifty seconds apart, a reminder chased at its third rung, a refusal
-- with nothing filed — all happened between 3.7 and 13 hours in. A review that
-- closes at three hours cannot see any of them. So '3h' catches what is still
-- cheap to fix while the conversation is live, and '1d' reads the whole first
-- day once the night gate, the check-in ladder and the reminders have all had
-- their turn.
CREATE TABLE IF NOT EXISTS onboarding_reviews (
  id              serial PRIMARY KEY,
  user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage           text NOT NULL DEFAULT '3h',
  reviewed_at     timestamptz NOT NULL DEFAULT now(),
  window_start    timestamptz,
  window_end      timestamptz,
  worst           text NOT NULL DEFAULT 'clean',
  findings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Everything the checks were shown, so a finding can be argued with months
  -- later without the transcript still being on disk.
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at timestamptz,
  UNIQUE (user_id, stage)
);

CREATE INDEX IF NOT EXISTS onboarding_reviews_reviewed_idx
  ON onboarding_reviews (reviewed_at DESC);
