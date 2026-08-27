-- 0042 down — reverse Phase 13 Wave 2.
--
-- The notification CHECKs are restored to 0027's and 0022's exact text rather
-- than dropped: a widened constraint left behind by a down migration is the
-- kind of drift that makes the next `migrate:verify` pass while the database
-- accepts a value nothing should write.
--
-- A row this migration's own feature wrote (kind = 'call.missed', subject_type
-- = 'call' — notification.projection.ts's own pairing) has no narrower value
-- to demote to once the CHECKs below are restored — see 0083's down.sql for
-- why this needs NO FORCE/FORCE bracketing rather than a plain DELETE:
-- platform.notifications is FORCE ROW LEVEL SECURITY (0022), which applies
-- row security to the table OWNER too, and the only policy admitting
-- taskflow_migrator here is scoped by app.org_id — unset during a migration,
-- so an unbracketed DELETE silently matches zero rows.
ALTER TABLE platform.notifications NO FORCE ROW LEVEL SECURITY;

DELETE FROM platform.notifications WHERE kind = 'call.missed';

ALTER TABLE platform.notifications FORCE ROW LEVEL SECURITY;

ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_subject_type_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_subject_type_valid
    CHECK (subject_type IN ('message', 'card', 'page'));

ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_kind_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_kind_valid
    CHECK (kind IN (
      'chat.mention', 'chat.direct', 'chat.thread_reply',
      'card.assigned', 'card.comment_mention', 'card.due_soon',
      'page.comment_mention'
    ));

DROP POLICY IF EXISTS recordings_tenant_isolation ON rtc.recordings;
REVOKE SELECT, INSERT, UPDATE ON rtc.recordings FROM taskflow_app;
DROP TABLE rtc.recordings;

ALTER TABLE rtc.participants
  DROP CONSTRAINT participants_consent_is_one_answer,
  DROP COLUMN recording_declined_at,
  DROP COLUMN recording_consent_at;

ALTER TABLE rtc.sessions
  DROP CONSTRAINT sessions_recording_has_start,
  DROP CONSTRAINT sessions_recording_needs_consent,
  DROP CONSTRAINT sessions_consent_count_sane,
  DROP CONSTRAINT sessions_recording_state_valid,
  DROP COLUMN consent_count,
  DROP COLUMN recording_started_at,
  DROP COLUMN recording_requested_by,
  DROP COLUMN recording_state;

DROP POLICY IF EXISTS call_prefs_self_update ON identity.call_prefs;
DROP POLICY IF EXISTS call_prefs_self_write ON identity.call_prefs;
DROP POLICY IF EXISTS call_prefs_self_read ON identity.call_prefs;

REVOKE SELECT, INSERT, UPDATE ON identity.call_prefs FROM taskflow_app;

DROP TABLE identity.call_prefs;
