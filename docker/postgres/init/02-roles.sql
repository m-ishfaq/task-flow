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

-- ---------------------------------------------------------------------------
-- taskflow_collab — apps/collab's write-exception role (Phase 6 Wave 2,
-- ai/phase-6-docs.md §6.1).
--
-- The ONE role in this system granted write access from inside a socket
-- handler, and scoped as narrowly as that sentence demands: INSERT/SELECT on
-- docs.yjs_updates, INSERT/SELECT on docs.page_versions, DELETE on
-- docs.yjs_updates (compaction's pruning, ai/phase-6-docs.md §3.7) — nothing
-- else. It holds no grant on docs.pages, docs.spaces, or any other tenant
-- table; apps/collab's `onAuthenticate` hook reads those over the ORDINARY
-- taskflow_app connection, exactly as it did in Wave 1 (§6.1's own
-- correction) and exactly as apps/realtime's rooms.ts does for boards. A
-- compromised apps/collab process under this role can reach the CRDT log it
-- owns and nothing else in the tenant's data.
-- ---------------------------------------------------------------------------
CREATE ROLE taskflow_collab WITH LOGIN PASSWORD 'collab-dev-secret' NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOBYPASSRLS;

-- ---------------------------------------------------------------------------
-- taskflow_notification_sweep — the due-reminder scan (Phase 9 Wave 2,
-- ai/phase-9-notifications.md §3.8, migration 0029's own header).
--
-- A SIXTH system role, for the identical reason taskflow_realtime and
-- taskflow_backlinks are separate roles: the sweep reads work.cards across
-- EVERY tenant in one pass, so no value of app.org_id is correct for it.
-- What makes it narrower than every precedent: its grant on work.cards is
-- COLUMN-LEVEL and names only the seven columns needed to decide "is this
-- card due, and who should be told" — never description, rank, or anything
-- else — mirroring taskflow_backlinks' exclusion of page_versions.state.
-- It also reads notification_prefs and writes notification rows plus
-- delivery rows (see migration 0029's header for why that is a deliberate
-- extension of §3.8's letter).
-- ---------------------------------------------------------------------------
CREATE ROLE taskflow_notification_sweep WITH LOGIN PASSWORD 'sweep-dev-secret' NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOBYPASSRLS;

-- ---------------------------------------------------------------------------
-- taskflow_backlinks — the backlinks relay's outbox-style consumer (Phase 6
-- Wave 3, ai/phase-6-docs.md §3.10, migration 0025's own header).
--
-- A FOURTH consumer role, mirroring taskflow_audit and taskflow_realtime:
-- NOBYPASSRLS, reaching across every tenant only on the tables carrying an
-- explicit `TO taskflow_backlinks` policy, for the identical "one relay
-- drains one queue" reason neither of those two roles is tenant-scoped
-- either. Narrower than both precedents in one respect: its claim-step
-- grant on docs.page_versions is COLUMN-LEVEL and excludes `state` — this
-- role can discover WHICH pages changed and never read what changed. The
-- content read that actually extracts links happens afterward, per page,
-- over the ordinary taskflow_app connection under ordinary org scoping —
-- this role never touches docs.backlinks either.
-- ---------------------------------------------------------------------------
CREATE ROLE taskflow_backlinks WITH LOGIN PASSWORD 'backlinks-dev-secret' NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOBYPASSRLS;

-- ---------------------------------------------------------------------------
-- taskflow_platform_admin — the org-directory console (Phase 12 Wave 1,
-- ai/phase-12-admin.md §3.7, migration 0035's own header).
--
-- A FIFTH consumer role on the same pattern as every role in this file:
-- NOBYPASSRLS, reaching across every tenant only on the tables carrying an
-- explicit `TO taskflow_platform_admin` policy. What it can see is the
-- org DIRECTORY — identity.orgs and identity.memberships (control-plane
-- tables) plus identity.users — never a board, card, chat message, or doc
-- page: no policy this wave adds names any product table, and the one table
-- it may WRITE among them is orgs.status alone (the application code is what
-- keeps it to status; the RLS policy is deliberately wide, §3.7). It also
-- owns the global operator audit log: INSERT on platform.operator_audit_log
-- and the head-table grants its chain trigger needs. It holds NOTHING on
-- platform.operators beyond SELECT — no application-reachable role may ever
-- write that table.
-- ---------------------------------------------------------------------------
CREATE ROLE taskflow_platform_admin WITH LOGIN PASSWORD 'platform-admin-dev-secret'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- ---------------------------------------------------------------------------
-- taskflow_recording_ingest — the call-recording ingest sweep (Phase 7 Wave 2,
-- ai/phase-7-voice.md §3.6, migration 0033's own header).
--
-- A FIFTH consumer role, on the same pattern as the four above: NOBYPASSRLS,
-- reaching across tenants only on the one table carrying an explicit
-- `TO taskflow_recording_ingest` policy, because the sweep pulls pending
-- recordings off the carrier for every tenant in one pass and no value of
-- app.org_id is correct for it.
--
-- Its grant is COLUMN-LEVEL on comms.recordings and it holds NOTHING on
-- comms.calls — so the role that fetches a recording cannot learn whose
-- conversation it is, the same separation taskflow_backlinks has from
-- docs.page_versions.state. It also has no INSERT anywhere: a compromised
-- sweep cannot fabricate a recording row pointing at an object it controls.
-- ---------------------------------------------------------------------------
CREATE ROLE taskflow_recording_ingest WITH LOGIN PASSWORD 'recording-dev-secret' NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- ---------------------------------------------------------------------------
-- taskflow_search — the search indexer's outbox CLAIM role (Phase 8 Wave 2,
-- ai/phase-8-search.md §2.3, migration 0045's own header).
--
-- A further consumer role on the identical pattern as every role in this
-- file: NOBYPASSRLS, reaching across every tenant only on the tables carrying
-- an explicit `TO taskflow_search` policy (platform.outbox and
-- platform.outbox_dispatch, scoped to consumer = 'search'). It holds NOTHING
-- on search.documents — the actual indexing happens afterward, per event,
-- over the ordinary taskflow_app connection under ordinary org scoping — the
-- same claim-only separation taskflow_backlinks has from docs.page_versions.
-- ---------------------------------------------------------------------------
CREATE ROLE taskflow_search WITH LOGIN PASSWORD 'search-dev-secret' NOSUPERUSER NOCREATEDB
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
