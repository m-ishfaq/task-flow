-- 0099 — Phase 15 §2+§3: the AI provider foundation — a resolvable provider
-- config, per-org overrides, and the tenant-scoped usage/spend ledger.
-- (ai/phase-15-ai-copilot-and-permissions.md §2, §3; PLAN.md §13 row 15)
--
-- ==========================================================================
-- THE LEDGER IS `ai.usage_ledger`, NOT `platform.ai_usage_ledger`
-- ==========================================================================
--
-- The spec's draft used `platform.ai_usage_ledger` throughout, following
-- `platform.flag_overrides`'s shape. That is right for the model CATALOG
-- (`ai_provider_config` below really is global, exactly like
-- `flag_overrides` — one row per configured provider/model, owned by an
-- operator, containing no per-org work). It is wrong for the ledger, which
-- records what one org's members actually spent. A global table queried per
-- org would need `WHERE org_id = ...` in application code — CLAUDE.md's
-- non-negotiable rule 1 bans exactly that, because a forgotten filter there
-- leaks every tenant's usage into the unfiltered query, where a forgotten
-- filter on an RLS-protected table instead returns zero rows. So the ledger
-- gets its own schema, tenant-scoped and RLS-protected precisely like
-- `comms.spend_ledger` — the budget gate this migration exists to build is
-- the direct telephony analogue, and there is no reason its ledger should be
-- the one spend table in the system that trusts a WHERE clause instead of a
-- policy.
--
-- `platform.ai_org_overrides` (below) turned out to belong in neither camp
-- cleanly: it is operator-owned configuration, like `flag_overrides`, but
-- unlike `flag_overrides` it names one specific org per row rather than
-- being globally scalar — so it carries an `org_id` column, and
-- `scripts/check-migration-rls.mjs` is right to demand RLS on any table that
-- does. It gets `identity.orgs`'s own two-policy shape instead (migration
-- 0035 §3.7): the ordinary tenant-isolation policy, so an org's own request
-- can read which provider IT resolves to, plus a second permissive policy
-- naming `taskflow_platform_admin` for the console that sets it across every
-- org. Read-only for `taskflow_app` — only the console writes a row here.
--
-- ==========================================================================
-- A NEW SCHEMA, AND DELIBERATELY NO `ALTER DEFAULT PRIVILEGES` ON IT
-- ==========================================================================
--
-- Same reasoning as 0041's `rtc` schema (see that migration's own header,
-- and 0036's correction of 0035's `platform.operators` grant): a schema
-- with default privileges silently grants `taskflow_app` full CRUD on every
-- table a LATER migration creates there, which can be broader than that
-- migration's own GRANT line says. `ai` gets nothing implicit — every grant
-- below is explicit, so a future table in this schema starts with zero
-- privileges until it says otherwise.
--
-- ==========================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CONTAIN
-- ==========================================================================
--
-- No assistant, no tool registry, no conversation history. Mirroring Phase 7
-- Wave 1 and Phase 13 Wave 1's own build order (ai/phase-15-ai-copilot-and-
-- permissions.md §10: "§2 + §3 in parallel... retrofitting spend tracking
-- after the fact is the mistake to avoid") — the provider abstraction and
-- the spend ledger ship before anything that could spend against them.

CREATE SCHEMA IF NOT EXISTS ai;   -- the tenant-scoped side: usage/spend only

GRANT USAGE ON SCHEMA ai TO taskflow_app;
-- The operator console's cross-org spend report (§3.3) reads across every
-- tenant, the same reason `taskflow_platform_admin` exists at all.
GRANT USAGE ON SCHEMA ai TO taskflow_platform_admin;

-- --------------------------------------------------------------------------
-- platform.ai_provider_config — the operator-maintained model catalog (§2.3).
--
-- Global, exactly like `platform.flag_overrides`: one row per configured
-- provider/model pair, maintained through the platform-admin console, never
-- through a tenant-scoped route. `is_default` marks which row a org with no
-- override resolves to.
--
-- The API key is envelope-encrypted under the SAME `KeyProvider` scheme
-- `comms.subaccounts` uses (§8.4) — `..._ciphertext` / `data_key_wrapped` /
-- `data_key_master_id` is that scheme's column shape, copied rather than
-- reinvented. Unlike a subaccount's auth token, this key is not merely a
-- verification key that happens to double as a credential — it is spent
-- directly against a paid API on every completion, which is exactly why
-- `packages/ai` is named a human-review surface in CLAUDE.md: the thing
-- this table protects moves org-authored CONTENT to a third party, not only
-- money.
-- --------------------------------------------------------------------------
CREATE TABLE platform.ai_provider_config (
  id                  uuid        PRIMARY KEY,

  -- 'anthropic' today; a closed, small vocabulary rather than free text,
  -- because the value selects WHICH `AiProvider` IMPLEMENTATION is
  -- constructed — a typo here must fail loudly at write time, not resolve
  -- to "no provider" the first time an org tries to use it.
  provider            text        NOT NULL,
  model               text        NOT NULL,

  api_key_ciphertext  bytea       NOT NULL,
  data_key_wrapped    bytea       NOT NULL,
  data_key_master_id  text        NOT NULL,

  is_default          boolean     NOT NULL DEFAULT false,
  label               text        NOT NULL CHECK (btrim(label) <> ''),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_provider_config_provider_valid CHECK (provider IN ('anthropic'))
);

-- At most one default at a time — the resolver's "no override" path must
-- never face an ambiguous choice. A partial unique index rather than a CHECK
-- because the constraint spans rows, which CHECK cannot express.
CREATE UNIQUE INDEX ai_provider_config_one_default_idx
  ON platform.ai_provider_config ((is_default))
  WHERE is_default;

