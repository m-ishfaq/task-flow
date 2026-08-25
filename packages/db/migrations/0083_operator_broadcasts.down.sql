-- 0083 down — drop operator broadcasts, restore 0072's CHECK constraints and
-- pre-0083 grants on platform.notifications / notification_deliveries.

DROP POLICY IF EXISTS notification_deliveries_platform_admin_write ON platform.notification_deliveries;
REVOKE SELECT, INSERT ON platform.notification_deliveries FROM taskflow_platform_admin;

DROP POLICY IF EXISTS notifications_platform_admin_read  ON platform.notifications;
DROP POLICY IF EXISTS notifications_platform_admin_write ON platform.notifications;
REVOKE SELECT, INSERT ON platform.notifications FROM taskflow_platform_admin;

ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_subject_type_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_subject_type_valid
    CHECK (subject_type IN ('message', 'card', 'page', 'call', 'webhook', 'membership'));

ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_kind_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_kind_valid
    CHECK (kind IN (
      'chat.mention', 'chat.direct', 'chat.thread_reply',
      'card.assigned', 'card.comment_mention', 'card.due_soon',
      'page.comment_mention',
      'call.missed',
      'webhook.disabled',
      'member.added', 'member.role_changed', 'member.removed'
    ));

REVOKE SELECT, INSERT ON platform.operator_broadcasts FROM taskflow_platform_admin;
DROP TABLE platform.operator_broadcasts;
