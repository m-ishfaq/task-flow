-- 0055 down — remove billing & org lifecycle's data half (Phase 12 Wave 3).

DROP TABLE IF EXISTS billing.webhook_events;
DROP TABLE IF EXISTS billing.customer_orgs;

ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA billing
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM taskflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA billing
  REVOKE USAGE, SELECT ON SEQUENCES FROM taskflow_app;

REVOKE USAGE ON SCHEMA billing FROM taskflow_app;

DROP SCHEMA IF EXISTS billing;

DROP INDEX IF EXISTS identity.orgs_trial_ends_at_idx;
DROP INDEX IF EXISTS identity.orgs_billing_grace_ends_at_idx;
DROP INDEX IF EXISTS identity.orgs_stripe_customer_id_key;
DROP INDEX IF EXISTS identity.orgs_stripe_subscription_id_key;

ALTER TABLE identity.orgs
  DROP CONSTRAINT IF EXISTS orgs_billing_status_valid,
  DROP COLUMN IF EXISTS billing_status,
  DROP COLUMN IF EXISTS plan_id,
  DROP COLUMN IF EXISTS trial_ends_at,
  DROP COLUMN IF EXISTS billing_grace_ends_at,
  DROP COLUMN IF EXISTS stripe_customer_id,
  DROP COLUMN IF EXISTS stripe_subscription_id;
