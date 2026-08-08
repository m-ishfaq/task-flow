-- 0032 — Phase 7 (Voice & Messaging) Wave 1: the safety rails, before anything
-- they gate exists. (PLAN.md §8.5; ai/phase-7-voice.md §3.1-§3.4, §3.11)
--
-- ==========================================================================
-- THE SCHEMA IS `comms`, NOT `telephony`
-- ==========================================================================
--
-- ai/phase-7-voice.md's draft said `telephony.*` throughout. 0001_schemas
-- created `CREATE SCHEMA comms` -- "calls, recordings, sms, spend ledger" --
-- and granted taskflow_app USAGE plus ALTER DEFAULT PRIVILEGES on it in the
-- same migration. A second schema would need its own grant chain to buy
-- nothing. The spec's status header records the correction.
--
-- ==========================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CONTAIN
-- ==========================================================================
--
-- No calls, messages, recordings, or transcripts. Wave 1's whole premise
-- (§3.2) is that the gate ships BEFORE the capability it gates, so that Wave 2
-- cannot ship without it. These five tables are the gate's state and nothing
-- else.
--
-- No new database role, unlike 0024 (taskflow_collab) or 0025
-- (taskflow_backlinks). Every read here happens either inside an ordinary
-- withOrgScope transaction or -- for the one genuinely pre-tenant lookup --
-- against a table carrying no secrets at all. See comms.subaccount_orgs.

