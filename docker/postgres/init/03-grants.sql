-- TaskFlow — per-database grants (PLAN.md §8.3, §8.6)
--
-- Applied to EVERY database that runs the schema: `taskflow` for development,
-- `taskflow_test` for the integration suites. Roles are cluster-wide and are
-- created once in 02-roles.sql; privileges are per-database and therefore live
-- here, where they can be replayed against a second database instead of being
-- copied into a second file.
--
-- That matters more than it looks. The test suites are the thing that proves
-- RLS works, and they only prove it if they run as a role with exactly the
-- privileges production has. A test database set up by hand — with a grant
-- missing, or an extra one added to make something pass — turns guardrail 3
-- into a test that agrees with itself.
--
-- The database is named by `current_database()` rather than written literally,
-- which is what makes replaying this against `taskflow_test` possible at all.

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO taskflow_app, taskflow_migrator, taskflow_audit, taskflow_realtime, taskflow_collab, taskflow_backlinks, taskflow_notification_sweep, taskflow_recording_ingest, taskflow_platform_admin, taskflow_search, taskflow_automation, taskflow_webhook, taskflow_api_token_auth, taskflow_billing_sweep, taskflow_ops_events, taskflow_analytics',
    current_database()
  );

  -- Only the migrator may create schemas. The app role deliberately cannot: if
  -- it could, a compromised runtime could create objects outside RLS coverage,
  -- or drop the policies protecting existing tables.
  EXECUTE format('GRANT CREATE ON DATABASE %I TO taskflow_migrator', current_database());
END
$$;

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
GRANT USAGE ON SCHEMA public TO taskflow_app, taskflow_audit, taskflow_realtime;

-- Objects the migrator creates must be usable by the app role WITHOUT the app
-- role ever being granted DDL rights. Default privileges apply to future objects;
-- each migration that creates a schema repeats this for that schema.
ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taskflow_app;

ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO taskflow_app;
