-- The three separate minute-sweeps (reminders/digests/unblocks) became one
-- 'minute_sweeps' job. Their heartbeat rows would otherwise sit at their last
-- run forever and permanently redden /health — a health check that is always
-- red is a health check nobody reads.
DELETE FROM job_heartbeats WHERE job_name IN ('reminders_sweep', 'digest_sweep', 'unblock_sweep');
