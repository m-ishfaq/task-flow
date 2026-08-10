-- 0041 — Phase 13 (In-app voice / WebRTC) Wave 1: call sessions, participants,
-- and the TURN issuance ledger. (ai/phase-13-webrtc.md §3.4–§3.7)
--
-- ==========================================================================
-- A NEW SCHEMA, AND DELIBERATELY NO `ALTER DEFAULT PRIVILEGES` ON IT
-- ==========================================================================
--
-- 0001_schemas pairs every schema it creates with ALTER DEFAULT PRIVILEGES
-- granting taskflow_app SELECT/INSERT/UPDATE/DELETE on every table a later
-- migration creates there. That is convenient and it has a failure mode
-- migration 0036 had to correct: 0035 said "SELECT only" on
-- platform.operators, and the table was WRITABLE anyway, because the default
-- privileges had already granted more than the migration's own GRANT
-- statement mentioned. A migration that creates a table in a schema with
-- default privileges must say what the table must NOT have, not only what it
-- should — and nobody remembers to.
--
-- So `rtc` has none. Every grant in this schema is explicit, forever, and the
-- next migration that adds a table here gets nothing until it says so. That
-- makes the two statements below FACTS rather than intentions:
--
--   * Nothing may DELETE a session or a participant row. A call record is
--     append-and-update-only; "this call never happened" is not a state the
--     application may express.
--   * Nothing may UPDATE an rtc.turn_issuance row. It is evidence that a
--     relay capability was handed out, on the same append-only argument
--     audit.audit_log makes. DELETE exists for retention only (see below).
--
-- ==========================================================================
-- SEPARATE TABLES FROM comms.calls, ON PURPOSE (§3.7)
-- ==========================================================================
--
-- A PSTN call carries an encrypted counterparty phone number and a
-- comms.spend_ledger row. An in-app call carries participant user ids and
-- costs nothing per minute. Conflating them would make every telephony query
-- disambiguate a `direction`/`kind` it does not care about, and would fill the
-- spend ledger with zero-cost rows that mean nothing to the cap that reads it.

CREATE SCHEMA IF NOT EXISTS rtc;   -- in-app voice sessions and their participants

GRANT USAGE ON SCHEMA rtc TO taskflow_app;

