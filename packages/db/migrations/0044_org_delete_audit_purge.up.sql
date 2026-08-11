-- 0044 — org deletion: purge the org's audit log when the org is deleted
-- (Phase 12 Wave 2 §3.5, ai/phase-12-wave2.md)
--
-- §3.5 decides the org's own audit chain dies with it: a deleted tenant's
-- compliance record is the GLOBAL operator-log entry the deleting route
-- writes, not a pile of rows in a chain nobody can ever query again (the org
-- row is gone, so every org-scoped RLS policy — app.org_id = org_id —
-- matches nothing, forever).
--
-- Every org_id foreign key in this schema cascades — migration 0040's header
-- verified all of them through 0039, and RTC's 0041/0042 added cascading
-- references too — EXCEPT audit.audit_log, which has NO foreign key to
-- identity.orgs at all, and cannot have one: it is partitioned BY RANGE
-- (occurred_at), and Postgres requires any foreign key on a partitioned table
-- to include the partition key. The chain-head row (audit.chain_heads)
-- cascades via its own FK, but the entries would survive as orphaned rows.
--
-- A plain DELETE by taskflow_platform_admin is equally impossible: the audit
-- log is append-only by GRANT (Phase 2) — SELECT-only for application-reachable
-- roles, and no grant at all for the deleting role. So this is the narrow
-- SECURITY DEFINER wrapper migration 0036's operator_chain_hash established:
-- a function owned by the migrator whose ONLY capability is deleting one
-- org's audit rows, invoked by an AFTER DELETE trigger on identity.orgs so
-- the org id always comes from the deleted row, never from a caller. The
-- function takes no arguments — no application code, future migration, or
-- mis-typed admin query can name a different org than the one Postgres is
-- deleting.
--
-- One trap verified against the real schema before writing this, not assumed:
-- audit.audit_log is FORCE ROW LEVEL SECURITY (0007), and FORCE applies to the
-- OWNER too — the function runs as the migrator and still passes through the
-- tenant policy (org_id = app.org_id). The deleting path clears org context
-- (withPlatformAdminScope sets app.org_id to ''), so a naive DELETE would
-- match ZERO rows and the purge would silently do nothing — a fail-open that
-- reads perfectly in a diff. The function sets app.org_id from OLD.id itself
-- (is_local = true, confined to the deleting transaction) before the DELETE.
-- The 0040 empirical note covers the rest: referential-integrity cascade
-- actions bypass row security, so chain_heads still cascades with no session
-- variable set.

CREATE FUNCTION platform.purge_org_audit() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM set_config('app.org_id', OLD.id::text, true);
  DELETE FROM audit.audit_log WHERE org_id = OLD.id;
  RETURN OLD;
END;
$$;

-- The trigger is the only caller. REVOKE ALL is belt and braces — the
-- function takes no arguments, so even a role with EXECUTE cannot aim it at
-- an org of their choice — but it keeps the grant surface as small as 0036's.
REVOKE ALL ON FUNCTION platform.purge_org_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.purge_org_audit() TO taskflow_platform_admin;

CREATE TRIGGER orgs_after_delete_purge_audit
  AFTER DELETE ON identity.orgs
  FOR EACH ROW EXECUTE FUNCTION platform.purge_org_audit();