-- Unlike `platform.operators`, this table is meant to be written by the
-- application, never by hand. No RLS: global by design, no `org_id` column
-- at all. Granted to BOTH `taskflow_app` (the resolver reads it on the
-- ordinary pool, via `withGlobalScope`, on every completion request — there
-- is no tenant context to open a second connection for) and
-- `taskflow_platform_admin` (the console writes it) — the identical split
-- `platform.flag_overrides` already uses for the same reason.
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.ai_provider_config TO taskflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.ai_provider_config TO taskflow_platform_admin;

-- --------------------------------------------------------------------------
-- platform.ai_org_overrides — per-org provider choice (§2.3, §3.3).
--
-- Shaped like `platform.flag_overrides` (a primary key naming what is being
-- overridden, the value, who set it and when) but NOT exempt from RLS the
-- way that table is, because this one names a specific org per row. An org
-- with no row here resolves to whichever `ai_provider_config` row has
-- `is_default = true`.
--
-- Two policies, mirroring `identity.orgs`'s own split from migration 0035
-- §3.7: the ordinary tenant-isolation policy lets an org's own request (the
-- config-resolver, running inside its normal `withOrgScope`) read which
-- provider IT resolves to, and a second permissive policy for
-- `taskflow_platform_admin` lets the console set an override for ANY org.
-- `taskflow_app` is granted SELECT only — an org never writes its own
-- override, only an operator does, through the console's own connection.
-- --------------------------------------------------------------------------
CREATE TABLE platform.ai_org_overrides (
  org_id              uuid        PRIMARY KEY REFERENCES identity.orgs (id) ON DELETE CASCADE,
  provider_config_id  uuid        NOT NULL REFERENCES platform.ai_provider_config (id),
  set_by              uuid        NOT NULL REFERENCES identity.users (id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform.ai_org_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.ai_org_overrides FORCE  ROW LEVEL SECURITY;

CREATE POLICY ai_org_overrides_tenant_isolation ON platform.ai_org_overrides
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

CREATE POLICY ai_org_overrides_platform_admin_all ON platform.ai_org_overrides
  FOR ALL TO taskflow_platform_admin
  USING (true) WITH CHECK (true);

GRANT SELECT ON platform.ai_org_overrides TO taskflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.ai_org_overrides TO taskflow_platform_admin;

-- --------------------------------------------------------------------------
-- ai.usage_ledger — what the budget gate is computed FROM (§3.4).
--
-- Same shape and the same reasoning as `comms.spend_ledger`: written in the
-- SAME transaction as the request it accounts for, never inferred later from
-- a provider billing API that may not exist for every provider. Two token
-- counts because they are billed at different per-token rates by every
-- provider in this market; `cost_cents` is computed once, at write time,
-- from whatever rate table the caller resolved, so a later rate change does
-- not retroactively rewrite history the way recomputing on read would.
--
-- No `estimated`/`actual` split like telephony's ledger: unlike a phone call,
-- an LLM completion's token usage is known synchronously, in the same
-- response that returns the content, so there is no asynchronous billing
-- callback to reconcile against later. The gate can therefore trust this
-- table's numbers as final the moment they are written.
-- --------------------------------------------------------------------------
CREATE TABLE ai.usage_ledger (
  id              uuid        PRIMARY KEY,
  org_id          uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  membership_id   uuid        REFERENCES identity.memberships (id) ON DELETE SET NULL,

  -- The calling surface, e.g. 'standup', 'pr-review', 'onboarding' — a
  -- closed set grows as §4-§8 add callers, so this column starts open
  -- (`text`, non-empty) rather than a CHECK enumerating features that do
  -- not exist yet; the CHECK narrows once a real feature set exists to
  -- validate it against.
  feature         text        NOT NULL CHECK (btrim(feature) <> ''),

  provider        text        NOT NULL,
  model           text        NOT NULL,

  input_tokens    integer     NOT NULL,
  output_tokens   integer     NOT NULL,
  cost_cents      bigint      NOT NULL,

  occurred_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT usage_ledger_input_tokens_nonnegative  CHECK (input_tokens >= 0),
  CONSTRAINT usage_ledger_output_tokens_nonnegative CHECK (output_tokens >= 0),
  CONSTRAINT usage_ledger_cost_nonnegative          CHECK (cost_cents >= 0)
);

-- The gate's read: sum this org's window. Ordered so the rolling-window scan
-- is an index range rather than a filter over the org's whole history —
-- identical reasoning to `spend_ledger_org_window_idx`.
CREATE INDEX usage_ledger_org_window_idx ON ai.usage_ledger (org_id, occurred_at DESC);

ALTER TABLE ai.usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.usage_ledger FORCE  ROW LEVEL SECURITY;

CREATE POLICY usage_ledger_tenant_isolation ON ai.usage_ledger
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- §3.3's operator-facing spend report groups by ORG and by model, across
-- every tenant — the identical cross-org shape `memberships_platform_admin_read`
-- (migration 0035) exists for. FOR SELECT only: an operator views spend, an
-- operator never books a charge, and this table is otherwise write-once from
-- inside the transaction that earns the cost.
CREATE POLICY usage_ledger_platform_admin_read ON ai.usage_ledger
  FOR SELECT TO taskflow_platform_admin
  USING (true);

GRANT SELECT, INSERT ON ai.usage_ledger TO taskflow_app;
GRANT SELECT ON ai.usage_ledger TO taskflow_platform_admin;
