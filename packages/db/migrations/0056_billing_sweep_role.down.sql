-- 0056 down — remove the billing sweep's grants and policies (Phase 12
-- Wave 3 §3.4). The role itself is dropped in docker/postgres/init, never
-- here — the same split its creation follows.

DROP POLICY IF EXISTS orgs_billing_sweep_read ON identity.orgs;

REVOKE SELECT (id, billing_status, trial_ends_at, billing_grace_ends_at) ON identity.orgs
  FROM taskflow_billing_sweep;

REVOKE USAGE ON SCHEMA identity FROM taskflow_billing_sweep;
