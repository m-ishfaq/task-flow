-- 0060 — Phase 12 Wave 3 §3.4: the billing sweep's own role
-- (ai/phase-12-wave3.md §3.4).
--
-- `apps/worker`'s trial/grace-expiry sweep scans `identity.orgs` across
-- every tenant in one pass — "every trialing org whose trial has ended",
-- "every past_due org whose grace has ended" — and no value of `app.org_id`
-- is correct for that, the identical shape 0037 already solved for the
-- notification sweeps. `taskflow_billing_sweep` is a NEW, narrow role rather
-- than widening 0037's existing `taskflow_notification_sweep` grant: this
-- codebase's own standing habit is one role per distinct cross-tenant
-- concern (`taskflow_recording_ingest` sitting alongside
-- `taskflow_backlinks` rather than folded into it, for the identical
-- reason), and reusing a notification-purposed role for a billing concern
-- would blur exactly the separation this wave's whole `billing_status` vs.
-- `status` design is built around.
--
-- ==========================================================================
-- CLAIM ONLY — SELECT, never UPDATE. The identical
-- taskflow_backlinks/taskflow_search/taskflow_automation shape.
-- ==========================================================================
--
-- This role's job is finding WHICH orgs a transition applies to; the actual
-- write happens afterward, per matched org, over the ORDINARY taskflow_app
-- connection inside `withOrgScope` — the same "claim via a narrow
-- cross-tenant role, act via the ordinary one" split every consumer role in
-- this codebase already uses once the claimed rows need real work done.
-- That also means this role never needs its own `WITH CHECK`-carrying write
-- policy: a read-only role has nothing for the migration-RLS checker's
-- write-policy rule to apply to.
--
-- ==========================================================================
-- THIS ROLE MUST NEVER SEE `status`
-- ==========================================================================
--
-- Granting it Wave 1's operator column — even SELECT — would put the
-- ability to observe an operator's suspension decision on a role whose
-- entire job is a scheduled timer with no human judgment behind it. The
-- column-level grant below deliberately excludes it, and excludes
-- `stripe_customer_id`/`stripe_subscription_id` too: this role's job is the
-- STATE MACHINE'S deadlines, never anything Stripe itself reports.

-- The ROLE itself is created in docker/postgres/init/02-roles.sql, never
-- here — taskflow_migrator is NOCREATEROLE by design, so a CREATE ROLE in a
-- migration fails with "permission denied to create role" (0033's own
-- header has the same lesson, learned the same way).

GRANT USAGE ON SCHEMA identity TO taskflow_billing_sweep;

GRANT SELECT (id, billing_status, trial_ends_at, billing_grace_ends_at)
  ON identity.orgs TO taskflow_billing_sweep;

DROP POLICY IF EXISTS orgs_billing_sweep_read ON identity.orgs;
CREATE POLICY orgs_billing_sweep_read ON identity.orgs
  FOR SELECT TO taskflow_billing_sweep
  USING (true);
