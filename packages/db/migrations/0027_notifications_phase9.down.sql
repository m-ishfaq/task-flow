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

-- Rows this migration's own feature wrote (kind IN ('card.assigned',
-- 'card.comment_mention', 'card.due_soon', 'page.comment_mention')) have no
-- narrower value to demote to once the CHECK below is restored — see 0083's
-- down.sql for why this needs NO FORCE/FORCE bracketing rather than a plain
-- DELETE: platform.notifications is FORCE ROW LEVEL SECURITY (0022), which
-- applies row security to the table OWNER too, and the only policy
-- admitting taskflow_migrator here is scoped by app.org_id — unset during a
-- migration, so an unbracketed DELETE silently matches zero rows.
-- subject_type_valid is untouched here on purpose: 'card' and 'page' were
-- already in 0022's original list, so they stay valid at this floor.
ALTER TABLE platform.notifications NO FORCE ROW LEVEL SECURITY;

DELETE FROM platform.notifications
 WHERE kind IN (
   'card.assigned', 'card.comment_mention', 'card.due_soon', 'page.comment_mention'
 );

ALTER TABLE platform.notifications FORCE ROW LEVEL SECURITY;

ALTER TABLE platform.notifications DROP CONSTRAINT notifications_kind_valid;
ALTER TABLE platform.notifications ADD CONSTRAINT notifications_kind_valid
  CHECK (kind IN ('chat.mention', 'chat.direct', 'chat.thread_reply'));
