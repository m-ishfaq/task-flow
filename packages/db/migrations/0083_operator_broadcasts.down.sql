-- 0083 down — drop operator broadcasts, restore 0072's CHECK constraints and
-- pre-0083 grants on platform.notifications / notification_deliveries.

DROP POLICY IF EXISTS notification_deliveries_platform_admin_write ON platform.notification_deliveries;
REVOKE SELECT, INSERT ON platform.notification_deliveries FROM taskflow_platform_admin;

DROP POLICY IF EXISTS notifications_platform_admin_read  ON platform.notifications;
DROP POLICY IF EXISTS notifications_platform_admin_write ON platform.notifications;
REVOKE SELECT, INSERT ON platform.notifications FROM taskflow_platform_admin;

-- A row this feature itself wrote (kind = subject_type = 'operator_broadcast')
-- has no narrower value to demote to once the CHECK constraints below are
-- restored to their pre-0083 shape — 'operator_broadcast' simply is not in
-- either list. Rolling back the feature that gave a row its only valid kind
-- means the row cannot be represented anymore, the same reason rolling back
-- a table drops its own rows rather than trying to preserve them under a
-- schema that predates it. Deleted here, before either ALTER, or the first
-- one fails against exactly the rows 0083's own feature produced —
-- `migrate:verify`'s up->down->up is what a real broadcast send now makes
-- this reachable at all, where every earlier run of this migration's own
-- verify step had nothing in the table to violate it with.
--
-- notification_deliveries needs no matching DELETE: its
-- notification_id ... REFERENCES platform.notifications (id) ON DELETE
-- CASCADE (0027) removes the matching delivery rows for free.
DELETE FROM platform.notifications WHERE kind = 'operator_broadcast';

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
