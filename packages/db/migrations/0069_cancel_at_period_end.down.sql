-- Down for 0069. The column carries no data the processor cannot re-supply on
-- the next reconcile, so dropping it loses a mirror rather than a record.
ALTER TABLE identity.orgs
  DROP COLUMN IF EXISTS cancel_at_period_end;
