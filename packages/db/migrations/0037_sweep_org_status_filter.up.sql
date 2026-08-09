-- 0037 — Phase 12 Wave 1 §3.9: the notification sweeps consult org status
-- (ai/phase-12-admin.md §3.9).
--
-- A suspended org's members are cut off from every REQUEST path by
-- resolveOrgMembership's ORG_SUSPENDED check (0035's wave), but the
-- notification pipeline never touches a request. It is four background
-- sweeps — the due-reminder scan (taskflow_notification_sweep) and the
-- digest, push drain, and projection's immediate-email decision
-- (taskflow_audit) — running with no per-request org resolution to
-- intercept. Without this migration, a suspended org's members keep
-- receiving due-date reminders, digests, and push notifications exactly as
-- if nothing changed.
--
-- The fix is one read of identity.orgs.status joined into each sweep's
-- query. Two things make a bare GRANT insufficient, and both follow the
-- established cross-tenant-role pattern:
--
-- 1. identity.orgs has FORCE ROW LEVEL SECURITY keyed on app.org_id (0004),
--    and neither sweep role sets that variable — a plain GRANT would still
--    see zero rows. The permissive policies below are what admit them, the
--    same NOBYPASSRLS shape 0035's orgs_platform_admin_read established for
--    the operator console.
-- 2. Both grants are COLUMN-LIMITED to (id, status), following
--    taskflow_backlinks' precedent: the roles that need to know whether an
--    org is active have no need for its name, slug, timestamps, or
--    deleted_at. And per 0029's own hard-won lesson — Postgres checks
--    column-level SELECT against every column a WHERE or JOIN mentions, not
--    just the SELECT list — the application joins use exactly the two
--    granted columns and nothing else.
--
-- No USAGE grant here: both roles already hold USAGE ON SCHEMA identity
-- (0027 for taskflow_audit, 0029 for taskflow_notification_sweep), and the
-- down must not revoke what a sibling migration granted.

GRANT SELECT (id, status) ON identity.orgs TO taskflow_notification_sweep;

DROP POLICY IF EXISTS orgs_sweep_status_read ON identity.orgs;
CREATE POLICY orgs_sweep_status_read ON identity.orgs
  FOR SELECT TO taskflow_notification_sweep
  USING (true);

GRANT SELECT (id, status) ON identity.orgs TO taskflow_audit;

DROP POLICY IF EXISTS orgs_audit_status_read ON identity.orgs;
CREATE POLICY orgs_audit_status_read ON identity.orgs
  FOR SELECT TO taskflow_audit
  USING (true);
