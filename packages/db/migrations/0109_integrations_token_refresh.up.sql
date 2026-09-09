-- 0109 — GitHub OAuth token refresh for platform.integrations
--
-- 0056's own header called the stored credential "non-expiring by
-- construction" — true for a Slack bot token, and true for a GitHub OAuth
-- App token UNLESS whoever registered that OAuth App on GitHub's side has
-- opted into "expire user tokens" (a per-app setting this deployment does
-- not control). When that setting is on, GitHub's token exchange starts
-- returning `expires_in`/`refresh_token`/`refresh_token_expires_in`
-- alongside `access_token` — fields the original exchange silently
-- discarded — and the access token stops working after 8 hours with no way
-- back short of a person reconnecting the repository by hand. Found from a
-- real report: the assistant's GitHub tools failing with a 401 the existing
-- error message correctly, but unhelpfully, called "invalid or was
-- revoked".
--
-- All five columns are nullable, on purpose: a Slack row, and a GitHub row
-- whose OAuth App has no expiration enabled, never populate them and behave
-- exactly as they did before this migration — `token_expires_at IS NULL` is
-- what `connectorFor` reads as "never refresh this one", the identical
-- signal a NULL `verify_ciphertext` already gives for "no GitHub inbound
-- secret" one row up. This is expand-only: no existing row is touched, and
-- no existing column's meaning changes.
--
-- Encrypted under the SAME per-row data key the access token already uses
-- (`token_wrapped`/`token_master_id`) — a second data key would only mean a
-- second key to unwrap for what is, functionally, the same secret's
-- lifecycle. No new AAD either: `integrationTokenAad(orgId, integrationId)`
-- already binds every ciphertext on this row to it, refresh token included.

ALTER TABLE platform.integrations
  ADD COLUMN refresh_token_ciphertext bytea,
  ADD COLUMN refresh_token_wrapped    bytea,
  ADD COLUMN refresh_token_master_id  text,
  ADD COLUMN token_expires_at         timestamptz,
  ADD COLUMN refresh_token_expires_at timestamptz;

-- taskflow_app already holds table-level SELECT/INSERT/UPDATE from 0056 —
-- these five columns are covered by that grant automatically. The
-- COLUMN-LEVEL grant to taskflow_integration_auth (0056) explicitly lists
-- the columns that role may see, so these new ones stay invisible to the
-- inbound-webhook lookup role with no REVOKE needed — the same "excluded by
-- not being named" property `token_ciphertext` already has for that role.
