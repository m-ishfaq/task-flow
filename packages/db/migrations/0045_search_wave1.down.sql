-- 0045 down — reverse Phase 8 Wave 1 (the search projection and claim role).
--
-- Policies and grants come off before the tables they name, so a partially
-- applied down leaves no policy pointing at a table that no longer exists
-- (the ordering 0041's down documents for itself).

DROP POLICY IF EXISTS outbox_dispatch_search_update ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_dispatch_search_insert ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_dispatch_search_read ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_search_mark ON platform.outbox;
DROP POLICY IF EXISTS outbox_search_read ON platform.outbox;
DROP POLICY IF EXISTS documents_tenant_isolation ON search.documents;

REVOKE SELECT, INSERT, UPDATE ON platform.outbox_dispatch FROM taskflow_search;
REVOKE SELECT, UPDATE ON platform.outbox FROM taskflow_search;
REVOKE USAGE ON SCHEMA platform FROM taskflow_search;

REVOKE SELECT, INSERT, UPDATE, DELETE ON search.documents FROM taskflow_app;
DROP TABLE search.documents;

REVOKE USAGE ON SCHEMA search FROM taskflow_app;

-- The schema itself goes too. It carries no default privileges to revoke —
-- see the up migration's header on why that is deliberate.
DROP SCHEMA IF EXISTS search;
