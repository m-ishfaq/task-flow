-- 0058 — Phase 10 Wave 4: inbound connector delivery dedupe (ai/phase-10-automation.md §7.4)
--
-- The GitHub delivery-id dedupe row. GitHub puts no timestamp inside its
-- webhook signature (see github-signature.ts's own header), so a captured
-- request can be replayed forever — the X-GitHub-Delivery id is the ONLY
-- replay control. GitHub retries a failed delivery with the SAME delivery id,
-- so the row must be written on SUCCESS inside the handler's own transaction
-- (the nonce-on-success lesson): a failed attempt rolls the row back and the
-- retry proceeds normally, and only a duplicate of a SUCCESS is refused.
--
-- Slack does NOT use this table, and the provider column's CHECK says so:
-- Slack's replay control is the five-minute freshness window inside
-- `verifySlackSignature`, which needs no storage. Keeping the column (rather
-- than naming the table `github_deliveries`) means a future provider with a
-- delivery-id scheme inherits the shape without a migration.
--
-- ==========================================================================
-- WHY `platform` AND WHAT THAT COSTS (the 0036 lesson, restated — a table in
-- this schema begins with ALTER DEFAULT PRIVILEGES from 0001, so taskflow_app
-- already holds full CRUD on it BEFORE any GRANT in this file runs)
-- ==========================================================================
--
-- The REVOKEs below are what make the table append-only: nothing may UPDATE a
-- delivery row's id or org, and nothing may DELETE one. Rows are not pruned,
-- deliberately — GitHub's automatic retries can span days, so any aggressive
-- window would have to be wrong, and the rows are one tiny tuple per GitHub
-- event. The unique index is the control, not the row count.

CREATE TABLE platform.integration_deliveries (
  org_id      uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  provider    text        NOT NULL DEFAULT 'github' CHECK (provider = 'github'),
  delivery_id text        NOT NULL CHECK (length(btrim(delivery_id)) > 0),
  seen_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT integration_deliveries_one UNIQUE (org_id, provider, delivery_id)
);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, verbatim from rls.ts.
-- --------------------------------------------------------------------------

ALTER TABLE platform.integration_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.integration_deliveries FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_deliveries_tenant_isolation ON platform.integration_deliveries;
CREATE POLICY integration_deliveries_tenant_isolation ON platform.integration_deliveries
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- Grants — the app role INSERTs a dedupe row in the handler's own transaction
-- and SELECTs nothing today; the 0036 lesson says what it must NOT have.
-- --------------------------------------------------------------------------
GRANT SELECT, INSERT ON platform.integration_deliveries TO taskflow_app;
REVOKE UPDATE, DELETE ON platform.integration_deliveries FROM taskflow_app;

-- No grant to taskflow_integration_auth: the role that resolves "who is this
-- webhook for" never touches the dedupe table — it holds no writes anywhere
-- (migration 0056), and this table is written only after verification passed,
-- under the org scope the lookup produced.