-- --------------------------------------------------------------------------
-- rtc.sessions — one in-app call.
--
-- ==========================================================================
-- THE PARTICIPANT CAP IS A CHECK CONSTRAINT, NOT A SERVICE BRANCH (§3.5)
-- ==========================================================================
--
-- Wave 1 is mesh: every participant holds a peer connection to every other, so
-- the connection count is N(N-1)/2 — fine at three or four and unusable at
-- ten. A cap enforced in the UI is not a cap, and a cap enforced only in the
-- service is a cap until the second caller arrives concurrently.
--
-- `joined_count` is incremented inside the join transaction and bounded by a
-- CHECK against `max_participants`, so the (N+1)th join is refused by Postgres
-- rather than by a count-then-insert that two callers can both pass. The cost
-- is a row lock that serializes joins within one session — accepted knowingly,
-- the same trade work.projects.next_card_number makes for gapless card numbers.
--
-- ==========================================================================
-- THE COMPOSITE FK TO chat.channels IS THE AUTHORIZATION ANCHOR
-- ==========================================================================
--
-- §1 of the spec: a call is joinable by precisely those who can read its
-- channel. That claim is only as good as the guarantee that a session names a
-- channel in its OWN tenant — RLS stops a row crossing a tenant and says
-- nothing about a row crossing a channel inside one. So `(org_id, channel_id)`
-- references chat.channels' `channels_org_id_key`, exactly as 0017's messages
-- do, and a session pointing at another tenant's channel is unwritable rather
-- than merely unwritten.
-- --------------------------------------------------------------------------
CREATE TABLE rtc.sessions (
  id               uuid        PRIMARY KEY,
  org_id           uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  channel_id       uuid        NOT NULL,

  -- 'audio' today. 'video' is Wave 3 and is accepted by the CHECK now so that
  -- adding it is a route change rather than a migration on a live table.
  kind             text        NOT NULL DEFAULT 'audio',

  -- 'ringing' — invited, nobody has answered.
  -- 'active'  — at least one invitee answered (see §3.6's conditional UPDATE).
  -- 'ended'   — over, for any reason. Terminal.
  status           text        NOT NULL DEFAULT 'ringing',

  initiated_by     uuid        NOT NULL REFERENCES identity.users (id),

  max_participants integer     NOT NULL,
  joined_count     integer     NOT NULL DEFAULT 0,

  -- When the call actually became a conversation, not when it started ringing.
  started_at       timestamptz,
  ended_at         timestamptz,
  -- 'hung_up' | 'declined' | 'no_answer' | 'empty' | 'org_suspended'
  end_reason       text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sessions_kind_valid   CHECK (kind IN ('audio', 'video')),
  CONSTRAINT sessions_status_valid CHECK (status IN ('ringing', 'active', 'ended')),

  -- Mesh is unusable well before this; 8 is a ceiling, not a target. The lower
  -- bound is 2 because a call with one possible participant is not a call.
  CONSTRAINT sessions_cap_sane CHECK (max_participants BETWEEN 2 AND 8),

  -- THE cap (§3.5). Refused by the database, not by a service branch.
  CONSTRAINT sessions_joined_within_cap
    CHECK (joined_count >= 0 AND joined_count <= max_participants),

  -- A status is a claim about time, and these keep the two from disagreeing.
  -- An 'active' session with no started_at, or an 'ended' one with no
  -- ended_at, would make every duration report silently wrong rather than
  -- visibly broken.
  CONSTRAINT sessions_active_has_start
    CHECK (status <> 'active' OR started_at IS NOT NULL),
  CONSTRAINT sessions_ended_has_end
    CHECK (status <> 'ended' OR (ended_at IS NOT NULL AND end_reason IS NOT NULL)),

  -- The tenancy anchor. See the header.
  CONSTRAINT sessions_channel_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES chat.channels (org_id, id) ON DELETE CASCADE
);

-- Referenced by rtc.participants and rtc.turn_issuance, so a child row can
-- never name a session in another tenant even when both ids are known.
CREATE UNIQUE INDEX sessions_org_id_key ON rtc.sessions (org_id, id);

-- ==========================================================================
-- AT MOST ONE LIVE SESSION PER CHANNEL
-- ==========================================================================
--
-- Partial, so ended sessions accumulate freely and only the live one is
-- constrained. Without it, two people pressing "call" in the same DM within a
-- second of each other create two sessions, ring each other from opposite
-- directions, and both sit in rooms the other is not in — a failure that looks
-- like the network dropped rather than like a missing constraint.
CREATE UNIQUE INDEX sessions_one_live_per_channel
  ON rtc.sessions (org_id, channel_id)
  WHERE status <> 'ended';

CREATE INDEX sessions_org_created_idx ON rtc.sessions (org_id, created_at DESC);

-- --------------------------------------------------------------------------
-- rtc.participants — who was invited, and what they did about it.
--
-- This table is a RECORD, never an authorization input. §1 of the spec is
-- explicit and it is the most important sentence in this phase: a call is
-- joinable by precisely those who can read its channel, decided by `can()`
-- against a `channelTarget`. Reading this table to answer "may this person
-- join" would be the `participantIds.includes(userId)` shortcut Phase 5 §3.3
-- forbids, rebuilt in a new schema.
-- --------------------------------------------------------------------------
CREATE TABLE rtc.participants (
  session_id uuid        NOT NULL,
  org_id     uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  -- 'invited'  — rung, no answer yet.
  -- 'joined'   — in the call now.
  -- 'left'     — was in the call, is not now. May become 'joined' again.
  -- 'declined' — actively refused.
  -- 'missed'   — the session ended while they were still 'invited'.
  state      text        NOT NULL DEFAULT 'invited',

  invited_at timestamptz NOT NULL DEFAULT now(),
  joined_at  timestamptz,
  left_at    timestamptz,

  PRIMARY KEY (session_id, user_id),

  CONSTRAINT participants_state_valid
    CHECK (state IN ('invited', 'joined', 'left', 'declined', 'missed')),
  CONSTRAINT participants_joined_has_time
    CHECK (state <> 'joined' OR joined_at IS NOT NULL),

  CONSTRAINT participants_session_fk
    FOREIGN KEY (org_id, session_id) REFERENCES rtc.sessions (org_id, id) ON DELETE CASCADE
);

-- "Is anyone ringing me?" — the query the client polls and the socket
-- invalidates. Partial so it stays small: a finished call's rows are never
-- part of this answer.
CREATE INDEX participants_org_user_pending_idx
  ON rtc.participants (org_id, user_id)
  WHERE state IN ('invited', 'joined');

-- --------------------------------------------------------------------------
-- rtc.turn_issuance — the durable half of the TURN gate (§3.4)
--
-- ==========================================================================
-- WHY A TABLE, WHEN AN IN-PROCESS COUNTER WOULD BE FASTER
-- ==========================================================================
--
-- A TURN relay carries someone's media on this deployment's bandwidth bill.
-- That makes credential issuance a spend surface, and Phase 7 Wave 1 already
-- settled how this codebase treats one: the in-process velocity limiter is the
-- cheap fast path, and the DURABLE ledger in Postgres is what actually stops
-- the bill. An in-memory counter forgives everyone on restart, which is
-- precisely the state an attacker restarts you to reach.
--
-- One row per credential MINTED. Never one per request — a refused request
-- writes nothing, so the budget cannot be exhausted by requests that were
-- always going to be refused. (That is the same reasoning that puts the
-- telephony velocity limiter LAST, after every check that can refuse for
-- free.)
--
-- DELETE is granted for retention and UPDATE is not. Deleting a row outside
-- the rolling window changes no decision the gate can make; changing a row's
-- org, user, or timestamp would rewrite the evidence that a capability was
-- issued, which is the audit.audit_log argument applied at a smaller scale.
-- --------------------------------------------------------------------------
CREATE TABLE rtc.turn_issuance (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  session_id  uuid        NOT NULL,
  user_id     uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  -- How long the minted credential was good for. Recorded so an incident
  -- review can bound the window a leaked credential was usable in, without
  -- having to know what the configured TTL was on the day it was issued.
  ttl_seconds integer     NOT NULL,

  issued_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT turn_issuance_ttl_sane CHECK (ttl_seconds BETWEEN 30 AND 86400),

  CONSTRAINT turn_issuance_session_fk
    FOREIGN KEY (org_id, session_id) REFERENCES rtc.sessions (org_id, id) ON DELETE CASCADE
);

-- The gate's read: count this org's window. Ordered so the rolling-window scan
-- is an index range rather than a filter over the org's whole history — the
-- same shape as comms.spend_ledger's own index.
CREATE INDEX turn_issuance_org_window_idx ON rtc.turn_issuance (org_id, issued_at DESC);

-- --------------------------------------------------------------------------
-- Grants — explicit, because this schema has no default privileges (header).
-- --------------------------------------------------------------------------

-- No DELETE. A call record is append-and-update-only.
GRANT SELECT, INSERT, UPDATE ON rtc.sessions     TO taskflow_app;
GRANT SELECT, INSERT, UPDATE ON rtc.participants TO taskflow_app;

-- No UPDATE. See the table's own header on why DELETE is here and UPDATE is not.
GRANT SELECT, INSERT, DELETE ON rtc.turn_issuance TO taskflow_app;

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, as every other tenant table.
-- --------------------------------------------------------------------------

ALTER TABLE rtc.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtc.sessions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sessions_tenant_isolation ON rtc.sessions;
CREATE POLICY sessions_tenant_isolation ON rtc.sessions
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE rtc.participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtc.participants FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS participants_tenant_isolation ON rtc.participants;
CREATE POLICY participants_tenant_isolation ON rtc.participants
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE rtc.turn_issuance ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtc.turn_issuance FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS turn_issuance_tenant_isolation ON rtc.turn_issuance;
CREATE POLICY turn_issuance_tenant_isolation ON rtc.turn_issuance
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
