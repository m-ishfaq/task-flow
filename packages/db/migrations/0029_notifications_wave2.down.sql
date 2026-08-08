-- 0029 (down) — see the .up.sql header for context.

REVOKE DELETE ON platform.notifications FROM taskflow_audit;

DROP POLICY IF EXISTS notification_deliveries_sweep_insert ON platform.notification_deliveries;
REVOKE INSERT ON platform.notification_deliveries FROM taskflow_notification_sweep;

DROP POLICY IF EXISTS notification_prefs_sweep_read ON identity.notification_prefs;
REVOKE SELECT ON identity.notification_prefs FROM taskflow_notification_sweep;
REVOKE USAGE ON SCHEMA identity FROM taskflow_notification_sweep;

DROP POLICY IF EXISTS notifications_notification_sweep_insert ON platform.notifications;
DROP POLICY IF EXISTS notifications_notification_sweep_select ON platform.notifications;
REVOKE SELECT, INSERT ON platform.notifications FROM taskflow_notification_sweep;
REVOKE USAGE ON SCHEMA platform FROM taskflow_notification_sweep;

DROP POLICY IF EXISTS cards_notification_sweep_claim ON work.cards;
REVOKE SELECT (id, org_id, board_id, title, number, due_date, assignee_ids)
  ON work.cards FROM taskflow_notification_sweep;
REVOKE USAGE ON SCHEMA work FROM taskflow_notification_sweep;

DROP POLICY IF EXISTS push_subscriptions_audit_send ON platform.push_subscriptions;
REVOKE SELECT, UPDATE, DELETE ON platform.push_subscriptions FROM taskflow_audit;

DROP POLICY IF EXISTS push_subscriptions_self_delete ON platform.push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_self_update ON platform.push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_self_insert ON platform.push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_self_read ON platform.push_subscriptions;

DROP TABLE IF EXISTS platform.push_subscriptions;
