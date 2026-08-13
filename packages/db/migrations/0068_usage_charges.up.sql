-- 0068 — Phase 12 Wave 4, slice 4: overage invoicing
-- (ai/phase-12-wave4-plans.md §3.8)
--
-- ==========================================================================
-- THE ONE THING THIS TABLE EXISTS TO PREVENT: BILLING SOMEBODY TWICE
-- ==========================================================================
--
-- The period-close job computes an org's telephony overage and pushes one
-- invoice item at the processor. It runs on a timer, on a worker that may be
-- running in two copies, against a processor that can time out AFTER having
-- accepted the call. Every one of those is a route to charging the same
-- period twice, and a duplicate charge is the single worst outcome this
-- module has — worse than not charging at all, because the second one has to
-- be found, refunded, and explained.
--
-- So the claim is a row, and the primary key is the dedupe: (org_id,
-- period_start). The job INSERTs it BEFORE calling the processor, with
-- ON CONFLICT DO NOTHING, and only the writer whose insert reported a row
-- proceeds. Two workers racing on the same period produce exactly one charge,
-- decided by Postgres rather than by a check-then-act both of them pass —
-- the same shape `billing.alerts_sent` (0067) uses for emails and
-- `claimForScanning` uses for attachments.
--
-- The failure direction that leaves is: claimed, then the processor call
-- failed, so nothing was billed and the row blocks a retry. That is
-- deliberate, and `provider_invoice_item_id` is what makes it visible — NULL
-- with a non-NULL `failed_reason` is a period an operator must look at. An
-- automatic retry would have to distinguish "the call never landed" from "the
-- call landed and the response was lost", which the processor's API cannot
-- tell us, and guessing wrong is the duplicate charge again.
--
-- ==========================================================================
-- WHY THE COMPUTED NUMBERS ARE STORED, NOT RECOMPUTED
-- ==========================================================================
--
-- `usage_cents`, `included_cents`, `markup_pct` and `billable_cents` are all
-- written here, even though three of the four could be re-derived from the
-- ledger and the plan. They are stored because the plan is MUTABLE: an
-- operator raising Pro's included allowance next week would silently change
-- what last month's invoice "should have been", and a support conversation
-- about a charge would have no way to reconstruct the inputs that produced
-- it. An invoice is a historical claim about a moment, so it records the
-- moment's numbers.
--
-- ==========================================================================
-- NO RLS-BYPASS ROLE, AND NO DELETE FOR ANYONE
-- ==========================================================================
--
-- Written by `taskflow_app` inside an ordinary `withOrgScope` — the worker
-- scans for candidate orgs with the read-only sweep role and then does the
-- per-org work as the application role, exactly as the trial sweep does. A
-- charge record nothing can delete is the same "the grant is the guarantee"
-- reasoning 0007 uses for the audit log and 0062 for the plan catalog: a bug
-- that erased one of these rows would re-open the period and bill it again.

CREATE TABLE billing.usage_charges (
  org_id                   uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  -- The closed period this charge covers. Half-open [start, end) — a ledger
  -- row exactly on `period_end` belongs to the NEXT period, so no usage is
  -- counted twice and none falls between two periods.
  period_start             timestamptz NOT NULL,
  period_end               timestamptz NOT NULL,

  -- The inputs, frozen. See this file's header on why these are stored.
  usage_cents              bigint      NOT NULL,
  included_cents           bigint      NOT NULL,
  markup_pct               integer     NOT NULL,
  -- max(0, round(usage x (1 + markup/100)) - included). Zero is a legitimate
  -- and common value: an org inside its allowance still gets a row, so the
  -- period is recorded as CLOSED rather than as never-attempted.
  billable_cents           bigint      NOT NULL,

  -- The processor's own id for the invoice item. NULL means either "nothing
  -- to bill" (billable_cents = 0, nothing was sent) or "the call failed" —
  -- `failed_reason` is what separates those two.
  provider_invoice_item_id text,
  failed_reason            text,

  claimed_at               timestamptz NOT NULL DEFAULT now(),
  charged_at               timestamptz,

  PRIMARY KEY (org_id, period_start),

  CONSTRAINT usage_charges_period_ordered
    CHECK (period_end > period_start),
  CONSTRAINT usage_charges_amounts_nonnegative
    CHECK (usage_cents >= 0 AND included_cents >= 0 AND billable_cents >= 0),
  CONSTRAINT usage_charges_markup_sane
    CHECK (markup_pct BETWEEN 0 AND 1000),
  -- The half-states this forbids: a charge that claims to have been sent with
  -- no id, and an id with no timestamp. Recording a charge is two column
  -- writes, and a service that does one of them leaves a period that looks
  -- billed to one query and unbilled to another.
  CONSTRAINT usage_charges_charged_is_complete
    CHECK ((provider_invoice_item_id IS NULL) = (charged_at IS NULL)),
  -- A period cannot both have succeeded and have failed.
  CONSTRAINT usage_charges_not_both_outcomes
    CHECK (provider_invoice_item_id IS NULL OR failed_reason IS NULL)
);

