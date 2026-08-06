-- Revert 0022 — saved messages and notifications.
--
-- Both self-contained: nothing references either table, so their indexes,
-- constraints, policies and grants go with them.
--
-- What is lost: everyone's saved-for-later list, and every record that somebody
-- was told something. The second is the one to notice — a notification is
-- evidence that a person was informed, and unlike a retention window it cannot
-- be recomputed from anything that survives.

-- The three outbox_dispatch policies added by 0022's up migration live on a
-- table 0022 does not own (0015's) and DROP TABLE platform.notifications
-- does not touch them — drop them explicitly or migrate:verify's up->down->up
-- leaves stale policies for a consumer name whose table no longer exists.
DROP POLICY IF EXISTS outbox_dispatch_notifications_read ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_dispatch_notifications_insert ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_dispatch_notifications_update ON platform.outbox_dispatch;

DROP TABLE IF EXISTS platform.notifications;
DROP TABLE IF EXISTS chat.saved_messages;
