-- Down for 0034 — Phase 7 Wave 3: SMS threads, suppressions, recording-card
-- attachments.
--
-- Children before parents: comms.messages references comms.message_threads,
-- and comms.recording_cards references both comms.recordings and work.cards.

DROP TABLE IF EXISTS comms.recording_cards;
DROP TABLE IF EXISTS comms.suppressions;
DROP TABLE IF EXISTS comms.messages;
DROP TABLE IF EXISTS comms.message_threads;
