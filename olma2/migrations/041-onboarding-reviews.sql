-- The onboarding review (src/domain/onboarding-review.js, src/jobs/onboarding-review.js).
-- Three hours after a person's first message, their first hours are read back
-- by the checks and the answer is kept here — one row per person, for ever,
-- clean ones included, because a review that only appears when something is
-- wrong cannot tell you the rate.
CREATE TABLE IF NOT EXISTS onboarding_reviews (
  id              serial PRIMARY KEY,
  user_id         integer NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  reviewed_at     timestamptz NOT NULL DEFAULT now(),
  window_start    timestamptz,
  window_end      timestamptz,
  worst           text NOT NULL DEFAULT 'clean',
  findings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Everything the checks were shown, so a finding can be argued with months
  -- later without the transcript still being on disk.
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at timestamptz
);

CREATE INDEX IF NOT EXISTS onboarding_reviews_reviewed_idx
  ON onboarding_reviews (reviewed_at DESC);
