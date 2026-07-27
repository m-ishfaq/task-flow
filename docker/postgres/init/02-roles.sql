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
-- Baseline grants.
-- ---------------------------------------------------------------------------
GRANT CONNECT ON DATABASE taskflow TO taskflow_app, taskflow_migrator, taskflow_audit;

-- Only the migrator may create schemas. The app role deliberately cannot: if it
-- could, a compromised runtime could create objects outside RLS coverage, or
-- drop the policies protecting existing tables.
GRANT CREATE ON DATABASE taskflow TO taskflow_migrator;

-- Revoke the implicit PUBLIC grant on the public schema — nothing should be
-- created there, and no role should get privileges by default.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO taskflow_migrator;

-- USAGE lets a role RESOLVE names inside a schema; it grants no access to any
-- table. Without it the app cannot reach its own tables at all ("permission
-- denied for schema"). Every migration that creates a schema (identity, work,
-- chat, docs, comms, platform, audit — §7) must repeat this pairing:
--
--   GRANT USAGE ON SCHEMA <name> TO taskflow_app;
--   ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA <name>
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taskflow_app;
--
-- Table-level access still comes from the grants below, and row-level access
-- still comes from RLS. This only makes the namespace visible.
GRANT USAGE ON SCHEMA public TO taskflow_app, taskflow_audit;

-- Objects the migrator creates must be usable by the app role WITHOUT the app
-- role ever being granted DDL rights. Default privileges apply to future objects;
-- each migration that creates a schema repeats this for that schema.
ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taskflow_app;

ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO taskflow_app;

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
