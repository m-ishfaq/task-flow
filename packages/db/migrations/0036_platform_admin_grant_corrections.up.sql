-- 0036 — corrections to 0035's grants and its chain trigger (Phase 12 Wave 1).
--
-- Three things 0035 intended and did not achieve, all found by the wave's own
-- §6 tests against a real database rather than by reading diffs:
--
-- 1. 0035 claimed `platform.operators` is SELECT-only for taskflow_app, and
--    granted exactly that. But migration 0001's DO block sets
--    `ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA platform
--    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taskflow_app` — the
--    mechanism that gives the app DML on the outbox and every other platform
--    table the migrator later creates. So when 0035 created `operators`,
--    `operator_audit_log` and `operator_chain_head`, taskflow_app received
--    full CRUD on all three AS A SIDE EFFECT, and 0035's explicit SELECT
--    grants were weaker than what the database already enforced. The REVOKEs
--    below restore the documented intent: the operator table stays
--    write-proof at the grant level (§3.1 — "no application code can write
--    this, ever"), and the operator audit log stays append-only for the app
--    role exactly as audit.audit_log is.
--
--    The lesson generalizes: a migration that creates a table in a schema
--    with default privileges must say what the table should NOT have, not
--    only what it should. A future platform table that must not be
--    app-writable needs the same explicit REVOKE.
--
-- 2. `platform.operator_chain_entry()` runs SECURITY INVOKER (the 0007
--    precedent — Postgres does not run a plain trigger as the table owner)
--    and calls `audit.chain_field()` plus `public.digest()`. taskflow_platform_admin
--    holds USAGE on schema platform and identity (0035) but not on schema
--    audit, so every INSERT into operator_audit_log failed with "permission
--    denied for schema audit". USAGE only resolves names — it grants no
--    access to any object, exactly as 0007's comment says — so granting it is
--    the whole fix for that schema.
--
-- 3. The same USAGE fix does NOT work for schema public, and the reason is a
--    Postgres subtlety worth a comment of its own: `03-grants.sql` grants
--    taskflow_migrator `ALL ON SCHEMA public` WITHOUT GRANT OPTION (the
--    grantor there is the bootstrap superuser, not the migrator), so when
--    this migration tries `GRANT USAGE ON SCHEMA public TO
--    taskflow_platform_admin`, Postgres answers `WARNING: no privileges were
--    granted` and changes NOTHING — a silent no-op, exactly the failure this
--    codebase does not rely on vigilance to catch. The trigger therefore
--    cannot call `public.digest` as SECURITY INVOKER at all.
--
--    The fix is a narrow SECURITY DEFINER wrapper, `platform.operator_chain_hash`,
--    owned by taskflow_migrator (which does hold access to public.digest),
--    IMMUTABLE, pure, and pinned to `search_path = pg_catalog` with the
--    `public.` qualification spelled out — the standard shape for exposing an
--    extension function through a schema the writer role can actually use.
--    The trigger itself stays SECURITY INVOKER, and the 0035 argument for
--    that choice (the writer must be able to forge a head and be CAUGHT as a
--    chain break, rather than running trigger code as the schema owner) is
--    unchanged. The digest preimage is byte-identical to 0035's — the hash
--    contract with the verifier is untouched.

GRANT USAGE ON SCHEMA audit TO taskflow_platform_admin;

-- The one function the trigger may not reach on its own. SECURITY DEFINER
-- here is not a privilege escalation: the body is a pure, immutable SELECT
-- over its two arguments and can touch nothing else.
CREATE FUNCTION platform.operator_chain_hash(head_hash bytea, fields text) RETURNS bytea
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT public.digest(head_hash || convert_to(fields, 'UTF8'), 'sha256')
$$;

-- Nobody but the chain's writer may invoke it, and the chain's writer is
-- taskflow_platform_admin alone (taskflow_app's INSERT was revoked below).
REVOKE ALL ON FUNCTION platform.operator_chain_hash(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.operator_chain_hash(bytea, text) TO taskflow_platform_admin;

-- Same signature, new body: the digest call moves behind the wrapper. The
-- field order and length-prefixed encoding in the preimage are unchanged.
CREATE OR REPLACE FUNCTION platform.operator_chain_entry() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  head_seq  bigint;
  head_hash bytea;
BEGIN
  SELECT seq, hash INTO head_seq, head_hash
    FROM platform.operator_chain_head
   WHERE id = true
     FOR UPDATE;

  NEW.seq := head_seq + 1;
  NEW.prev_hash := CASE WHEN head_seq = 0 THEN NULL ELSE head_hash END;

  NEW.hash := platform.operator_chain_hash(
    head_hash,
    audit.chain_field(NEW.seq::text) ||
    audit.chain_field(NEW.operator_id::text) ||
    audit.chain_field(NEW.action) ||
    audit.chain_field(NEW.target::text) ||
    audit.chain_field((extract(epoch FROM NEW.occurred_at) * 1000)::bigint::text)
  );

  UPDATE platform.operator_chain_head SET seq = NEW.seq, hash = NEW.hash WHERE id = true;
  RETURN NEW;
END
$$;

REVOKE INSERT, UPDATE, DELETE ON platform.operators FROM taskflow_app;
REVOKE INSERT, UPDATE, DELETE ON platform.operator_audit_log FROM taskflow_app;
REVOKE INSERT, UPDATE, DELETE ON platform.operator_chain_head FROM taskflow_app;