-- The operator console's "which periods need looking at" read, and small
-- enough to stay partial: almost every row is a success or a zero.
CREATE INDEX usage_charges_failed_idx
  ON billing.usage_charges (claimed_at DESC)
  WHERE failed_reason IS NOT NULL;

ALTER TABLE billing.usage_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.usage_charges FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS usage_charges_tenant_isolation ON billing.usage_charges;
CREATE POLICY usage_charges_tenant_isolation ON billing.usage_charges
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- 0059's ALTER DEFAULT PRIVILEGES on schema `billing` grants taskflow_app all
-- four verbs on this table the instant it exists. The REVOKE is what makes
-- the header's "nothing may delete a charge record" true rather than
-- intended — 0036's lesson, and 0062 walked into the same trap one table
-- over. UPDATE is kept: the job claims a row and then writes the outcome.
REVOKE DELETE ON billing.usage_charges FROM taskflow_app;
GRANT SELECT, INSERT, UPDATE ON billing.usage_charges TO taskflow_app;

-- The read-only scan role the worker uses to FIND candidate orgs. SELECT
-- only: it decides what to look at and never what to charge.
--
-- USAGE FIRST, and it is not optional. 0059 granted USAGE on this schema to
-- taskflow_app, and 0062 had to add taskflow_platform_admin for exactly the
-- same reason: USAGE resolves NAMES and confers no access to any object, so a
-- role without it cannot reach a table it holds SELECT on. The failure is
-- `permission denied for schema billing` — which names the schema, not the
-- grant, and reads like the table grant is missing.
--
-- 0064 exists because this was got wrong once already, on `people` for the
-- operator console, and it was found by connecting as the real role rather
-- than by reading the migration. Verified the same way here.
GRANT USAGE ON SCHEMA billing TO taskflow_billing_sweep;
GRANT SELECT ON billing.usage_charges TO taskflow_billing_sweep;

DROP POLICY IF EXISTS usage_charges_sweep_read ON billing.usage_charges;
CREATE POLICY usage_charges_sweep_read ON billing.usage_charges
  FOR SELECT TO taskflow_billing_sweep
  USING (true);

-- The operator console reads every org's charge history from the billing tab.
GRANT SELECT ON billing.usage_charges TO taskflow_platform_admin;

DROP POLICY IF EXISTS usage_charges_platform_admin_read ON billing.usage_charges;
CREATE POLICY usage_charges_platform_admin_read ON billing.usage_charges
  FOR SELECT TO taskflow_platform_admin
  USING (true);

COMMENT ON TABLE billing.usage_charges IS
  'One row per (org, closed period). The primary key IS the double-charge guard: the period-close job claims the row before calling the processor, so two workers racing produce one charge (migration 0068).';
COMMENT ON COLUMN billing.usage_charges.failed_reason IS
  'Set when the processor call failed after the claim. NOT retried automatically — the API cannot distinguish "never landed" from "landed, response lost", and guessing wrong bills twice.';
