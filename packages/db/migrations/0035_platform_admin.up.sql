-- 0035 — Phase 12 Wave 1: platform operators, flag overrides, and the global
-- operator audit chain (ai/phase-12-admin.md; PLAN.md §13 row 12).
--
-- Four things land here, and three of them need reading before touching.
--
-- 1. platform.operators IS THE ONE TABLE WHERE "NO APPLICATION CODE CAN WRITE
--    THIS, EVER" IS THE CORRECT ANSWER, not merely the cautious one (§3.1).
--    The rows decide who may bypass tenant isolation, so `taskflow_app` gets
--    SELECT only. No INSERT, UPDATE or DELETE, ever, to any role reachable
--    from application code — the first operator is bootstrapped at the bottom
--    of this file, and later ones by a one-off script connected as
--    `taskflow_migrator`. A route that writes this table would be a
--    privilege-escalation bug with no operator-side control at all.
--
-- 2. platform.operator_audit_log IS A HASH CHAIN, THE GLOBAL SIBLING OF
--    audit.audit_log (0007). Same trigger-under-a-lock design; the head is
--    ONE ROW for the whole platform instead of one per org. The trigger runs
--    SECURITY INVOKER (the same as audit.chain_entry() in 0007 — Postgres
--    does NOT run a plain trigger as the table owner), so every role that
--    holds INSERT on the log also holds SELECT, UPDATE on the head table.
--    That is the one place this migration deliberately diverges from the
--    implementation runbook's claim that the writer needs no head grant; the
--    runbook's own stated precedent, 0007, grants the writer the head table
--    for exactly this reason, and a SECURITY DEFINER trigger would have been
--    the bigger deviation.
--
-- 3. identity.orgs GAINS A CROSS-TENANT READ + STATUS WRITE PATH FOR
--    taskflow_platform_admin (§3.7). That table has FORCE ROW LEVEL SECURITY
--    keyed on app.org_id, so `withGlobalScope` can never read it — the whole
--    reason the new role exists is to reach the org DIRECTORY through
--    permissive policies that name it, the same NOBYPASSRLS pattern
--    taskflow_audit / taskflow_backlinks / taskflow_notification_sweep all
--    use. `WITH CHECK (true)` on the UPDATE policy is deliberately as wide as
--    UPDATE gets; the actual boundary is the application code, which only
--    ever sets `status` through this connection (§6's tests prove it).
--
-- 4. The bootstrap operator INSERT is a NO-OP when the placeholder email does
--    not exist in a given environment. In production the real first operator
--    is seeded by running a second, environment-specific INSERT manually as
--    `taskflow_migrator` — this line only makes a fresh dev database usable.

-- --------------------------------------------------------------------------
-- platform.operators — the flat operator flag (§3.1).
-- --------------------------------------------------------------------------
CREATE TABLE platform.operators (
  user_id     uuid        PRIMARY KEY REFERENCES identity.users (id) ON DELETE CASCADE,
  granted_by  uuid        NOT NULL REFERENCES identity.users (id),
  granted_at  timestamptz NOT NULL DEFAULT now(),

  -- Who this is and why, free text, never blank (accountability, §4). The
  -- CHECK enforces "never blank" in the schema, not just in an application
  -- layer — nothing application-layer may ever write this table anyway.
  note        text        NOT NULL CHECK (btrim(note) <> '')
);

GRANT SELECT ON platform.operators TO taskflow_app;

-- --------------------------------------------------------------------------
-- platform.flag_overrides — the global feature-flag override store (§3.8).
-- --------------------------------------------------------------------------
CREATE TABLE platform.flag_overrides (
  flag_name   text        PRIMARY KEY,
  value       boolean     NOT NULL,
  set_by      uuid        NOT NULL REFERENCES identity.users (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Unlike `operators`, this table is meant to be written by the application —
-- through platformRoute, which already gates who can reach it. No RLS: global
-- by design, exactly like the table's name says.
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.flag_overrides TO taskflow_app;

-- --------------------------------------------------------------------------
-- The global operator chain (§4). One head row for the whole platform.
-- --------------------------------------------------------------------------
CREATE TABLE platform.operator_chain_head (
  -- Singleton: exactly one row, ever. The CHECK makes a second INSERT fail
  -- rather than create a fork in the chain.
  id    boolean PRIMARY KEY DEFAULT true CHECK (id),
  seq   bigint  NOT NULL DEFAULT 0,
  hash  bytea   NOT NULL DEFAULT '\x'::bytea
);

INSERT INTO platform.operator_chain_head (id) VALUES (true);

CREATE TABLE platform.operator_audit_log (
  seq         bigint      NOT NULL,
  operator_id uuid        NOT NULL REFERENCES identity.users (id),
  -- 'orgs.suspend', 'orgs.list', 'flags.set', ... — the operator-Action
  -- vocabulary, never user input.
  action      text        NOT NULL,
  -- { orgId } or { userId }, or null for a bare list call.
  target      jsonb,
  -- Null only for the first entry in the chain (the trigger's choice, so
  -- "first entry" is visible in the row instead of inferred from seq = 1).
  prev_hash   bytea,
  hash        bytea       NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (seq)
);

-- Same shape as audit.chain_entry() (0007), with the head lock narrowed to the
-- one global row. FIELD ORDER IN THE DIGEST IS PART OF THE CHAIN'S CONTRACT —
-- reordering it later is a chain migration, not an edit, exactly as 0007's
-- own warning says. `audit.chain_field` is reused rather than duplicated; it
-- is schema-qualified and callable from a platform.* function.
CREATE FUNCTION platform.operator_chain_entry() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  head_seq  bigint;
  head_hash bytea;
BEGIN
  -- Lock the singleton head. One global lock serializes every operator
  -- action into one chain rather than a tree — the same job the per-org row
  -- lock does for audit.audit_log, at platform scale instead of tenant scale.
  SELECT seq, hash INTO head_seq, head_hash
    FROM platform.operator_chain_head
   WHERE id = true
     FOR UPDATE;

  NEW.seq := head_seq + 1;
  NEW.prev_hash := CASE WHEN head_seq = 0 THEN NULL ELSE head_hash END;

  NEW.hash := public.digest(
    head_hash || convert_to(
      audit.chain_field(NEW.seq::text) ||
      audit.chain_field(NEW.operator_id::text) ||
      audit.chain_field(NEW.action) ||
      audit.chain_field(NEW.target::text) ||
      audit.chain_field((extract(epoch FROM NEW.occurred_at) * 1000)::bigint::text),
      'UTF8'),
    'sha256');

  UPDATE platform.operator_chain_head SET seq = NEW.seq, hash = NEW.hash WHERE id = true;
  RETURN NEW;
END
$$;

CREATE TRIGGER operator_audit_log_chain
  BEFORE INSERT ON platform.operator_audit_log
  FOR EACH ROW EXECUTE FUNCTION platform.operator_chain_entry();

-- The writer role. SELECT, INSERT only — never UPDATE or DELETE, the same
-- append-only argument audit.audit_log makes, and the trigger below needs the
-- head table (SECURITY INVOKER — see the header note).
GRANT SELECT, INSERT ON platform.operator_audit_log TO taskflow_platform_admin;
GRANT SELECT, UPDATE ON platform.operator_chain_head TO taskflow_platform_admin;

-- The application role reads the log (the Audit tab renders through the
-- platform-admin connection, but an app-side read must not be impossible) and
-- holds NOTHING that can write it. This mirrors audit.audit_log's own grant
-- split exactly: the dedicated writer holds INSERT, the app role holds SELECT.
GRANT SELECT ON platform.operator_audit_log TO taskflow_app;

-- --------------------------------------------------------------------------
-- taskflow_platform_admin's reach across the org directory (§3.7).
-- --------------------------------------------------------------------------
GRANT USAGE ON SCHEMA identity TO taskflow_platform_admin;
GRANT USAGE ON SCHEMA platform TO taskflow_platform_admin;

-- The org directory: read every org, write status only (the application layer
-- is what keeps it to status — the WITH CHECK is deliberately wide, §3.7).
GRANT SELECT, UPDATE ON identity.orgs TO taskflow_platform_admin;
GRANT SELECT ON identity.memberships TO taskflow_platform_admin;
-- identity.users carries no RLS at all (verified: no ENABLE ROW LEVEL SECURITY
-- anywhere in the migration history) — the grant alone is the whole access.
GRANT SELECT ON identity.users TO taskflow_platform_admin;
GRANT SELECT ON platform.operators TO taskflow_platform_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.flag_overrides TO taskflow_platform_admin;

-- Permissive policies OR together with the tenant-isolation ones (the same
-- property 0004 documents for orgs_self_read), so the platform-admin role
-- sees every org/membership row while taskflow_app's view is unchanged.
DROP POLICY IF EXISTS orgs_platform_admin_read ON identity.orgs;
CREATE POLICY orgs_platform_admin_read ON identity.orgs
  FOR SELECT TO taskflow_platform_admin
  USING (true);

DROP POLICY IF EXISTS orgs_platform_admin_status_write ON identity.orgs;
CREATE POLICY orgs_platform_admin_status_write ON identity.orgs
  FOR UPDATE TO taskflow_platform_admin
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS memberships_platform_admin_read ON identity.memberships;
CREATE POLICY memberships_platform_admin_read ON identity.memberships
  FOR SELECT TO taskflow_platform_admin
  USING (true);

-- --------------------------------------------------------------------------
-- Bootstrap the first operator (§7 decision 7: migration or one-off script,
-- never a route). By email, so it can run in any environment without knowing
-- a user id. A NO-OP (0 rows) in any database where this address does not
-- exist yet — the production seed is a manual, environment-specific INSERT
-- run as taskflow_migrator, deliberately not encoded here.
-- --------------------------------------------------------------------------
INSERT INTO platform.operators (user_id, granted_by, note)
SELECT id, id, 'Bootstrap operator — set by migration 0035'
FROM identity.users
WHERE email_normalized = 'REPLACE_WITH_REAL_OPERATOR_EMAIL@example.com';
