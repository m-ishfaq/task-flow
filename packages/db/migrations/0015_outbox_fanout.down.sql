-- Revert 0015 — the outbox fan-out seam.

DROP POLICY IF EXISTS outbox_dispatch_audit_read ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_dispatch_audit_insert ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_dispatch_audit_update ON platform.outbox_dispatch;
REVOKE ALL ON platform.outbox_dispatch FROM taskflow_audit;
DROP INDEX IF EXISTS platform.outbox_dispatch_pending_idx;
DROP TABLE IF EXISTS platform.outbox_dispatch;
