-- 0066 — when the paid period ends
-- (Phase 12 Wave 4; the gap the console made obvious)
--
-- `identity.orgs` could say when a TRIAL ends (0059's trial_ends_at) and when
-- a past-due GRACE period ends (billing_grace_ends_at), and nothing at all
-- about the state most paying customers are in. An `active` org showed an
-- empty "ends" column in every surface — the operator console's billing tab,
-- the owner's own settings page — because there was no column to fill it
-- from, which reads as missing data rather than as a missing feature.
--
-- ==========================================================================
-- A MIRROR OF THE PROCESSOR'S PERIOD, LIKE billing.invoices
-- ==========================================================================
--
-- Stripe owns the billing cycle; this records what it last told us. Two
-- consequences worth stating rather than discovering:
--
--   1. It can be STALE. A subscription whose period rolled while our webhook
--      was undeliverable keeps the old date until the next event or an
--      explicit reconcile. Every surface that shows it should therefore show
--      it as information, never as an authorization input — nothing gates on
--      this column, and nothing should start to.
--   2. It is NULL for an org that has never had a subscription, which is most
--      of them. Trialing, free, and never-converted orgs all read NULL, and
--      that is the honest answer rather than a zero date.
--
-- Deliberately NOT a CHECK against billing_status. A subscription that has
-- been cancelled keeps its period end until the period actually expires —
-- Stripe bills through the end of a paid month — so `canceled` with a future
-- period end is a real and common state, not a contradiction.

ALTER TABLE identity.orgs
  ADD COLUMN current_period_end timestamptz,
  ADD COLUMN current_price_cents bigint,
  ADD COLUMN current_price_interval text,
  ADD COLUMN pending_plan_id text REFERENCES billing.plans (id) ON DELETE RESTRICT,
  ADD COLUMN pending_plan_effective_at timestamptz,
  ADD CONSTRAINT orgs_current_price_cents_nonnegative
    CHECK (current_price_cents IS NULL OR current_price_cents >= 0),
  ADD CONSTRAINT orgs_current_price_interval_valid
    CHECK (current_price_interval IS NULL OR current_price_interval IN ('month', 'year')),
  ADD CONSTRAINT orgs_pending_plan_complete
    CHECK ((pending_plan_id IS NULL) = (pending_plan_effective_at IS NULL));

-- The console's "what renews soon" read, and the shape a future renewal
-- reminder would scan. Partial: most orgs have no subscription at all, and
-- indexing their NULLs would be indexing the table.
CREATE INDEX orgs_current_period_end_idx
  ON identity.orgs (current_period_end)
  WHERE current_period_end IS NOT NULL;

-- The sweep's scan: "which parked downgrades are now due". Partial, because
-- a pending change is rare and indexing the NULLs would index the table.
CREATE INDEX orgs_pending_plan_effective_at_idx
  ON identity.orgs (pending_plan_effective_at)
  WHERE pending_plan_effective_at IS NOT NULL;

COMMENT ON COLUMN identity.orgs.current_period_end IS
  'When the paid period renews, mirrored from the processor. Can be stale if a webhook was missed; information only, never an authorization input (migration 0066).';
