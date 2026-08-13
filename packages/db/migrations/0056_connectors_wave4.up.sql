-- 0056 — Phase 10 Wave 4: connectors (ai/phase-10-automation.md §7)
--
-- One org's authorization of one provider — a Slack workspace or a GitHub
-- repository — in both directions. The row is the ORG-SCOPED half of a
-- connector: the outbound credential (Slack bot token / GitHub PAT, D6:
-- non-expiring by construction), and — for GitHub only — the per-org inbound
-- verify secret (D4). Slack inbound verification uses the deployment-wide
-- signing secret, so its verify_* columns stay NULL. There is no
-- bi-directional sync: this pushes and receives webhooks, nothing else.
--
-- ==========================================================================
-- WHY `platform` AND WHAT THAT COSTS (the 0036 lesson, restated — a table in
-- this schema begins with ALTER DEFAULT PRIVILEGES from 0001, so taskflow_app
-- already holds full CRUD on it BEFORE any GRANT in this file runs)
-- ==========================================================================
--
-- The REVOKE of DELETE below is what makes "a disconnect is a status flip,
-- never a row gone" a fact rather than an intention — the same soft-delete
-- shape platform.api_tokens has. The org's webhook URLs (Slack's app config
-- takes one URL, deployment-wide) and the connect OAuth flow are slice 2;
-- this file is the storage the rows land in, plus the narrow role that
-- resolves "who is this webhook for" before any org is known (slice 3).

CREATE TABLE platform.integrations (
  id              uuid        PRIMARY KEY,
  org_id          uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  -- The provider and WHAT it names within that provider. For Slack this is
  -- the team_id; for GitHub the repository full_name. Together with the org
  -- they are unique — an org cannot hold the same Slack workspace twice.
  provider        text        NOT NULL CHECK (provider IN ('slack', 'github')),
  provider_scope  text        NOT NULL,

  -- Human label for the list view: the workspace or repository name.
  name            text        NOT NULL,

  -- 'connected' | 'disconnected'. A disconnect flips this and never deletes
  -- the row (see the REVOKE below) — the row is the org's audit trail of
  -- having authorized this scope, and its credential stays dead.
  status          text        NOT NULL DEFAULT 'connected'
                  CHECK (status IN ('connected', 'disconnected')),

  -- The OUTBOUND credential, envelope-encrypted under a per-org data key
  -- (the webhook secret's recipe: ciphertext + wrapped key + master key id,
  -- with the AAD binding to org+row). Non-expiring by construction (D6): a
  -- Slack bot token or a GitHub PAT. NEVER readable by the lookup role.
  token_ciphertext bytea      NOT NULL,
  token_wrapped    bytea      NOT NULL,
  token_master_id  text       NOT NULL,

  -- The INBOUND verify secret, GitHub only (D4 — per-org repo webhook
  -- secrets). NULL for Slack, whose verification uses the deployment-wide
  -- SLACK_SIGNING_SECRET instead. The lookup role needs these three columns
  -- and nothing else (see the grants below).
  verify_ciphertext bytea,
  verify_wrapped    bytea,
  verify_master_id  text,

  -- Who authorized it; NULL-safe because a connector outliving its author is
  -- a fact of life for standing integrations (SET NULL, not CASCADE — the
  -- row is the org's, not the person's).
  created_by       uuid       REFERENCES identity.users (id) ON DELETE SET NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT integrations_provider_scope_present CHECK (length(btrim(provider_scope)) > 0),
  CONSTRAINT integrations_name_present          CHECK (length(btrim(name)) > 0),
  CONSTRAINT integrations_one_scope UNIQUE (org_id, provider, provider_scope)
);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, verbatim from rls.ts.
-- --------------------------------------------------------------------------

ALTER TABLE platform.integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.integrations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integrations_tenant_isolation ON platform.integrations;
CREATE POLICY integrations_tenant_isolation ON platform.integrations
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- Grants for the APPLICATION role — a restatement plus one REVOKE; see the
-- file header. The org's members connect/disconnect their own connectors
-- through the CRUD routes, and nothing in the application hard-deletes one.
-- --------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON platform.integrations TO taskflow_app;
REVOKE DELETE ON platform.integrations FROM taskflow_app;

-- --------------------------------------------------------------------------
-- taskflow_integration_auth — the LOOKUP role (the claim-role recipe applied
-- to inbound connector webhooks; §7.2).
-- --------------------------------------------------------------------------
-- The role is created in docker/postgres/init/02-roles.sql, not here — roles
-- are cluster-wide and the migrator is NOCREATEROLE on purpose (0047's note).
--
-- What it may do is the one thing an inbound Slack/GitHub webhook needs done
-- across every tenant: resolve the body's team_id / repository full_name to an
-- org BEFORE any org is known — the row names its org, so no value of
-- app.org_id is correct for the read (the api_token_auth argument, made for a
-- webhook instead of a token). Its grant is COLUMN-LEVEL, and what is excluded
-- is the point:
--
--   - it never sees `token_ciphertext` / `token_wrapped` / `token_master_id`
--     — the role that resolves "who is this webhook for" cannot read anyone's
--     outbound credential — nor `name` or `status`;
--   - it holds NO INSERT/UPDATE/DELETE — nothing in inbound verification
--     writes, and a compromised lookup role can neither mint nor revoke a
--     connector.
--
-- It DOES see the GitHub verify columns, because GitHub verification is
-- per-org (D4): the signature check needs the org's secret before the request
-- can be trusted, and the org is only known through this same row.
GRANT USAGE ON SCHEMA platform TO taskflow_integration_auth;

GRANT SELECT (org_id, provider, provider_scope, verify_ciphertext, verify_wrapped, verify_master_id)
  ON platform.integrations TO taskflow_integration_auth;

-- USING (true), not tenant-scoped: the whole point of the role is that the
-- org is unknown until this read answers. What contains it is the role —
-- NOBYPASSRLS, reaching across orgs only on this one table's one policy,
-- through its column-level grant.
DROP POLICY IF EXISTS integrations_auth_lookup ON platform.integrations;
CREATE POLICY integrations_auth_lookup ON platform.integrations
  FOR SELECT TO taskflow_integration_auth
  USING (true);
