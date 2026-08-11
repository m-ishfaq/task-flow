-- 0052 — the per-token daily quota (ai/phase-10-automation.md §6.5, Wave 3
-- slice 4).
--
-- One row per token: the durable counters that bound what a `tf_pat` may do
-- in a day. Two counters, because §6.5 counts twice:
--
--   - `used_count` — EVERY token-authenticated request counts toward the
--     token's daily total (a generous allowance; the point of a token is
--     programmatic volume);
--   - `expensive_count` — additionally counted for the closed class of
--     expensive routes (search, analytics, export, telephony; PLAN.md §627),
--     which opt in by declaring `quotaClass` in their route meta.
--
-- The LIMITS are TypeScript constants in packages/db/src/api-token-quota.ts,
-- not columns: a limit is deployment policy that changes without a schema
-- migration, and a ceiling carried in the consume statement's WHERE is the
-- whole mechanism (§6.5's claim pattern — a count-then-write lets two
-- parallel requests both pass a one-slot quota; the database adjudicates).
--
-- Durable by design, the 0045/0047 argument restated: a restart must not
-- forgive a quota, and an in-process counter forgives everyone on restart.
-- `quota_date` is the UTC day the counters apply to; a stale date means
-- yesterday's row, and the consume statement RESETS rather than increments.
--
-- `last_used_at` is the api_tokens list view's "last used", written at most
-- once per minute by the consume statement — the row is rewritten on every
-- request anyway (the counters), so the throttle is about the FIELD's
-- information content, not write volume.

CREATE TABLE platform.api_token_quota (
  token_id        uuid        PRIMARY KEY REFERENCES platform.api_tokens (id) ON DELETE CASCADE,
  org_id          uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  quota_date      date        NOT NULL,
  used_count      integer     NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expensive_count integer     NOT NULL DEFAULT 0 CHECK (expensive_count >= 0),
  last_used_at    timestamptz
);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, verbatim from rls.ts.
-- --------------------------------------------------------------------------
-- The consuming statement runs as taskflow_app under withOrgScope — the same
-- scope every route's own queries run under — so a quota row is only ever
-- touched from inside its own org's transaction.

ALTER TABLE platform.api_token_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.api_token_quota FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_token_quota_tenant_isolation ON platform.api_token_quota;
CREATE POLICY api_token_quota_tenant_isolation ON platform.api_token_quota
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- Grants for the APPLICATION role — a restatement plus one REVOKE; see 0050's
-- identical header for the 0036 lesson. `platform` carries ALTER DEFAULT
-- PRIVILEGES from 0001, so taskflow_app held full CRUD here BEFORE this file
-- ran; the REVOKE is what says what the table must NOT have. Nothing in the
-- application deletes a quota row: the counters are append-only by design,
-- and the row dies with its token (the ON DELETE CASCADE above).
-- --------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON platform.api_token_quota TO taskflow_app;
REVOKE DELETE ON platform.api_token_quota FROM taskflow_app;

-- No grant for taskflow_api_token_auth: the authentication path reads
-- api_tokens and nothing else. Quota consumption runs as the app role inside
-- the route gate, after authentication has already answered.
