-- One-off verification that the RLS mechanism from PLAN.md §8.3 actually works
-- against this Postgres image and these roles. Run manually:
--
--   docker compose exec -T postgres psql -U postgres -d taskflow -f /probe/rls-probe.sql
--
-- This is a smoke test of the MECHANISM, not of application tables. The real,
-- continuously-run protection is the tenancy isolation fuzz test (guardrail 8),
-- which lands in Phase 0B once there are endpoints to fuzz.

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS public.rls_probe (
  id     serial PRIMARY KEY,
  org_id uuid NOT NULL,
  data   text NOT NULL
);

-- Seeded as superuser, which bypasses RLS by design.
TRUNCATE public.rls_probe;
INSERT INTO public.rls_probe (org_id, data) VALUES
  ('11111111-1111-1111-1111-111111111111', 'org A secret'),
  ('22222222-2222-2222-2222-222222222222', 'org B secret');

ALTER TABLE public.rls_probe ENABLE ROW LEVEL SECURITY;

-- FORCE matters: without it, the table OWNER silently bypasses every policy.
-- Migrations must apply FORCE to every tenant table for the same reason.
ALTER TABLE public.rls_probe FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.rls_probe;

-- NULLIF is load-bearing, and this is the canonical form every tenant table
-- must use.
--
-- The obvious spelling — current_setting('app.org_id', true)::uuid — behaves
-- differently for the two ways org context can be absent:
--   * setting never set  -> NULL::uuid   -> comparison NULL -> 0 rows (good)
--   * setting set to ''  -> ''::uuid     -> THROWS 22P02    -> 500 (bad)
--
-- Both are technically fail-closed in that no data escapes, but the second
-- turns a scoping bug into a server error instead of an empty result, and makes
-- behaviour depend on how the context was cleared. NULLIF collapses both to
-- NULL, so an unscoped query returns zero rows in every case.
CREATE POLICY tenant_isolation ON public.rls_probe
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT ON public.rls_probe TO taskflow_app;

COMMIT;

-- ---------------------------------------------------------------------------
-- Assertions, run as the application role.
-- ---------------------------------------------------------------------------
SET ROLE taskflow_app;

DO $$
DECLARE
  visible int;
  leaked  text;
BEGIN
  -- 1. Scoped to org A: exactly one row, and it must be org A's.
  PERFORM set_config('app.org_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) INTO visible FROM public.rls_probe;
  IF visible <> 1 THEN
    RAISE EXCEPTION 'FAIL: org A should see 1 row, saw %', visible;
  END IF;

  SELECT data INTO leaked FROM public.rls_probe;
  IF leaked <> 'org A secret' THEN
    RAISE EXCEPTION 'FAIL: org A saw the wrong row: %', leaked;
  END IF;

  -- 2. Scoped to org B: sees only its own row. Cross-tenant read is impossible.
  PERFORM set_config('app.org_id', '22222222-2222-2222-2222-222222222222', true);
  SELECT data INTO leaked FROM public.rls_probe;
  IF leaked <> 'org B secret' THEN
    RAISE EXCEPTION 'FAIL: org B saw the wrong row: %', leaked;
  END IF;

  -- 3. THE CRITICAL CASE — no org context set at all.
  -- A query that forgets tenant scoping must return ZERO rows, never all rows.
  -- This is what turns a missing WHERE clause from a breach into a bug.
  PERFORM set_config('app.org_id', '', true);
  SELECT count(*) INTO visible FROM public.rls_probe;
  IF visible <> 0 THEN
    RAISE EXCEPTION 'FAIL: unscoped query leaked % row(s) — RLS is not protecting anything', visible;
  END IF;

  RAISE NOTICE 'PASS: RLS isolates by org, and fails closed with no org context.';
END
$$;

RESET ROLE;
DROP TABLE public.rls_probe;
