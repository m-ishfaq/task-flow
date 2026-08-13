-- 0065 — Phase 12 Wave 4: recorded invoices
-- (ai/phase-12-wave4-plans.md; the billing-history decision)
--
-- ==========================================================================
-- WHY WE STORE THESE RATHER THAN FETCHING THEM FROM THE PROCESSOR
-- ==========================================================================
--
-- The alternative was reading Stripe live on every page load. Recording them
-- wins on three counts, and only the third is about performance:
--
--   1. The page works when Stripe does not. A billing history that 500s
--      during a processor incident is exactly the surface a worried customer
--      opens during a processor incident.
--   2. It survives a processor swap. `PaymentProvider` exists so a second
--      implementation is a config change (§3.3); a history that can only be
--      read out of Stripe's API makes "swap processors" mean "lose the
--      record", which is not a swap.
--   3. It is one indexed read instead of a network round trip per view.
--
-- The cost, stated plainly: this table is a MIRROR, not the source of truth.
-- Stripe's own record is authoritative for what a customer was actually
-- charged, and a webhook we never received is an invoice we never learn
-- about. `hosted_invoice_url` is therefore stored on every row — the console
-- and the customer both get a one-click path to the real document rather
-- than being asked to trust this copy.
--
-- ==========================================================================
-- ORG-SCOPED, RLS'd, AND WRITTEN ONLY AFTER THE ORG IS KNOWN
-- ==========================================================================
--
-- The same shape and the same order of operations as `billing.webhook_events`
-- (0059): a Stripe webhook is an unauthenticated POST carrying a customer id,
-- which `billing.customer_orgs` resolves to an org BEFORE any scope opens and
-- before anything here is written. Nothing in this table is reachable until
-- that lookup has succeeded and the signature has verified.
--
-- Money is `bigint` cents, never numeric or float — the same integer-minor-
-- units discipline `comms.spend_ledger` and `billing.plan_prices` keep, so
-- nothing in this codebase ever does decimal arithmetic on money.

CREATE TABLE billing.invoices (
  -- The PROCESSOR's own invoice id as the primary key, not a generated uuid.
  -- Stripe retries a webhook it could not confirm, and a retry carries the
  -- same invoice; making its id the key turns "record this invoice twice"
  -- into an idempotent upsert rather than a duplicate row nothing dedupes.
  provider_invoice_id text        PRIMARY KEY,

  org_id              uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  -- The human-facing number Stripe prints on the document (e.g. "A1B2C3-0001").
  -- Nullable: a draft invoice has none, and one can arrive before it is
  -- finalized.
  number              text,

  -- Closed set, mirroring the processor's own vocabulary that we act on.
  -- Extend the CHECK when a new state is wired in rather than widening it to
  -- free text — a typo here is a row no query can find again.
  status              text        NOT NULL
                        CHECK (status IN ('draft', 'open', 'paid', 'uncollectible', 'void')),

  amount_due_cents    bigint      NOT NULL,
  amount_paid_cents   bigint      NOT NULL DEFAULT 0,
  currency            text        NOT NULL,

  -- The billing period this invoice covers. Both nullable because a one-off
  -- invoice has no period at all.
  period_start        timestamptz,
  period_end          timestamptz,

  -- Stripe's own hosted copy and PDF. Stored rather than derived: the URL
  -- format is Stripe's to change, and a link we constructed ourselves would
  -- break silently the day it does. See the header on why these matter — this
  -- table is a mirror, and these are the path back to the original.
  hosted_invoice_url  text,
  invoice_pdf_url     text,

  -- When the processor issued it, not when we recorded it. A webhook can
  -- arrive late (a retry after an outage), and ordering a customer's history
  -- by OUR clock would put a recovered invoice in the wrong place.
  issued_at           timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoices_amounts_nonnegative
    CHECK (amount_due_cents >= 0 AND amount_paid_cents >= 0),
  CONSTRAINT invoices_currency_is_iso4217
    CHECK (currency ~ '^[a-z]{3}$'),
  -- A period with an end before its start is not a period. Both-or-neither is
  -- not enforced: a one-off invoice legitimately has neither, and Stripe has
  -- been known to send a start with no end on proration lines.
  CONSTRAINT invoices_period_ordered
    CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start)
);

-- The one read this table exists for: "this org's invoices, newest first".
CREATE INDEX invoices_org_issued_at_idx ON billing.invoices (org_id, issued_at DESC);

-- Tenant isolation, generated form, repeated verbatim from packages/db/src/rls.ts
-- exactly as every other tenant table.
ALTER TABLE billing.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.invoices FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoices_tenant_isolation ON billing.invoices;
CREATE POLICY invoices_tenant_isolation ON billing.invoices
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- Grants
-- --------------------------------------------------------------------------
--
-- taskflow_app needs INSERT and UPDATE here, unlike the catalog tables: the
-- webhook handler runs as the ordinary application role inside withOrgScope,
-- and it is the only writer. 0059's ALTER DEFAULT PRIVILEGES already granted
-- all four, so the REVOKE below is the narrowing — DELETE is removed, because
-- a billing record is not something application code should be able to erase.
-- Correcting a wrong invoice is the processor's job, and the correction
-- arrives as another webhook.
REVOKE DELETE ON billing.invoices FROM taskflow_app;

GRANT SELECT, INSERT, UPDATE ON billing.invoices TO taskflow_app;

-- The console reads every org's invoices through the operator role, which has
-- its own permissive policy below for the same reason 0062 gives for
-- org_entitlements: the tenant-isolation policy above keys on app.org_id, and
-- an operator opens no org scope.
GRANT SELECT ON billing.invoices TO taskflow_platform_admin;

DROP POLICY IF EXISTS invoices_platform_admin_read ON billing.invoices;
CREATE POLICY invoices_platform_admin_read ON billing.invoices
  FOR SELECT TO taskflow_platform_admin
  USING (true);

COMMENT ON TABLE billing.invoices IS
  'A MIRROR of the payment processor''s invoices, written by the webhook handler. Stripe remains authoritative for what a customer was charged; hosted_invoice_url is the path back to the original (ai/phase-12-wave4-plans.md).';
