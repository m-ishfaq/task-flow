-- TaskFlow — database role separation (PLAN.md §8.3, §8.6)
--
-- This file is the foundation of guardrail 3. Row-Level Security only protects
-- anything if the application connects as a role that CANNOT bypass it. Getting
-- these grants wrong silently disables tenant isolation across the entire system.
--
-- DEV CREDENTIALS ONLY. Production roles are created by Terraform with secrets
-- from the secrets manager, and the app uses short-lived IAM credentials.

-- ---------------------------------------------------------------------------
-- taskflow_migrator — schema owner. Runs DDL and migrations.
-- Elevated by necessity; never used by running application code.
-- ---------------------------------------------------------------------------
CREATE ROLE taskflow_migrator WITH LOGIN PASSWORD 'migrator-dev-secret' NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOBYPASSRLS;

-- ---------------------------------------------------------------------------
-- taskflow_app — the application runtime role.
--
-- NOBYPASSRLS is the single most important attribute in this file. Combined with
-- FORCE ROW LEVEL SECURITY on every tenant table (applied by migrations, since
-- even a table's owner bypasses ordinary RLS), it means a query that forgets its
-- org filter returns zero rows instead of another tenant's data.
-- ---------------------------------------------------------------------------
CREATE ROLE taskflow_app WITH LOGIN PASSWORD 'app-dev-secret' NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOBYPASSRLS;

-- ---------------------------------------------------------------------------
-- taskflow_audit — append-only writer for audit.audit_log (§8.6).
--
-- Holds INSERT and SELECT but never UPDATE or DELETE, so the hash-chained audit
-- trail cannot be rewritten by the application, even if the app role is fully
-- compromised. Grants are applied by the migration that creates the audit schema.
-- ---------------------------------------------------------------------------
CREATE ROLE taskflow_audit WITH LOGIN PASSWORD 'audit-dev-secret' NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOBYPASSRLS;

-- ---------------------------------------------------------------------------
-- taskflow_realtime — the socket gateway's outbox consumer (Phase 4, §3.5).
--
-- A SECOND consumer role rather than reusing taskflow_audit, which is the whole
-- point of migration 0015's per-consumer dispatch table. Two properties follow
-- from the separation, and neither survives sharing one role:
--
--   - The gateway can never write an audit entry. It holds nothing on
--     audit.audit_log, so a bug in the broadcaster cannot append to, or fail a
--     write against, the compliance record.
--   - The gateway can never mark an event dispatched to AUDIT. Migration 0016's
--     policies pin it to consumer = 'realtime' with a WITH CHECK, so a mixed-up
--     consumer name is refused by the database rather than silently erasing an
--     event from the audit relay's queue.
--
-- It reads platform.outbox and writes only its own dispatch bookkeeping. It has
-- no access to any tenant table: the gateway resolves membership and tuples
-- over the ORDINARY taskflow_app connection, under RLS, exactly as the API
-- does — see apps/realtime's env schema for why it holds two URLs.
-- ---------------------------------------------------------------------------
CREATE ROLE taskflow_realtime WITH LOGIN PASSWORD 'realtime-dev-secret' NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOBYPASSRLS;

-- Baseline grants live in 03-grants.sql, NOT here.
--
-- Roles are cluster-wide; grants are per-database. This file creates the roles
-- once, and 03-grants.sql is applied separately to each database that needs
-- them — `taskflow` for development and `taskflow_test` for the suites (see
-- 04-test-database.sql). Keeping the two apart is what lets the test database
-- receive an identical, and therefore trustworthy, privilege setup without the
-- grants being written down twice and drifting.

-- ---------------------------------------------------------------------------
-- Sanity check — fail loudly at container init if any role can bypass RLS.
-- Cheap insurance against a future edit to this file quietly re-enabling it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(rolname, ', ')
    INTO offending
    FROM pg_roles
   WHERE rolname LIKE 'taskflow\_%'
     AND (rolbypassrls OR rolsuper);

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'RLS bypass enabled for role(s): %. Tenant isolation would be disabled. See PLAN.md 8.3.',
      offending;
  END IF;
END
$$;
