-- Revert 0022 — saved messages and notifications.
--
-- Both self-contained: nothing references either table, so their indexes,
-- constraints, policies and grants go with them.
--
-- What is lost: everyone's saved-for-later list, and every record that somebody
-- was told something. The second is the one to notice — a notification is
-- evidence that a person was informed, and unlike a retention window it cannot
-- be recomputed from anything that survives.

DROP TABLE IF EXISTS platform.notifications;
DROP TABLE IF EXISTS chat.saved_messages;
