-- Down for 0033 — Phase 7 Wave 2: numbers, calls, recordings, transcripts.
--
-- Children before parents. The role's grants go with the table it holds them
-- on, but the ROLE itself is not dropped: it may still own grants from a
-- re-application, and a DROP ROLE that fails takes the whole down-migration
-- with it. 0025 leaves taskflow_backlinks behind for the same reason.

DROP TABLE IF EXISTS comms.transcripts;
DROP TABLE IF EXISTS comms.recordings;
DROP TABLE IF EXISTS comms.calls;
DROP TABLE IF EXISTS comms.phone_numbers;

REVOKE USAGE ON SCHEMA comms FROM taskflow_recording_ingest;
