-- One row per number `jobs/stranger-greet.js` has greeted because the gateway
-- dropped their first message (2026-10-07: three new people in twenty minutes
-- wrote and heard nothing). The row is the CLAIM, inserted and committed
-- before the send, so a brokerd restart mid-send can never greet anybody
-- twice; `sent_at`/`result` are stamped after the send answers.
--
-- Keyed on the phone and never cleared: a person is told "your first message
-- did not reach me" once in their life, whatever happens next.
--
-- Additive: a new table nothing older reads.
CREATE TABLE IF NOT EXISTS stranger_greetings (
  phone        text PRIMARY KEY,
  lane_first_at timestamptz,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  result       text CHECK (result IN ('sent', 'timed_out', 'failed'))
);
