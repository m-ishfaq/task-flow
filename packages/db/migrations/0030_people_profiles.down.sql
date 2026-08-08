-- 0030 — people: schema + personal profiles (down)
--
-- Reverses the expand step: drop the schema (and with it the table and the
-- backfilled names — identity.users.display_name still holds the pre-0030
-- truth, so a rollback loses nothing that 0030 did not copy FROM somewhere).
-- The default privileges are revoked too, so an up→down→up cycle leaves no
-- lingering grants for a schema that no longer exists.

DROP TABLE IF EXISTS people.profiles;

ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA people
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM taskflow_app;

ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA people
  REVOKE USAGE, SELECT ON SEQUENCES FROM taskflow_app;

REVOKE USAGE ON SCHEMA people FROM taskflow_app;

DROP SCHEMA IF EXISTS people;
