-- 0032 — platform admin: org governance & the platform-operator trust tier
-- (Phase 12 Wave 1, ai/phase-12-admin.md)
--
-- Four things land in this one migration, because none of them is
-- independently useful without the others (ai/phase-12-admin.md §5):
--
--   1. platform.operators — the flat operator flag (§3.1). No role column,
--      no scoped permissions: everyone in this table can do everything this
--      wave's console offers. The strictest grant surface in the system —
--      see the GRANT block below for why taskflow_app gets SELECT and
--      nothing else, ever.
--   2. platform.flag_overrides — the missing store `packages/feature-flags`'
--      evaluator has always been shaped for (`orgOverrides`) but nothing
--      ever persisted (§3.8). Global only; no per-org row shape yet.
--   3. platform.operator_chain_head / platform.operator_audit_log — a
--      SECOND hash chain, mirroring audit.audit_log's trigger-computed,
--      length-prefixed chain from migration 0007, but globally chained
--      (one operator population, not one per tenant) rather than per-org
--      (§4). platform.chain_field() duplicates audit.chain_field() rather
--      than reusing it across schemas — see the function's own comment.
--   4. taskflow_platform_admin — a SIXTH cross-tenant consumer role
--      (taskflow_audit, taskflow_realtime, taskflow_collab,
--      taskflow_notification_sweep, taskflow_backlinks precede it),
--      NOBYPASSRLS like every one of them, reaching identity.orgs and
--      identity.memberships only through the permissive policies below
--      (§3.7). Created in docker/postgres/init/02-roles.sql, not here —
--      roles are cluster-wide, policies are per-database, and this
--      migration only ever references a role that already exists, exactly
--      the taskflow_backlinks precedent in migration 0025.
--
-- Slice C (this session's added scope, ai/phase-12-admin.md §3.9's own
-- "confirm before built" recommendation, confirmed): two narrow read
-- policies letting taskflow_audit and taskflow_notification_sweep see
-- identity.orgs.status, so the Phase 9 sweeps can exclude a suspended org's
-- members. Column-limited to (id, status) — neither role gains any other
-- reach into identity.orgs.

