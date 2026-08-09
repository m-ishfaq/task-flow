-- 0033 — Phase 7 (Voice & Messaging) Wave 2: numbers, calls, recordings,
-- transcripts. (PLAN.md §3.4, §8.5; ai/phase-7-voice.md §3.5-§3.7, §3.10)
--
-- ==========================================================================
-- COUNTERPARTY NUMBERS ARE ENCRYPTED; OUR OWN NUMBERS ARE NOT
-- ==========================================================================
--
-- The asymmetry is deliberate and is the main thing to understand here.
--
-- comms.phone_numbers holds the ORG'S OWN numbers. They are business numbers
-- the org publishes on a website; they identify a tenant, not a person. They
-- are stored in plaintext because an inbound webhook arrives saying only "a
-- call came to +14155550100", and finding which org owns that number is the
-- first thing that has to happen — before any scope exists to decrypt within.
--
-- comms.calls.counterparty_* holds THE OTHER PARTY'S number. That is personal
-- data about a human being: a customer's mobile. REDACTION_PATHS already says
-- of it "field-encrypted at rest; logging them in plaintext would defeat that
-- entirely", and this migration is where that claim stops being aspirational.
--
-- ==========================================================================
-- WHY TWO COLUMNS PER ENCRYPTED NUMBER
-- ==========================================================================
--
-- AES-GCM is randomized: the same number encrypted twice yields different
-- ciphertexts, so `WHERE counterparty_ciphertext = $1` matches nothing, ever.
-- Wave 3's SMS threading needs exactly that lookup.
--
-- So each encrypted number is TWO columns: a randomized ciphertext nobody can
-- read, and a `_index` — a keyed one-way hash (@taskflow/security's
-- blindIndex) that supports equality and nothing else. The two shortcuts this
-- avoids are both cryptographic mistakes: storing plaintext "just for the
-- index" (then it is plaintext), or encrypting deterministically (then the
-- equality leak applies to the ciphertext itself, and the value is still
-- recoverable by whoever holds the key).
--
-- The index is namespaced by org id, so the same number in two tenants
-- produces two unrelated indexes and the column cannot be used to correlate
-- people across orgs.
--
-- ==========================================================================
-- WHICH KEY ENCRYPTS THEM
-- ==========================================================================
--
-- The org's existing subaccount data key (comms.subaccounts, 0032), with a
-- distinct AAD per column so a ciphertext moved between columns or rows fails
-- to decrypt rather than silently returning the wrong value.
--
-- Reusing that key is safe and is also guaranteed to be AVAILABLE: the Wave 1
-- gate refuses every outbound action with `no_subaccount`, and an inbound call
-- can only arrive on a number bought through a subaccount. No subaccount means
-- no calls, which means no PII needing a key. The invariant falls out of the
-- gate rather than needing to be maintained.

-- --------------------------------------------------------------------------
-- comms.phone_numbers — the org's own numbers (§3.10, Wave 2)
--
-- `inbound_route` is a validated JSON blob rather than a table because it is a
-- CONFIG document, not a set of related rows: an IVR is a tree of prompts and
-- destinations, and modelling it relationally would mean four tables to express
-- something every read wants in one piece. It is parsed by a Zod schema on the
-- way in and on the way out (guardrail 6), so the database storing it opaquely
-- does not mean it is unvalidated.
-- --------------------------------------------------------------------------
CREATE TABLE comms.phone_numbers (
  id            uuid        PRIMARY KEY,
  org_id        uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  -- E.164, plaintext. See the header: this is the org's own published number.
  e164          text        NOT NULL,
  -- The carrier's id for it, needed to release it later.
  provider_sid  text        NOT NULL,
  iso_country   text        NOT NULL,

  inbound_route jsonb,

  purchased_by  uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  purchased_at  timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz,

  CONSTRAINT phone_numbers_e164_format CHECK (e164 ~ '^\+[1-9][0-9]{1,14}$'),
  CONSTRAINT phone_numbers_country_format CHECK (iso_country ~ '^[A-Z]{2}$')
);

