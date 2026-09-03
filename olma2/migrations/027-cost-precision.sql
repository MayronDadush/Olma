-- cost_usd was numeric(10,4), so Postgres rounded every write to a hundredth
-- of a cent. recordUsage does one INSERT ... ON CONFLICT per CALL, adding a
-- rounded amount each time, so anything under $0.00005 was added as exactly
-- zero — for ever, no matter how many of them there were. Probed live
-- 2026-09-03: a real deepseek-v4-flash completion reported usage.cost =
-- $0.00000686, which this column could only store as 0.0000.
--
-- That is the same shape as every other invisible-spend bug in this file: the
-- number is not wrong in a way anyone would notice, it is simply absent, and
-- the page looks healthy. Widening the scale is additive and backward
-- compatible — every existing value re-reads identically at the new scale, and
-- a code rollback keeps working against it, which is what a migration has to
-- guarantee here since --restart rolls back CODE only.
ALTER TABLE usage_ledger        ALTER COLUMN cost_usd TYPE numeric(14, 8);
ALTER TABLE usage_system_ledger ALTER COLUMN cost_usd TYPE numeric(14, 8);
ALTER TABLE media_usage_ledger  ALTER COLUMN cost_usd TYPE numeric(14, 8);
ALTER TABLE media_jobs          ALTER COLUMN cost_usd TYPE numeric(14, 8);
