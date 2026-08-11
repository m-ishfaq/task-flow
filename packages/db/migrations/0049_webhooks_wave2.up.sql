-- 0049 — outbound webhooks (ai/phase-10-automation.md, Wave 2)
--
-- The first thing in this codebase that deliberately makes a request to a URL
-- a USER chose, on a schedule, without a person watching (§5). Link unfurls do
-- this already, which is why the SSRF gate exists — but an unfurl is one fetch
-- triggered by a human pasting a link, and a webhook is a standing instruction.
--
-- Two tables, one registry and one queue:
--
--   - platform.webhooks        — endpoints the org registered. The SIGNING
--                                secret lives here, encrypted at rest under a
--                                per-webhook data key (the subaccount pattern),
--                                because the receiver must verify us and we
--                                must be able to sign — a hash would make
--                                signing impossible.
--   - platform.webhook_deliveries — the queue. Written by the `call_webhook`
--                                automation action (through apps/api's service
--                                layer, emitting webhook.delivery_queued) and
--                                drained by a loop in apps/worker.
--
-- ==========================================================================
-- WHY `platform` AND WHAT THAT COSTS (same statement as 0047's header)
-- ==========================================================================
--
-- `platform` carries ALTER DEFAULT PRIVILEGES from 0001, so taskflow_app
-- already holds full CRUD on every table created here BEFORE any GRANT in this
-- file runs. The grants below are a restatement of access that already exists,
-- not the thing creating it — written out anyway so reading this migration
-- tells the truth about what the app role can do (the 0036 lesson).
--
-- The role that must NOT reach these tables is taskflow_webhook, and the way
-- that is guaranteed is by never granting it anything on platform.webhooks at
-- all: the role that CLAIMS a delivery can never read the endpoint's URL or
-- its signing key. Those are loaded afterward, per org, over the ordinary
-- taskflow_app connection inside withOrgScope — the same claim-only separation
-- taskflow_backlinks has from docs.page_versions, with the same consequence
-- that a compromised claim role can neither see what is being delivered nor
-- forge a signature.

-- --------------------------------------------------------------------------
-- platform.webhooks — the registry.
--
-- `url` is shape-checked at the service with the real SSRF gate
-- (`packages/security/outbound-url.ts`), which is why the CHECK below only
-- demands a scheme — the meaningful test happens where the test can change
-- with the security module, not in a constraint that would drift.
--
-- `signing_key_wrapped` + `signing_key_master_id` are a per-webhook data key
-- from the KeyProvider, exactly as comms.subaccounts stores its auth token:
-- the wrapped key names the master key that unwraps it, so key rotation can
-- tell generations apart.
-- --------------------------------------------------------------------------
CREATE TABLE platform.webhooks (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  name        text        NOT NULL,
  url         text        NOT NULL,

  -- The per-endpoint half of the kill switch. A failing endpoint is
  -- auto-disabled after its dead-letter threshold (see the delivery loop) with
  -- `disabled_at` recording when, so an operator can tell an operator's pause
  -- from an automated one.
  enabled     boolean     NOT NULL DEFAULT true,
  disabled_at timestamptz,

  -- How many deliveries have ever failed. Kept as its own counter rather than
  -- derived from the queue so the disable decision and the health read do not
  -- have to query the (prunable) delivery history.
  failure_count integer    NOT NULL DEFAULT 0,

  -- WHOSE endpoint it is. The delivery loop notifies `created_by` when the
  -- endpoint is auto-disabled — the person who set up the behaviour is the
  -- person who can fix it.
  created_by  uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  -- Envelope-encrypted `tf_whs` signing secret (packages/security/tokens.ts).
  -- Shown ONCE at creation — the org pastes it into their receiver, and a lost
  -- secret means recreating the webhook, never reading it back out. The three
  -- columns are the comms.subaccounts shape: `signing_key_ciphertext` is
  -- AES-GCM(secret, per-webhook data key), and the data key itself is stored
  -- wrapped by the master key whose id `signing_key_master_id` names, so a
  -- master-key rotation can tell generations apart.
  signing_key_ciphertext bytea   NOT NULL,
  signing_key_wrapped    bytea   NOT NULL,
  signing_key_master_id  text    NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT webhooks_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT webhooks_name_length  CHECK (length(name) <= 120),
  CONSTRAINT webhooks_url_scheme   CHECK (url LIKE 'http://%' OR url LIKE 'https://%'),
  CONSTRAINT webhooks_url_length   CHECK (length(url) <= 2048),
  CONSTRAINT webhooks_failures_nonnegative CHECK (failure_count >= 0),

  CONSTRAINT webhooks_signing_key_present CHECK (octet_length(signing_key_ciphertext) > 0),
  CONSTRAINT webhooks_wrapped_key_present CHECK (octet_length(signing_key_wrapped) > 0)
);

-- One webhook name per org, case-insensitive — the same reasoning as
-- automations_org_name_key: two endpoints called "Ship it" are
-- indistinguishable in a list, which is where a name is read.
CREATE UNIQUE INDEX webhooks_org_name_key
  ON platform.webhooks (org_id, lower(name));

-- What `webhook_deliveries`' composite FK references. Declared here because
-- Postgres resolves REFERENCES at CREATE TABLE time (the 0047 lesson).
CREATE UNIQUE INDEX webhooks_org_id_key ON platform.webhooks (org_id, id);

-- --------------------------------------------------------------------------
-- platform.webhook_deliveries — the queue.
--
-- `payload` is the canonical JSON body the receiver is sent (the triggering
-- event's envelope fields), signed with the webhook's secret. The delivery
-- loop reads it per org over the app role — the claim role below never sees it.
--
-- `status`: pending -> (succeeded | dead). There is no 'in_flight': the claim
-- is a conditional UPDATE on `attempts` (the recording-ingest pattern), so a
-- row stays `pending` while its attempt is being made, and a worker that dies
-- mid-attempt simply retries on the next tick — at-least-once, told to
-- deduplicate on the event id.
-- --------------------------------------------------------------------------
CREATE TABLE platform.webhook_deliveries (
  id           uuid        PRIMARY KEY,
  org_id       uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  webhook_id   uuid        NOT NULL,

  -- The event that caused this delivery. NOT a foreign key to platform.outbox,
  -- for the same reason automation_runs.event_id is not one: Phase 11 will
  -- prune the outbox, and an FK would block it.
  event_id     uuid        NOT NULL,
  event_name   text        NOT NULL,

  payload      jsonb       NOT NULL,

  status       text        NOT NULL DEFAULT 'pending',
  attempts     integer     NOT NULL DEFAULT 0,

  -- When this row may next be claimed. Backoff is expressed HERE (set on
  -- failure), so a dead endpoint stops costing a claim per tick long before it
  -- is dead-lettered.
  next_attempt_at timestamptz NOT NULL DEFAULT now(),

  last_status_code integer,
  last_error       text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT webhook_deliveries_status_valid
    CHECK (status IN ('pending', 'succeeded', 'dead')),
  CONSTRAINT webhook_deliveries_attempts_nonnegative CHECK (attempts >= 0),

  CONSTRAINT webhook_deliveries_payload_shape
    CHECK (jsonb_typeof(payload) = 'object'),

  -- org-scoped composite FK, the work.cards pattern: a delivery can never name
  -- a webhook belonging to another tenant, and the database refuses it rather
  -- than the service remembering to check.
  CONSTRAINT webhook_deliveries_webhook_fk
    FOREIGN KEY (org_id, webhook_id)
      REFERENCES platform.webhooks (org_id, id) ON DELETE CASCADE
);

-- The engine is at-least-once, so a redelivered event could enqueue the same
-- webhook twice. The dedupe key makes the second insert a no-op — the honest
-- fix 0047's relay comment names as belonging to this wave.
CREATE UNIQUE INDEX webhook_deliveries_dedupe_key
  ON platform.webhook_deliveries (org_id, webhook_id, event_id);

-- The delivery loop's claim: due rows first. `next_attempt_at` is the backoff,
-- so this index is what keeps a dead endpoint out of the hot path.
CREATE INDEX webhook_deliveries_due_idx
  ON platform.webhook_deliveries (status, next_attempt_at, created_at);

-- --------------------------------------------------------------------------
-- platform.notifications — admit the webhook-disable kind.
-- --------------------------------------------------------------------------
-- The delivery loop notifies the endpoint's creator when an endpoint is
-- auto-disabled (§5: "A failing endpoint is disabled after a threshold, with
-- the org notified"). The kind CHECK is the 0027 pattern — a constraint swap,
-- never an enum — and the existing unique (org_id, subject_id, user_id, kind)
-- index makes the notification itself idempotent across redelivered batches.
ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_kind_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_kind_valid
    CHECK (kind IN (
      'chat.mention', 'chat.direct', 'chat.thread_reply',
      'card.assigned', 'card.comment_mention', 'card.due_soon',
      'page.comment_mention',
      'call.missed',
      'webhook.disabled'
    ));

-- The disable notification's subject IS the webhook — a real new subject
-- type, so the CHECK widens with the kind (the 0042 pattern, one swap).
ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_subject_type_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_subject_type_valid
    CHECK (subject_type IN ('message', 'card', 'page', 'call', 'webhook'));

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, verbatim from rls.ts.
-- --------------------------------------------------------------------------

ALTER TABLE platform.webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.webhooks FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhooks_tenant_isolation ON platform.webhooks;
CREATE POLICY webhooks_tenant_isolation ON platform.webhooks
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE platform.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.webhook_deliveries FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_deliveries_tenant_isolation ON platform.webhook_deliveries;
CREATE POLICY webhook_deliveries_tenant_isolation ON platform.webhook_deliveries
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- Grants for the APPLICATION role — a restatement, not a creation; see the
-- file header.
--
-- `webhook_deliveries` is INSERT + SELECT for the app role: the enqueue
-- (through apps/api's service layer) writes pending rows, and the run history /
-- future delivery UI reads them. Nothing in the application rewrites a
-- delivery's outcome after the fact — that is the claim role's job, below.
-- --------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.webhooks TO taskflow_app;
GRANT SELECT, INSERT ON platform.webhook_deliveries TO taskflow_app;
REVOKE UPDATE, DELETE ON platform.webhook_deliveries FROM taskflow_app;

-- --------------------------------------------------------------------------
-- taskflow_webhook — the delivery loop's CLAIM role (the recording-ingest
-- recipe, second use).
-- --------------------------------------------------------------------------
-- The role is created in docker/postgres/init/02-roles.sql, not here — roles
-- are cluster-wide and the migrator is NOCREATEROLE on purpose (0047's note).
--
-- What it may do is the one thing the delivery loop needs done across every
-- tenant in one pass: CLAIM due deliveries and record their outcomes. Its
-- grants are COLUMN-LEVEL, and what is excluded is the point:
--
--   - it never sees `payload` — the role that decides what to deliver cannot
--     read what is being delivered (the taskflow_backlinks shape);
--   - it holds NOTHING on platform.webhooks — it cannot learn the endpoint's
--     URL, and cannot read or forge the signing key.
--
-- The URL, the signing key and the payload are all loaded afterward, per org,
-- over the ordinary taskflow_app connection inside withOrgScope. This is the
-- identical split 0047 draws for taskflow_automation: the role that decides
-- "which rows need work" cannot do the work.
--
-- The claim is a conditional UPDATE (never FOR UPDATE ... SKIP LOCKED), which
-- is what makes column-level grants possible at all — a row lock would demand
-- SELECT on every column (the backlinks lesson) and widen this grant to
-- include the payload. `attempts` is both the retry budget and the optimistic
-- concurrency token, exactly as comms.recordings uses it.
GRANT USAGE ON SCHEMA platform TO taskflow_webhook;

GRANT SELECT (id, org_id, webhook_id, status, attempts, next_attempt_at, created_at)
  ON platform.webhook_deliveries TO taskflow_webhook;
GRANT UPDATE (status, attempts, next_attempt_at, last_status_code, last_error, updated_at)
  ON platform.webhook_deliveries TO taskflow_webhook;

DROP POLICY IF EXISTS webhook_deliveries_webhook_claim_read ON platform.webhook_deliveries;
CREATE POLICY webhook_deliveries_webhook_claim_read ON platform.webhook_deliveries
  FOR SELECT TO taskflow_webhook
  USING (true);

-- WITH CHECK (true), not (false) — unlike the outbox claim roles, this role
-- GENUINELY writes the rows it claims (marking outcomes). The 0016/0047
-- WITH CHECK (false) exists because a locking select never writes; here the
-- write is the point.
DROP POLICY IF EXISTS webhook_deliveries_webhook_claim_update ON platform.webhook_deliveries;
CREATE POLICY webhook_deliveries_webhook_claim_update ON platform.webhook_deliveries
  FOR UPDATE TO taskflow_webhook
  USING (true)
  WITH CHECK (true);
