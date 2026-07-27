-- 0001 — schema namespaces and their grants (PLAN.md §7)
--
-- Creates the seven schemas the system is organized into. Deliberately contains
-- no tables: this migration exists so that every later migration lands in a
-- namespace whose grants and default privileges are already correct.
--
-- The grant pairing repeated for each schema is not optional:
--   * USAGE lets taskflow_app RESOLVE names in the schema. Without it the app
--     gets "permission denied for schema" before RLS is ever consulted.
--   * ALTER DEFAULT PRIVILEGES gives the app DML on tables the migrator creates
--     LATER, so no future migration has to remember to grant.
-- Neither grants row access — that remains RLS's job (§8.3).

CREATE SCHEMA IF NOT EXISTS identity;   -- users, orgs, memberships, sessions
CREATE SCHEMA IF NOT EXISTS authz;      -- roles, permissions, relationship tuples
CREATE SCHEMA IF NOT EXISTS work;       -- projects, boards, lists, cards
CREATE SCHEMA IF NOT EXISTS chat;       -- channels, messages, read cursors
CREATE SCHEMA IF NOT EXISTS docs;       -- spaces, pages, yjs updates
CREATE SCHEMA IF NOT EXISTS comms;      -- calls, recordings, sms, spend ledger
CREATE SCHEMA IF NOT EXISTS platform;   -- activities, notifications, automations
CREATE SCHEMA IF NOT EXISTS audit;      -- append-only, hash-chained audit log

-- --------------------------------------------------------------------------
-- Application role: name resolution + DML on future tables.
-- --------------------------------------------------------------------------
GRANT USAGE ON SCHEMA identity, authz, work, chat, docs, comms, platform TO taskflow_app;

DO $$
DECLARE
  target_schema text;
BEGIN
  FOREACH target_schema IN ARRAY ARRAY['identity','authz','work','chat','docs','comms','platform']
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA %I '
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taskflow_app', target_schema);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA %I '
      'GRANT USAGE, SELECT ON SEQUENCES TO taskflow_app', target_schema);
  END LOOP;
END
$$;

-- --------------------------------------------------------------------------
-- Audit schema (§8.6) — deliberately asymmetric.
--
-- The application may READ the audit log (admins view it in the UI) but must
-- never write to it directly. taskflow_audit holds INSERT and SELECT and is
-- never granted UPDATE or DELETE, so the hash-chained trail cannot be rewritten
-- even if the application role is fully compromised.
-- --------------------------------------------------------------------------
GRANT USAGE ON SCHEMA audit TO taskflow_app, taskflow_audit;

ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA audit
  GRANT SELECT ON TABLES TO taskflow_app;

ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA audit
  GRANT SELECT, INSERT ON TABLES TO taskflow_audit;

ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA audit
  GRANT USAGE, SELECT ON SEQUENCES TO taskflow_audit;