-- --------------------------------------------------------------------------
-- 1. platform.operators
--
-- WHO MAY WRITE THIS TABLE MATTERS AS MUCH AS WHO MAY READ IT (§3.1). If
-- taskflow_app — the ordinary role every route runs as — held INSERT or
-- UPDATE here, any bug in any future route reachable by any authenticated
-- user would be a path to self-granting platform-operator access. So
-- taskflow_app gets SELECT only, below. No role reachable from application
-- code gets INSERT/UPDATE/DELETE — rows are written by a migration or by a
-- one-off script connected as taskflow_migrator (§7 decision 7), never by a
-- route. Stricter than every other cross-tenant role in this system, because
-- this table's entire purpose is deciding who bypasses tenant isolation —
-- "no application code can write this, ever" is the correct answer here,
-- not merely the cautious one.
--
-- No RLS: this is not tenant data, the same reasoning identity.users (no RLS
-- at all) and platform.operator_audit_log below already rest on. Access is
-- controlled by GRANTs alone.
-- --------------------------------------------------------------------------
CREATE TABLE platform.operators (
  user_id     uuid        PRIMARY KEY REFERENCES identity.users (id) ON DELETE CASCADE,
  granted_by  uuid        NOT NULL REFERENCES identity.users (id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  -- Who this is and why, free text, never blank — the accountability record
  -- for a row nothing in this system will ever let application code write.
  note        text        NOT NULL,

  CONSTRAINT operators_note_present CHECK (length(btrim(note)) > 0)
);

-- --------------------------------------------------------------------------
-- 2. platform.flag_overrides (§3.8)
--
-- A single GLOBAL override table, not a per-org one — the evaluator's
-- `orgOverrides` context parameter is real and already shaped for per-org
-- targeting, and stays unused by this wave (a conscious, named cut, not
-- silence — see the spec). No RLS, for the identical reason platform.operators
-- has none: this is not tenant data.
-- --------------------------------------------------------------------------
CREATE TABLE platform.flag_overrides (
  flag_name   text        PRIMARY KEY,
  value       boolean     NOT NULL,
  set_by      uuid        NOT NULL REFERENCES identity.users (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- 3. The operator audit chain (§4)
--
-- Same hash-chain SHAPE audit.audit_log's migration 0007 established — a
-- trigger computes seq/prev_hash/hash under a row lock, so a writer cannot
-- choose its own position or digest — but GLOBALLY chained: one head row,
-- not one per org, because there is exactly one operator population to
-- account for. No partitioning: this is an accountability log for a
-- realistically single- or double-digit population of operators, not a
-- product-event stream at audit.audit_log's volume.
-- --------------------------------------------------------------------------
CREATE TABLE platform.operator_chain_head (
  -- A singleton row. `id` is always `true`; the CHECK makes a second row
  -- impossible rather than merely unlikely.
  id    boolean PRIMARY KEY DEFAULT true,
  seq   bigint  NOT NULL,
  hash  bytea   NOT NULL,

  CONSTRAINT operator_chain_head_singleton CHECK (id)
);

CREATE TABLE platform.operator_audit_log (
  -- A plain column, not GENERATED ALWAYS AS IDENTITY: the value is assigned
  -- entirely by platform.operator_chain_entry()'s BEFORE INSERT trigger
  -- below, under the head-row lock, the same way audit.audit_log's own `seq`
  -- is trigger-assigned rather than sequence-generated (migration 0007). An
  -- identity column here would work — Postgres lets a BEFORE trigger
  -- override an identity column's computed value — but the identity
  -- sequence would advance on every insert while never actually being used,
  -- which is confusing rather than merely unnecessary.
  seq         bigint      PRIMARY KEY,
  operator_id uuid        NOT NULL REFERENCES identity.users (id),
  -- e.g. 'orgs.suspend', 'orgs.list', 'flags.set' — a short, stable string,
  -- never user input.
  action      text        NOT NULL,
  -- { orgId } or { userId }, or null for a bare list call with no single
  -- resource named.
  target      jsonb,

  prev_hash   bytea,
  hash        bytea       NOT NULL,

  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX operator_audit_log_operator_idx
  ON platform.operator_audit_log (operator_id, occurred_at DESC);

-- One field, encoded so its boundaries are unambiguous — a duplicate of
-- audit.chain_field() (migration 0007), not a call to it. Reusing the
-- audit-schema function would mean granting taskflow_platform_admin USAGE
-- on schema audit just to call one helper, which blurs a boundary worth
-- keeping sharp: this role touches identity.orgs/identity.memberships and
-- platform.* tables, never anything under the audit schema.
CREATE FUNCTION platform.chain_field(v text) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN v IS NULL THEN '-' ELSE octet_length(v)::text || ':' || v END
$$;

CREATE FUNCTION platform.operator_chain_entry() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  head_seq  bigint;
  head_hash bytea;
BEGIN
  -- Create the singleton head on the first-ever entry, then lock it. One
  -- global lock, not one per org — there is exactly one chain here.
  INSERT INTO platform.operator_chain_head (id, seq, hash)
       VALUES (true, 0, '\x'::bytea)
  ON CONFLICT (id) DO NOTHING;

  SELECT seq, hash INTO head_seq, head_hash
    FROM platform.operator_chain_head
   WHERE id = true
     FOR UPDATE;

  NEW.seq := head_seq + 1;
  NEW.prev_hash := CASE WHEN head_seq = 0 THEN NULL ELSE head_hash END;

  -- Field order is part of the contract with the verifier
  -- (packages/security/src/audit-chain.ts's OperatorChainEntry /
  -- operatorEntryHash). Appending a column here changes every subsequent
  -- hash, so a schema change to this list is a chain migration, not an edit.
  NEW.hash := public.digest(
    head_hash || convert_to(
      platform.chain_field(NEW.seq::text) ||
      platform.chain_field((extract(epoch FROM NEW.occurred_at) * 1000)::bigint::text) ||
      platform.chain_field(NEW.operator_id::text) ||
      platform.chain_field(NEW.action) ||
      platform.chain_field(NEW.target::text),
      'UTF8'),
    'sha256');

  UPDATE platform.operator_chain_head
     SET seq = NEW.seq, hash = NEW.hash
   WHERE id = true;

  RETURN NEW;
END
$$;

CREATE TRIGGER operator_audit_log_chain
  BEFORE INSERT ON platform.operator_audit_log
  FOR EACH ROW EXECUTE FUNCTION platform.operator_chain_entry();

-- --------------------------------------------------------------------------
-- Grants — platform.operators, platform.flag_overrides,
-- platform.operator_chain_head, platform.operator_audit_log
--
-- CAUTION, discovered the hard way while verifying this migration against
-- real Postgres: migration 0001 sets ALTER DEFAULT PRIVILEGES on every
-- schema this app uses, including `platform`, so taskflow_app AUTOMATICALLY
-- receives SELECT/INSERT/UPDATE/DELETE on every table taskflow_migrator
-- creates here — with no GRANT statement of this migration's own asking for
-- it. That default is correct and wanted for most platform.* tables (e.g.
-- push_subscriptions, where taskflow_app inserting IS a person registering
-- their own device) and WRONG for all four tables in this section, where
-- the entire security argument is what taskflow_app must NOT be able to do.
-- A plain `GRANT SELECT ON platform.operators TO taskflow_app` — the first
-- version of this migration — reads as "the narrow, correct grant" and is
-- actually a no-op layered on top of a silent INSERT/UPDATE/DELETE nobody
-- asked for. The REVOKEs below are not defensive boilerplate; they are the
-- control.
-- --------------------------------------------------------------------------

-- taskflow_app keeps SELECT (isPlatformOperator's own read) and loses
-- everything the schema default silently handed it — INSERT/UPDATE/DELETE
-- on the one table in this system where "no application code can write
-- this, ever" is the correct answer (§3.1).
REVOKE INSERT, UPDATE, DELETE ON platform.operators FROM taskflow_app;

-- taskflow_app keeps SELECT (resolving a flag needs to see the override)
-- and loses write access — only an operator, through
-- taskflow_platform_admin, may set or clear one.
REVOKE INSERT, UPDATE, DELETE ON platform.flag_overrides FROM taskflow_app;

-- taskflow_app gets NOTHING on the operator accountability log — an
-- ordinary request has no business reading or writing it, and operators
-- read their own audit tab through taskflow_platform_admin instead.
REVOKE ALL ON platform.operator_audit_log FROM taskflow_app;
REVOKE ALL ON platform.operator_chain_head FROM taskflow_app;

-- taskflow_platform_admin: SELECT on operators (the same isPlatformOperator
-- read, available over either connection — the route layer uses
-- taskflow_app's), full read/write on flag_overrides, and INSERT/SELECT on
-- its own audit chain (the trigger runs as the inserting role, so it also
-- needs the head table — mirroring taskflow_audit's identical need on
-- audit.chain_heads in migration 0007, including the identical accepted
-- trade: a compromised taskflow_platform_admin could forge a head, but still
-- cannot alter an existing operator_audit_log row).
GRANT SELECT ON platform.operators TO taskflow_platform_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.flag_overrides TO taskflow_platform_admin;
GRANT SELECT, INSERT ON platform.operator_audit_log TO taskflow_platform_admin;
GRANT SELECT, INSERT, UPDATE ON platform.operator_chain_head TO taskflow_platform_admin;

-- --------------------------------------------------------------------------
-- 4. taskflow_platform_admin's reach into identity.orgs / identity.memberships
-- (§3.7)
--
-- identity.orgs has FORCE ROW LEVEL SECURITY (migration 0004) with
-- orgs_tenant_isolation (org_id = app.org_id) and the permissive
-- orgs_self_read (app.user_id-keyed). withGlobalScope clears BOTH session
-- variables, so a query run in it would see neither policy apply — the read
-- would silently return an empty list, the write would be refused by
-- WITH CHECK. Rather than reach for withGlobalScope here (wrong for exactly
-- the reason `identity.orgs` is real tenant data, not a pre-tenant table
-- like identity.users), this migration adds a fifth cross-tenant consumer
-- role's own permissive policies, following the taskflow_audit /
-- taskflow_realtime / taskflow_notification_sweep / taskflow_backlinks
-- precedent exactly: every one of them NOBYPASSRLS, reaching across tenants
-- only through policies that explicitly name them.
--
-- The write policy is intentionally as wide as UPDATE gets — WITH CHECK
-- (true) — because this role should not be able to write anything the
-- APPLICATION CODE running as it doesn't already constrain to `status`
-- alone. The code is the real boundary; the grant is the outer one — the
-- identical relationship taskflow_backlinks' column-level grant already has
-- with docs.page_versions. packages/db's tests assert the service only ever
-- sets `status` through this connection.
-- --------------------------------------------------------------------------

CREATE POLICY orgs_platform_admin_read ON identity.orgs
  FOR SELECT TO taskflow_platform_admin USING (true);

CREATE POLICY orgs_platform_admin_status_write ON identity.orgs
  FOR UPDATE TO taskflow_platform_admin
  USING (true) WITH CHECK (true);

-- memberCount for platformAdmin.orgs.list — a read, scoped the same way,
-- since counting members is a read the console needs and nothing about it
-- should imply write access to membership rows.
CREATE POLICY memberships_platform_admin_read ON identity.memberships
  FOR SELECT TO taskflow_platform_admin USING (true);

GRANT USAGE ON SCHEMA identity TO taskflow_platform_admin;
GRANT USAGE ON SCHEMA platform TO taskflow_platform_admin;
GRANT SELECT, UPDATE ON identity.orgs TO taskflow_platform_admin;
GRANT SELECT ON identity.memberships TO taskflow_platform_admin;

-- identity.users carries no RLS at all (verified: no ENABLE ROW LEVEL
-- SECURITY on it anywhere in the migration history) — the same property
-- that lets login resolve any email to an account before any org is known.
-- platformAdmin.users.list reads it through withGlobalScope, correctly this
-- time (§3.6): no new grant needed for that role, taskflow_app already has
-- what it needs. taskflow_platform_admin gets no grant on identity.users at
-- all — the users list is a withGlobalScope read on the ordinary
-- application connection, not a taskflow_platform_admin one.

-- --------------------------------------------------------------------------
-- 5. Slice C — org-status visibility for the Phase 9 sweeps
--
-- Two column-limited read policies so due-reminders.ts (taskflow_notification_
-- sweep) and digest.ts/notification-push.ts/notification.projection.ts
-- (taskflow_audit) can exclude a suspended org's members, closing the gap
-- ai/phase-12-admin.md §3.9 names explicitly: enforcement lives in
-- resolveOrgMembership, which nothing outside a live request ever calls, so
-- a cross-tenant sweep with no request context sails past it.
--
-- (id, status) only — neither role gains any other column, and neither
-- gains write access. Counting members, reading a name, or anything else
-- about an org stays out of reach for both.
-- --------------------------------------------------------------------------

CREATE POLICY orgs_audit_status_read ON identity.orgs
  FOR SELECT TO taskflow_audit USING (true);

CREATE POLICY orgs_sweep_status_read ON identity.orgs
  FOR SELECT TO taskflow_notification_sweep USING (true);

-- Both roles already hold USAGE ON SCHEMA identity (migrations 0027 and
-- 0029 respectively) — only the new column-level SELECT is added here.
GRANT SELECT (id, status) ON identity.orgs TO taskflow_audit;
GRANT SELECT (id, status) ON identity.orgs TO taskflow_notification_sweep;
