-- 0042 — Phase 13 Wave 2: ringing preferences, and recording behind a consent
-- gate. (ai/phase-13-webrtc.md §3.9, §7)
--
-- ==========================================================================
-- RECORDING SHIPS WITH A CONSENT GATE, OR IT DOES NOT SHIP
-- ==========================================================================
--
-- ai/phase-13-webrtc.md §3.9 deferred recording from Wave 1 with one
-- condition attached: "if it ever lands, the consent gate applies exactly as
-- it does for PSTN. An in-app call is no less a recorded conversation."
--
-- Phase 7 met that bar with THREE layers, and only the third is a thing the
-- database will not let be wrong: `comms.calls`' own
-- `calls_recording_after_announcement` CHECK refuses a row whose recording
-- started before a required announcement played. §3.5's standard is that a UI
-- affordance a determined caller could skip is not a control.
--
-- The equivalent here is `sessions_recording_needs_consent` below. It cannot
-- be written as "every participant agreed" — a CHECK sees one row — so it is
-- written as a COUNTER comparison, the same trick `joined_count` already uses
-- for the mesh cap:
--
--   CHECK (recording_state <> 'active' OR consent_count >= joined_count)
--
-- `consent_count` is incremented only by a participant consenting for
-- themselves, and `joined_count` by 0041's join path. So a session cannot be
-- in `active` recording while anybody in the call has not agreed, and the
-- database is what says so rather than a service branch somebody can forget.
--
-- ==========================================================================
-- SOMEBODY JOINING A RECORDING CALL PAUSES IT, AND THE CHECK IS WHY
-- ==========================================================================
--
-- A new participant increments `joined_count` and not `consent_count`, so an
-- `active` recording would immediately violate the constraint and the JOIN
-- would fail. That is the wrong failure — being unable to join a call is
-- worse than a pause — so the join path moves recording back to `pending`
-- in the same transaction.
--
-- The result is the behaviour a compliance review would ask for anyway:
-- recording stops the moment somebody who has not agreed can hear it, and
-- resumes only when they do. The constraint is what forces that rather than
-- leaving it to be remembered.