-- --------------------------------------------------------------------------
-- comms.subaccounts -- the per-org carrier tenancy boundary (§3.1)
--
-- PLAN.md §8.5: "Twilio subaccount per org -- a leaked credential's blast
-- radius is one tenant."
--
-- The auth token is stored ENCRYPTED under the org's own data key, wrapped by
-- the master key (the KeyProvider envelope scheme, §8.4). This is that
-- interface's first real consumer: it has existed since Phase 0B with a
-- software implementation and no caller.
--
-- Worth being precise about what the stored token is FOR, because it reads
-- like an access credential and is not one. Outbound API calls authenticate as
-- `subaccount_sid : master auth token` -- Twilio accepts the parent's token for
-- its children, so the application never needs this value to spend money. It is
-- needed for exactly one thing: verifying the SIGNATURE on webhooks from this
-- subaccount, which Twilio signs with the subaccount's own token and nothing
-- else can check. It is a verification key that happens to also be a credential,
-- which is why it is encrypted at rest rather than merely access-controlled.
-- --------------------------------------------------------------------------
CREATE TABLE comms.subaccounts (
  org_id                uuid        PRIMARY KEY REFERENCES identity.orgs (id) ON DELETE CASCADE,

  provider              text        NOT NULL DEFAULT 'twilio',
  subaccount_sid        text        NOT NULL,

  -- Envelope-encrypted (§8.4). Never selected into a route's output; the only
  -- consumer is the webhook signature check.
  auth_token_ciphertext bytea       NOT NULL,
  data_key_wrapped      bytea       NOT NULL,
  data_key_master_id    text        NOT NULL,

  -- The carrier's own view of the account, mirrored so the org-freeze path can
  -- record that it suspended the subaccount AT Twilio and not only refused
  -- locally (ai/phase-12-admin.md §9's stretch goal).
  status                text        NOT NULL DEFAULT 'active',

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subaccounts_provider_valid CHECK (provider IN ('twilio')),
  CONSTRAINT subaccounts_status_valid   CHECK (status IN ('active', 'suspended', 'closed')),
  CONSTRAINT subaccounts_sid_present    CHECK (length(btrim(subaccount_sid)) > 0)
);

-- One org per carrier subaccount, globally. Not merely per-org: two orgs
-- sharing a subaccount would mean one tenant's webhook resolving to the other's
-- data, which is the tenancy boundary this whole table exists to draw.
CREATE UNIQUE INDEX subaccounts_sid_key ON comms.subaccounts (subaccount_sid);

-- --------------------------------------------------------------------------
-- comms.subaccount_orgs -- the pre-tenant lookup, and the one table here with
-- no RLS (§3.11)
--
-- ==========================================================================
-- WHY THIS TABLE EXISTS AT ALL, WHICH IS NOT OBVIOUS
-- ==========================================================================
--
-- An inbound Twilio webhook is an unauthenticated POST. To verify its
-- signature we need the subaccount's auth token; to read that token under RLS
-- we need an org_id; and the only thing identifying the org is the AccountSid
-- INSIDE the very payload we have not verified yet. That is a genuine
-- chicken-and-egg, not an oversight: withOrgScope cannot be opened without the
-- answer, and withGlobalScope -- which could read across tenants -- is
-- lint-restricted to the identity module and would return zero rows against an
-- RLS'd table anyway.
--
-- The resolution is to split the lookup from the secret. This table maps a
-- carrier SID to an org id and holds NOTHING ELSE. Reading all of it teaches an
-- attacker that some opaque SID belongs to some opaque UUID, and no credential,
-- no phone number, no spend figure. The auth token stays in comms.subaccounts
-- above, behind ordinary RLS, read only after the org is known.
--
-- The alternative considered was a dedicated database role with a column-level
-- grant, the taskflow_backlinks pattern (0025). Rejected because the isolation
-- it buys here is illusory: that role would need the ciphertext column to do
-- its job, and the same process holds the master key, so it could decrypt what
-- the grant was supposedly withholding. A table with no secrets in it is a
-- stronger statement than a narrow grant on a table that has them.
--
-- Non-tenant tables are established vocabulary in this codebase -- people.
-- profiles (0030) is one, for its own structural reason. This is not a new
-- exception being invented.
-- --------------------------------------------------------------------------
CREATE TABLE comms.subaccount_orgs (
  subaccount_sid text NOT NULL PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE
);

-- --------------------------------------------------------------------------
-- comms.spend_policy -- the cap, per org (§3.3, §7.2)
--
-- A table rather than a column on comms.subaccounts, because a cap is an org
-- POLICY and a subaccount is provisioning: the cap must be settable before a
-- subaccount exists and must survive one being closed and recreated. It also
-- gives the "who may raise it" route (Owner + step-up) something to write that
-- is not tangled with carrier state.
--
-- 2500 cents over 30 rolling days is the resolved default (§7.2): roughly 12x
-- PLAN.md §14's ~$2/month expected spend, so a real demo never trips it, while
-- an SMS-pumping burst hits the wall in minutes.
--
-- ROLLING, not calendar. A calendar reset hands an attacker a guaranteed fresh
-- budget on a date they can read off a calendar.
-- --------------------------------------------------------------------------
CREATE TABLE comms.spend_policy (
  org_id       uuid        PRIMARY KEY REFERENCES identity.orgs (id) ON DELETE CASCADE,

  cap_cents    bigint      NOT NULL DEFAULT 2500,
  window_days  integer     NOT NULL DEFAULT 30,

  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid        REFERENCES identity.users (id) ON DELETE SET NULL,

  -- A negative cap would be a cap that refuses everything, which sounds safe
  -- and is actually a silent outage; zero is the honest way to say "no spend".
  CONSTRAINT spend_policy_cap_nonnegative CHECK (cap_cents >= 0),
  CONSTRAINT spend_policy_window_sane     CHECK (window_days BETWEEN 1 AND 365)
);

-- --------------------------------------------------------------------------
-- comms.spend_ledger -- what the cap is computed FROM (§3.4)
--
-- Written in the SAME transaction as the record of the action, never inferred
-- later from the carrier's billing API. §3.4's reasoning, which is the same
-- shape as work.projects.next_card_number: the number that gates the next spend
-- decision must not depend on a reconciliation job running on time, or the cap
-- becomes a control with a lag that can be outrun by placing calls faster than
-- the reconciliation interval.
--
-- Two amounts, and the difference matters. `estimated_cents` is what the gate
-- charged against the cap BEFORE the carrier was called; `actual_cents` is what
-- the carrier's asynchronous billing callback later reported. The rolling sum
-- reads COALESCE(actual, estimated), so an unreconciled row still counts at its
-- conservative estimate rather than counting as zero.
-- --------------------------------------------------------------------------
CREATE TABLE comms.spend_ledger (
  id              uuid        PRIMARY KEY,
  org_id          uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  kind            text        NOT NULL,
  estimated_cents bigint      NOT NULL,
  actual_cents    bigint,

  -- The carrier's own identifier (CA.../SM.../PN...). Nullable because the
  -- ledger row is written before the provider call returns in some paths, and
  -- UNIQUE per org so the billing callback's correction is idempotent -- a
  -- retried callback updates one row rather than appending a second charge.
  provider_sid    text,

  occurred_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT spend_ledger_kind_valid CHECK (
    kind IN ('call', 'sms', 'number_purchase', 'verification')
  ),
  CONSTRAINT spend_ledger_estimate_nonnegative CHECK (estimated_cents >= 0),
  CONSTRAINT spend_ledger_actual_nonnegative   CHECK (actual_cents IS NULL OR actual_cents >= 0)
);

-- The gate's read: sum this org's window. Ordered so the rolling-window scan
-- is an index range rather than a filter over the org's whole history.
CREATE INDEX spend_ledger_org_window_idx ON comms.spend_ledger (org_id, occurred_at DESC);

CREATE UNIQUE INDEX spend_ledger_provider_sid_key
  ON comms.spend_ledger (org_id, provider_sid)
  WHERE provider_sid IS NOT NULL;

-- --------------------------------------------------------------------------
-- comms.webhook_nonces -- replay protection (§3.11; PLAN.md §8.5's "nonce
-- cache with a 5-minute window")
--
-- ==========================================================================
-- THE NONCE IS RECORDED ON SUCCESS, INSIDE THE HANDLER'S TRANSACTION
-- ==========================================================================
--
-- Not on receipt. Twilio legitimately RETRIES a webhook when we answer 5xx, and
-- a retry carries a byte-identical signature -- so a nonce written on receipt
-- would mark the request seen, the handler would then fail, and the retry that
-- exists to recover the event would be rejected as a replay. The event is lost,
-- silently, and only when something was already going wrong.
--
-- Writing it in the same transaction as the effect makes a failed attempt roll
-- the nonce back with everything else, so a retry proceeds normally and a
-- replay of an attempt that SUCCEEDED is refused. This is the same
-- claim/write/mark-in-one-transaction discipline the outbox relay already uses
-- to make the audit projection exactly-once.
--
-- Honest about the window: Twilio does not put a timestamp inside the signed
-- payload, so "5 minutes" is how long a nonce is RETAINED, not an age limit
-- read off the request. A replay arriving after the retention window would be
-- reprocessed. That is why Wave 2's call and message tables carry a UNIQUE
-- constraint on the carrier SID -- durable idempotency is a schema property
-- there, and this table is only the cheap fast path in front of it.
-- --------------------------------------------------------------------------
CREATE TABLE comms.webhook_nonces (
  org_id    uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  signature text        NOT NULL,
  seen_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, signature)
);

-- Supports the retention sweep, which deletes by age across orgs.
CREATE INDEX webhook_nonces_seen_at_idx ON comms.webhook_nonces (seen_at);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) -- generated form, as every other tenant table.
--
-- comms.subaccount_orgs is deliberately absent from this block. See its own
-- header: it is a non-tenant lookup table holding no secrets, and RLS on it
-- would make the pre-tenant webhook lookup it exists for return zero rows.
-- --------------------------------------------------------------------------

ALTER TABLE comms.subaccounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.subaccounts FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subaccounts_tenant_isolation ON comms.subaccounts;
CREATE POLICY subaccounts_tenant_isolation ON comms.subaccounts
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE comms.spend_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.spend_policy FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS spend_policy_tenant_isolation ON comms.spend_policy;
CREATE POLICY spend_policy_tenant_isolation ON comms.spend_policy
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE comms.spend_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.spend_ledger FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS spend_ledger_tenant_isolation ON comms.spend_ledger;
CREATE POLICY spend_ledger_tenant_isolation ON comms.spend_ledger
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE comms.webhook_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.webhook_nonces FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_nonces_tenant_isolation ON comms.webhook_nonces;
CREATE POLICY webhook_nonces_tenant_isolation ON comms.webhook_nonces
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
