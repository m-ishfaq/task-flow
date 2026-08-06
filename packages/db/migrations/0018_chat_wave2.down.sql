-- Revert 0018 — reactions, pins, read cursors.
--
-- No ordering dependency between the three: none references another, they
-- only reference `chat.messages`. What is lost and unrecoverable by
-- re-running the up file: every reaction, pin, and read position anyone has
-- recorded — the same inherent data-loss caveat 0017's own down file states
-- for messages themselves.

DROP TABLE IF EXISTS chat.message_reactions;
DROP TABLE IF EXISTS chat.pinned_messages;
DROP TABLE IF EXISTS chat.read_cursors;
