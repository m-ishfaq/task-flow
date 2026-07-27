-- FIXTURE — deliberately wrong. Not a real migration; never applied.
--
-- Exists so scripts/verify-semgrep-rules.sh can assert that the RLS rules
-- actually fire. A security rule that silently matches nothing is worse than no
-- rule, because the protection is assumed but absent (PLAN.md 2.3).
--
-- Expected findings:
--   tenant-table-without-force-rls   (ENABLE without FORCE)
--   rls-policy-without-nullif        (bare ::uuid cast)
--   rls-policy-without-with-check    (USING but no WITH CHECK)

CREATE TABLE work.bad_example (
  id     serial PRIMARY KEY,
  org_id uuid NOT NULL,
  data   text NOT NULL
);

ALTER TABLE work.bad_example ENABLE ROW LEVEL SECURITY;

CREATE POLICY bad_example_tenant_isolation ON work.bad_example
  USING (org_id = current_setting('app.org_id', true)::uuid);
