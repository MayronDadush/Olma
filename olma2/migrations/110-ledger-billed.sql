-- Whether a ledger row's cost_usd is what the provider actually charged.
--
-- Every money figure on the admin pages is re-priced at render from the token
-- columns through model-pricing.RATES, and the stored cost_usd is read only
-- for a model with no rate. That was right while the stored figure was itself
-- a table price (cost.js, renderCost, 2026-09-06). It stopped being right once
-- the gateway began writing OpenRouter's own charge into every transcript
-- (`usage.cost.totalOrigin = 'provider-billed'`): measured 2026-09-05..10-05,
-- the provider billed $10.01 for 45 real people and the table said less for
-- every one of them, about 30% in all, mostly cache reads the pinned provider
-- charges above the listing.
--
-- TRUE means every call summed into the row was the provider's own figure, so
-- a reader shows cost_usd as it stands. A row that ever took one table-priced
-- call is FALSE for good (the writers AND it), and is re-priced exactly as
-- before. Additive, defaulted: every existing row is FALSE and renders as it
-- did, and a code rollback simply never reads the column.
ALTER TABLE usage_ledger        ADD COLUMN IF NOT EXISTS billed boolean NOT NULL DEFAULT false;
ALTER TABLE usage_system_ledger ADD COLUMN IF NOT EXISTS billed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN usage_ledger.billed IS 'every call in cost_usd was the provider''s stated charge; readers show it as is instead of re-pricing (model-pricing.ledgerRowCost)';
COMMENT ON COLUMN usage_system_ledger.billed IS 'every call in cost_usd was the provider''s stated charge; readers show it as is instead of re-pricing (model-pricing.ledgerRowCost)';
