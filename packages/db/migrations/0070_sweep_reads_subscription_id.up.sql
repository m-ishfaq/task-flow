-- 0070 — the billing sweep may see WHETHER an org has a subscription
-- (Phase 12 Wave 4 §3.8, the period-close scan)
--
-- ==========================================================================
-- WHAT BROKE, AND WHY IT DID NOT LOOK LIKE A GRANT PROBLEM
-- ==========================================================================
--
-- `taskflow_billing_sweep` holds a COLUMN-LEVEL grant on `identity.orgs` —
-- exactly `id`, `billing_status`, `trial_ends_at`, `billing_grace_ends_at`,
-- and nothing else. That is deliberate: the scan decides what to LOOK at, and
-- the per-org work runs as `taskflow_app` afterwards.
--
-- The period-close scan added in this wave filtered on
-- `stripe_subscription_id IS NOT NULL`, which is outside that grant. Postgres
-- reports a column the role may not read as:
--
--   permission denied for table orgs
--
-- naming the TABLE, not the column — so it reads as "this role cannot see
-- orgs at all", which is plainly false three lines away where two other scans
-- select from the same table successfully. The same shape as 0064 (`USAGE`
-- reported against a schema) and Wave 3's backlinks relay (`FOR UPDATE`
-- needing SELECT on every column, not only the projected ones). A column
-- grant's refusal always names the table.
--
-- ==========================================================================
-- WHY WIDEN THE GRANT RATHER THAN CHANGE THE QUERY
-- ==========================================================================
--
-- The alternative was to scan `billing_status = 'active'` — already granted —
-- and let `closeUsagePeriod` reject the orgs with no subscription. That works
-- and needs no migration, and it makes every active org pay three reads per
-- tick to be told it has nothing to do. Precision at the scan is what the
-- other two scans already do, and it is what keeps this loop's cost
-- proportional to the number of SUBSCRIBED orgs rather than to the tenant
-- count.
--
-- What is actually being disclosed: an opaque processor identifier, on a role
-- that can already read every org's id and billing status. It reveals "this
-- org has a subscription", which `billing_status` already implies. No amount,
-- no customer, no period. SELECT only — the sweep still writes nothing here,
-- and the write path stays `taskflow_app` under `withOrgScope`.

GRANT SELECT (stripe_subscription_id) ON identity.orgs TO taskflow_billing_sweep;

COMMENT ON COLUMN identity.orgs.stripe_subscription_id IS
  'The processor''s subscription id. Readable by taskflow_billing_sweep (migration 0070) so the period-close scan can find subscribed orgs without reading every active one.';
