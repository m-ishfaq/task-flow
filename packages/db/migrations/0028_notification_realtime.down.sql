-- 0028 (down) — see the .up.sql header for context.

DROP POLICY IF EXISTS outbox_notification_projection_insert ON platform.outbox;
REVOKE INSERT ON platform.outbox FROM taskflow_audit;
