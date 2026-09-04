-- "Update me when the email arrives" is not a daily digest.
--
-- live_subscriptions has only ever offered daily and weekly, which is right
-- for a weather forecast and useless for the thing a user actually asked for
-- on 2026-09-04: tell me when Amazon mails me the delivery date. Told once a
-- day, the answer arrives up to 23 hours after the fact.
--
-- Widening a CHECK is additive — every existing row still satisfies it, and a
-- rollback of the CODE leaves this constraint in place harmlessly, because
-- nothing writes 'hourly' unless the source registry offers it.
ALTER TABLE live_subscriptions DROP CONSTRAINT IF EXISTS live_subscriptions_cadence_check;
ALTER TABLE live_subscriptions
  ADD CONSTRAINT live_subscriptions_cadence_check
  CHECK (cadence IN ('hourly', 'daily', 'weekly'));
