-- 0059 — Phase 12 Wave 3: billing & org lifecycle, the data half
-- (ai/phase-12-wave3.md §3.2, §3.5)
--
-- ==========================================================================
-- TWO INDEPENDENT COLUMNS, NOT ONE — billing_status IS NOT status
-- ==========================================================================
--
-- identity.orgs.status (0004) is Wave 1's operator kill switch: manual, for
-- abuse and support tickets, written only by platformAdmin.orgs.suspend /
-- .reactivate. billing_status is a SEPARATE fact, written only by the
-- billing worker sweep and the Stripe webhook handler. Neither writer ever
-- touches the other's column.
--
-- The alternative — folding a lapsed subscription into `status = 'suspended'`
-- — was rejected for a concrete failure mode, not on style: an operator
-- suspends an org for a fraud investigation (status='suspended'); the org's
-- card is fine and Stripe keeps charging it successfully in the background;
-- an automated billing recovery, seeing a paid-up org, would "helpfully"
-- flip status back to 'active' and undo the operator's decision with no way
-- to know a human made it. Two columns make that structurally impossible —
-- the billing sweep can never write `status`, and the platform console can
-- never write `billing_status`.
--
-- resolveOrgMembership (apps/api/src/tenancy/resolve.ts) is widened, not
-- duplicated, to refuse on EITHER `status = 'suspended'` OR
-- `billing_status = 'canceled'` — the same chokepoint Wave 1 already proved
-- covers every org-scoped route, every realtime room join, and every collab
-- page authorization "for free".
--
-- ==========================================================================
-- ONLY 'canceled' BLOCKS — 'trialing'/'active'/'past_due' DO NOT
-- ==========================================================================
--
-- A declined card (`past_due`) keeps working for `billing_grace_ends_at`'s
-- duration. Blocking on the first failed charge would lock an org out over a
-- transient card-network hiccup, which is a worse failure mode than a few
-- extra days of access — the identical "flag, don't block" reasoning 0043's
-- impossible-travel detection already applies. Only the WORKER SWEEP, after
-- the grace period genuinely expires with no recovery, writes
-- `billing_status = 'canceled'` — never a webhook directly, so a single
-- missed or delayed webhook can never be the thing that locks an org out.
--
-- ==========================================================================
-- billing.customer_orgs HAS NO RLS, ON PURPOSE — the identical shape as
-- comms.subaccount_orgs (0032), and exempted in scripts/check-migration-
-- rls.mjs for the identical reason
-- ==========================================================================
--
-- A Stripe webhook is an unauthenticated POST carrying a customer id and
-- nothing else verified yet. To check its signature we would need the org's
-- secret; to read anything under RLS we need an org_id; and the only thing
-- naming the org is the customer id INSIDE the payload we have not verified.
-- Splitting the lookup from everything else resolves the same chicken-and-
-- egg comms.subaccount_orgs already resolves: this table maps a Stripe
-- customer id to an org id and holds NOTHING ELSE. Reading all of it teaches
-- an attacker that some opaque customer id belongs to some opaque org id —
-- no plan, no card, no invoice, no secret. (Unlike Twilio's per-subaccount
-- webhook secret, Stripe signs with ONE account-level secret, so there is no
-- second, RLS'd table this lookup gates entry to the way subaccount_orgs
-- gates comms.subaccounts — this table is simpler than its model for that
-- reason, not less carefully considered.)
--
-- ==========================================================================
-- billing.webhook_events IS RLS'd, ORG-SCOPED, AND WRITTEN ONLY AFTER THE
-- ORG IS KNOWN — mirrors comms.webhook_nonces (0032) exactly
-- ==========================================================================
--
-- Recorded ON SUCCESS, inside the same transaction as the effect it dedupes
-- — not on receipt. Stripe retries a webhook it could not confirm was
-- processed, and a retry carries the same event id; a nonce written on
-- receipt would mark the retry a replay before the handler ever got to
-- finish the work the retry exists to complete.

-- --------------------------------------------------------------------------
-- identity.orgs — the billing state itself
-- --------------------------------------------------------------------------
ALTER TABLE identity.orgs
  ADD COLUMN billing_status          text NOT NULL DEFAULT 'trialing',
  ADD COLUMN plan_id                 text,
  ADD COLUMN trial_ends_at           timestamptz,
  ADD COLUMN billing_grace_ends_at   timestamptz,
  ADD COLUMN stripe_customer_id      text,
  ADD COLUMN stripe_subscription_id text,
  ADD CONSTRAINT orgs_billing_status_valid
    CHECK (billing_status IN ('trialing', 'active', 'past_due', 'canceled'));

CREATE UNIQUE INDEX orgs_stripe_customer_id_key
  ON identity.orgs (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE UNIQUE INDEX orgs_stripe_subscription_id_key
  ON identity.orgs (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- Supports the worker sweep's own conditional-UPDATE scans (§3.4): "every
-- trialing org whose trial has ended" and "every past_due org whose grace
-- has ended" are both range scans over these two columns, run on every
-- sweep tick.
CREATE INDEX orgs_trial_ends_at_idx ON identity.orgs (trial_ends_at)
  WHERE billing_status = 'trialing';
CREATE INDEX orgs_billing_grace_ends_at_idx ON identity.orgs (billing_grace_ends_at)
  WHERE billing_status = 'past_due';

COMMENT ON COLUMN identity.orgs.billing_status IS
  'Independent of status (Wave 1''s operator kill switch). trialing/active/past_due never block; only canceled does, written exclusively by the billing worker sweep after a grace period genuinely expires (Phase 12 Wave 3 §3.2).';
COMMENT ON COLUMN identity.orgs.trial_ends_at IS
  'Set once, at org creation (BILLING_TRIAL_DAYS out). Null once a real subscription exists.';
COMMENT ON COLUMN identity.orgs.billing_grace_ends_at IS
  'Set when billing_status transitions to past_due; cleared on recovery. The sweep''s own deadline for the past_due -> canceled transition.';

-- --------------------------------------------------------------------------
-- billing schema
-- --------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS billing;

GRANT USAGE ON SCHEMA billing TO taskflow_app;

ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA billing
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taskflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA billing
  GRANT USAGE, SELECT ON SEQUENCES TO taskflow_app;

-- --------------------------------------------------------------------------
-- billing.customer_orgs — the pre-tenant lookup (see header above)
-- --------------------------------------------------------------------------
CREATE TABLE billing.customer_orgs (
  stripe_customer_id text NOT NULL PRIMARY KEY,
  org_id             uuid NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE
);

-- --------------------------------------------------------------------------
-- billing.webhook_events — idempotency, org-scoped (see header above)
-- --------------------------------------------------------------------------
CREATE TABLE billing.webhook_events (
  org_id             uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  provider_event_id  text        NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, provider_event_id)
);

CREATE INDEX billing_webhook_events_received_at_idx ON billing.webhook_events (received_at);

ALTER TABLE billing.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.webhook_events FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_events_tenant_isolation ON billing.webhook_events;
CREATE POLICY webhook_events_tenant_isolation ON billing.webhook_events
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