-- GLOBALLY unique, not per-org. A phone number is a globally unique resource —
-- the carrier will not sell the same one twice — and an inbound webhook
-- resolves an org FROM this column, so two rows claiming one number would make
-- that resolution ambiguous in the one place there is no user to ask.
--
-- Partial, on live numbers only: a released number can genuinely be bought by
-- somebody else later, and the historical row must not block that.
CREATE UNIQUE INDEX phone_numbers_e164_live_key ON comms.phone_numbers (e164)
  WHERE released_at IS NULL;

-- Target of comms.calls' composite FK. A plain REFERENCES phone_numbers(id)
-- would let a call name another org's number while carrying this org's org_id,
-- which RLS would then happily show to the wrong tenant — the same trap
-- docs.spaces' own unique index documents.
CREATE UNIQUE INDEX phone_numbers_org_id_key ON comms.phone_numbers (org_id, id);

CREATE INDEX phone_numbers_org_live_idx ON comms.phone_numbers (org_id, e164)
  WHERE released_at IS NULL;

-- --------------------------------------------------------------------------
-- comms.calls — the call log (§3.10), and the consent record (§3.5)
--
-- The consent columns are NOT a settings snapshot. PLAN.md §8.5 requires a
-- consent gate BEFORE recording begins, with an enforced announcement in
-- two-party jurisdictions. `announcement_played_at` is written when the carrier
-- confirms the audio actually played, and `recording_started_at` cannot be set
-- before it — enforced by the CHECK below rather than by service code, because
-- "the service always does it in the right order" is exactly the kind of claim
-- that survives until a second call site appears.
-- --------------------------------------------------------------------------
CREATE TABLE comms.calls (
  id                     uuid        PRIMARY KEY,
  org_id                 uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  direction              text        NOT NULL,
  -- The org's own number this call used. Composite FK below.
  phone_number_id        uuid,

  -- The other party. Encrypted + blind-indexed; see the header.
  counterparty_ciphertext bytea      NOT NULL,
  counterparty_index      bytea      NOT NULL,

  status                 text        NOT NULL DEFAULT 'queued',
  provider_sid           text,

  -- Who clicked call. Null for inbound.
  placed_by              uuid        REFERENCES identity.users (id) ON DELETE SET NULL,

  started_at             timestamptz,
  answered_at            timestamptz,
  ended_at               timestamptz,
  duration_seconds       integer,

  -- Consent (§3.5). `consent_basis` records WHAT decided the requirement, for
  -- a compliance reviewer who needs to know why an announcement was or was not
  -- played on a specific call two years ago.
  consent_rule           text,
  consent_basis          text,
  announcement_required  boolean     NOT NULL DEFAULT true,
  announcement_played_at timestamptz,
  recording_started_at   timestamptz,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT calls_direction_valid CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT calls_status_valid CHECK (
    status IN ('queued', 'ringing', 'in_progress', 'completed', 'busy', 'no_answer', 'failed', 'canceled')
  ),
  CONSTRAINT calls_consent_rule_valid CHECK (
    consent_rule IS NULL OR consent_rule IN ('all_party', 'one_party')
  ),

  -- THE consent invariant, in the database rather than in a service.
  --
  -- If an announcement was required, recording may not have started before the
  -- announcement finished playing. A service can be careful about this; a CHECK
  -- makes the illegal state unrepresentable, which is what CLAUDE.md means by
  -- making dangerous mistakes impossible to express rather than discouraged.
  CONSTRAINT calls_recording_after_announcement CHECK (
    recording_started_at IS NULL
    OR announcement_required = false
    OR (announcement_played_at IS NOT NULL AND recording_started_at >= announcement_played_at)
  ),

  CONSTRAINT calls_duration_nonnegative CHECK (duration_seconds IS NULL OR duration_seconds >= 0),

  FOREIGN KEY (org_id, phone_number_id)
    REFERENCES comms.phone_numbers (org_id, id) ON DELETE SET NULL
);

