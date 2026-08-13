-- 0064 — let the platform console read display names
-- (Phase 12 Wave 4 §5; the org directory and the org drill-down).
--
-- ==========================================================================
-- WHAT BROKE, AND WHY NOTHING CAUGHT IT
-- ==========================================================================
--
-- The org directory grew a LEFT JOIN onto people.profiles so the console can
-- show an owner's NAME beside their address, and the org drill-down does the
-- same for every member. Both run as taskflow_platform_admin, which holds
-- USAGE on schema platform (0001), identity (0035) and audit (0036) — and has
-- never held it on people.
--
-- The result was `permission denied for schema people` on
-- platformAdmin.orgs.list: a 500 on the console's FIRST query, so the whole
-- Organizations tab was blank. Not a subtle degradation — but also not
-- something any amount of reading catches, because the join is valid SQL, the
-- table exists, Drizzle types it correctly and `tsc` is perfectly happy. Only
-- a real connection as the real role says otherwise.
--
-- That is 0036's own lesson arriving from the other direction. There, a
-- SECURITY INVOKER trigger could not reach `audit.chain_field` for exactly
-- this reason, and the fix was the same one line. USAGE grants no access to
-- any object — it only allows names in that schema to RESOLVE — so it has to
-- be paired with a table grant, and it has to be repeated for every schema a
-- role's queries reach into.
--
-- ==========================================================================
-- SELECT ON people.profiles, AND NOTHING ELSE IN THE SCHEMA
-- ==========================================================================
--
-- Not `ALL TABLES IN SCHEMA people`, and not `ALTER DEFAULT PRIVILEGES`. The
-- console needs one column off one table; a blanket grant would hand this role
-- every future people table — membership_profiles carries work_phone (0039),
-- which is org-scoped precisely so a number given to one employer is not
-- disclosed to every other — and it would do so silently, as each new table
-- was created.
--
-- The narrow grant is also what keeps the 0035 shape true: this role reads
-- identity and platform to run the console, and holds nothing on any product
-- table. A directory listing is not a reason to widen that.
--
-- people.profiles carries no org_id and has no RLS (it is per-USER, global —
-- see migration 0030), so the grant alone is the whole access, exactly as
-- 0035 notes for identity.users.

GRANT USAGE ON SCHEMA people TO taskflow_platform_admin;

GRANT SELECT ON people.profiles TO taskflow_platform_admin;

COMMENT ON TABLE people.profiles IS
  'Per-user, global (no org_id, no RLS). Readable by taskflow_platform_admin since 0064 for the console''s display names — SELECT only, and only this table in the schema.';
