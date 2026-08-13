-- Reverses 0066. Dropping the columns takes their CHECK constraints and the
-- partial index with them.

DROP INDEX IF EXISTS identity.orgs_current_period_end_idx;
DROP INDEX IF EXISTS identity.orgs_pending_plan_effective_at_idx;

ALTER TABLE identity.orgs
  DROP COLUMN IF EXISTS current_period_end,
  DROP COLUMN IF EXISTS current_price_cents,
  DROP COLUMN IF EXISTS current_price_interval,
  DROP COLUMN IF EXISTS pending_plan_id,
  DROP COLUMN IF EXISTS pending_plan_effective_at;