-- The carrier's id, unique per org. This is the DURABLE idempotency the webhook
-- nonce table (0032) is only a fast path in front of: a status callback
-- replayed after the 5-minute nonce window updates one row rather than creating
-- a second call.
CREATE UNIQUE INDEX calls_provider_sid_key ON comms.calls (org_id, provider_sid)
  WHERE provider_sid IS NOT NULL;

CREATE UNIQUE INDEX calls_org_id_key ON comms.calls (org_id, id);

CREATE INDEX calls_org_recent_idx ON comms.calls (org_id, created_at DESC);

-- Wave 3's SMS threading and "show me every call with this person" both key off
-- this. Useless without the blind index, which is why the two columns arrive
-- together.
CREATE INDEX calls_counterparty_idx ON comms.calls (org_id, counterparty_index);

-- --------------------------------------------------------------------------
-- comms.recordings — ingested into OUR storage, never left on Twilio (§3.6)
--
-- PLAN.md §8.5: "Recordings stored in your own object storage, never left on
-- Twilio. Access requires explicit permission plus step-up auth. Every download
-- audited."
--
-- The status column is the same shape as work.attachments' scan pipeline, and
-- for the same reason: `presignDownload` is called for exactly ONE value of it.
-- The difference is the direction of trust — an attachment arrives from an
-- untrusted browser and must be scanned, a recording arrives from the carrier
-- over a signed callback, so there is no magic-byte or AV step here. What
-- carries over unchanged is that a presigned URL is the only door.
-- --------------------------------------------------------------------------
CREATE TABLE comms.recordings (
  id               uuid        PRIMARY KEY,
  org_id           uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  call_id          uuid        NOT NULL,

  provider_sid     text        NOT NULL,
  -- Where the carrier says the audio is. Used ONCE, by the ingest sweep, and
  -- never handed to a client: it is a URL to a third party's copy of a private
  -- conversation.
  provider_url     text,

  status           text        NOT NULL DEFAULT 'pending',
  -- Set when status becomes 'stored'. Server-generated; nothing from a client
  -- ever reaches it (packages/storage/keys.ts).
  storage_key      text,
  bytes            bigint,
  duration_seconds integer,

  -- Why ingestion failed, for the sweep's own retry accounting.
  last_error       text,
  attempts         integer     NOT NULL DEFAULT 0,

  created_at       timestamptz NOT NULL DEFAULT now(),
  stored_at        timestamptz,

  CONSTRAINT recordings_status_valid CHECK (
    status IN ('pending', 'stored', 'failed', 'deleted')
  ),

  -- A 'stored' row with no key is a row `presignDownload` would hand out a URL
  -- to nothing for. Unrepresentable rather than defended against.
  CONSTRAINT recordings_stored_has_key CHECK (
    status <> 'stored' OR (storage_key IS NOT NULL AND stored_at IS NOT NULL)
  ),

  FOREIGN KEY (org_id, call_id) REFERENCES comms.calls (org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX recordings_provider_sid_key ON comms.recordings (org_id, provider_sid);
CREATE UNIQUE INDEX recordings_org_id_key ON comms.recordings (org_id, id);

-- The ingest sweep's claim query: oldest pending first, across orgs.
CREATE INDEX recordings_pending_idx ON comms.recordings (status, created_at)
  WHERE status = 'pending';

-- --------------------------------------------------------------------------
-- comms.transcripts — redacted BEFORE the insert (§3.7)
--
-- There is no `raw_text` column, and its absence is the control. PLAN.md §8.5
-- says redaction happens "before storage"; a schema with somewhere to put the
-- unredacted text is a schema where somebody eventually does, and the window
-- between writing it and redacting it is exactly what the requirement forbids.
--
-- `redaction_counts` records which rules fired and how often — never what they
-- matched, which would put the PII straight back.
-- --------------------------------------------------------------------------
CREATE TABLE comms.transcripts (
  id               uuid        PRIMARY KEY,
  org_id           uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  recording_id     uuid        NOT NULL,

  -- Already redacted. Always.
  text             text        NOT NULL,
  language         text,
  redaction_counts jsonb       NOT NULL DEFAULT '{}'::jsonb,

  created_at       timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (org_id, recording_id) REFERENCES comms.recordings (org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX transcripts_recording_key ON comms.transcripts (org_id, recording_id);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, as every other tenant table.
-- --------------------------------------------------------------------------

ALTER TABLE comms.phone_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.phone_numbers FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS phone_numbers_tenant_isolation ON comms.phone_numbers;
CREATE POLICY phone_numbers_tenant_isolation ON comms.phone_numbers
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE comms.calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.calls FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calls_tenant_isolation ON comms.calls;
CREATE POLICY calls_tenant_isolation ON comms.calls
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE comms.recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.recordings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recordings_tenant_isolation ON comms.recordings;
CREATE POLICY recordings_tenant_isolation ON comms.recordings
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE comms.transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.transcripts FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transcripts_tenant_isolation ON comms.transcripts;
CREATE POLICY transcripts_tenant_isolation ON comms.transcripts
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- The recording-ingest role (§3.6, and the taskflow_backlinks precedent, 0025)
--
-- The sweep that pulls recordings off the carrier runs across EVERY tenant —
-- it has no request and no org — so it cannot use withOrgScope. Rather than
-- widen withGlobalScope, it gets its own role with a COLUMN-LEVEL grant that
-- excludes every column it has no business reading.
--
-- What it can see: which recordings are pending, and where the carrier says
-- the audio is. What it cannot see: comms.calls at all — so the role that
-- fetches a recording cannot learn whose conversation it is, the same
-- separation taskflow_backlinks has from docs.page_versions.state.
--
-- NO row-locking clause is used against this grant. 0025's own lesson, learned
-- against a real database: `FOR UPDATE` needs SELECT on EVERY column of a
-- table, not just the projected ones, and Postgres refuses it with "permission
-- denied" — which a migration review and a type checker both read as fine.
-- --------------------------------------------------------------------------
-- The ROLE itself is created in docker/postgres/init/02-roles.sql, never here.
-- Roles are cluster-wide and grants are per-database, which is the split that
-- lets taskflow_test receive an identical privilege setup; and taskflow_migrator
-- is NOCREATEROLE by design, so a CREATE ROLE in a migration fails with
-- "permission denied to create role" — as this one did, before it was moved.

GRANT USAGE ON SCHEMA comms TO taskflow_recording_ingest;

GRANT SELECT (id, org_id, call_id, provider_sid, provider_url, status, attempts, created_at)
  ON comms.recordings TO taskflow_recording_ingest;
GRANT UPDATE (status, storage_key, bytes, duration_seconds, stored_at, last_error, attempts)
  ON comms.recordings TO taskflow_recording_ingest;

ALTER TABLE comms.recordings FORCE ROW LEVEL SECURITY;

-- Cross-tenant BY DESIGN for this role only, and read/update only — it can
-- never insert a recording, so a compromised sweep cannot fabricate one
-- pointing at an object it controls.
DROP POLICY IF EXISTS recordings_ingest_read ON comms.recordings;
CREATE POLICY recordings_ingest_read ON comms.recordings
  FOR SELECT TO taskflow_recording_ingest
  USING (true);

DROP POLICY IF EXISTS recordings_ingest_update ON comms.recordings;
CREATE POLICY recordings_ingest_update ON comms.recordings
  FOR UPDATE TO taskflow_recording_ingest
  USING (true)
  WITH CHECK (true);
