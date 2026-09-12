-- Voice call quota: a LIFETIME cap (twice, ever — not a windowed daily/hourly
-- allowance), plus the once-per-person stamp for "asked for more calls".
--
-- Both live on users, the same way timezone_asked_at and opening_sent_at do
-- for other once-per-life facts — a dedicated table would be one row per
-- user forever, which is just a second copy of the users row with extra
-- steps. quota_counters' day/hour window shape does not fit "twice, ever".
--
-- Additive and backward-compatible: DEFAULT 0 / NULL means every existing
-- user starts with a full fresh allowance the day this ships. There is no
-- honest backfill from voice_usage_ledger — it is keyed by call_sid/phone
-- for Twilio cost accounting, not by "was this one of the dashboard's 2".
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS voice_call_attempts_used INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS voice_more_requested_at TIMESTAMPTZ;
