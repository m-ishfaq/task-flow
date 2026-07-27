-- 0001 down — remove the schema namespaces.
--
-- CASCADE is correct here and only here: this migration created empty schemas,
-- so a full rollback should leave nothing behind. In practice this path runs in
-- exactly two places — local development resets, and the `up -> down -> up`
-- CI verification — never against an environment holding real data.
--
-- Default privileges are keyed to (grantor, schema) and disappear with the
-- schema, so there is nothing further to revoke.

DROP SCHEMA IF EXISTS audit    CASCADE;
DROP SCHEMA IF EXISTS platform CASCADE;
DROP SCHEMA IF EXISTS comms    CASCADE;
DROP SCHEMA IF EXISTS docs     CASCADE;
DROP SCHEMA IF EXISTS chat     CASCADE;
DROP SCHEMA IF EXISTS work     CASCADE;
DROP SCHEMA IF EXISTS authz    CASCADE;
DROP SCHEMA IF EXISTS identity CASCADE;
