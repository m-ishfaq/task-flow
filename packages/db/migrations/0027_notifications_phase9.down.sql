-- 0027 (down) — see the .up.sql header for context.

REVOKE SELECT (id, email, display_name) ON identity.users FROM taskflow_audit;
REVOKE USAGE ON SCHEMA identity FROM taskflow_audit;

DROP POLICY IF EXISTS notification_deliveries_projection_write ON platform.notification_deliveries;
REVOKE SELECT, INSERT, UPDATE ON platform.notification_deliveries FROM taskflow_audit;
DROP POLICY IF EXISTS notification_deliveries_tenant_isolation ON platform.notification_deliveries;

DROP INDEX IF EXISTS platform.notification_deliveries_pending_idx;
DROP INDEX IF EXISTS platform.notification_deliveries_notification_idx;
DROP TABLE IF EXISTS platform.notification_deliveries;

DROP POLICY IF EXISTS notification_prefs_audit_read ON identity.notification_prefs;
REVOKE SELECT ON identity.notification_prefs FROM taskflow_audit;
DROP POLICY IF EXISTS notification_prefs_self_update ON identity.notification_prefs;
DROP POLICY IF EXISTS notification_prefs_self_write ON identity.notification_prefs;
DROP POLICY IF EXISTS notification_prefs_self_read ON identity.notification_prefs;
DROP TABLE IF EXISTS identity.notification_prefs;

ALTER TABLE platform.notifications DROP COLUMN board_id;

ALTER TABLE platform.notifications DROP CONSTRAINT notifications_kind_valid;
ALTER TABLE platform.notifications ADD CONSTRAINT notifications_kind_valid
  CHECK (kind IN ('chat.mention', 'chat.direct', 'chat.thread_reply'));
