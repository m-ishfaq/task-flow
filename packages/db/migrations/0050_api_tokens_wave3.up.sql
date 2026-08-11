-- 0050 — API tokens (ai/phase-10-automation.md, Wave 3, §6)
--
-- The `tf_pat` credential: long-lived programmatic access to the existing
-- tRPC router, minted with a SUBSET of the minting user's live permissions
-- (§6.3) and authenticated by hash on every request (§6.4).
--
-- One table, `platform.api_tokens`. Deliberately NOT a second no-RLS
-- directory table in the comms.subaccount_orgs shape: scopes and revocation
-- ARE the security state, and a copy that bypasses RLS would drift the instant
-- anything else touched it — a revoked token that still authenticates is the
-- failure a sidecar table makes possible. The auth lookup therefore runs as a
-- NARROW ROLE with a `USING (true)` policy, the claim-role recipe applied to
-- the authentication path: the role that decides who you are may read the
-- lookup columns of every row and nothing else.
--
-- ==========================================================================
-- WHY `platform` AND WHAT THAT COSTS (same statement as 0047/0049's header)
-- ==========================================================================
--
-- `platform` carries ALTER DEFAULT PRIVILEGES from 0001, so taskflow_app
-- already holds full CRUD on every table created here BEFORE any GRANT in this
-- file runs. The REVOKE below is what makes "a token is never hard-deleted"
-- a fact rather than an intention — revocation is the operation, and DELETE
-- is refused by the database (the 0036 lesson: say what the table must NOT
-- have).

CREATE TABLE platform.api_tokens (
  id           uuid        PRIMARY KEY,
  org_id       uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  -- WHOSE credential it is. The holder's membership is re-resolved on every
  -- request, so a token dies the moment its holder leaves the org; the
  -- ON DELETE CASCADE is the same control automations.created_by makes — a
  -- credential must not outlive its owner.
  created_by   uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  -- A human label for the list view. `token_prefix` is the first ten
  -- characters of the token BODY, stored at mint, because the list needs to
  -- distinguish two tokens both called "CI" and the full token is never
  -- stored — only `token_hash` (sha256 hex), which is the lookup key.
  name         text        NOT NULL,
  token_hash   text        NOT NULL,
  token_prefix text        NOT NULL,

  -- Permission strings from the closed catalog, validated at the route against
  -- the minting user's LIVE can() (§6.3). Deliberately NO CHECK on content:
  -- the catalog lives in TypeScript (a widened catalog would otherwise demand
  -- a migration per permission), and a bogus scope is inert — enforcement is
  -- the intersection of this list and the live can() answer, so a stored
  -- scope no one can hold matches nothing.
  scopes       text[]      NOT NULL,

  created_at   timestamptz NOT NULL DEFAULT now(),

  -- "When was this token last used", for the list view. Written throttled to
  -- once per minute by the quota path (§6.5) — never on every request.
  last_used_at timestamptz,

  -- NULL = live. Soft delete: the audit trail keeps the row, the auth lookup
  -- refuses it. There is no hard delete — see the grants below.
  revoked_at   timestamptz,

  CONSTRAINT api_tokens_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT api_tokens_name_length  CHECK (length(name) <= 120),
  -- sha256 hex, exactly — the shape `tokens.ts`'s `hashToken` produces.
  CONSTRAINT api_tokens_hash_length  CHECK (length(token_hash) = 64),
  CONSTRAINT api_tokens_prefix_length CHECK (length(token_prefix) = 10),
  -- A token with zero scopes can never pass the scope-intersection gate; it
  -- is a revoked-by-nature row, and the mint form will not create one.
  CONSTRAINT api_tokens_scopes_nonempty CHECK (cardinality(scopes) > 0)
);

-- The lookup is by hash, and hashes are globally unique — 256 bits of CSPRNG
-- output, so there is no collision and no cross-org ambiguity in the WHERE.
CREATE UNIQUE INDEX api_tokens_hash_key ON platform.api_tokens (token_hash);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, verbatim from rls.ts.
-- --------------------------------------------------------------------------

ALTER TABLE platform.api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.api_tokens FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_tokens_tenant_isolation ON platform.api_tokens;
CREATE POLICY api_tokens_tenant_isolation ON platform.api_tokens
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- Grants for the APPLICATION role — a restatement plus one REVOKE; see the
-- file header. The org's members manage their own tokens through the CRUD
-- routes (mint/list/revoke), and nothing in the application hard-deletes one.
-- --------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON platform.api_tokens TO taskflow_app;
REVOKE DELETE ON platform.api_tokens FROM taskflow_app;

-- --------------------------------------------------------------------------
-- taskflow_api_token_auth — the LOOKUP role (the claim-role recipe, third
-- use; §6.2).
-- --------------------------------------------------------------------------
-- The role is created in docker/postgres/init/02-roles.sql, not here — roles
-- are cluster-wide and the migrator is NOCREATEROLE on purpose (0047's note).
--
-- What it may do is the one thing the authentication path needs done across
-- every tenant: resolve a presented `tf_pat` by its hash BEFORE any org is
-- known — the token row names its org, so no value of `app.org_id` is correct
-- for the read. Its grant is COLUMN-LEVEL, and what is excluded is the point:
--
--   - it never sees `name`, `token_prefix` or `last_used_at` — the role that
--     decides who you are cannot read what your tokens are called or when you
--     last used them;
--   - it holds NO INSERT/UPDATE/DELETE — nothing in authentication writes, and
--     a compromised lookup role can neither mint nor revoke.
--
-- Unlike the worker claim roles, this one is on the REQUEST hot path — every
-- token-authenticated call starts here. The hash lookup is an equality probe
-- of a unique index, which is what keeps a per-request role read affordable.
GRANT USAGE ON SCHEMA platform TO taskflow_api_token_auth;

GRANT SELECT (token_hash, org_id, created_by, scopes, revoked_at)
  ON platform.api_tokens TO taskflow_api_token_auth;

-- USING (true), not tenant-scoped: the whole point of the role is that the
-- org is unknown until this read answers. What contains it is the role —
-- NOBYPASSRLS, reaching across orgs only on this one table's one policy,
-- through its column-level grant.
DROP POLICY IF EXISTS api_tokens_auth_lookup ON platform.api_tokens;
CREATE POLICY api_tokens_auth_lookup ON platform.api_tokens
  FOR SELECT TO taskflow_api_token_auth
  USING (true);
