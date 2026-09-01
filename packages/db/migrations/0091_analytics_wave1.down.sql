-- 0091 down — reverse Phase 11 Wave 1 (the analytics transitions projection).
--
-- Policies and grants come off before the tables they name, so a partially
-- applied down leaves no policy pointing at a table that no longer exists (the
-- ordering 0045's down documents for itself). The claim policies are on
-- platform.outbox_dispatch (TO taskflow_audit, consumer = 'analytics') — there
-- is no dedicated role or outbox grant to revoke, since this projection reuses
-- taskflow_audit (see the up migration's header).

DROP POLICY IF EXISTS outbox_dispatch_analytics_update ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_dispatch_analytics_insert ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_dispatch_analytics_read ON platform.outbox_dispatch;
DROP POLICY IF EXISTS card_transitions_tenant_isolation ON analytics.card_transitions;

REVOKE SELECT, INSERT ON analytics.card_transitions FROM taskflow_app;
DROP TABLE analytics.card_transitions;

REVOKE USAGE ON SCHEMA analytics FROM taskflow_app;

-- The schema itself goes too. It carries no default privileges to revoke — see
-- the up migration's header on why that is deliberate.
DROP SCHEMA IF EXISTS analytics;
