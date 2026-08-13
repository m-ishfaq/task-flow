-- Reverses 0062.
--
-- Children before parents, the ordering tenancy-seed.ts's clearTenant already
-- documents for Work and that Phase 6 Wave 4's own test suite learned the hard
-- way: billing.plan_prices references billing.plans, so dropping the parent
-- first is refused by the foreign key.
--
-- DROP TABLE takes the table's policies, indexes and grants with it, so the
-- only thing needing an explicit reversal is the schema-level USAGE grant --
-- which outlives every table in it, and which 0059 had given to taskflow_app
-- alone before this migration widened it.

DROP TABLE IF EXISTS billing.org_entitlements;
DROP TABLE IF EXISTS billing.plan_prices;
DROP TABLE IF EXISTS billing.plans;

REVOKE USAGE ON SCHEMA billing FROM taskflow_platform_admin;