-- --------------------------------------------------------------------------
-- identity.call_prefs — the ringtone, per person (§7)
--
-- GLOBAL PER USER, NOT PER ORG, and in `identity` rather than `rtc`, for the
-- reason 0027 gives at length for identity.notification_prefs: every route
-- that reads it must be a `selfRoute` (no permission describes "choose your
-- own ringtone", and a guest must be able to), and `selfRoute` resolves no
-- org — so an org-keyed row would have no org to key it by. A ringtone is
-- yours alone and the same wherever you sign in, exactly like `display_name`.
--
-- The tone itself is not stored here and never will be. `ringtone` names one
-- of a closed set the client SYNTHESIZES (Web Audio oscillators — see
-- apps/web/src/features/rtc/ringtone.ts), so there is no audio file to host,
-- no upload path to secure, and no way for this column to become a URL
-- somebody's browser fetches.
-- --------------------------------------------------------------------------
CREATE TABLE identity.call_prefs (
  user_id     uuid        PRIMARY KEY REFERENCES identity.users (id) ON DELETE CASCADE,

  -- One of the closed set in the client's own tone table. A CHECK rather than
  -- an enum, the same choice as every other closed vocabulary here: adding a
  -- tone is one constraint swap.
  ringtone    text        NOT NULL DEFAULT 'classic',

  -- Ring audibly at all. Distinct from muting notifications: somebody in an
  -- open-plan office wants the popup and not the sound, and folding the two
  -- together would make "stop the noise" mean "stop telling me".
  ring_enabled boolean    NOT NULL DEFAULT true,

  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT call_prefs_ringtone_valid
    CHECK (ringtone IN ('classic', 'chime', 'pulse', 'marimba', 'digital'))
);

ALTER TABLE identity.call_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.call_prefs FORCE  ROW LEVEL SECURITY;

-- Keyed on app.user_id, the same self-scoped trio 0027 uses for
-- notification_prefs — and safe for the same reason: writing your own
-- ringtone is not a privilege escalation, so the write side gets a real
-- WITH CHECK rather than being read-only.
CREATE POLICY call_prefs_self_read ON identity.call_prefs
  FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY call_prefs_self_write ON identity.call_prefs
  FOR INSERT
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY call_prefs_self_update ON identity.call_prefs
  FOR UPDATE
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON identity.call_prefs TO taskflow_app;

-- --------------------------------------------------------------------------
-- rtc.sessions — recording state and the consent counter (see the header).
-- --------------------------------------------------------------------------
ALTER TABLE rtc.sessions
  -- 'none'    — nobody has asked.
  -- 'pending' — asked, waiting for everyone in the call to agree.
  -- 'active'  — everyone agreed and capture is running.
  -- 'stopped' — was active, has ended. Terminal for this session.
  ADD COLUMN recording_state text NOT NULL DEFAULT 'none',
  ADD COLUMN recording_requested_by uuid REFERENCES identity.users (id),
  ADD COLUMN recording_started_at timestamptz,
  -- How many CURRENTLY JOINED participants have agreed. Maintained alongside
  -- joined_count, and compared against it by the CHECK below.
  ADD COLUMN consent_count integer NOT NULL DEFAULT 0;

ALTER TABLE rtc.sessions
  ADD CONSTRAINT sessions_recording_state_valid
    CHECK (recording_state IN ('none', 'pending', 'active', 'stopped'));

ALTER TABLE rtc.sessions
  ADD CONSTRAINT sessions_consent_count_sane
    CHECK (consent_count >= 0 AND consent_count <= max_participants);

-- THE gate (see the header). Not a service branch — a constraint.
ALTER TABLE rtc.sessions
  ADD CONSTRAINT sessions_recording_needs_consent
    CHECK (recording_state <> 'active' OR consent_count >= joined_count);

-- An active recording must know when it started, or every duration is wrong.
ALTER TABLE rtc.sessions
  ADD CONSTRAINT sessions_recording_has_start
    CHECK (recording_state <> 'active' OR recording_started_at IS NOT NULL);

-- --------------------------------------------------------------------------
-- rtc.participants — this person's own consent decision.
--
-- Nullable, and three-valued by construction: NULL is "not asked / not
-- answered", a timestamp is "agreed", and `recording_declined_at` is
-- "refused". A single boolean would collapse the first and third, and
-- "nobody asked them" and "they said no" are the two states a compliance
-- review most needs to tell apart.
-- --------------------------------------------------------------------------
ALTER TABLE rtc.participants
  ADD COLUMN recording_consent_at timestamptz,
  ADD COLUMN recording_declined_at timestamptz;

ALTER TABLE rtc.participants
  ADD CONSTRAINT participants_consent_is_one_answer
    CHECK (recording_consent_at IS NULL OR recording_declined_at IS NULL);

-- --------------------------------------------------------------------------
-- rtc.recordings — one stored capture.
--
-- ==========================================================================
-- THE OBJECT KEY IS SERVER-GENERATED AND NOTHING FROM A CLIENT REACHES IT
-- ==========================================================================
--
-- The identical rule Phase 3's attachments settled: a filename in the key
-- would need path escaping, which is a traversal this design REMOVES rather
-- than mitigates. The key is derived from ids this server minted.
--
-- `status` is the same state machine attachments use, and for the same
-- reason: the object exists in storage the moment the browser's PUT finishes
-- and nothing can prevent that, so what the service controls is whether
-- anyone is ever handed a URL to it.
-- --------------------------------------------------------------------------
CREATE TABLE rtc.recordings (
  id               uuid        PRIMARY KEY,
  org_id           uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  session_id       uuid        NOT NULL,

  -- 'pending'  — presigned, not yet confirmed uploaded.
  -- 'stored'   — the upload completed and the row was confirmed.
  -- 'failed'   — the client reported it could not finish.
  status           text        NOT NULL DEFAULT 'pending',

  storage_key      text        NOT NULL,
  content_type     text        NOT NULL,
  bytes            bigint,
  duration_seconds integer,

  -- Who pressed record. Not "who was in the call" — that is rtc.participants,
  -- and a compliance review needs both the decision and the audience.
  created_by       uuid        NOT NULL REFERENCES identity.users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  stored_at        timestamptz,

  CONSTRAINT recordings_status_valid CHECK (status IN ('pending', 'stored', 'failed')),
  CONSTRAINT recordings_bytes_nonnegative CHECK (bytes IS NULL OR bytes >= 0),
  CONSTRAINT recordings_stored_has_time
    CHECK (status <> 'stored' OR (stored_at IS NOT NULL AND bytes IS NOT NULL)),

  CONSTRAINT recordings_session_fk
    FOREIGN KEY (org_id, session_id) REFERENCES rtc.sessions (org_id, id) ON DELETE CASCADE
);

CREATE INDEX recordings_org_session_idx ON rtc.recordings (org_id, session_id);

-- One object key, globally. Two rows pointing at one object would make a
-- delete on either orphan the other.
CREATE UNIQUE INDEX recordings_storage_key_key ON rtc.recordings (storage_key);

-- No DELETE, matching the rest of the rtc schema (0041's header): a recording
-- row is a record that a conversation was captured, and "this never happened"
-- is not a state the application may express. Retention deletion, if it ever
-- lands, is a deliberate migration granting exactly that.
GRANT SELECT, INSERT, UPDATE ON rtc.recordings TO taskflow_app;

ALTER TABLE rtc.recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtc.recordings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recordings_tenant_isolation ON rtc.recordings;
CREATE POLICY recordings_tenant_isolation ON rtc.recordings
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- platform.notifications — the missed-call kind (§7).
--
-- 0022 left both CHECKs deliberately widenable and 0027 already used that
-- once. `subject_type` gains 'call'; `kind` gains 'call.missed'.
--
-- ONLY the missed one. A notification for a call that is currently ringing
-- would arrive alongside the live ring the socket already delivers, and be
-- read minutes later as a row saying "someone is calling" about a call that
-- ended long ago. A missed call is the durable fact; the ring is the live one.
-- --------------------------------------------------------------------------
ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_kind_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_kind_valid
    CHECK (kind IN (
      'chat.mention', 'chat.direct', 'chat.thread_reply',
      'card.assigned', 'card.comment_mention', 'card.due_soon',
      'page.comment_mention',
      'call.missed'
    ));

ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_subject_type_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_subject_type_valid
    CHECK (subject_type IN ('message', 'card', 'page', 'call'));
