-- 0044 down — remove the org-deletion audit purge (Phase 12 Wave 2 §3.5).
-- The function is dropped with its trigger; the audit log returns to the
-- pre-0044 state where a deleted org's entries survive as unreadable rows.
--
-- Note what down does NOT do: purged audit rows are gone forever. Rolling
-- 0044 back after an org was deleted under it removes the mechanism, not the
-- deletion's effect — the same irreversibility the up migration exists to
-- provide, stated here so a rollback is never mistaken for an undo.

DROP TRIGGER IF EXISTS orgs_after_delete_purge_audit ON identity.orgs;
DROP FUNCTION IF EXISTS platform.purge_org_audit();
