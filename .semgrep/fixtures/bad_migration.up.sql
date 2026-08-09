-- FIXTURE — deliberately wrong. Not a real migration; never applied.
--
-- Exists so scripts/check-migration-rls.mjs can assert that the RLS checks
-- actually fire. A security check that silently matches nothing is worse than
-- no check, because the protection is assumed but absent (PLAN.md 2.3).
--
-- It stays under .semgrep/fixtures even though the checks are no longer Semgrep
-- rules: this is where the deliberately-wrong code lives, and the full Semgrep
-- scan already excludes the directory. Moving it would mean teaching that
-- exclusion a second path for no gain.
--
-- Expected findings:
--   tenant-table-without-force-rls   (ENABLE without FORCE)
--   rls-policy-without-nullif        (bare ::uuid cast)
--   rls-policy-without-with-check    (USING but no WITH CHECK)
--   rls-exempt-table-grew-a-column   (an RLS-exempt table carrying a secret)

CREATE TABLE work.bad_example (
  id     serial PRIMARY KEY,
  org_id uuid NOT NULL,
  data   text NOT NULL
);

ALTER TABLE work.bad_example ENABLE ROW LEVEL SECURITY;

CREATE POLICY bad_example_tenant_isolation ON work.bad_example
  USING (org_id = current_setting('app.org_id', true)::uuid);

-- The RLS-exempt lookup table, with a column it must never have.
--
-- comms.subaccount_orgs is exempt from the FORCE-RLS rule because it is a
-- pre-tenant lookup holding nothing but a carrier SID and an org id. That
-- argument expires the instant it holds a credential — so the checker bounds
-- the exemption by its COLUMN SET, and this is the fixture proving it fires.
CREATE TABLE comms.subaccount_orgs (
  subaccount_sid text NOT NULL PRIMARY KEY,
  org_id         uuid NOT NULL,
  auth_token     text NOT NULL,

  CONSTRAINT subaccount_orgs_sid_present CHECK (length(subaccount_sid) > 0)
);
